/** Ikisai Tasks · API. Configuración de la app sobre el núcleo: hooks de dominio y rutas propias (docs/tasks/API.md §4–§6). */
import { createApp, createSupabase, fail, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase } from '../_kit/mod.ts';
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME, DomainError, allAccess, riskNeedsData, statuses, tasksAgentRisk, validateOperations, visible, visibleRow,
  type AttachmentRow, type ProjectRow, type Role, type TaskDependencyRow, type TaskRow,
} from '../_domain/tasks/mod.ts';

import { exchangeRoutes, exchangeWorkerRoutes } from './exchange.ts';

export const TASKS_ORIGINS = ['https://tasks.ikisai.com', 'https://ikisai-tasks.pages.dev'];
export const TASKS_BUCKET = 'ikisai-files';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `beforeCommit`: la validación compartida con el cliente; los errores de dominio salen con el sobre de la API. */
export function validateTasksOperations(operations: Operation[], ctx: RequestContext, options: { allowCalls?: boolean } = {}): void {
  try {
    validateOperations(operations, { role: ctx.membership.role as Role, scopes: ctx.membership.scopes, allowCalls: options.allowCalls });
  } catch (error) {
    if (error instanceof DomainError) fail(error.status, error.code, error.message, error.details);
    throw error;
  }
}

/**
 * Hook `agentRisk` (docs/tasks/AGENTES.md §3.1): archivar exige aprobación y el alcance cuenta lo que cuelga de un
 * contenedor. Solo lee filas cuando el lote archiva o borra contenedores, y solo las que el agente puede ver.
 * Se conecta a `hooks` cuando el kit tenga `AppHooks.agentRisk` en `main` (rama `core/agentes`).
 */
export function tasksAgentRiskHook(supabase: Supabase) {
  return async (operations: Operation[], ctx: RequestContext) => {
    if (!riskNeedsData(operations)) return tasksAgentRisk(operations);
    const role = ctx.membership.role;
    const read = async <T extends Record<string, unknown>>(table: 'tasks.tasks' | 'tasks.labels' | 'tasks.projects') =>
      (await allRows<T>(supabase, role, table, false)).filter((row) => visibleRow(table, row, ctx.membership.scopes));
    const [tasks, labels, projects] = await Promise.all([read<any>('tasks.tasks'), read<any>('tasks.labels'), read<any>('tasks.projects')]);
    return tasksAgentRisk(operations, { 'tasks.tasks': tasks, 'tasks.labels': labels, 'tasks.projects': projects });
  };
}

/** Todas las filas de una tabla, sin filtrar por ámbitos (uso interno de las rutas; nunca se devuelven tal cual). */
async function allRows<T>(supabase: Supabase, role: string, table: string, includeDeleted = true): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 2000) {
    const page = await supabase.rpc<{ rows: T[]; total: number }>('core_snapshot_table', {
      p_app: 'tasks', p_role: role, p_table: table, p_include_deleted: includeDeleted, p_limit: 2000, p_offset: offset,
    });
    rows.push(...page.rows);
    if (page.rows.length < 2000) return rows;
  }
}

export function tasksRoutes(supabase: Supabase): AppRoute[] {
  return [
    /**
     * Bloqueos privados (API.md §5.3): por cada tarea visible, cuántas de sus condiciones incumplidas están fuera
     * del ámbito del usuario. No revela qué tareas son. Vacío con acceso a toda la app.
     */
    {
      method: 'GET', pattern: 'blockers', handler: async ({ ctx }) => {
        const scopes = ctx.membership.scopes;
        if (allAccess(scopes)) return { cursor: ctx.bootstrap.cursor, items: [] };
        const role = ctx.membership.role;
        const [tasks, projects, dependencies] = await Promise.all([
          allRows<TaskRow>(supabase, role, 'tasks.tasks'),
          allRows<ProjectRow>(supabase, role, 'tasks.projects'),
          allRows<TaskDependencyRow>(supabase, role, 'tasks.task_dependencies'),
        ]);
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const items: Array<{ taskId: string; hidden: number }> = [];
        for (const [taskId, status] of statuses({ tasks, projects, dependencies })) {
          const task = byId.get(taskId)!;
          if (task.deleted_at || !visibleRow('tasks.tasks', task as unknown as Record<string, unknown>, scopes)) continue;
          const hidden = status.blockedBy.filter((id) => {
            const blocker = byId.get(id);
            return !blocker || !visibleRow('tasks.tasks', blocker as unknown as Record<string, unknown>, scopes);
          }).length;
          if (hidden > 0) items.push({ taskId, hidden });
        }
        return { cursor: ctx.bootstrap.cursor, items };
      },
    },
    /** Descarga de un adjunto tras comprobar que su fila es visible para el usuario (API.md §8). */
    {
      method: 'GET', pattern: 'attachments/:id', handler: async ({ ctx, params }) => {
        const id = params.id ?? '';
        if (!UUID.test(id)) fail(404, 'NOT_FOUND', 'Adjunto no encontrado.');
        const rows = await allRows<AttachmentRow>(supabase, ctx.membership.role, 'tasks.attachments', false);
        const attachment = rows.find((row) => row.id === id.toLowerCase());
        if (!attachment || !visibleRow('tasks.attachments', attachment as unknown as Record<string, unknown>, ctx.membership.scopes)) {
          fail(404, 'NOT_FOUND', 'Adjunto no encontrado.');
        }
        const file = await supabase.rpc<{ bucket: string; path: string; status: string; mime: string }>('core_file_get', { p_app: 'tasks', p_actor: ctx.user.id, p_id: attachment.file_id });
        if (file.status !== 'verified') fail(404, 'NOT_FOUND', 'El archivo no está disponible.');
        const response: Response = await supabase.remote(`/storage/v1/object/${file.bucket}/${file.path.split('/').map(encodeURIComponent).join('/')}`, { service: true, raw: true });
        if (!response.ok) fail(response.status === 404 || response.status === 400 ? 404 : 503, response.status === 404 || response.status === 400 ? 'NOT_FOUND' : 'STORAGE_UNAVAILABLE', 'No se pudo leer el archivo.');
        return new Response(response.body, {
          status: 200,
          headers: {
            'Content-Type': attachment.mime || file.mime || 'application/octet-stream',
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(attachment.name),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      },
    },
  ];
}

export function createTasksApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins'>>) {
  const supabase = createSupabase(base);
  return createApp({
    ...base,
    app: 'tasks',
    slug: 'tasks-api',
    origins: base.origins ?? TASKS_ORIGINS,
    uploads: { bucket: TASKS_BUCKET, maxBytes: ATTACHMENT_MAX_BYTES, allowedMime: [...ATTACHMENT_MIME] },
    hooks: {
      visible,
      beforeCommit: (operations, ctx) => validateTasksOperations(operations, ctx),
    },
    routes: [...tasksRoutes(supabase), ...exchangeRoutes(supabase)],
    workerRoutes: exchangeWorkerRoutes(),
  });
}
