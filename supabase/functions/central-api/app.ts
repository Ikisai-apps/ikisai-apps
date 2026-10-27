/** Ikisai Central · API. Administración común (`admin/*` del kit) y personas sobre el núcleo (docs/central/API.md). */
import { createApp, createStorage, createSupabase, createUploads, fail, generateAgentKey, r2ConfigFromEnv, isFault, sha256Hex, stable, type AppConfig, type AppRoute, type Operation, type RequestContext, type StorageAccess, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import {
  BED_LAYOUT_PROJECTION, COMPLIANCE_TABLES, ENTITY_TABLE, type BedLayout, KPI_SOURCES, LOGO_MIME, SITE_PLAN_MIME, canSeeKpi, TABLES, accountGuardIssue, accountGuardTargets, TASK_KIND, TASK_KIND_LABEL, kpiState, targetFor, taskExternalRef, WEEKLY_ACTIONS_TABLE, WEEKLY_TASK_KIND, WEEKLY_TASK_KIND_LABEL, canPrepareReview, weeklyTaskRef, validateOperations, visibleRow,
  type HouseGrant, type KpiRow, type KpiTarget,
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
  // K3 para miembros (núcleo #585): un archivo ajeno se lee solo si se ve una fila viva que lo referencia (`visibleRow`).
  membersK3: true,
};

/** Columnas que referencian un archivo de Central, y los tipos que admite cada una (vacío = cualquiera del bucket). Todas en
 *  `core.register_file_field`: con K3, un archivo que no esté en ellas no lo lee más que quien lo subió y el owner. */
export const FILE_FIELDS: Record<string, Array<{ field: string; mime: readonly string[] }>> = {
  [TABLES.personRecords]: [{ field: 'file_id', mime: [] }],
  [ENTITY_TABLE]: [{ field: 'logo_file_id', mime: LOGO_MIME }, { field: 'site_plan_file_id', mime: SITE_PLAN_MIME }],
  [COMPLIANCE_TABLES.keyDocuments]: [{ field: 'file_id', mime: [] }],
};

/** Un archivo referenciado debe ser de Central, estar verificado y tener un tipo admitido para esa columna. */
async function checkFiles(supabase: Supabase, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    for (const spec of (op.table ? FILE_FIELDS[op.table] : undefined) ?? []) {
      const id = op.fields ? op.fields[spec.field] : undefined;
      if (typeof id !== 'string') continue;
      let file: { status: string; mime: string };
      try {
        file = await supabase.rpc('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
      } catch (error) {
        if (isFault(error) && error.code === 'FILE_NOT_FOUND') fail(422, 'INVALID_FILE', 'El archivo no existe o no pertenece a Central.', { index, field: spec.field });
        throw error;
      }
      if (file.status !== 'verified') fail(422, 'INVALID_FILE', 'El archivo todavía no se ha subido por completo.', { index, field: spec.field });
      if (spec.mime.length && !spec.mime.includes(file.mime)) fail(422, 'INVALID_FILE', spec.field === 'logo_file_id' ? 'El logotipo debe ser una imagen PNG, JPEG o WebP.' : 'El plano debe ser una imagen o un PDF.', { index, field: spec.field, mime: file.mime });
    }
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

function centralRoutes(supabase: Supabase, uploads: UploadsConfig, options: CentralAppOptions, storage: StorageAccess): AppRoute[] {
  // Mismo almacenamiento que el kit (Supabase o R2 según `core.files.storage_provider`; contrato §3.9).
  const files = createUploads(supabase, 'central', uploads, storage);
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
    // Acción de la revisión semanal como tarea de Tasks (1523; VG, vg-41): como las obligaciones, con el token de la persona
    // y referencia idempotente; la acción queda enlazada en `central.weekly_actions`. Solo Dirección y con la revisión abierta.
    {
      method: 'POST', pattern: 'weekly/:id/task', handler: async ({ ctx, params, json }) => {
        if (!canPrepareReview(ctx.membership)) fail(403, 'FORBIDDEN', 'Las acciones de la revisión las crea Dirección.');
        const body = (await json().catch(() => ({}))) ?? {};
        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
        const code = typeof body.code === 'string' ? body.code : '';
        const kpi = typeof body.kpi === 'string' ? body.kpi : '';
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        const due = typeof body.due === 'string' && body.due ? body.due : null;
        if (!/^[A-Za-z0-9-]{8,100}$/.test(requestId) || !UUID.test(params.id ?? '') || !/^RSM_\d{4}_\d{3,}$/.test(code)) fail(422, 'INVALID_OPERATION', 'Faltan la revisión o requestId.');
        if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(kpi) || !label || !title || title.length > 500 || note.length > 2000 || (due !== null && !DATE.test(due))) fail(422, 'INVALID_OPERATION', 'Indicador, título, nota o fecha no válidos.');
        const externalRef = weeklyTaskRef(code, requestId);
        const out = await tasks<{ created: boolean; routed?: string; task: TasksTask }>(ctx, 'requests/task', {
          source: 'central', external_ref: externalRef, kind: WEEKLY_TASK_KIND, kind_label: WEEKLY_TASK_KIND_LABEL,
          external_url: `${CENTRAL_ORIGINS[0]}/#/direccion/semana`, title, ...(note ? { note } : {}), ...(due ? { due } : {}), priority: 'normal',
        });
        if (!out?.task?.id || !UUID.test(out.task.id)) fail(503, 'TASKS_UNAVAILABLE', 'Respuesta de Tasks no válida.');
        const actionId = await derivedUuid(`central-weekly-task:${requestId}`);
        const operations = [{ op: 'insert', table: WEEKLY_ACTIONS_TABLE, id: actionId, fields: {
          review_id: params.id, kpi, label, kind: 'task', task_target_id: out.task.id, task_external_ref: externalRef,
          task_label: out.task.title ?? title, task_revision: out.task.revision ?? null,
        } }];
        const digest = await sha256Hex(new TextEncoder().encode(stable(operations)));
        try {
          await supabase.rpc('core_commit', { p_app: ctx.app, p_actor: ctx.user.id, p_request_id: `weekly-task:${requestId}`, p_digest: digest, p_expected_cursor: null, p_operations: operations });
        } catch (error) {
          if (!(isFault(error) && error.code === 'CONSTRAINT_VIOLATION')) throw error;
        }
        return { actionId, created: out.created, task: out.task };
      },
    },
    // Alta de un agente desde Central (VG, 27-10: no encontraba cómo darle lectura en todas las apps). Como el alta de agentes
    // del kit, pero en varias apps de una vez: crea la cuenta de agente, le da su rol (lector, salvo que se pida editor) en
    // cada app elegida donde quien la da es propietario, y emite una clave que solo se ve en la respuesta. Nunca en Central.
    {
      method: 'POST', pattern: 'agents/new', handler: async ({ ctx, json }) => {
        if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Solo quien administra Central da de alta agentes.');
        const body = (await json().catch(() => ({}))) ?? {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 100) fail(422, 'INVALID_OPERATION', 'Pon un nombre de hasta 100 caracteres.');
        const role = body.role === 'editor' ? 'editor' : 'reader';
        const apps = Array.isArray(body.apps)
          ? [...new Set((body.apps as unknown[]).filter((a): a is string => typeof a === 'string' && /^[a-z][a-z0-9_]*$/.test(a) && a !== 'central'))].slice(0, 20)
          : [];
        if (!apps.length) fail(422, 'INVALID_OPERATION', 'Elige al menos una app (Central no admite agentes).');
        let expiresAt: string | null = null;
        if (typeof body.expiresAt === 'string' && body.expiresAt) {
          const when = new Date(body.expiresAt);
          if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) fail(422, 'INVALID_OPERATION', 'La caducidad debe ser una fecha futura.');
          expiresAt = when.toISOString();
        }
        const bytes = new Uint8Array(18); crypto.getRandomValues(bytes);
        const password = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '');
        const created = await supabase.remote('/auth/v1/admin/users', {
          service: true, method: 'POST',
          body: { email: `agent-${crypto.randomUUID().slice(0, 8)}@agents.ikisai.invalid`, password, email_confirm: true, user_metadata: { kind: 'agent', name } },
        });
        if (typeof created?.id !== 'string') fail(502, 'AUTH_ADMIN_FAILED', 'No se pudo crear la cuenta del agente.');
        const token = generateAgentKey();
        const digest = await sha256Hex(new TextEncoder().encode(token));
        let keyId: string | null = null;
        const results: Array<{ app: string; ok: boolean; code?: string }> = [];
        for (const app of apps) {
          const first: boolean = keyId === null;
          try {
            const out: { keyId: string | null } | null = await supabase.rpc<{ keyId: string | null }>('core_agent_key_issue', {
              p_app: app, p_actor: ctx.user.id, p_user: created.id, p_name: name, p_role: role, p_scopes: null,
              p_digest: first ? digest : null, p_hint: first ? token.slice(-4) : null, p_expires_at: first ? expiresAt : null,
            });
            if (first) keyId = out?.keyId ?? null;
            results.push({ app, ok: true });
          } catch (error) {
            results.push({ app, ok: false, code: isFault(error) ? error.code : 'ERROR' });
          }
        }
        if (keyId === null) fail(403, 'FORBIDDEN', 'No eres propietario de ninguna de esas apps: el agente no tiene acceso a ninguna.', { apps: results });
        return { userId: created.id, keyId, name, role, token, apps: results };
      },
    },
    // Panel de dirección (API.md §7.2): lee la proyección de KPIs de cada app con la clave de servicio y la registración
    // `core.allow_read('central', …)` de la app dueña. Una app sin proyección o con error va en `unavailable`; si la app
    // la publica solo para otros roles (FORBIDDEN), se omite: no es que no tenga indicadores, es que este rol no los ve.
    // Camas en el plano con un solo modelo (VG, 27-10): la disposición de cada cama la guarda Booking y Central la lee aquí
    // para derivar su forma. Si Booking no responde, ninguna cama en el plano (`available: false`), nunca la forma vieja.
    {
      method: 'GET', pattern: 'beds/layout', handler: async ({ ctx }) => {
        try {
          const out = await read<{ rows: BedLayout[] }>(ctx, BED_LAYOUT_PROJECTION, { limit: 2000 });
          return { rows: out.rows.map((b) => ({ resource_bed_id: b.resource_bed_id, resource_space_id: b.resource_space_id, cols: Number(b.cols), rows: Number(b.rows), x: Number(b.x), y: Number(b.y), rot: Number(b.rot), label: b.label ?? null })), available: true };
        } catch {
          return { rows: [], available: false };
        }
      },
    },
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
              if (!canSeeKpi(String(row.unit), ctx.membership.role)) continue;
              const value = row.value === null || row.value === undefined ? null : Number(row.value);
              const target = targetFor(targets, row.kpi, row.period);
              items.push({ app: source.app, kpi: row.kpi, label: row.label, value, unit: row.unit, period: row.period,
                periodStart: row.period_start, periodEnd: row.period_end, direction: row.direction, link: row.link, computedAt: row.computed_at,
                target: target?.target ?? null, state: kpiState(value, target) });
            }
          } catch (error) {
            if (isFault(error) && error.code === 'FORBIDDEN') return;
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
    // Accesos que ha dado el nivel de casa (O4, núcleo 0092): para marcarlos «por nivel de casa» en Personas y Accesos.
    {
      method: 'GET', pattern: 'people/house-grants', handler: async ({ ctx }) => {
        if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Solo dirección ve los accesos que da el nivel de casa.');
        return { items: (await supabase.rpc<HouseGrant[]>('core_house_grants', { p_user: null })) ?? [] };
      },
    },
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
  const env = (name: string) => (globalThis as any).Deno?.env?.get?.(name) as string | undefined;
  const storage = createStorage(supabase, {
    r2: base.storage?.r2 !== undefined ? base.storage.r2 : r2ConfigFromEnv(env),
    defaultProvider: base.storage?.defaultProvider ?? (env('IKISAI_STORAGE_PROVIDER') === 'r2' ? 'r2' : 'supabase'),
    fetch: base.fetch,
  });
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
        // Nivel de casa de una ficha con cuenta: solo el owner (C1). La base lo impone también (1518).
        const guarded = accountGuardTargets(operations, ctx.membership);
        if (guarded.length) {
          const out = await supabase.rpc<{ ids: string[] }>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'central.people_with_account', p_args: { ids: guarded.map((t) => t.id) } });
          const denied = accountGuardIssue(guarded, new Set(out?.ids ?? []));
          if (denied) fail(403, denied.code, denied.message, denied.details);
        }
        await checkFiles(supabase, operations, ctx);
      },
    },
    routes: centralRoutes(supabase, uploads, options, storage),
  });
}
