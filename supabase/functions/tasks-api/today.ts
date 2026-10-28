/**
 * Ikisai Tasks · «Trabajos de hoy» para Flow (encargo de Core, 27-10-2026; docs/tasks/API.md §47).
 * - `GET today/projection?date=AAAA-MM-DD&projectId=…&spaceId=…|none`: lo de hoy del equipo en el ámbito de quien lee
 *   (`tasks.today_projection`; capacidad del mismo nombre). Sin el Plan de hoy de cada cual, que es privado (0339).
 * - `POST tasks/complete {taskId, requestId?}`: marca hecha una tarea que la persona ve (capacidad `tasks.complete`).
 *   Idempotente: si ya estaba hecha devuelve `changed: false`. No marca sus hijas.
 * - `POST tasks/unit-step {taskId, unit, done?}`: una unidad de una tarea con unidades (`tasks.unit_step`; capacidad del
 *   mismo nombre, §55). La tarea queda hecha con todas sus unidades.
 */
import { createSync, fail, type AppRoute, type Supabase } from '../_kit/mod.ts';
import { DomainError, effectiveScopes, validateOperations, type Operation, type Role } from '../_domain/tasks/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayRoutes(supabase: Supabase): AppRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  return [{
    method: 'GET', pattern: 'today/projection', handler: async ({ ctx, url }) => {
      const date = url.searchParams.get('date'), projectId = url.searchParams.get('projectId'), spaceId = url.searchParams.get('spaceId');
      if (date !== null && (!DATE.test(date) || Number.isNaN(Date.parse(date)))) fail(422, 'INVALID_INPUT', 'date va como AAAA-MM-DD.', { field: 'date' });
      if (projectId !== null && !UUID.test(projectId)) fail(422, 'INVALID_INPUT', 'projectId debe ser un uuid.', { field: 'projectId' });
      // 0366: un espacio (con lo que tiene dentro) o «none», lo que no tiene espacio.
      if (spaceId !== null && spaceId !== 'none' && !UUID.test(spaceId)) fail(422, 'INVALID_INPUT', 'spaceId es un uuid o none.', { field: 'spaceId' });
      return await supabase.rpc('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.today_projection',
        p_args: { ...(date ? { date } : {}), ...(projectId ? { projectId: projectId.toLowerCase() } : {}), ...(spaceId ? { spaceId: spaceId.toLowerCase() } : {}) } });
    },
  }, {
    method: 'POST', pattern: 'tasks/complete', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Marcar tareas desde otra app necesita permiso de edición en Tasks.');
      // Los agentes marcan por `commands`, con su revisión de riesgo; esta ruta es para personas.
      if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', 'Un agente marca tareas por commands.');
      const body = (await json().catch(() => ({}))) as Record<string, unknown>;
      for (const key of Object.keys(body)) if (!['requestId', 'taskId'].includes(key)) fail(422, 'INVALID_INPUT', `Campo no admitido: ${key}.`, { field: key });
      if (typeof body.taskId !== 'string' || !UUID.test(body.taskId)) fail(422, 'INVALID_INPUT', 'taskId debe ser un uuid.', { field: 'taskId' });
      const id = (body.taskId as string).toLowerCase();
      const read = async () => (await supabase.rpc<{ items: Array<{ id: string; revision: number; done: boolean; deleted?: boolean; visible?: boolean }> }>('core_read', {
        p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.targets', p_args: { kind: 'task', ids: [id] } })).items[0] ?? null;
      const task = await read() as ({ id: string; revision: number; done: boolean; deleted?: boolean; visible?: boolean; archived?: boolean } | null);
      if (!task || task.visible === false || task.deleted) fail(404, 'NOT_FOUND', 'Esa tarea no existe o no la ves.');
      if (task!.archived) fail(409, 'PROJECT_ARCHIVED', 'Esa tarea es de un proyecto archivado.');
      if (task!.done) return { taskId: id, done: true, changed: false, revision: task!.revision };
      const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? `complete-${body.requestId}` : `complete-${crypto.randomUUID()}`;
      const operations: Operation[] = [{ op: 'update', table: 'tasks.tasks', id, expectedRevision: task!.revision, fields: { done: true } }];
      // La misma validación que `commands` (beforeCommit de la app); el ámbito lo vuelve a comprobar tasks.validate_batch.
      try {
        validateOperations(operations, { role: ctx.membership.role as Role, scopes: effectiveScopes(ctx.membership) });
      } catch (error) {
        if (error instanceof DomainError) fail(error.status, error.code, error.message, error.details);
        throw error;
      }
      await internal.commit(ctx, { requestId, operations });
      const after = await read();
      return { taskId: id, done: !!after?.done, changed: true, revision: after?.revision ?? task!.revision + 1 };
    },
  }, {
    // Unidades (0360, §55): marca o desmarca una unidad («Montar bastidor · 2 de 4»). Rol, ámbito y reglas, en el SQL.
    method: 'POST', pattern: 'tasks/unit-step', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Marcar unidades desde otra app necesita permiso de edición en Tasks.');
      if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', 'Un agente marca por commands.');
      const body = (await json().catch(() => ({}))) as Record<string, unknown>;
      for (const key of Object.keys(body)) if (!['requestId', 'taskId', 'unit', 'done'].includes(key)) fail(422, 'INVALID_INPUT', `Campo no admitido: ${key}.`, { field: key });
      if (typeof body.taskId !== 'string' || !UUID.test(body.taskId)) fail(422, 'INVALID_INPUT', 'taskId debe ser un uuid.', { field: 'taskId' });
      if (typeof body.unit !== 'number' || !Number.isInteger(body.unit) || body.unit < 1 || body.unit > 100) fail(422, 'INVALID_INPUT', 'unit es un entero de 1 a 100.', { field: 'unit' });
      if (body.done !== undefined && typeof body.done !== 'boolean') fail(422, 'INVALID_INPUT', 'done es verdadero o falso.', { field: 'done' });
      const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? `unit-${body.requestId}` : `unit-${crypto.randomUUID()}`;
      const args = { taskId: (body.taskId as string).toLowerCase(), unit: body.unit, done: body.done ?? true };
      return ((await internal.commit(ctx, { requestId, operations: [{ op: 'call', procedure: 'tasks.unit_step', args }] })).results[0] as { result?: unknown })?.result;
    },
  }];
}
