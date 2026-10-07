/**
 * Ikisai Tasks · trabajo pedido desde otras apps (docs/tasks/API.md §19). `POST requests/task` crea, una sola vez por
 * referencia, una tarea pedida por otra app (Central) con el token de la persona. No es una acción `invoke`: la tarea
 * pasa por `core.commit` (procedimiento `tasks.request_task`), y así llega a los espejos, al historial y a «deshacer».
 *
 * Idempotencia: el id de la tarea se deriva de `<source>:<external_ref>`. Si ya existe se devuelve tal cual
 * (`created: false`), también si está en la papelera (`deleted: true`): otra app no resucita lo que alguien borró.
 */
import { createSync, fail, sha256Hex, type AppRoute, type Supabase } from '../_kit/mod.ts';

const SOURCE = /^[a-z][a-z0-9_-]{1,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ['normal', 'high', 'critical'];

/** Uuid v4 derivado de un texto (mismo esquema que los ids deterministas de `mcp.ts`). */
export async function requestTaskId(externalRef: string): Promise<string> {
  const hex = (await sha256Hex(`ikisai-tasks-request:${externalRef}`)).slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type TaskTarget = { id: string; deleted: boolean; [key: string]: unknown };

export function requestRoutes(supabase: Supabase): AppRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  return [{
    method: 'POST', pattern: 'requests/task', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Pedir tareas necesita permiso de edición en Tasks.');
      const body = await json() as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      const text = (field: string, max: number, required = false): string | undefined => {
        const value = body[field];
        if (value === undefined || value === null) return required ? invalid(field, `Falta ${field}.`) : undefined;
        if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(field, `${field} debe ser texto de 1 a ${max} caracteres.`);
        return value as string;
      };
      const source = text('source', 31, true)!;
      if (!SOURCE.test(source)) invalid('source', 'source es el id de la app que pide, en minúsculas (p. ej. central).');
      const reference = text('external_ref', 150, true)!.trim();
      const title = text('title', 500, true)!.trim();
      const note = text('note', 20000);
      const due = text('due', 10);
      if (due !== undefined && (!DATE.test(due) || Number.isNaN(Date.parse(due)))) invalid('due', 'due va como AAAA-MM-DD.');
      const priority = text('priority', 10);
      if (priority !== undefined && !PRIORITIES.includes(priority)) invalid('priority', 'priority es normal, high o critical.');
      const projectId = text('project_id', 36), tabId = text('tab_id', 36);
      for (const [field, value] of [['project_id', projectId], ['tab_id', tabId]] as const) if (value !== undefined && !UUID.test(value)) invalid(field, `${field} debe ser un uuid.`);
      if (!projectId && !tabId) invalid('project_id', 'Indica project_id o tab_id (la tarea irá a la Entrada del área).');

      const externalRef = `${source}:${reference}`;
      const id = await requestTaskId(externalRef);
      const read = async () => {
        const out = await supabase.rpc<{ items: TaskTarget[] }>('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.targets', p_args: { kind: 'task', ids: [id] } });
        return out.items[0] ?? null;
      };
      const existing = await read();
      if (existing) return { created: false, task: existing };

      let created = false;
      try {
        const result = await internal.commit(ctx, {
          requestId: `request-task-${crypto.randomUUID()}`,
          operations: [{ op: 'call', procedure: 'tasks.request_task', args: { id, externalRef, title, note, due, priority, projectId: projectId?.toLowerCase(), tabId: tabId?.toLowerCase() } }],
        });
        created = !!(result.results[0] as { result?: { created?: boolean } })?.result?.created;
      } catch (error) {
        // Dos peticiones a la vez: la segunda choca con la tarea que acaba de crear la primera, que es la que se devuelve.
        const raced = await read();
        if (raced) return { created: false, task: raced };
        throw error;
      }
      const task = await read();
      if (!task) fail(409, 'EXTERNAL_REF_IN_USE', 'Esa referencia ya la usa una tarea que no puedes ver.');
      return { created, task };
    },
  }];
}
