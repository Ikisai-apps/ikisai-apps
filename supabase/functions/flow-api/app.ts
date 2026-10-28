/**
 * Ikisai Flow · API (docs/flow/API.md). El núcleo del kit (sesión, bootstrap, sincronización con `core.commit` y los
 * procedimientos `flow.*`, feedback y uso) y las rutas públicas sin sesión de la carta (§6 y §14, FLOW-DIR-001 §1), que se
 * atienden aquí antes de pasar la petición al kit:
 * - `GET public/menu`: la carta (cacheable 30 s).
 * - `POST public/customer`: crea el cliente anónimo; devuelve su token (solo para el navegador) y su número.
 * - `POST public/orders`: envía la cesta como pedido abierto del cliente de la cabecera `X-Flow-Customer`.
 * - `GET public/mine`: los pedidos de ese cliente, y nada más.
 * - `POST public/invitation`: canje del enlace firmado de un huésped o visitante (0910, 0915): rota el token de su cliente.
 * - `POST public/visitor_join` (ruta pública del kit, con `X-Visitor`): número del visitante en la barra de su evento (0915).
 * El token nunca llega a la base de datos: aquí se resume con SHA-256 y solo viaja el resumen. Las escrituras van por la
 * escritura pública del núcleo (actor «Flow (sistema)», lote público que limita `flow.guard`).
 */
