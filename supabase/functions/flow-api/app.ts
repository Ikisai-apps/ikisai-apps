/**
 * Ikisai Flow · API (docs/flow/API.md). El núcleo del kit (sesión, bootstrap, sincronización con `core.commit` y los
 * procedimientos `flow.*`, feedback y uso) y las rutas públicas sin sesión de la carta (§6 y §14, FLOW-DIR-001 §1), que se
 * atienden aquí antes de pasar la petición al kit:
 * - `GET public/menu`: la carta (cacheable 30 s).
 * - `POST public/customer`: crea el cliente anónimo; devuelve su token (solo para el navegador) y su número.
 * - `POST public/orders`: envía la cesta como pedido abierto del cliente de la cabecera `X-Flow-Customer`.
 * - `GET public/mine`: los pedidos de ese cliente, y nada más.
 * - `POST public/invitation`: canje del enlace firmado de un huésped (0910): rota el token de su cliente y lo devuelve.
 * El token nunca llega a la base de datos: aquí se resume con SHA-256 y solo viaja el resumen. Las escrituras van por la
 * escritura pública del núcleo (actor «Flow (sistema)», lote público que limita `flow.guard`).
 */
import { applyPublicOperations, createApp, createSupabase, fail, isFault, sha256Hex, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import { APP, TABLES, visibleRow } from '../_domain/flow/mod.ts';

export const FLOW_ORIGINS = ['https://flow.ikisai.com', 'https://ikisai-flow.pages.dev'];

/** Lecturas públicas registradas por las migraciones 0900 y 0901. */
export const PUBLIC_MENU = 'flow_menu';
export const PUBLIC_MINE = 'flow_mine';
export const PUBLIC_GUEST_LINK = 'flow_guest_link';
export const CUSTOMER_HEADER = 'x-flow-customer';
export const MAX_PUBLIC_LINES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;

/** Escritura pública del núcleo (`applyPublicOperations` del kit, migración core 0094); inyectable en pruebas. */
export type PublicWriter = (supabase: Supabase, app: string, operations: unknown[]) => Promise<{ cursor: number; results: unknown[] }>;

type FlowBase = Omit<AppConfig, 'app' | 'slug' | 'origins' | 'routes' | 'hooks' | 'uploads'> & Partial<Pick<AppConfig, 'origins'>>;

interface Mine { number: number | null; customerId: string | null; projectId: string | null; orders: unknown[] }

/** Opciones inyectables en pruebas: escritura pública, transporte hacia las otras apps y base de la API de Tasks. */
export interface FlowAppOptions { publicWrite?: PublicWriter; appsFetch?: typeof fetch; tasksApiBase?: string }

export const DEFAULT_TASKS_API_BASE = 'https://tasks.ikisai.com';

/** Documentos y portadas del flujo (orden de VG del 27-10): bucket privado `flow-media`, imágenes y PDF. */
export const FLOW_UPLOADS: UploadsConfig = {
  bucket: 'flow-media',
  maxBytes: 15 * 1024 * 1024,
  allowedMime: ['image/webp', 'image/jpeg', 'image/png', 'application/pdf'],
};

/** Columnas que referencian un archivo de Flow y los tipos que admite cada una. */
const FILE_FIELDS: Record<string, Array<{ field: string; mime: readonly string[] }>> = {
  'flow.projects': [{ field: 'cover_file_id', mime: ['image/webp', 'image/jpeg', 'image/png'] }],
  'flow.project_documents': [{ field: 'file_id', mime: FLOW_UPLOADS.allowedMime! }],
};

/** Un archivo referenciado tiene que ser de Flow, estar verificado y tener un tipo admitido para esa columna (como Central). */
async function checkFiles(supabase: Supabase, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    for (const spec of (op.table ? FILE_FIELDS[op.table] : undefined) ?? []) {
      const id = op.fields ? op.fields[spec.field] : undefined;
      if (typeof id !== 'string') continue;
      let file: { status: string; mime: string };
      try {
        file = await supabase.rpc('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
      } catch (error) {
        if (isFault(error) && error.code === 'FILE_NOT_FOUND') fail(422, 'INVALID_FILE', 'El archivo no existe o no es de Flow.', { index, field: spec.field });
        throw error;
      }
      if (file.status !== 'verified') fail(422, 'INVALID_FILE', 'El archivo todavía no se ha subido por completo.', { index, field: spec.field });
      if (!spec.mime.includes(file.mime)) fail(422, 'INVALID_FILE', spec.field === 'cover_file_id' ? 'La portada debe ser una imagen.' : 'Ese tipo de archivo no vale aquí.', { index, field: spec.field, mime: file.mime });
    }
  }
}

/** Ruta de cada columna en la app (`#/p/<proyecto>/<ruta>`), para los enlaces que se mandan a otras apps. */
const COLUMN_SLUGS: Record<string, string> = { order: 'caja', prep: 'preparacion', ingredients: 'ingredientes', service: 'servicio', logistics: 'logistica' };

interface ClosureForSend {
  closure: { id: string; project_id: string; day: string; data: DayData };
  project: { id: string; name: string; test_mode: boolean; food_menu_id: string | null; booking_event_id: string | null };
}
interface DayData {
  orders: number; sales_cents: number; sales_by_method: { cash: number; bizum: number; card?: number }; refunds_pending_cents: number;
  units_by_product: Array<{ scope: string; code: string; name: string; units: number; amount_cents: number; source_line_id: string | null }>;
}

/**
 * Envíos del Cierre del día (contratos con Food y Finance del 26-10): desde aquí, con la sesión de la persona, a la API de
 * cada app (como Central con Tasks). Nunca desde el navegador. Quien envía tiene que ser miembro de esa app: si no, la
 * respuesta lo dice (`NEEDS_ACCESS`). El resultado lo anota el cliente con `flow.mark_closure_sent`.
 */
function closureRoutes(supabase: Supabase, base: FlowBase, options: FlowAppOptions): AppRoute[] {
  const transport = options.appsFetch ?? fetch;
  const apiOf = (slug: string) => `${base.url.replace(/\/$/, '')}/functions/v1/${slug}/api/v1/commands`;

  async function closure(ctx: RequestContext, id: string): Promise<ClosureForSend> {
    if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'El cierre del día lo envía el encargado.');
    const out = await supabase.rpc<ClosureForSend | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.closure_for_send', p_args: { id } });
    if (!out?.closure) fail(404, 'NOT_FOUND', 'Ese cierre no existe.');
    return out;
  }

  async function callApp(ctx: RequestContext, slug: string, label: string, requestId: string, procedure: string, args: unknown) {
    let res: Response;
    try {
      res = await transport(apiOf(slug), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, operations: [{ op: 'call', procedure, args }] }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      fail(503, 'APP_UNAVAILABLE', `${label} no responde ahora mismo. Inténtalo más tarde.`);
    }
    const out = await res.json().catch(() => ({})) as any;
    const code = out?.error?.code as string | undefined;
    if (res.status === 401 || res.status === 403 || code === 'NO_MEMBERSHIP') fail(403, 'NEEDS_ACCESS', `Pide acceso a ${label}: tu cuenta no puede enviarle datos.`, { app: slug, code: code ?? null });
    if (!res.ok) fail(res.status === 409 ? 409 : 422, code ?? 'APP_REJECTED', out?.error?.message ?? `${label} no ha aceptado el envío.`, { app: slug, details: out?.error?.details ?? null });
    return out?.results?.[0]?.result ?? null;
  }

  const digest = async (value: unknown) => (await sha256Hex(JSON.stringify(value))).slice(0, 24);

  return [
    {
      // Ventas por línea de la carta de Food (food.record_carta_sales, idempotente por carta y día).
      method: 'POST', pattern: 'closures/:id/send/food', handler: async ({ ctx, params }) => {
        const { closure: c, project } = await closure(ctx, params.id ?? '');
        if (!project.food_menu_id) fail(409, 'NO_FOOD_MENU', 'Este flujo no está ligado a una carta de Food: actualiza la carta desde Food primero.');
        const lines = c.data.units_by_product.filter((u) => u.source_line_id).map((u) => ({ line_id: u.source_line_id, quantity: u.units }));
        const args = { menu_id: project.food_menu_id, day: c.day, lines };
        const result = await callApp(ctx, 'food-api', 'Food', `flow:food:${c.id}:${await digest(args)}`, 'food.record_carta_sales', args);
        return { status: 'sent', result };
      },
    },
    {
      // Apunte de ingresos del día en Finance (invoices.record_app_entry, idempotente por source_ref). En modo pruebas, no.
      method: 'POST', pattern: 'closures/:id/send/finance', handler: async ({ ctx, params }) => {
        const { closure: c, project } = await closure(ctx, params.id ?? '');
        if (project.test_mode) return { status: 'skipped_test_mode', result: null };
        const [y, m, d] = c.day.split('-');
        const sourceRef = `flow:project:${project.id}:${c.day}`;
        const args = {
          source_app: 'flow', source_ref: sourceRef, kind: 'income', entry_date: c.day,
          description: `${project.name} · ${d}-${m}-${y}`,
          amount_cents: c.data.sales_cents, tax_rate: 10,
          methods: { cash: c.data.sales_by_method.cash, bizum: c.data.sales_by_method.bizum, ...(c.data.sales_by_method.card ? { card: c.data.sales_by_method.card } : {}) },
          detail: c.data.units_by_product.map((u) => ({ code: `${u.scope}:${u.code}`, name: u.name, quantity: u.units, amount_cents: u.amount_cents })),
          pending_refunds_cents: c.data.refunds_pending_cents,
          event_id: project.booking_event_id,
        };
        const result = await callApp(ctx, 'invoices-api', 'Finance', `flow:${sourceRef}:${await digest(args)}`, 'invoices.record_app_entry', args);
        return { status: 'sent', result };
      },
    },
  ];
}

