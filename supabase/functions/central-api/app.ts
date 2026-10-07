/** Ikisai Central · API. Administración común (`admin/*` del kit) y personas sobre el núcleo (docs/central/API.md). */
import { createApp, createSupabase, createUploads, fail, isFault, sha256Hex, stable, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import {
  COMPLIANCE_TABLES, ENTITY_TABLE, KPI_SOURCES, LOGO_MIME, TABLES, TASK_KIND, TASK_KIND_LABEL, kpiState, targetFor, taskExternalRef, validateOperations, visibleRow,
  type KpiRow, type KpiTarget,
} from '../_domain/central/mod.ts';

export const CENTRAL_ORIGINS = ['https://central.ikisai.com', 'https://ikisai-central.pages.dev'];
export const DEFAULT_TASKS_API_BASE = 'https://tasks.ikisai.com';

export interface CentralAppOptions {
  /** Base de la API de Tasks (`https://tasks.ikisai.com` o la función directa en QA). */
  tasksApiBase?: string;
  /** Transporte hacia la API de Tasks (inyectable en pruebas). */
  tasksFetch?: typeof fetch;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITY_BY_RISK: Record<string, string> = { critico: 'critical', alto: 'high' };

/** Documentación de personas y de cumplimiento: PDF e imágenes (fotos recomprimidas en el cliente). */
export const CENTRAL_UPLOADS: UploadsConfig = {
  bucket: 'central-documents',
  maxBytes: 25 * 1024 * 1024,
  allowedMime: ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'],
};

/** Columnas que referencian un archivo de Central, y los tipos que admite cada una (vacío = cualquiera del bucket). */
const FILE_FIELDS: Record<string, { field: string; mime: readonly string[] }> = {
  [TABLES.personRecords]: { field: 'file_id', mime: [] },
  [ENTITY_TABLE]: { field: 'logo_file_id', mime: LOGO_MIME },
  [COMPLIANCE_TABLES.keyDocuments]: { field: 'file_id', mime: [] },
};

/** Un archivo referenciado debe ser de Central, estar verificado y tener un tipo admitido para esa columna. */
async function checkFiles(supabase: Supabase, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    const spec = op.table ? FILE_FIELDS[op.table] : undefined;
    const id = spec && op.fields ? op.fields[spec.field] : undefined;
    if (!spec || typeof id !== 'string') continue;
    let file: { status: string; mime: string };
    try {
      file = await supabase.rpc('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
    } catch (error) {
      if (isFault(error) && error.code === 'FILE_NOT_FOUND') fail(422, 'INVALID_FILE', 'El archivo no existe o no pertenece a Central.', { index, field: spec.field });
      throw error;
    }
    if (file.status !== 'verified') fail(422, 'INVALID_FILE', 'El archivo todavía no se ha subido por completo.', { index, field: spec.field });
    if (spec.mime.length && !spec.mime.includes(file.mime)) fail(422, 'INVALID_FILE', 'El logotipo debe ser una imagen PNG, JPEG o WebP.', { index, field: spec.field, mime: file.mime });
  }
}

/**
 * Trabajo pedido a Tasks (API.md §7.3; `docs/tasks/API.md` §19 y §20): con el token de la persona, sin área ni proyecto
 * (`kind` y las reglas de Tasks deciden), idempotente por `external_ref`. El estado se lee de Tasks, no se copia.
 */
function createTasksClient(options: CentralAppOptions) {
  const base = (options.tasksApiBase ?? DEFAULT_TASKS_API_BASE).replace(/\/$/, '');
  const transport = options.tasksFetch ?? fetch;
  return async function call<T>(ctx: RequestContext, path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await transport(`${base}/api/v1/${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail(503, 'TASKS_UNAVAILABLE', 'Tasks no responde ahora mismo. Inténtalo más tarde.');
    }
    const out = await response.json().catch(() => ({})) as any;
    if (response.status === 401 || response.status === 403) fail(403, 'TASKS_FORBIDDEN', 'Tu cuenta no puede crear tareas en Tasks.', { error: out?.error ?? null });
    if (response.status === 409 && out?.error?.code === 'EXTERNAL_REF_IN_USE') fail(409, 'EXTERNAL_REF_IN_USE', 'Esa tarea ya existe en Tasks y no la ves.');
    if (response.status >= 400 && response.status < 500) fail(422, 'TASKS_REJECTED', out?.error?.message ?? 'Tasks no ha aceptado la petición.', { error: out?.error ?? null });
    if (!response.ok) fail(503, 'TASKS_UNAVAILABLE', 'Tasks no responde ahora mismo. Inténtalo más tarde.', { status: response.status });
    return out as T;
  };
}

/** Id de fila derivado del lote: un reintento con el mismo `requestId` produce exactamente las mismas operaciones. */
async function derivedUuid(seed: string): Promise<string> {
  const h = await sha256Hex(new TextEncoder().encode(seed));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface TasksTask { id: string; title?: string; revision?: number; deleted?: boolean; pending?: boolean; visible?: boolean; done?: boolean; request?: string }

function centralRoutes(supabase: Supabase, uploads: UploadsConfig, options: CentralAppOptions): AppRoute[] {
  const files = createUploads(supabase, 'central', uploads);
  const tasks = createTasksClient(options);
  const read = <T>(ctx: RequestContext, name: string, args: Record<string, unknown> = {}) =>
    supabase.rpc<T>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: name, p_args: args });
  return [
    // Pide a Tasks una tarea para una obligación y la enlaza (API.md §6). Necesita red; idempotente por `requestId`.
    {
      method: 'POST', pattern: 'requirements/:id/task', handler: async ({ ctx, params, json }) => {
        if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', 'Solo quien edita puede pedir tareas.');
        const body = (await json().catch(() => ({}))) ?? {};
        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
        if (!/^[A-Za-z0-9-]{8,100}$/.test(requestId)) fail(422, 'INVALID_OPERATION', 'Falta requestId.');
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        const due = typeof body.due === 'string' && body.due ? body.due : null;
        if (title.length > 500 || note.length > 2000 || (due !== null && !DATE.test(due))) fail(422, 'INVALID_OPERATION', 'Título, nota o fecha no válidos.');
        const req = await read<{ id: string; code: string; name: string; expiresOn: string | null; risk: string }>(ctx, 'central.requirement_brief', { id: params.id ?? '' });
        const externalRef = taskExternalRef(req.code, requestId);
        const out = await tasks<{ created: boolean; routed?: string; task: TasksTask }>(ctx, 'requests/task', {
          source: 'central', external_ref: externalRef, kind: TASK_KIND, kind_label: TASK_KIND_LABEL,
          external_url: `${CENTRAL_ORIGINS[0]}/#/cumplimiento/${req.id}`,
          title: title || req.name, ...(note ? { note } : {}), ...(due ? { due } : {}),
          priority: PRIORITY_BY_RISK[req.risk] ?? 'normal',
        });
        if (!out?.task?.id || !UUID.test(out.task.id)) fail(503, 'TASKS_UNAVAILABLE', 'Respuesta de Tasks no válida.');
        const linkId = await derivedUuid(`central-requirement-task:${requestId}`);
        const operations = [{ op: 'insert', table: COMPLIANCE_TABLES.requirementTasks, id: linkId, fields: {
          requirement_id: req.id, target_id: out.task.id, external_ref: externalRef,
          target_label: out.task.title ?? (title || req.name), target_revision: out.task.revision ?? null, due_on: due,
        } }];
        const digest = await sha256Hex(new TextEncoder().encode(stable(operations)));
        try {
          await supabase.rpc('core_commit', { p_app: ctx.app, p_actor: ctx.user.id, p_request_id: `task:${requestId}`, p_digest: digest, p_expected_cursor: null, p_operations: operations });
        } catch (error) {
          // La tarea ya estaba enlazada (otro lote la pidió con la misma referencia): no es un error para quien pide.
          if (!(isFault(error) && error.code === 'CONSTRAINT_VIOLATION')) throw error;
        }
        return { requirementTaskId: linkId, created: out.created, routed: out.routed ?? null, task: out.task };
      },
    },
    // Panel de dirección (API.md §7.2): lee la proyección de KPIs de cada app con la clave de servicio y la registración
    // `core.allow_read('central', …)` de la app dueña. Una app sin proyección o con error va en `unavailable`.
    {
      method: 'GET', pattern: 'dashboard', handler: async ({ ctx }) => {
        const snapshot = await supabase.rpc<{ rows: KpiTarget[] }>('core_snapshot_table', { p_app: ctx.app, p_role: ctx.membership.role, p_table: 'central.kpi_targets', p_include_deleted: false, p_limit: 1000, p_offset: 0 });
        const targets = (snapshot?.rows ?? []).map((t) => ({ ...t, target: num(t.target), warn_at: num(t.warn_at), critical_at: num(t.critical_at) })) as KpiTarget[];
        const items: unknown[] = [];
        const unavailable: string[] = [];
        await Promise.all(KPI_SOURCES.map(async (source) => {
          try {
            const out = await read<{ rows: KpiRow[] }>(ctx, source.projection, { limit: 500 });
            for (const row of out.rows) {
              const value = row.value === null || row.value === undefined ? null : Number(row.value);
              const target = targetFor(targets, row.kpi, row.period);
              items.push({ app: source.app, kpi: row.kpi, label: row.label, value, unit: row.unit, period: row.period,
                periodStart: row.period_start, periodEnd: row.period_end, direction: row.direction, link: row.link, computedAt: row.computed_at,
                target: target?.target ?? null, state: kpiState(value, target) });
            }
          } catch {
            unavailable.push(source.app);
          }
        }));
        const order = new Map(KPI_SOURCES.map((s, i) => [s.app, i]));
        items.sort((x: any, y: any) => (order.get(x.app)! - order.get(y.app)!) || String(x.kpi).localeCompare(String(y.kpi)) || String(x.period).localeCompare(String(y.period)));
        return { computedAt: new Date().toISOString(), items, unavailable: unavailable.sort((x, y) => order.get(x)! - order.get(y)!) };
      },
    },
    // Estado en Tasks de las tareas pedidas: `tasks.targets` con lista de ids y el token de la persona (solo lo que ve).
    {
      method: 'POST', pattern: 'requirements/tasks-status', handler: async ({ ctx, json }) => {
        const body = (await json().catch(() => ({}))) ?? {};
        const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string' && UUID.test(x)).slice(0, 200) : [];
        if (!ids.length) return { items: [], missing: [] };
        return tasks<{ items: TasksTask[]; missing: string[] }>(ctx, 'read/tasks.targets', { kind: 'task', ids });
      },
    },
    // Catálogo completo de apps para la pantalla Accesos (solo owner de Central).
    { method: 'GET', pattern: 'catalog/apps', handler: ({ ctx }) => read(ctx, 'central.app_catalog') },
    // Archivo de un registro de documentación: solo para quien ve los datos reservados (API.md §8, mientras falte P1).
    {
      method: 'GET', pattern: 'people/records/:id/file', handler: async ({ ctx, params }) => {
        const { fileId } = await read<{ fileId: string }>(ctx, 'central.record_file', { id: params.id ?? '' });
        return files.readUrl(ctx, fileId);
      },
    },
  ];
}

export function createCentralApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads' | 'admin'> & Partial<Pick<AppConfig, 'origins' | 'uploads'>>, options: CentralAppOptions = {}) {
  const supabase = createSupabase(base);
  const uploads = base.uploads ?? CENTRAL_UPLOADS;
  return createApp({
    ...base,
    app: 'central',
    slug: 'central-api',
    admin: true,
    origins: base.origins ?? CENTRAL_ORIGINS,
    uploads,
    hooks: {
      visible: (table, _row, ctx) => visibleRow(table, ctx.membership),
      beforeCommit: async (operations, ctx) => {
        const issue = validateOperations(operations, ctx.membership);
        if (issue) fail(issue.code === 'FORBIDDEN' ? 403 : 422, issue.code, issue.message, issue.details);
        await checkFiles(supabase, operations, ctx);
      },
    },
    routes: centralRoutes(supabase, uploads, options),
  });
}
