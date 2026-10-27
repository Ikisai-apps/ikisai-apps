/**
 * Ikisai Tasks · «Proyectos y producción», 7.2 (docs/tasks/API.md §52).
 * - `GET projects/production?projectId=…`: la producción de un proyecto que quien lee ve (`tasks.project_production_projection`;
 *   capacidad `tasks.project_production`): fases, tareas con su bloqueo, carriles y la siguiente acción por fase. 404 si no
 *   lo ve o no existe.
 * - `POST projects/design {designId, tabId, title, objective?, due?, phases[], tasks[]}` (7.4, §54): el proyecto entero que
 *   sale de una entrevista, en un lote (`tasks.project_design`; capacidad del mismo nombre). Repetible por `designId`.
 *   Aquí solo la forma; reglas, rol y ámbito, en el SQL. Los agentes van por `commands`, con su revisión de riesgo.
 */
import { createSync, fail, type AppRoute, type Supabase } from '../_kit/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DESIGN_KEYS = ['requestId', 'designId', 'tabId', 'title', 'objective', 'due', 'phases', 'tasks'];
const PHASE_KEYS = ['key', 'name', 'start', 'due'];
const TASK_KEYS = ['key', 'phase', 'title', 'note', 'due', 'priority', 'inOrder', 'steps', 'trades', 'spaces', 'people', 'materials', 'dependsOn'];

export function productionRoutes(supabase: Supabase): AppRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  return [{
    method: 'POST', pattern: 'projects/design', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Crear un proyecto necesita permiso de edición en Tasks.');
      if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', 'Un agente crea proyectos por commands.');
      const body = (await json().catch(() => null)) as Record<string, unknown> | null;
      const invalid = (field: string, message: string): never => fail(422, 'INVALID_INPUT', message, { field });
      if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('body', 'El cuerpo es un objeto.');
      const only = (value: unknown, keys: string[], field: string) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, `${field} es un objeto.`);
        for (const key of Object.keys(value as object)) if (!keys.includes(key)) invalid(`${field}.${key}`, `Campo no admitido: ${key}.`);
      };
      only(body, DESIGN_KEYS, 'body');
      for (const field of ['designId', 'tabId']) if (typeof body[field] !== 'string' || !UUID.test(body[field] as string)) invalid(field, `${field} debe ser un uuid.`);
      if (typeof body.title !== 'string') invalid('title', 'Falta title.');
      for (const field of ['phases', 'tasks']) if (body[field] !== undefined && !Array.isArray(body[field])) invalid(field, `${field} es una lista.`);
      ((body.phases ?? []) as unknown[]).forEach((phase, i) => only(phase, PHASE_KEYS, `phases[${i}]`));
      ((body.tasks ?? []) as unknown[]).forEach((task, i) => only(task, TASK_KEYS, `tasks[${i}]`));
      const { requestId: _ignored, ...args } = body;
      const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? `design-${body.requestId}` : `design-${crypto.randomUUID()}`;
      return ((await internal.commit(ctx, { requestId, operations: [{ op: 'call', procedure: 'tasks.project_design', args }] })).results[0] as { result?: unknown })?.result;
    },
  }, {
    method: 'GET', pattern: 'projects/production', handler: async ({ ctx, url }) => {
      const projectId = url.searchParams.get('projectId');
      if (projectId === null || !UUID.test(projectId)) fail(422, 'INVALID_INPUT', 'projectId debe ser un uuid.', { field: 'projectId' });
      return await supabase.rpc('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.project_production_projection',
        p_args: { projectId: projectId!.toLowerCase() } });
    },
  }];
}