/**
 * «Pedir a Tasks» (contrato de Tasks §39): con la sesión de la persona, a la API de Tasks, como Central. Quien pide tiene
 * que ser editor u owner de Tasks y ver el proyecto. Tasks no avisa de cambios: el estado se consulta al enseñarlo.
 */
function tasksRoutes(supabase: Supabase, options: FlowAppOptions): AppRoute[] {
  const transport = options.appsFetch ?? fetch;
  const env = (name: string) => (globalThis as any).Deno?.env?.get?.(name) as string | undefined;
  const base = (options.tasksApiBase ?? env('IKISAI_TASKS_API_BASE') ?? DEFAULT_TASKS_API_BASE).replace(/\/$/, '');

  async function tasks<T>(ctx: RequestContext, path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await transport(`${base}/api/v1/${path}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail(503, 'APP_UNAVAILABLE', 'Tasks no responde ahora mismo. Inténtalo más tarde.');
    }
    const out = await res.json().catch(() => ({})) as any;
    const code = out?.error?.code as string | undefined;
    if (res.status === 401 || res.status === 403 || code === 'NO_MEMBERSHIP') fail(403, 'NEEDS_ACCESS', 'Pide acceso a Tasks: tu cuenta no puede crear tareas allí.', { app: 'tasks', code: code ?? null });
    if (res.status === 404) fail(409, 'TASKS_PROJECT_GONE', 'El proyecto de Tasks de este flujo ya no existe o no lo ves: elige otro.');
    if (!res.ok) fail(res.status === 409 ? 409 : 422, code ?? 'APP_REJECTED', out?.error?.message ?? 'Tasks no ha aceptado la petición.', { details: out?.error?.details ?? null });
    return out as T;
  }

  return [
    {
      // Proyectos abiertos de Tasks que ve la persona (para elegir el del flujo, una vez).
      method: 'POST', pattern: 'tasks/projects', handler: async ({ ctx }) => {
        const out = await tasks<{ tabs?: Array<{ id: string; name: string; projects?: Array<{ id: string; title: string; status: string; system?: boolean; deleted?: boolean }> }> }>(ctx, 'read/tasks.targets', {});
        const items = (out.tabs ?? []).flatMap((t) => (t.projects ?? [])
          .filter((p) => !p.system && p.status !== 'archived' && !p.deleted)
          .map((p) => ({ id: p.id, title: p.title, area: t.name })));
        return { items };
      },
    },
    {
      // Pedir a Tasks una tarea o una compra desde una tarea de Flow. Una vez por tarea (external_ref = id de la unidad).
      method: 'POST', pattern: 'units/:id/tasks', handler: async ({ ctx, params, json }) => {
        if (ctx.membership.role === 'reader' || ctx.membership.role === 'outsider') fail(403, 'FORBIDDEN', 'Tu cuenta no puede pedir a Tasks.');
        const body = (await json().catch(() => ({}))) ?? {};
        const found = await supabase.rpc<{ unit: any; project: any } | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.unit_for_tasks', p_args: { id: params.id } });
        if (!found?.unit) fail(404, 'NOT_FOUND', 'Esa tarea no existe.');
        if (found.unit.kind !== 'task') fail(422, 'INVALID_OPERATION', 'Solo las tareas se piden a Tasks.');
        if (!found.project.tasks_project_id) fail(409, 'NO_TASKS_PROJECT', 'Este flujo aún no tiene proyecto de Tasks: el encargado lo elige en el Inicio del flujo.');
        const priority = found.unit.priority ? 'high' : 'normal';
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 4000) : `Desde ${found.project.name}`;
        if (body.type === 'purchase') {
          const quantity = Number(body.quantity);
          const out = await tasks<{ created: boolean; purchase: { id: string; status: string } }>(ctx, 'requests/purchase', {
            source: 'flow', external_ref: found.unit.id, title: String(found.unit.label ?? '').slice(0, 300), project_id: found.project.tasks_project_id, priority, note,
            // «Ver en Flow ›» de Tasks (§39.5): la columna de la tarea en su flujo.
            external_url: `${FLOW_ORIGINS[0]}/equipo#/p/${found.project.id}/${COLUMN_SLUGS[found.unit.column_key as string] ?? 'logistica'}`,
            ...(Number.isFinite(quantity) && quantity > 0 ? { quantity, unit: typeof body.unit === 'string' ? body.unit.slice(0, 20) : undefined } : {}),
          });
          return { created: out.created, link: { app: 'tasks', kind: 'purchase_request', id: out.purchase.id, status: out.purchase.status } };
        }
        const out = await tasks<{ created: boolean; task: { id: string; done?: boolean } }>(ctx, 'requests/task', {
          source: 'flow', kind: 'flow.logistics', kind_label: 'Logística de la barra', external_ref: found.unit.id,
          title: String(found.unit.label ?? '').slice(0, 300), note, project_id: found.project.tasks_project_id, priority,
        });
        return { created: out.created, link: { app: 'tasks', kind: 'task', id: out.task.id, status: out.task.done ? 'done' : 'open' } };
      },
    },
    {
      // Estado de las tareas pedidas (Tasks no avisa).
      method: 'POST', pattern: 'tasks/status', handler: async ({ ctx, json }) => {
        const body = (await json().catch(() => ({}))) ?? {};
        const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'string').slice(0, 200) : [];
        if (!ids.length) return { items: [] };
        return tasks(ctx, 'read/tasks.targets', { kind: 'task', ids });
      },
    },
  ];
}