import { applyPublicOperations, createApp, createSupabase, fail, isFault, sha256Hex, type AppConfig, type AppRoute, type Operation, type PublicRoute, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
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

/**
 * Freno por IP de la carta pública (FL5): ventana deslizante en memoria de cada instancia de la Edge. Es un freno de más;
 * los topes firmes (por flujo y por cliente) los pone la base de datos (0923). La IP llega del proxy de Pages
 * (`X-Ikisai-Client-Ip`, desde `CF-Connecting-IP`) o, si no, de `X-Forwarded-For`.
 */
const PUBLIC_IP_LIMITS: Record<'customer' | 'orders', { max: number; windowMs: number }> = {
  customer: { max: 10, windowMs: 10 * 60_000 },
  orders: { max: 30, windowMs: 60_000 },
};
const PUBLIC_MESSAGES: Record<string, string> = {
  RATE_LIMITED: 'Demasiados intentos seguidos. Espera un momento y vuelve a probar.',
  TOO_MANY_OPEN_ORDERS: 'Tienes varios pedidos sin cobrar: pásate por la barra antes de pedir más.',
  MENU_CLOSED: 'La barra no está abierta ahora mismo.',
};
export function createIpLimiter(now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (kind: keyof typeof PUBLIC_IP_LIMITS, ip: string | null): boolean => {
    if (!ip) return true;
    const { max, windowMs } = PUBLIC_IP_LIMITS[kind];
    const key = `${kind}:${ip}`;
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t); hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 10 * 60_000)) hits.delete(k);
    return true;
  };
}
const clientIp = (request: Request): string | null =>
  (request.headers.get('x-ikisai-client-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0] ?? '').trim().slice(0, 64) || null;

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
  closure: { id: string; revision: number; project_id: string; day: string; data: DayData };
  project: { id: string; name: string; test_mode: boolean; food_menu_id: string | null; booking_event_id: string | null };
}
interface DayData {
  orders: number; sales_cents: number; sales_by_method: { cash: number; bizum: number; card?: number }; refunds_pending_cents: number;
  units_by_product: Array<{ scope: string; code: string; name: string; units: number; amount_cents: number; source_line_id: string | null }>;
}

/**
 * Cabeceras de servicio de Flow (auditoría 27-10, FL1 y FL2): Finance y Tasks reservan `source_app`/`source: 'flow'` a
 * quien llega con la clave de worker y `X-Ikisai-Caller: flow`. Van además del token de la persona, que sigue decidiendo.
 * Solo a esas dos apps, que son las que las piden.
 */
const SERVICE_IDENTITY_APPS = new Set(['invoices-api', 'tasks-api']);
export function serviceHeaders(workerKey: string | undefined, slug: string): Record<string, string> {
  return workerKey && SERVICE_IDENTITY_APPS.has(slug) ? { 'X-Ikisai-Worker-Key': workerKey, 'X-Ikisai-Caller': 'flow' } : {};
}

/** Llamada a un procedimiento de otra app por su API, con el token de la persona (su acceso decide). */
function appCaller(base: FlowBase, options: FlowAppOptions) {
  const transport = options.appsFetch ?? fetch;
  const apiOf = (slug: string) => `${base.url.replace(/\/$/, '')}/functions/v1/${slug}/api/v1/commands`;
  return async function callApp(ctx: RequestContext, slug: string, label: string, requestId: string, procedure: string, args: unknown) {
    let res: Response;
    try {
      res = await transport(apiOf(slug), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json', ...serviceHeaders(base.workerKey, slug) },
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
  };
}

/**
 * Llegada y salida de huéspedes (check-in, 0911): flow-api comprueba que el flujo es de la persona y que el huésped es
 * de su evento, y llama a booking.guest_arrive / guest_leave por booking-api con su token (editor en Booking).
 */
function checkinRoutes(supabase: Supabase, base: FlowBase, options: FlowAppOptions): AppRoute[] {
  const callApp = appCaller(base, options);
  /** El evento de Booking de un flujo de check-in del ámbito de la persona (si no, PROJECT_OUT_OF_SCOPE / NO_BOOKING_EVENT). */
  async function eventOf(ctx: RequestContext, project: string): Promise<string> {
    if (!UUID.test(project)) fail(422, 'INVALID_OPERATION', 'Identificador no válido.');
    const target = await supabase.rpc<{ booking_event_id: string | null } | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.checkin_target', p_args: { project_id: project } });
    if (!target) fail(403, 'PROJECT_OUT_OF_SCOPE', 'Este flujo no es tuyo: pide acceso a Dirección.');
    if (!target.booking_event_id) fail(409, 'NO_BOOKING_EVENT', 'Este flujo aún no está ligado a su evento de Booking: el encargado lo liga en el Inicio.');
    return target.booking_event_id;
  }
  // Los huéspedes de un evento: booking.flow_guests_of (Booking 0486), que solo responde si el evento está en el ámbito de la
  // persona en Flow (core.reader_in_scope → flow.in_scope, 0916). Con `guest`, solo ese huésped.
  async function guestsOf(ctx: RequestContext, event: string, guest?: string): Promise<{ rows: Array<{ guest_id: string }> }> {
    const out = await supabase.rpc<{ items?: Array<{ guest_id: string }> } | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id,
      p_name: 'booking.flow_guests_of', p_args: { event_id: event } });
    const items = out?.items ?? [];
    return { rows: guest ? items.filter((g) => g.guest_id === guest) : items };
  }
  return [{
    // Los huéspedes del evento de ESTE flujo (la app no lee la proyección de Booking directamente: así solo ve los de sus flujos).
    method: 'GET', pattern: 'checkin/:project/guests', handler: async ({ ctx, params }) => {
      const event = await eventOf(ctx, params.project ?? '');
      return { rows: (await guestsOf(ctx, event))?.rows ?? [] };
    },
  }, {
    method: 'POST', pattern: 'checkin/:project/guests/:guest/:action', handler: async ({ ctx, params, json }) => {
      if (ctx.membership.role !== 'editor' && ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Tu cuenta no puede marcar llegadas ni salidas.');
      const action = params.action === 'arrive' ? 'booking.guest_arrive' : params.action === 'leave' ? 'booking.guest_leave' : null;
      if (!action) fail(404, 'NOT_FOUND', 'Ruta no encontrada.');
      if (!UUID.test(params.guest ?? '')) fail(422, 'INVALID_OPERATION', 'Identificador no válido.');
      const body = (await json().catch(() => ({}))) ?? {};
      const found = await guestsOf(ctx, await eventOf(ctx, params.project ?? ''), params.guest);
      if (!found?.rows?.length) fail(404, 'NOT_FOUND', 'Ese huésped no es de este evento.');
      const undo = body.undo === true;
      return callApp(ctx, 'booking-api', 'Booking', `flow:${params.action}:${params.guest}:${crypto.randomUUID()}`, action, { guest_id: params.guest, ...(undo ? { undo: true } : {}) });
    },
  }];
}

/**
 * Envíos del Cierre del día (contratos con Food y Finance del 26-10): desde aquí, con la sesión de la persona, a la API de
 * cada app (como Central con Tasks). Nunca desde el navegador. Quien envía tiene que ser miembro de esa app: si no, la
 * respuesta lo dice (`NEEDS_ACCESS`). El resultado lo anota el servidor (lote público, solo los campos de envío; FL9).
 */
function closureRoutes(supabase: Supabase, base: FlowBase, options: FlowAppOptions, publicWrite: PublicWriter): AppRoute[] {
  const callApp = appCaller(base, options);

  async function closure(ctx: RequestContext, id: string): Promise<ClosureForSend> {
    if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'El cierre del día lo envía el encargado.');
    const out = await supabase.rpc<ClosureForSend | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.closure_for_send', p_args: { id } });
    if (!out?.closure) fail(404, 'NOT_FOUND', 'Ese cierre no existe.');
    return out;
  }

  const digest = async (value: unknown) => (await sha256Hex(JSON.stringify(value))).slice(0, 24);

  /** Envía y anota el resultado en el cierre (enviado o error). El navegador no puede marcarlo (0927). */
  async function sendAndMark(c: ClosureForSend['closure'], target: 'food' | 'finance', send: () => Promise<unknown>) {
    const mark = (status: string, result: unknown) => publicWrite(supabase, APP, [{ op: 'update', table: TABLES.dayClosures, id: c.id, expectedRevision: c.revision,
      fields: { [`${target}_status`]: status, [`${target}_sent_at`]: new Date().toISOString(), [`${target}_result`]: result } }]);
    let result: unknown;
    try {
      result = await send();
    } catch (error) {
      await mark('error', { code: isFault(error) ? error.code : 'ERROR' }).catch(() => undefined);
      throw error;
    }
    await mark('sent', result ?? null);
    return { status: 'sent', result };
  }

  return [
    {
      // Ventas por línea de la carta de Food (food.record_carta_sales, idempotente por carta y día).
      method: 'POST', pattern: 'closures/:id/send/food', handler: async ({ ctx, params }) => {
        const { closure: c, project } = await closure(ctx, params.id ?? '');
        if (!project.food_menu_id) fail(409, 'NO_FOOD_MENU', 'Este flujo no está ligado a una carta de Food: actualiza la carta desde Food primero.');
        const lines = c.data.units_by_product.filter((u) => u.source_line_id).map((u) => ({ line_id: u.source_line_id, quantity: u.units }));
        const args = { menu_id: project.food_menu_id, day: c.day, lines };
        const requestId = `flow:food:${c.id}:${await digest(args)}`;
        return sendAndMark(c, 'food', () => callApp(ctx, 'food-api', 'Food', requestId, 'food.record_carta_sales', args));
      },
    },
    {
      // Apunte de ingresos del día en Finance (invoices.record_app_entry, idempotente por source_ref). Decisión de VG del
      // 27-10: el cierre es un apunte de PROCESO (informativo), nunca fiscal; lo fiscal es la factura de la caja. Por eso ya
      // no hay «modo pruebas» para Finance: el resumen se manda siempre, como `nature: 'process'`.
      method: 'POST', pattern: 'closures/:id/send/finance', handler: async ({ ctx, params }) => {
        const { closure: c, project } = await closure(ctx, params.id ?? '');
        const [y, m, d] = c.day.split('-');
        const sourceRef = `flow:project:${project.id}:${c.day}`;
        // Un cobro va en un solo apunte (Core/Finance 27-10): lo ya enviado como fiscal (justificantes de la caja, 0917) sale del resumen.
        const fiscal = await supabase.rpc<FiscalOfDay | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.fiscal_of_day', p_args: { project_id: project.id, day: c.day } });
        const fm = fiscal?.methods ?? {};
        const byMethod: Record<string, number> = { cash: c.data.sales_by_method.cash - (fm.cash ?? 0), bizum: c.data.sales_by_method.bizum - (fm.bizum ?? 0) };
        const card = (c.data.sales_by_method.card ?? 0) - (fm.card ?? 0);
        if (card) byMethod.card = card;
        const amount = c.data.sales_cents - (fiscal?.amount_cents ?? 0);
        const other = amount - Object.values(byMethod).reduce((s, v) => s + v, 0);
        if (other) byMethod.bitcoin = other; // lo cobrado en Bitcoin (Lightning u on-chain) que no ha ido como fiscal
        const minus = new Map((fiscal?.detail ?? []).map((x) => [x.code, x]));
        const detail = c.data.units_by_product.map((u) => {
          const f = minus.get(`${u.scope}:${u.code}`);
          return { code: `${u.scope}:${u.code}`, name: u.name, quantity: u.units - (f?.units ?? 0), amount_cents: u.amount_cents - (f?.amount_cents ?? 0) };
        }).filter((x) => x.quantity !== 0 || x.amount_cents !== 0);
        const args = {
          source_app: 'flow', source_ref: sourceRef, kind: 'income', nature: 'process', entry_date: c.day,
          description: `${project.name} · ${d}-${m}-${y}`,
          amount_cents: amount, tax_rate: 10,
          methods: byMethod,
          detail,
          pending_refunds_cents: c.data.refunds_pending_cents,
          event_id: project.booking_event_id,
        };
        const requestId = `flow:${sourceRef}:${await digest(args)}`;
        return sendAndMark(c, 'finance', () => callApp(ctx, 'invoices-api', 'Finance', requestId, 'invoices.record_app_entry', args));
      },
    },
    {
      // «Enviar a Finance» de un justificante de la caja (0917): ESE cobro como apunte fiscal, idempotente por justificante.
      method: 'POST', pattern: 'receipts/:id/send/finance', handler: async ({ ctx, params }) => {
        if (ctx.membership.role !== 'editor' && ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Tu cuenta no puede enviar a Finance.');
        const out = await supabase.rpc<ReceiptForSend | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.receipt_for_send', p_args: { id: params.id } });
        if (!out?.receipt) fail(404, 'NOT_FOUND', 'Ese justificante no existe.');
        const r = out.receipt;
        const [y, m, d] = out.day.split('-');
        const sourceRef = `flow:receipt:${r.id}`;
        const method = r.method === 'btc_ln' || r.method === 'btc_chain' ? 'bitcoin' : r.method;
        const args = {
          source_app: 'flow', source_ref: sourceRef, kind: 'income', nature: 'fiscal', entry_date: out.day,
          description: `${out.project.name} · justificante ${r.id.slice(0, 8)} · ${d}-${m}-${y}`,
          amount_cents: r.total_cents, tax_rate: 10, methods: { [method]: r.total_cents },
          detail: out.detail, pending_refunds_cents: 0, event_id: out.project.booking_event_id,
          // Un cobro de la caja es un ticket de venta (la factura solo la hace Finance), con su número de cobro.
          receipt_kind: 'ticket', ...(out.receipt_number ? { receipt_number: out.receipt_number } : {}),
        };
        // El estado lo anota el servidor (lote público, solo los campos de envío): el navegador no puede marcarlo.
        const mark = (fields: Record<string, unknown>) => publicWrite(supabase, APP, [{ op: 'update', table: TABLES.receipts, id: r.id, expectedRevision: r.revision, fields }]);
        let result: unknown;
        try {
          result = await callApp(ctx, 'invoices-api', 'Finance', `flow:${sourceRef}:${await digest(args)}`, 'invoices.record_app_entry', args);
        } catch (error) {
          await mark({ finance_status: 'error', finance_sent_at: new Date().toISOString(), finance_result: { code: isFault(error) ? error.code : 'ERROR' } }).catch(() => undefined);
          throw error;
        }
        await mark({ finance_status: 'sent', finance_sent_at: new Date().toISOString(), finance_result: result ?? null });
        return { status: 'sent', result };
      },
    },
  ];
}

interface FiscalOfDay { amount_cents: number; methods: Record<string, number>; detail: Array<{ code: string; units: number; amount_cents: number }> }
interface ReceiptForSend {
  receipt: { id: string; revision: number; method: string; total_cents: number; order_ids: string[] };
  project: { id: string; name: string; booking_event_id: string | null };
  day: string;
  /** Números de cobro de sus pedidos («12» o «12+13»), 0921. */
  receipt_number: string | null;
  detail: Array<{ code: string; name: string; quantity: number; amount_cents: number }>;
}

/**
 * «Pedir a Tasks» (contrato de Tasks §39): con la sesión de la persona, a la API de Tasks, como Central. Quien pide tiene
 * que ser editor u owner de Tasks y ver el proyecto. Tasks no avisa de cambios: el estado se consulta al enseñarlo.
 */
function tasksRoutes(supabase: Supabase, options: FlowAppOptions, workerKey: string | undefined, publicWrite: PublicWriter): AppRoute[] {
  const transport = options.appsFetch ?? fetch;
  const env = (name: string) => (globalThis as any).Deno?.env?.get?.(name) as string | undefined;
  const base = (options.tasksApiBase ?? env('IKISAI_TASKS_API_BASE') ?? DEFAULT_TASKS_API_BASE).replace(/\/$/, '');

  /**
   * Anota en la unidad lo que Tasks creó (FL6, 0931): el servidor, con el lote público que solo cambia `payload.external`.
   * El navegador ya no puede marcar una unidad como pedida.
   */
  async function linkUnit(unit: { id: string; revision: number; payload?: Record<string, unknown> | null }, link: Record<string, unknown>): Promise<void> {
    const payload = { ...(unit.payload ?? {}), external: { ...link, at: new Date().toISOString() } };
    await publicWrite(supabase, APP, [{ op: 'update', table: TABLES.units, id: unit.id, expectedRevision: unit.revision, fields: { payload } }]);
  }

  async function tasks<T>(ctx: RequestContext, path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await transport(`${base}/api/v1/${path}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json', ...serviceHeaders(workerKey, 'tasks-api') },
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
            external_url: `${FLOW_ORIGINS[0]}/#/p/${found.project.id}/${COLUMN_SLUGS[found.unit.column_key as string] ?? 'logistica'}`,
            ...(Number.isFinite(quantity) && quantity > 0 ? { quantity, unit: typeof body.unit === 'string' ? body.unit.slice(0, 20) : undefined } : {}),
          });
          const link = { app: 'tasks', kind: 'purchase_request', id: out.purchase.id, status: out.purchase.status };
          await linkUnit(found.unit, link);
          return { created: out.created, link };
        }
        const out = await tasks<{ created: boolean; task: { id: string; done?: boolean } }>(ctx, 'requests/task', {
          source: 'flow', kind: 'flow.logistics', kind_label: 'Logística de la barra', external_ref: found.unit.id,
          title: String(found.unit.label ?? '').slice(0, 300), note, project_id: found.project.tasks_project_id, priority,
        });
        const link = { app: 'tasks', kind: 'task', id: out.task.id, status: out.task.done ? 'done' : 'open' };
        await linkUnit(found.unit, link);
        return { created: out.created, link };
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

/**
 * Visitante por QR (FL2, 0915): número de cliente en la barra del evento (la que atiende la carta), una vez por visitante.
 * El cliente lo crea el lote público firmado por el visitante (flow.guard lo exige así). Devuelve «Mi pedido».
 */
/**
 * «Alójate aquí» (0936): liga el cliente web de la carta (`X-Flow-Customer`) al visitante del kit (`X-Visitor`), para que
 * «Mi pedido» siga a la misma persona en ven.ikisai.com. Una vez; si ya tiene visitante o el visitante ya tiene cliente en
 * ese flujo, no cambia nada.
 */
function customerVisitorRoute(): PublicRoute {
  return {
    method: 'POST', pattern: 'customer_visitor', handler: async ({ request, visitor, apply, read }) => {
      if (!visitor) fail(401, 'VISITOR_REQUIRED', 'Falta el visitante.');
      const token = (request.headers.get(CUSTOMER_HEADER) ?? '').trim().toLowerCase();
      if (!TOKEN.test(token)) fail(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
      const c = await read('flow_customer_for_link', { token_hash: await sha256Hex(token) }) as { customerId?: string; revision?: number; origin?: string; visitorId?: string | null } | null;
      if (!c?.customerId) fail(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
      if (c.origin !== 'web' || c.visitorId) return { linked: c.visitorId === visitor.id };
      try {
        await apply([{ op: 'update', table: TABLES.customers, id: c.customerId, expectedRevision: c.revision, fields: { visitor_id: visitor.id } }]);
      } catch (error) {
        // Ese visitante ya tiene cliente en el flujo (índice único): se queda como está.
        if (isFault(error) && (error.status === 409 || error.code === 'CONSTRAINT_VIOLATION')) return { linked: false };
        throw error;
      }
      return { linked: true };
    },
  };
}

function visitorJoinRoute(): PublicRoute {
  return {
    method: 'POST', pattern: 'visitor_join', handler: async ({ json, visitor, apply, read }) => {
      if (!visitor) fail(401, 'VISITOR_REQUIRED', 'Abre la carta desde el QR del evento.');
      const body = (await json().catch(() => ({}))) ?? {};
      const code = typeof body.event_code === 'string' ? body.event_code.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(code)) fail(422, 'INVALID_OPERATION', 'Código de evento no válido.');
      const target = await read('flow_visitor_target', { event_code: code }) as { projectId?: string | null; customerId?: string | null } | null;
      if (!target?.projectId) fail(404, 'NO_FLOW', 'Este evento no tiene la barra abierta ahora mismo.');
      if (!target.customerId) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        try {
          await apply([{ op: 'insert', table: TABLES.customers, id: crypto.randomUUID(), fields: { project_id: target.projectId, token_hash: await sha256Hex(token), origin: 'visitor', visitor_id: visitor.id } }]);
        } catch (error) {
          // Dos toques a la vez: el otro ya lo creó (índice único por flujo y visitante).
          if (!(isFault(error) && error.status === 409) && !(isFault(error) && error.code === 'CONSTRAINT_VIOLATION')) throw error;
        }
      }
      return read('flow_visitor_customer', { event_code: code });
    },
  };
}

/**
 * Capacidades que Flow ofrece a otras apps (catálogo del núcleo, 0920): `flow.day_summary` (lectura, owner) y
 * `flow.logistics_task` (crear una tarea de Logística; idempotente por requestId). Las invoca la Edge de quien las ofrece
 * con el token de la persona: su rol y su ámbito en Flow deciden.
 */
function capabilityRoutes(supabase: Supabase): AppRoute[] {
  return [
    {
      method: 'POST', pattern: 'day-summary', handler: async ({ ctx, json }) => {
        const body = (await json().catch(() => ({}))) ?? {};
        return supabase.rpc('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.day_summary_read', p_args: { project_id: body.project_id, day: body.day } });
      },
    },
    {
      // Cobertura (0946): anclajes de los pasos publicados y reglas de Flow, para el Revisor de Central. Solo metadatos.
      method: 'POST', pattern: 'anchor-coverage', handler: async ({ ctx, json }) => {
        const body = (await json().catch(() => ({}))) ?? {};
        const app = typeof body.app === 'string' && /^[a-z][a-z0-9_]{1,30}$/.test(body.app) ? body.app : null;
        return supabase.rpc('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.anchor_coverage_read', p_args: app ? { app } : {} });
      },
    },
    {
      // Guiado (0940): los pasos de una ejecución que tocan a una app, con ruta y confirmación de cada anclaje (lectura por id de
      // campo del núcleo, 0109). Solo quien hace la ejecución. Sin la lectura del núcleo, sin ruta (el kit dice «no lo encuentro»).
      method: 'POST', pattern: 'guide-read', handler: async ({ ctx, json }) => {
        const body = (await json().catch(() => ({}))) ?? {};
        if (typeof body.execution_id !== 'string' || !UUID.test(body.execution_id)) fail(422, 'INVALID_OPERATION', 'execution_id inválido.');
        const app = typeof body.app === 'string' && /^[a-z][a-z0-9_]{1,30}$/.test(body.app) ? body.app : null;
        if (!app) fail(422, 'INVALID_OPERATION', 'app inválida.');
        const out = await supabase.rpc<{ id: string; title: string; mode: string; status: string; steps: Array<Record<string, any>> }>('core_read',
          { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.guide_steps_read', p_args: { execution_id: body.execution_id, app } });
        const anchors = [...new Set(out.steps.map((s) => s.anchor).filter((x): x is string => !!x))].slice(0, 200);
        let fields: Array<{ fieldId: string; route?: string | null; confirm?: string | null }> = [];
        if (anchors.length) {
          try { fields = (await supabase.rpc<Array<{ fieldId: string; route?: string | null; confirm?: string | null }> | null>('core_field_lookup', { p_actor: ctx.user.id, p_field_ids: anchors })) ?? []; }
          catch { fields = []; }
        }
        const byId = new Map(fields.map((f) => [f.fieldId, f]));
        return { id: out.id, title: out.title, mode: out.mode, status: out.status, steps: out.steps.map((s) => {
          const f = s.anchor ? byId.get(s.anchor) : undefined;
          const confirm = !s.anchor ? 'manual' : (['save', 'event', 'manual', 'none'].includes(String(f?.confirm)) ? f!.confirm : 'manual');
          return { id: s.id, title: s.title, explain: s.explain ?? null, anchor: s.anchor ?? null, route: f?.route ?? null, confirm, done: !!s.done, essential: !!s.essential, app: s.app ?? null, stage: s.stage };
        }) };
      },
    },
    {
      // Guiado (0940): recibo de que la app confirmó un paso; nunca valores. Idempotente por requestId (recibo del núcleo).
      method: 'POST', pattern: 'guide-confirm', handler: async ({ ctx, json }) => {
        const body = (await json().catch(() => ({}))) ?? {};
        const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? body.requestId : null;
        if (!requestId) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        const args = { execution_id: body.execution_id, step_id: body.step_id, how: body.how, pending: body.pending === true };
        const operations = [{ op: 'call', procedure: 'flow.guide_confirm', args }];
        const out = await supabase.rpc<{ replayed?: boolean }>('core_commit', { p_app: ctx.app, p_actor: ctx.user.id, p_request_id: `cap:${requestId}`,
          p_digest: await sha256Hex(JSON.stringify(args)), p_expected_cursor: null, p_operations: operations, p_confirmation: null });
        return { ok: true, replayed: !!out?.replayed };
      },
    },
    {
      // «Avance» (0938): crear o cambiar una tarjeta en el carril de quien llama (el guard comprueba scopes.lanes).
      // Idempotente por requestId (recibo del núcleo por persona); el id de una tarjeta nueva lo pone la Edge.
      method: 'POST', pattern: 'board-card', handler: async ({ ctx, json }) => {
        if (!['editor', 'owner', 'outsider'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Tu cuenta no puede escribir en el Avance.');
        const body = (await json().catch(() => ({}))) ?? {};
        const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? body.requestId : null;
        if (!requestId) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        const KEYS = ['project_id', 'card_id', 'lane_key', 'title', 'status', 'prio', 'flag', 'kind', 'tipo', 'order', 'ref', 'url', 'url_text', 'steps', 'note'];
        const args: Record<string, unknown> = Object.fromEntries(KEYS.filter((k) => k in body).map((k) => [k, body[k]]));
        if (!args.card_id) args.card_id = crypto.randomUUID();
        const operations = [{ op: 'call', procedure: 'flow.board_card', args }];
        const { card_id: _new, ...digestOf } = args;
        const out = await supabase.rpc<{ replayed?: boolean; results?: Array<{ result?: { card_id?: string; created?: boolean } }> }>('core_commit', {
          p_app: ctx.app, p_actor: ctx.user.id, p_request_id: `cap:${requestId}`,
          p_digest: await sha256Hex(JSON.stringify(body.card_id ? args : digestOf)), p_expected_cursor: null, p_operations: operations, p_confirmation: null });
        const result = out?.results?.[0]?.result ?? {};
        return { card_id: result.card_id ?? null, created: !!result.created, replayed: !!out?.replayed };
      },
    },
    {
      method: 'POST', pattern: 'logistics-task', handler: async ({ ctx, json }) => {
        const body = (await json().catch(() => ({}))) ?? {};
        const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? body.requestId : null;
        if (!requestId) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        if (typeof body.project_id !== 'string' || !UUID.test(body.project_id)) fail(422, 'INVALID_OPERATION', 'project_id inválido.');
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 120) : '';
        if (!label) fail(422, 'INVALID_OPERATION', 'Falta el texto de la tarea.');
        // Lo que declara la capacidad: editor u owner, y el proyecto en su ámbito (FL7).
        if (ctx.membership.role !== 'editor' && ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Tu cuenta no puede crear tareas de Logística.');
        const access = await supabase.rpc<{ in_scope?: boolean } | null>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'flow.project_access_read', p_args: { project_id: body.project_id } });
        if (!access?.in_scope) fail(403, 'PROJECT_OUT_OF_SCOPE', 'Ese flujo no está en tu ámbito.');
        // Id aleatorio (nadie puede ocuparlo antes); repetir la petición devuelve la misma tarea por el recibo del núcleo,
        // que es de la persona y del requestId.
        const fields = { project_id: body.project_id, column_key: 'logistics', kind: 'task', label, priority: body.priority === true };
        const operations = [{ op: 'insert', table: TABLES.units, id: crypto.randomUUID(), fields }];
        const out = await supabase.rpc<{ replayed?: boolean; results?: Array<{ id?: string }> }>('core_commit', { p_app: ctx.app, p_actor: ctx.user.id, p_request_id: `cap:${requestId}`,
          p_digest: await sha256Hex(JSON.stringify(fields)), p_expected_cursor: null, p_operations: operations, p_confirmation: null });
        const id = out?.results?.[0]?.id ?? operations[0]!.id;
        return { id, replayed: !!out?.replayed };
      },
    },
  ];
}

export function createFlowApp(base: FlowBase, options: FlowAppOptions = {}) {
  const origins = base.origins ?? FLOW_ORIGINS;
  const supabase = createSupabase(base);
  // Acceso por proyecto (0902): cada persona solo sincroniza las filas de sus proyectos; el owner, todas.
  const publicWrite: PublicWriter = options.publicWrite ?? ((db, app, operations) => applyPublicOperations(db, app, operations as Parameters<typeof applyPublicOperations>[2]));
  const kit = createApp({ ...base, app: APP, slug: 'flow-api', origins, routes: [...closureRoutes(supabase, base, options, publicWrite), ...tasksRoutes(supabase, options, base.workerKey, publicWrite), ...checkinRoutes(supabase, base, options), ...capabilityRoutes(supabase)], uploads: FLOW_UPLOADS,
    publicRoutes: [visitorJoinRoute(), customerVisitorRoute()],
    hooks: { visible: (table, row, ctx) => visibleRow(table, row, ctx.membership),
      // FL3: los `call` del historial (argumentos y resultado: nombres de huéspedes, titulares de cuentas…) solo los ve el
      // owner y quien hizo la llamada; los demás miembros no los reciben.
      visibleCall: (change, ctx) => ctx.membership.role === 'owner' || change.actorId === ctx.user.id,
      beforeCommit: (operations, ctx) => checkFiles(supabase, operations, ctx) } });

  const ipAllowed = createIpLimiter();
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
        const out = await supabase.rpc<{ project: string | null; products: unknown[]; eventCode?: string | null } | null>('core_public_read', { p_name: PUBLIC_MENU, p_args: {} });
        // «Alójate aquí» (0936): solo si el evento del flujo admite alojamiento según Booking. Si Booking no responde, sin enlace.
        // `eventCode` (URLS_ENTRADA, 27-10): el de ven.ikisai.com/e/<código>, solo si el evento sale abierto en Booking, para
        // «Seguir» con el siguiente recorrido.
        let lodging: { eventCode: string } | null = null;
        let eventCode: string | null = null;
        if (out?.eventCode) {
          const events = await supabase.rpc<{ items?: Array<{ code: string; lodging?: boolean }> } | null>('core_public_read', { p_name: 'booking_public_events', p_args: {} }).catch(() => null);
          const event = events?.items?.find((e) => e.code === out.eventCode);
          if (event) eventCode = out.eventCode;
          if (event?.lodging) lodging = { eventCode: out.eventCode };
        }
        return reply({ project: out?.project ?? null, products: Array.isArray(out?.products) ? out.products : [], lodging, eventCode }, 200, { 'Cache-Control': 'public, max-age=30' });
      }
      if (route === 'mine' && request.method === 'GET') {
        const hash = await customerHash();
        if (!hash) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        const out = await mine(hash);
        if (!out?.customerId) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        return reply({ number: out.number, orders: out.orders ?? [] });
      }
      if (route === 'customer' && request.method === 'POST') {
        if (!ipAllowed('customer', clientIp(request))) return error(429, 'RATE_LIMITED', PUBLIC_MESSAGES.RATE_LIMITED!);
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
        const link = invitation ? await supabase.rpc<{ customerId?: string; revision?: number; number?: number; expired?: boolean; used?: boolean } | null>('core_public_read', { p_name: PUBLIC_GUEST_LINK, p_args: { invitation } }) : null;
        if (link?.used) return error(410, 'INVITATION_USED', 'Ese enlace ya se ha usado. Ábrelo otra vez desde la app de huéspedes.');
        if (link?.expired) return error(410, 'INVITATION_EXPIRED', 'Ese enlace ha caducado. Ábrelo otra vez desde la app de huéspedes.');
        if (!link?.customerId) return error(404, 'INVITATION_INVALID', 'Ese enlace no vale. Pide uno nuevo en la app de huéspedes.');
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        await publicWrite(supabase, APP, [{ op: 'update', table: TABLES.customers, id: link.customerId, expectedRevision: link.revision, fields: { token_hash: await sha256Hex(token) } }]);
        return reply({ token, number: link.number ?? null });
      }
      if (route === 'orders' && request.method === 'POST') {
        if (!ipAllowed('orders', clientIp(request))) return error(429, 'RATE_LIMITED', PUBLIC_MESSAGES.RATE_LIMITED!);
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
      if (isFault(caught) && caught.status < 500) return error(caught.status, caught.code, PUBLIC_MESSAGES[caught.code] ?? caught.message);
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
