/**
 * Ikisai Tasks · trabajo pedido desde otras apps (docs/tasks/API.md §19). `POST requests/task` crea, una sola vez por
 * referencia, una tarea pedida por otra app (Central) con el token de la persona. No es una acción `invoke`: la tarea
 * pasa por `core.commit` (procedimiento `tasks.request_task`), y así llega a los espejos, al historial y a «deshacer».
 *
 * Idempotencia: el id de la tarea se deriva de `<source>:<external_ref>`. Si ya existe se devuelve tal cual
 * (`created: false`), también si está en la papelera (`deleted: true`): otra app no resucita lo que alguien borró.
 *
 * Enrutado (§20): la petición dice qué es (`kind`) y Tasks decide dónde va: la regla del usuario para ese tipo, la
 * sugerencia `project_id | tab_id` si quien pide la ve, o «Por clasificar». Lo que una regla manda a un área que quien
 * pide no ve entra igualmente (buzón) y quien pide solo recibe su estado (`request`: pending, created o dismissed).
 */
import { createSync, fail, sha256Hex, type AppRoute, type Supabase, type WorkerRoute } from '../_kit/mod.ts';

const SOURCE = /^[a-z][a-z0-9_-]{1,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ['normal', 'high', 'critical'];
const KIND_NAME = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const ORIGIN_URL = /^https:\/\/([a-z0-9-]+\.)*ikisai\.com(\/|$)/;
const REPORT_CODE = /^[A-Za-z0-9_-]{1,40}$/;
/** Tipos que Feedback puede pedir por la ruta de worker (contrato de Core, FEEDBACK.md §4): solo lo operativo. */
const FEEDBACK_KINDS = new Set([
  ...['damage', 'cleaning', 'missing', 'utilities', 'safety', 'other'].map((k) => `feedback.space.${k}`),
  ...['setup', 'accommodation', 'cleaning', 'food', 'technical', 'operation', 'other'].map((k) => `feedback.event.${k}`),
]);

/** Uuid v4 derivado de un texto (mismo esquema que los ids deterministas de `mcp.ts`). */
export async function requestTaskId(externalRef: string): Promise<string> {
  const hex = (await sha256Hex(`ikisai-tasks-request:${externalRef}`)).slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type TaskTarget = { id: string; visible?: boolean; request?: string; [key: string]: unknown };

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
      // Qué es: `<source>.<nombre>`. Sin él (peticiones de §19), `<source>.general`.
      const kind = text('kind', 100) ?? `${source}.general`;
      if (!kind.startsWith(source + '.') || !KIND_NAME.test(kind.slice(source.length + 1))) invalid('kind', `kind va como ${source}.<nombre>, en minúsculas.`);
      const kindLabel = text('kind_label', 100)?.trim() || undefined;
      const externalUrl = text('external_url', 500);
      if (externalUrl !== undefined && !ORIGIN_URL.test(externalUrl)) invalid('external_url', 'external_url debe ser https en ikisai.com.');
      // Dónde, solo como sugerencia: manda la regla del usuario; sin regla ni sugerencia válida, «Por clasificar».
      const projectId = text('project_id', 36), tabId = text('tab_id', 36);
      for (const [field, value] of [['project_id', projectId], ['tab_id', tabId]] as const) if (value !== undefined && !UUID.test(value)) invalid(field, `${field} debe ser un uuid.`);

      const externalRef = `${source}:${reference}`;
      const id = await requestTaskId(externalRef);
      const read = async () => {
        const out = await supabase.rpc<{ items: TaskTarget[] }>('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.targets', p_args: { kind: 'task', ids: [id] } });
        return out.items[0] ?? null;
      };
      const existing = await read();
      if (existing) return { created: false, routed: null, task: existing };

      let created = false, routed: string | null = null;
      try {
        const result = await internal.commit(ctx, {
          requestId: `request-task-${crypto.randomUUID()}`,
          operations: [{ op: 'call', procedure: 'tasks.request_task', args: { id, externalRef, kind, kindLabel, externalUrl, title, note, due, priority, projectId: projectId?.toLowerCase(), tabId: tabId?.toLowerCase() } }],
        });
        const outcome = (result.results[0] as { result?: { created?: boolean; routed?: string } })?.result;
        created = !!outcome?.created;
        routed = outcome?.routed ?? null;
      } catch (error) {
        // Dos peticiones a la vez: la segunda choca con la tarea que acaba de crear la primera, que es la que se devuelve.
        const raced = await read();
        if (raced) return { created: false, routed: null, task: raced };
        throw error;
      }
      const task = await read();
      if (!task) fail(409, 'EXTERNAL_REF_IN_USE', 'Esa referencia ya la usa una tarea que no puedes ver.');
      return { created, routed, task };
    },
  }];
}

/**
 * Orígenes de sistema (§22.2): qué app puede pedir trabajo desde su worker, sin persona, con qué tipos, con qué
 * identidad de servicio de Core escribe y qué enlace y metadatos lleva. Nada fuera de esta lista entra por aquí.
 */
interface SystemSource {
  service: string;
  kinds: ReadonlySet<string>;
  /** `external_ref` sin el prefijo de la app. */
  reference: RegExp;
  /** `external_url` válido para esta petición. */
  url: (reference: string, url: string) => boolean;
  /** Si `on_behalf_of` es obligatorio (Feedback) u opcional (Booking). */
  behalf: 'required' | 'optional';
}
const SYSTEM_SOURCES: Record<string, SystemSource> = {
  feedback: {
    service: 'feedback', kinds: FEEDBACK_KINDS, reference: REPORT_CODE, behalf: 'required',
    url: (reference, url) => url === `https://tasks.ikisai.com/#/feedback/${reference}`,
  },
  booking: {
    service: 'booking', kinds: new Set(['booking.ses_deadline']), reference: /^[A-Za-z0-9_.:-]{1,150}$/, behalf: 'optional',
    url: (_reference, url) => /^https:\/\/booking\.ikisai\.com\/#\/[^\s]{0,190}$/.test(url),
  },
};
const SYSTEM_REF = new RegExp(`^(${Object.keys(SYSTEM_SOURCES).join('|')}):.{1,150}$`);