export function createFlowApp(base: FlowBase, options: FlowAppOptions = {}) {
  const origins = base.origins ?? FLOW_ORIGINS;
  const supabase = createSupabase(base);
  // Acceso por proyecto (0902): cada persona solo sincroniza las filas de sus proyectos; el owner, todas.
  const kit = createApp({ ...base, app: APP, slug: 'flow-api', origins, routes: [...closureRoutes(supabase, base, options), ...tasksRoutes(supabase, options)], uploads: FLOW_UPLOADS,
    hooks: { visible: (table, row, ctx) => visibleRow(table, row, ctx.membership), beforeCommit: (operations, ctx) => checkFiles(supabase, operations, ctx) } });
  const publicWrite: PublicWriter = options.publicWrite ?? ((db, app, operations) => applyPublicOperations(db, app, operations as Parameters<typeof applyPublicOperations>[2]));

  async function handlePublic(request: Request, route: string): Promise<Response> {
    const origin = request.headers.get('origin');
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin', 'Cache-Control': 'no-store' };
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    const error = (status: number, code: string, message: string) => reply({ error: { code, message, details: null } }, status);
    if (origin && !origins.includes(origin)) return error(403, 'ORIGIN_REJECTED', 'Origen no autorizado.');

    const mine = async (tokenHash: string) => supabase.rpc<Mine>('core_public_read', { p_name: PUBLIC_MINE, p_args: { token_hash: tokenHash } });
    const customerHash = async (): Promise<string | null> => {
      const token = (request.headers.get(CUSTOMER_HEADER) ?? '').trim().toLowerCase();
      return TOKEN.test(token) ? sha256Hex(token) : null;
    };

    try {
      if (route === 'menu' && request.method === 'GET') {
        const out = await supabase.rpc<{ project: string | null; products: unknown[] } | null>('core_public_read', { p_name: PUBLIC_MENU, p_args: {} });
        return reply({ project: out?.project ?? null, products: Array.isArray(out?.products) ? out.products : [] }, 200, { 'Cache-Control': 'public, max-age=30' });
      }
      if (route === 'mine' && request.method === 'GET') {
        const hash = await customerHash();
        if (!hash) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        const out = await mine(hash);
        if (!out?.customerId) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        return reply({ number: out.number, orders: out.orders ?? [] });
      }
      if (route === 'customer' && request.method === 'POST') {
        const menu = await supabase.rpc<{ projectId?: string | null } | null>('core_public_read', { p_name: PUBLIC_MENU, p_args: {} });
        const projectId = menu?.projectId ?? null;
        if (!projectId) return error(409, 'MENU_CLOSED', 'La barra no está abierta ahora mismo.');
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        const hash = await sha256Hex(token);
        await publicWrite(supabase, APP, [{ op: 'insert', table: TABLES.customers, id: crypto.randomUUID(), fields: { project_id: projectId, token_hash: hash } }]);
        const out = await mine(hash);
        return reply({ token, number: out?.number ?? null });
      }
      if (route === 'invitation' && request.method === 'POST') {
        // Enlace firmado de Guests (`<cliente>.<caducidad>.<firma>`): un token nuevo para este navegador; el anterior deja de valer.
        const body = await request.json().catch(() => null) as { invitation?: unknown } | null;
        const invitation = typeof body?.invitation === 'string' ? body.invitation.trim().slice(0, 200) : '';
        const link = invitation ? await supabase.rpc<{ customerId?: string; revision?: number; number?: number; expired?: boolean } | null>('core_public_read', { p_name: PUBLIC_GUEST_LINK, p_args: { invitation } }) : null;
        if (link?.expired) return error(410, 'INVITATION_EXPIRED', 'Ese enlace ha caducado. Ábrelo otra vez desde la app de huéspedes.');
        if (!link?.customerId) return error(404, 'INVITATION_INVALID', 'Ese enlace no vale. Pide uno nuevo en la app de huéspedes.');
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        await publicWrite(supabase, APP, [{ op: 'update', table: TABLES.customers, id: link.customerId, expectedRevision: link.revision, fields: { token_hash: await sha256Hex(token) } }]);
        return reply({ token, number: link.number ?? null });
      }
      if (route === 'orders' && request.method === 'POST') {
        const hash = await customerHash();
        const me = hash ? await mine(hash) : null;
        if (!me?.customerId || !me.projectId) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        const body = await request.json().catch(() => null) as { lines?: Array<{ productId?: unknown; quantity?: unknown }> } | null;
        const lines = Array.isArray(body?.lines) ? body!.lines : [];
        if (!lines.length || lines.length > MAX_PUBLIC_LINES) return error(422, 'INVALID_ORDER', `El pedido debe tener entre 1 y ${MAX_PUBLIC_LINES} productos.`);
        for (const l of lines) {
          if (typeof l.productId !== 'string' || !UUID.test(l.productId) || !Number.isInteger(l.quantity) || (l.quantity as number) < 1 || (l.quantity as number) > 99) {
            return error(422, 'INVALID_ORDER', 'Hay un producto o una cantidad que no vale.');
          }
        }
        const orderId = crypto.randomUUID();
        await publicWrite(supabase, APP, [
          { op: 'insert', table: TABLES.orders, id: orderId, fields: { project_id: me.projectId, origin: 'public', customer_id: me.customerId } },
          ...lines.map((l, i) => ({ op: 'insert', table: TABLES.orderLines, id: crypto.randomUUID(), fields: { order_id: orderId, product_id: l.productId, quantity: l.quantity, position: i + 1 } })),
        ]);
        return reply({ orderId, number: me.number });
      }
      return error(404, 'NOT_FOUND', 'Ruta no encontrada.');
    } catch (caught) {
      if (isFault(caught) && caught.status < 500) return error(caught.status, caught.code, caught.message);
      return error(503, 'BACKEND_UNAVAILABLE', 'No disponible ahora mismo. Inténtalo de nuevo.');
    }
  }

  return async (request: Request): Promise<Response> => {
    const match = new URL(request.url).pathname.match(/\/api\/v1\/public\/(menu|customer|orders|mine|invitation)\/?$/);
    if (match && ['GET', 'POST', 'OPTIONS'].includes(request.method)) {
      if (request.method === 'OPTIONS') return kit(request);
      return handlePublic(request, match[1]!);
    }
    return kit(request);
  };
}
