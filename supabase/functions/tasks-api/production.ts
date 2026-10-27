/**
 * Ikisai Tasks · «Proyectos y producción», 7.2 (docs/tasks/API.md §52).
 * - `GET projects/production?projectId=…`: la producción de un proyecto que quien lee ve (`tasks.project_production_projection`;
 *   capacidad `tasks.project_production`): fases, tareas con su bloqueo, carriles y la siguiente acción por fase. 404 si no
 *   lo ve o no existe.
 */
import { fail, type AppRoute, type Supabase } from '../_kit/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function productionRoutes(supabase: Supabase): AppRoute[] {
  return [{
    method: 'GET', pattern: 'projects/production', handler: async ({ ctx, url }) => {
      const projectId = url.searchParams.get('projectId');
      if (projectId === null || !UUID.test(projectId)) fail(422, 'INVALID_INPUT', 'projectId debe ser un uuid.', { field: 'projectId' });
      return await supabase.rpc('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.project_production_projection',
        p_args: { projectId: projectId!.toLowerCase() } });
    },
  }];
}