/**
 * Rutas de worker (§22.2 y §22.3), de servidor a servidor con la clave de worker y sin sesión:
 * - `POST worker/requests/task`: una app de la lista pide trabajo; escribe su identidad de servicio por `core.commit`,
 *   con `tasks.request_task` y las reglas del usuario. Quién informó va como metadato (`on_behalf_of`), nunca como
 *   actor. Idempotente por `external_ref`.
 * - `POST worker/requests/status {externalRefs}`: solo el estado de cada petición (pending, open, done, dismissed,
 *   deleted o unknown), para que el worker de quien pidió lo copie.
 */
export function requestWorkerRoutes(supabase: Supabase): WorkerRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  return [{
    method: 'POST', pattern: 'requests/task', handler: async ({ json, invoke }) => {
      const body = await json() as Record<string, unknown>;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      const text = (field: string, max: number, required = false): string | undefined => {
        const value = body?.[field];
        if (value === undefined || value === null) return required ? invalid(field, `Falta ${field}.`) : undefined;
        if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(field, `${field} debe ser texto de 1 a ${max} caracteres.`);
        return (value as string).trim();
      };
      // Solo los campos del contrato: el destino lo deciden las reglas del usuario, nunca quien pide.
      for (const key of Object.keys(body ?? {})) if (!['source', 'kind', 'kind_label', 'external_ref', 'title', 'note', 'external_url', 'on_behalf_of'].includes(key)) invalid(key, `Campo no admitido: ${key}.`);
      const sourceName = String(body?.source ?? '');
      const source = Object.hasOwn(SYSTEM_SOURCES, sourceName) ? SYSTEM_SOURCES[sourceName]! : invalid('source', `source debe ser ${Object.keys(SYSTEM_SOURCES).join(' o ')}.`);
      const kind = text('kind', 100, true)!;
      if (!source.kinds.has(kind)) invalid('kind', `Tipo no admitido para ${sourceName}: ${[...source.kinds].join(', ')}.`);
      const reference = text('external_ref', 150, true)!;
      if (!source.reference.test(reference)) invalid('external_ref', 'external_ref no es una referencia válida.');
      const title = text('title', 120, true)!, note = text('note', 1000), kindLabel = text('kind_label', 100) || undefined;
      const externalUrl = text('external_url', 200);
      if (externalUrl !== undefined && !source.url(reference, externalUrl)) invalid('external_url', `external_url no es un enlace válido para ${sourceName}.`);
      const behalf = body?.on_behalf_of as { kind?: unknown; report_code?: unknown } | undefined;
      if (behalf === undefined || behalf === null) {
        if (source.behalf === 'required') invalid('on_behalf_of', 'Falta on_behalf_of.');
      } else if (typeof behalf !== 'object' || !['internal', 'organizer', 'guest'].includes(String(behalf.kind)) || typeof behalf.report_code !== 'string' || !REPORT_CODE.test(behalf.report_code)
        || Object.keys(behalf).some((k) => k !== 'kind' && k !== 'report_code')) {
        invalid('on_behalf_of', 'on_behalf_of es {kind: internal|organizer|guest, report_code}.');
      }

      const externalRef = `${sourceName}:${reference}`;
      const id = await requestTaskId(externalRef);
      const status = async () => ((await invoke('tasks.requests_status', { externalRefs: [externalRef] })) as { items: Array<{ status: string; taskId: string | null }> }).items[0]!;
      const reply = (current: { status: string }) => ({ taskId: id, status: current.status });
      const before = await status();
      if (before.status !== 'unknown') return reply(before);

      const actor = ((await invoke('tasks.service_actor', { name: source.service })) as { actor: string | null }).actor;
      if (!actor) fail(503, 'SERVICE_NOT_READY', `La identidad de servicio «${source.service}» aún no existe.`);
      const ctx = await internal.context({ id: actor!, email: null, sessionId: `service:${source.service}`, kind: 'human' }, '');
      try {
        await internal.commit(ctx, {
          requestId: `${sourceName}-${crypto.randomUUID()}`,
          operations: [{ op: 'call', procedure: 'tasks.request_task', args: {
            id, externalRef, kind, kindLabel, externalUrl, title, note, ...(behalf ? { onBehalfOf: { kind: behalf.kind, report_code: behalf.report_code } } : {}),
          } }],
        });
      } catch (error) {
        // Dos reintentos a la vez: el segundo choca con la petición que acaba de dar de alta el primero.
        const raced = await status();
        if (raced.status !== 'unknown') return reply(raced);
        throw error;
      }
      return reply(await status());
    },
  }, {
    method: 'POST', pattern: 'requests/status', handler: async ({ json, invoke }) => {
      const body = await json() as { externalRefs?: unknown };
      const refs = body?.externalRefs;
      if (!Array.isArray(refs) || refs.length > 200 || refs.some((r) => typeof r !== 'string' || !SYSTEM_REF.test(r))) {
        fail(422, 'INVALID_INPUT', `externalRefs: hasta 200 referencias de ${Object.keys(SYSTEM_SOURCES).join(' o ')}.`, { field: 'externalRefs' });
      }
      return invoke('tasks.requests_status', { externalRefs: refs });
    },
  }];
}
