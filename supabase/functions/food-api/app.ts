/** Ikisai Food · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { afterCartaSales, syncCartaStock } from './carta.ts';
import { FOOD_SERVICE, runConsumptionTick, stableUuid } from './consumption.ts';
import { createApp, createSupabase, ensureServiceActor, fail, isFault, sha256Hex, stable, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import {
  eventSnapshot, FOOD_PROCEDURES, isHouseMenu, menuWarnings, PHOTO_MAX_BYTES, PHOTO_MIME, RECIPE_FILE_FIELDS, requiredAcknowledgements, validateOperations,
  copyCartaOperations, defaultOfferFields, dayBefore, eventPurchaseRef, eventPurchaseTitle, itemStatusFromPurchase, unrequestedQuantity,
  type EventShopping, type EventShoppingRow, type AcknowledgedWarning, type CartaLine, type FoodEvent, type Menu, type MenuGraph,
} from '../_domain/food/mod.ts';

export const FOOD_ORIGINS = ['https://food.ikisai.com', 'https://ikisai-food.pages.dev'];
import { runEquipmentTick } from './equipment.ts';
import { stockRoutes } from './stock.ts';

export const DEFAULT_TASKS_API_BASE = 'https://tasks.ikisai.com';

export interface FoodAppOptions {
  /** Base de la API de Tasks para las peticiones de §6.1 (en pruebas, una falsa). */
  tasksApiBase?: string;
  tasksFetch?: typeof fetch;
  /** Para bajar de Flow la imagen de una línea de la carta (`carta/image`); en pruebas, una falsa. */
  flowFetch?: typeof fetch;
  /**
   * Clave de worker (`IKISAI_WORKER_KEY`) para que Tasks sepa que la fuente `food` la manda el servidor de Food
   * (auditoría FO2; Tasks #852, API §45). Si no se da, la de `base.workerKey`.
   */
  workerKey?: string;
}

const FAULT_STATUSES: Record<string, { title: string; priority: 'normal' | 'high' }> = {
  limitado: { title: 'Revisar', priority: 'normal' },
  averiado: { title: 'Reparar', priority: 'high' },
  fuera_de_servicio: { title: 'Reparar', priority: 'high' },
};

export const FOOD_UPLOADS: UploadsConfig = { bucket: 'kitchen-media', maxBytes: PHOTO_MAX_BYTES, allowedMime: [...PHOTO_MIME] };

const EVENT_PROJECTION = 'booking.food_event_projection';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Lectura de eventos como lectura registrada del núcleo (contrato §5.1). Food nunca recibe huéspedes. */
function createEventReader(supabase: Supabase) {
  async function read(ctx: RequestContext, where?: Record<string, string>): Promise<FoodEvent[]> {
    const out = await supabase.rpc<{ rows: FoodEvent[] }>('core_read', {
      p_app: ctx.app, p_actor: ctx.user.id, p_name: EVENT_PROJECTION, p_args: { ...(where ? { where } : {}), limit: 2000 },
    });
    return out.rows;
  }

  return {
    list: (ctx: RequestContext) => read(ctx),
    async get(ctx: RequestContext, id: string): Promise<FoodEvent | null> {
      if (!UUID.test(id)) return null;
      return (await read(ctx, { event_id: id.toLowerCase() }))[0] ?? null;
    },
  };
}
type EventReader = ReturnType<typeof createEventReader>;

/** Una foto de receta debe ser un archivo de Food ya verificado y con tipo de imagen admitido. */
async function checkRecipePhotos(supabase: Supabase, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    if (op.table !== 'food.recipes' || !op.fields) continue;
    for (const field of RECIPE_FILE_FIELDS) {
      const id = op.fields[field];
      if (typeof id !== 'string') continue;
      let file: { status: string; mime: string };
      try {
        file = await supabase.rpc('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
      } catch (error) {
        if (isFault(error) && error.code === 'FILE_NOT_FOUND') fail(422, 'INVALID_FILE', 'La foto no existe o no pertenece a Food.', { index, field });
        throw error;
      }
      if (file.status !== 'verified') fail(422, 'INVALID_FILE', 'La foto todavía no se ha subido por completo.', { index, field });
      if (!(PHOTO_MIME as readonly string[]).includes(file.mime)) fail(422, 'INVALID_FILE', 'La foto debe ser una imagen WebP o JPEG.', { index, field, mime: file.mime });
    }
  }
}

/**
 * Un menú de retiro nace contra un evento que existe y contra una revisión que el evento ya ha alcanzado. El de casa no
 * tiene evento. Una carta puede no tenerlo; si se liga a uno (al crearla o después), el evento tiene que existir.
 */
async function checkNewMenus(events: EventReader, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    if (op.table !== 'food.menus' || !op.fields) continue;
    if (op.op === 'update' && typeof op.fields.event_id === 'string' && !(await events.get(ctx, op.fields.event_id))) {
      fail(422, 'EVENT_NOT_FOUND', 'El evento no existe o ya no está disponible para cocina.', { index, event_id: op.fields.event_id });
    }
    if (op.op !== 'insert' || op.fields.kind === 'casa') continue;
    if (op.fields.kind === 'carta') {
      if (typeof op.fields.event_id === 'string' && !(await events.get(ctx, op.fields.event_id))) {
        fail(422, 'EVENT_NOT_FOUND', 'El evento no existe o ya no está disponible para cocina.', { index, event_id: op.fields.event_id });
      }
      continue;
    }
    const event = await events.get(ctx, String(op.fields.event_id));
    if (!event) fail(422, 'EVENT_NOT_FOUND', 'El evento no existe o ya no está disponible para cocina.', { index, event_id: op.fields.event_id });
    if ((op.fields.source_event_revision as number) > event.event_revision) {
      fail(422, 'INVALID_FIELDS', 'La revisión del evento es posterior a la actual.', { index, field: 'source_event_revision', currentRevision: event.event_revision });
    }
  }
}

/**
 * Revisar un cambio del evento o validar el menú: la revisión y la foto del evento que envía el cliente deben ser
 * las actuales de la proyección y, al validar, los avisos aceptados deben cubrir todos los que lo exigen.
 * Las migraciones de Food no pueden leer la proyección de Booking; por eso se comprueba aquí y no en el procedimiento.
 */
async function checkMenuCalls(supabase: Supabase, events: EventReader, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    if (op.op !== 'call' || (op.procedure !== FOOD_PROCEDURES.acknowledgeEvent && op.procedure !== FOOD_PROCEDURES.validateMenu)) continue;
    const args = op.args ?? {};
    const graph = await supabase.rpc<MenuGraph & { menu: Menu | null }>('core_read', {
      p_app: ctx.app, p_actor: ctx.user.id, p_name: 'food.menu_graph', p_args: { menu_id: args.menu_id },
    });
    if (!graph.menu) fail(422, 'MENU_NOT_FOUND', 'El menú no existe o está en la papelera.', { index, menu_id: args.menu_id });
    if (graph.menu.kind === 'carta') fail(422, 'CARTA_MENU', 'Una carta no se revisa ni se valida.', { index, menu_id: args.menu_id, action: 'status' });
    if (isHouseMenu(graph.menu) || !graph.menu.event_id) fail(422, 'HOUSE_MENU', 'El menú de casa no tiene evento: no se revisa ni se valida.', { index, menu_id: args.menu_id, action: 'status' });
    const event = await events.get(ctx, graph.menu.event_id);
    if (!event) fail(422, 'EVENT_NOT_FOUND', 'El evento no existe o ya no está disponible para cocina.', { index, event_id: graph.menu.event_id });
    if (args.event_revision !== event.event_revision || stable(args.event_snapshot) !== stable(eventSnapshot(event))) {
      fail(422, 'EVENT_CHANGED', 'La información del evento ha cambiado. Revísala antes de continuar.', { index, currentRevision: event.event_revision, event });
    }
    if (op.procedure !== FOOD_PROCEDURES.validateMenu) continue;
    const warnings = menuWarnings(event, graph);
    const accepted = new Set((args.acknowledged as AcknowledgedWarning[]).map((w) => w.key));
    const missing = requiredAcknowledgements(warnings).filter((key) => !accepted.has(key));
    if (missing.length) {
      fail(422, 'MENU_WARNINGS_UNACKNOWLEDGED', 'Hay avisos de restricciones sin aceptar.', { index, missing, warnings });
    }
  }
}

function dateParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return null;
  if (!DATE.test(value)) fail(422, 'INVALID_FILTER', `Parámetro ${name} inválido.`);
  return value;
}

function eventRoutes(events: EventReader): AppRoute[] {
  return [
    {
      // scope=upcoming (por defecto): eventos que terminan desde hace siete días en adelante. scope=all: todos.
      method: 'GET', pattern: 'events', handler: async ({ ctx, url }) => {
        const scope = url.searchParams.get('scope') ?? 'upcoming';
        if (scope !== 'upcoming' && scope !== 'all') fail(422, 'INVALID_FILTER', 'Parámetro scope inválido.');
        const now = new Date();
        const from = dateParam(url, 'from') ?? (scope === 'upcoming' ? new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10) : null);
        const to = dateParam(url, 'to');
        const rows = (await events.list(ctx))
          .filter((e) => (!from || e.end_date >= from) && (!to || e.start_date <= to))
          .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.event_id.localeCompare(b.event_id));
        return { events: rows, serverTime: now.toISOString() };
      },
    },
    {
      method: 'GET', pattern: 'events/:id', handler: async ({ ctx, params }) => {
        const event = await events.get(ctx, params.id ?? '');
        if (!event) fail(404, 'NOT_FOUND', 'No se encontró el evento.');
        return { event };
      },
    },
  ];
}

/**
 * Llamada a Tasks con el token de la persona (como Central, docs/tasks/API.md §19.6 y §20) y la prueba de que viene del
 * servidor de Food: `X-Ikisai-Worker-Key` y `X-Ikisai-Caller: food` (auditoría FO2; Tasks #852). Un navegador no tiene la
 * clave, así que nadie más puede pedir con `source: 'food'`.
 */
function createTasksClient(options: FoodAppOptions) {
  const base = (options.tasksApiBase ?? DEFAULT_TASKS_API_BASE).replace(/\/$/, '');
  const transport = options.tasksFetch ?? fetch;
  return async function call<T>(ctx: RequestContext, path: string, body: unknown, method: 'POST' | 'GET' = 'POST'): Promise<T> {
    let response: Response;
    try {
      response = await transport(`${base}/api/v1/${path}`, {
        method,
        headers: { Authorization: 'Bearer ' + ctx.token, 'X-Ikisai-Worker-Key': options.workerKey ?? '', 'X-Ikisai-Caller': 'food', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail(503, 'TASKS_UNAVAILABLE', 'Tasks no responde ahora mismo. Inténtalo más tarde.');
    }
    const out = await response.json().catch(() => ({})) as any;
    if (response.status === 401 || response.status === 403) fail(403, 'TASKS_FORBIDDEN', 'Tu cuenta no puede pedir tareas en Tasks.', { error: out?.error ?? null });
    if (response.status >= 400 && response.status < 500) fail(422, 'TASKS_REJECTED', out?.error?.message ?? 'Tasks no ha aceptado la petición.', { error: out?.error ?? null });
    if (!response.ok) fail(503, 'TASKS_UNAVAILABLE', 'Tasks no responde ahora mismo. Inténtalo más tarde.', { status: response.status });
    return out as T;
  };
}

/** Hoy en hora de Madrid (AAAA-MM-DD). */
function madridToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Uuid v4 fijo para un texto: el aviso de una máquina en un día tiene siempre la misma fila. */
async function fixedId(text: string): Promise<string> {
  const hex = (await sha256Hex(text)).slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Tanda 27: deja constancia del aviso en `food.equipment_notices` (1104), como quien avisa, para que «Avisado» sea un
 * dato del servidor y lo vean todos los dispositivos. Una fila por máquina y día, con id fijo: repetir no duplica. Si no
 * se puede anotar (la máquina no está en Food, o falla la base), el aviso a Tasks ya salió y no se deshace: `recorded: false`.
 * Lo anota la cuenta de servicio `food` (auditoría FO3, 1119): ninguna persona escribe avisos.
 */
async function recordNotice(supabase: Supabase, equipmentId: string, day: string, status: string, taskId: string): Promise<boolean> {
  const ref = `equipment_fault:${equipmentId}:${day}`;
  const operations = [{ op: 'insert', table: 'food.equipment_notices', id: await fixedId(`ikisai-food-notice:${ref}`),
    fields: { equipment_id: equipmentId, notified_on: day, equipment_status: status, task_id: taskId } }];
  try {
    const actor = await ensureServiceActor(supabase, FOOD_SERVICE);
    await supabase.rpc('core_commit', {
      p_app: 'food', p_actor: actor, p_request_id: `notice:${ref}`, p_digest: await sha256Hex(stable(operations)),
      p_expected_cursor: null, p_operations: operations, p_confirmation: null,
    });
    return true;
  } catch (error) {
    // Ya anotado hoy (otra persona, o un reintento con otra tarea): cuenta como anotado.
    if (isFault(error) && ['ROW_EXISTS', 'CONSTRAINT_VIOLATION', 'IDEMPOTENCY_REUSE'].includes(error.code)) return true;
    return false;
  }
}

/**
 * Tanda 27 · votos a las sugerencias de plato (1103). Vota cualquiera de la cocina, también quien solo lee: la ruta de
 * comandos del núcleo no deja escribir al lector, así que esta llama solo a `food.vote_suggestion`, como quien vota.
 * Cuerpo: `{ requestId, suggestionId, vote: 'keep' | 'drop' | null }` (null quita el voto). Necesita red.
 */
function voteRoutes(supabase: Supabase): AppRoute[] {
  return [{
    method: 'POST', pattern: 'suggestion-votes', handler: async ({ ctx, json }) => {
      if (!['reader', 'editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo vota la gente de la cocina.');
      const body = ((await json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? body.requestId : fail(422, 'INVALID_OPERATION', 'requestId inválido.');
      const suggestionId = typeof body.suggestionId === 'string' && UUID.test(body.suggestionId) ? body.suggestionId : fail(422, 'INVALID_OPERATION', 'Sugerencia no válida.');
      if (body.vote !== null && body.vote !== 'keep' && body.vote !== 'drop') fail(422, 'INVALID_OPERATION', 'El voto es keep, drop o null.');
      const operations = [{ op: 'call', procedure: 'food.vote_suggestion', args: { suggestion_id: suggestionId, vote: body.vote } }];
      const out = await supabase.rpc<{ cursor: number }>('core_commit', {
        p_app: 'food', p_actor: ctx.user.id, p_request_id: `vote:${requestId}`, p_digest: await sha256Hex(stable(operations)),
        p_expected_cursor: null, p_operations: operations, p_confirmation: null,
      });
      return { cursor: out?.cursor ?? null, suggestionId, vote: body.vote };
    },
  }];
}

/**
 * La carta (1109): `POST carta/stock {menuId, day}` vuelve a dejar el stock de Recursos como dicen las ventas de ese
 * día. Lo hace solo tras registrar las ventas; esta ruta es para reintentarlo si entonces falló. Editor u owner.
 */
/**
 * `GET carta/image?key=<clave>`: la imagen grande de una línea de la carta, que sirve Flow (assets de VG), para guardarla
 * como foto de su receta (VG, 28-10: que no se pierda si la carta cambia). Flow no la sirve con CORS: la baja el
 * servidor y la devuelve en base64; la app la sube como cualquier foto. Editor u owner.
 */
const CARTA_IMAGE_KEY = /^[a-z0-9_]{1,40}\/[a-z0-9_]{1,40}$/;
function cartaImageRoutes(options: FoodAppOptions): AppRoute[] {
  return [{
    method: 'GET', pattern: 'carta/image', handler: async ({ ctx, url }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo quien edita puede guardar la foto.');
      const key = url.searchParams.get('key') ?? '';
      if (!CARTA_IMAGE_KEY.test(key)) fail(422, 'INVALID_OPERATION', 'Imagen no válida.');
      const res = await (options.flowFetch ?? fetch)(`https://flow.ikisai.com/assets/${key}/zoom.webp`);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) fail(404, 'NOT_FOUND', 'Flow no tiene esa imagen.');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > 5_000_000) fail(413, 'PAYLOAD_TOO_LARGE', 'La imagen es demasiado grande.');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { contentType: type, data: btoa(binary) };
    },
  }];
}

function cartaRoutes(supabase: Supabase, events: EventReader): AppRoute[] {
  return [{
    /**
     * «Usar en otro evento» como capacidad del núcleo (`food.use_carta_in_event`, 1113): copia la carta con sus líneas y,
     * con evento, le crea su oferta. Ids estables por `requestId`: repetir la llamada devuelve el recibo, la misma copia.
     */
    method: 'POST', pattern: 'carta/:id/use-in-event', handler: async ({ ctx, params, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo quien edita puede copiar una carta.');
      const sourceId = UUID.test(params.id ?? '') ? params.id!.toLowerCase() : fail(422, 'INVALID_OPERATION', 'Carta no válida.');
      const body = ((await json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? body.requestId : fail(422, 'INVALID_OPERATION', 'requestId inválido.');
      const eventId = body.eventId === undefined || body.eventId === null ? null
        : typeof body.eventId === 'string' && UUID.test(body.eventId) ? body.eventId.toLowerCase() : fail(422, 'INVALID_OPERATION', 'Evento no válido.');
      if (eventId && !(await events.get(ctx, eventId))) fail(422, 'EVENT_NOT_FOUND', 'El evento no existe o ya no está disponible para cocina.', { event_id: eventId });
      const source = await supabase.rpc<{ menu: Menu & { prep_split?: unknown }; lines: CartaLine[] }>('core_read', {
        p_app: 'food', p_actor: ctx.user.id, p_name: 'food.carta_copy_source', p_args: { menu_id: sourceId },
      });
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : `${source.menu.name ?? 'Carta'} (copia)`;
      const newId = await stableUuid(`food-carta-use:${ctx.user.id}:${requestId}:menu`);
      const lineIds = await Promise.all(source.lines.map((l) => stableUuid(`food-carta-use:${ctx.user.id}:${requestId}:${l.id}`)));
      let n = 0;
      const ops = copyCartaOperations({ lines: source.lines, sourceId, newId, name, eventId, newLineId: () => lineIds[n++]!, prepSplit: (source.menu.prep_split as never) ?? null }) as Operation[];
      const offerId = eventId ? await stableUuid(`food-carta-use:${ctx.user.id}:${requestId}:offer`) : null;
      if (eventId) ops.push({ op: 'insert', table: 'food.event_offers', id: offerId!, fields: defaultOfferFields({ id: newId, kind: 'carta', name }, eventId) } as Operation);
      const issue = validateOperations(ops);
      if (issue) fail(422, issue.code, issue.message, issue.details);
      // ¿Ya se hizo con este requestId? (el núcleo devuelve el recibo sin repetir nada; aquí solo se dice).
      const replayed = await supabase.rpc('core_read', { p_app: 'food', p_actor: ctx.user.id, p_name: 'food.carta_copy_source', p_args: { menu_id: newId } })
        .then(() => true, () => false);
      await supabase.rpc('core_commit', {
        p_app: 'food', p_actor: ctx.user.id, p_request_id: `carta-use:${requestId}`, p_digest: await sha256Hex(stable(ops)),
        p_expected_cursor: null, p_operations: ops, p_confirmation: null,
      });
      return { menuId: newId, name, lines: source.lines.length, eventId, offerId, replayed };
    },
  }, {
    method: 'POST', pattern: 'carta/stock', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo quien edita puede ajustar el stock de la carta.');
      const body = ((await json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const menuId = typeof body.menuId === 'string' && UUID.test(body.menuId) ? body.menuId.toLowerCase() : fail(422, 'INVALID_OPERATION', 'Carta no válida.');
      const day = typeof body.day === 'string' && DATE.test(body.day) ? body.day : fail(422, 'INVALID_DAY', 'Día no válido.');
      return syncCartaStock(supabase, menuId, day);
    },
  }];
}

function tasksRoutes(supabase: Supabase, options: FoodAppOptions): AppRoute[] {
  const tasks = createTasksClient(options);
  return [{
    // Avisa a Tasks de una máquina averiada, limitada o fuera de servicio (API.md §6.1). Necesita red. Una petición por
    // máquina y día: `external_ref` = `equipment_fault:<id>:<día>`, así que repetir el aviso el mismo día no duplica la tarea.
    method: 'POST', pattern: 'equipment/:id/fault', handler: async ({ ctx, params, json }) => {
      if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', 'Solo quien edita puede avisar de una avería.');
      const id = params.id ?? '';
      if (!UUID.test(id)) fail(422, 'INVALID_OPERATION', 'Máquina no válida.');
      const body = ((await json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const status = typeof body.status === 'string' ? body.status : '';
      const location = typeof body.location === 'string' ? body.location.trim() : '';
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      const fault = FAULT_STATUSES[status];
      if (!name || name.length > 120 || !fault || location.length > 200 || note.length > 2000) fail(422, 'INVALID_OPERATION', 'Nombre, estado o nota no válidos.');
      const day = madridToday();
      const out = await tasks<{ created: boolean; routed?: string; task?: { id?: string; title?: string } }>(ctx, 'requests/task', {
        source: 'food', kind: 'food.equipment_fault', kind_label: 'Averías de cocina',
        external_ref: `equipment_fault:${id}:${day}`,
        external_url: `${FOOD_ORIGINS[0]}/#/maquinaria`,
        title: `${fault!.title}: ${name}${location ? ` (${location})` : ''}`,
        ...(note ? { note } : {}),
        priority: fault!.priority,
      });
      if (!out?.task?.id) fail(503, 'TASKS_UNAVAILABLE', 'Respuesta de Tasks no válida.');
      const recorded = await recordNotice(supabase, id, day, status, out.task!.id!);
      return { created: out.created, routed: out.routed ?? null, taskId: out.task!.id, recorded };
    },
  }];
}

/**
 * La lista de la compra única por evento (1117, API.md §2.15), hacia Tasks por el catálogo (`tasks.request_purchase`).
 * - `GET events/:id/shopping/projects`: los proyectos abiertos de Tasks donde pedir (`requests/projects`).
 * - `POST events/:id/shopping/request {projectId, keys}`: pide a Tasks lo pendiente sin pedir de esas filas, una compra por
 *   fila (referencia por evento, ingrediente, unidad y tienda: repetir no duplica), y lo apunta en sus líneas.
 * - `POST events/:id/shopping/refresh`: pregunta a Tasks por lo pedido (la misma referencia devuelve la compra con su estado,
 *   sin crear nada) y marca en Food lo comprado o recibido. Sin entrada en la Despensa: el stock entra por Recursos en Tasks.
 * Editor u owner; necesitan red.
 */
function eventShoppingRoutes(supabase: Supabase, events: EventReader, options: FoodAppOptions): AppRoute[] {
  const tasks = createTasksClient(options);
  type Purchase = { created: boolean; purchase?: { id?: string; status?: string; externalRef?: string } };
  const guard = async (ctx: RequestContext, id: string | undefined) => {
    if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo quien edita puede pedir la compra.');
    const eventId = UUID.test(id ?? '') ? id!.toLowerCase() : fail(422, 'INVALID_OPERATION', 'Evento no válido.');
    const event = await events.get(ctx, eventId);
    if (!event) fail(422, 'EVENT_NOT_FOUND', 'El evento no existe o ya no está disponible para cocina.', { event_id: eventId });
    const data = await supabase.rpc<EventShopping>('core_read', { p_app: 'food', p_actor: ctx.user.id, p_name: 'food.event_shopping', p_args: { event_id: eventId } });
    return { eventId, event: event!, data };
  };
  const ask = (ctx: RequestContext, row: EventShoppingRow, ref: string, projectId: string, quantity: number, eventId: string, event: FoodEvent) =>
    tasks<Purchase>(ctx, 'requests/purchase', {
      source: 'food', external_ref: ref, project_id: projectId, title: eventPurchaseTitle(row, quantity, event.title),
      quantity, unit: row.unit,
      // El artículo de Recursos (Tasks #874, API §39.6): al recibirla, Tasks apunta la entrada de stock con su coste.
      ...(row.item_id ? { item_id: row.item_id } : {}),
      note: [row.supplier ? `Proveedor: ${row.supplier}` : null, `Sale de: ${row.menus.join(', ')}`, 'Lista de la compra del evento en Food.'].filter(Boolean).join(' · '),
      due: dayBefore(event.start_date), external_url: `${FOOD_ORIGINS[0]}/#/eventos/${eventId}/compra`,
    });
  const commitLines = async (ctx: RequestContext, requestId: string, ops: Operation[]) => {
    if (!ops.length) return;
    await supabase.rpc('core_commit', {
      p_app: 'food', p_actor: ctx.user.id, p_request_id: requestId, p_digest: await sha256Hex(stable(ops)),
      p_expected_cursor: null, p_operations: ops, p_confirmation: null,
    });
  };
  return [{
    method: 'GET', pattern: 'events/:id/shopping/projects', handler: async ({ ctx, params }) => {
      await guard(ctx, params.id);
      const out = await tasks<{ projects?: unknown[] }>(ctx, 'requests/projects', null, 'GET');
      return { projects: Array.isArray(out?.projects) ? out.projects : [] };
    },
  }, {
    method: 'POST', pattern: 'events/:id/shopping/request', handler: async ({ ctx, params, json }) => {
      const { eventId, event, data } = await guard(ctx, params.id);
      const body = ((await json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const projectId = typeof body.projectId === 'string' && UUID.test(body.projectId) ? body.projectId.toLowerCase() : fail(422, 'INVALID_OPERATION', 'Elige un proyecto de Tasks.');
      const keys = Array.isArray(body.keys) && body.keys.length <= 500 && body.keys.every((k) => typeof k === 'string') ? body.keys as string[] : fail(422, 'INVALID_OPERATION', 'Filas no válidas.');
      const results: Array<{ key: string; ref: string; created: boolean; quantity: number }> = [];
      for (const row of data.rows.filter((r) => keys.includes(r.key))) {
        const quantity = Math.round(unrequestedQuantity(row) * 1000) / 1000;
        if (!(quantity > 0)) continue;
        // Lo ya pedido de esta fila guarda su referencia; lo nuevo pendiente se pide aparte (:2, :3…).
        const asked = new Set(row.lines.map((l) => l.purchase_ref).filter(Boolean)).size;
        const ref = eventPurchaseRef(eventId, row) + (asked ? `:${asked + 1}` : '');
        const out = await ask(ctx, row, ref, projectId, quantity, eventId, event);
        if (!out?.purchase?.id) fail(503, 'TASKS_UNAVAILABLE', 'Respuesta de Tasks no válida.');
        const ops = row.lines.filter((l) => l.status === 'pendiente' && !l.purchase_ref).map((l) => ({
          op: 'update', table: 'food.shopping_list_items', id: l.id, expectedRevision: Number(l.revision),
          fields: { purchase_ref: ref, purchase_project_id: projectId, purchase_requested: Number(l.quantity) },
        }) as Operation);
        await commitLines(ctx, `shopping-request:${(await sha256Hex(ref)).slice(0, 40)}`, ops);
        results.push({ key: row.key, ref, created: out.created, quantity });
      }
      return { requested: results };
    },
  }, {
    method: 'POST', pattern: 'events/:id/shopping/refresh', handler: async ({ ctx, params }) => {
      const { eventId, event, data } = await guard(ctx, params.id);
      const ops: Operation[] = [];
      const statuses: Array<{ ref: string; status: string | null }> = [];
      for (const row of data.rows) {
        const refs = new Map<string, EventShoppingRow['lines']>();
        for (const l of row.lines) if (l.purchase_ref && l.status === 'pendiente') refs.set(l.purchase_ref, [...(refs.get(l.purchase_ref) ?? []), l]);
        for (const [ref, lines] of refs) {
          const quantity = lines.reduce((n, l) => n + Number(l.quantity), 0);
          const out = await ask(ctx, row, ref, row.purchase_project_id ?? fail(422, 'INVALID_OPERATION', 'Falta el proyecto de Tasks.'), quantity, eventId, event);
          const status = itemStatusFromPurchase(out?.purchase?.status);
          statuses.push({ ref, status: out?.purchase?.status ?? null });
          if (status) for (const l of lines) ops.push({ op: 'update', table: 'food.shopping_list_items', id: l.id, expectedRevision: Number(l.revision), fields: { status } } as Operation);
        }
      }
      await commitLines(ctx, `shopping-refresh:${(await sha256Hex(stable(ops))).slice(0, 40)}`, ops);
      return { checked: statuses.length, marked: ops.length, statuses };
    },
  }];
}

export function createFoodApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins' | 'uploads'>>, options: FoodAppOptions = {}) {
  // La clave de worker también va en las llamadas a Tasks (FO2).
  options = { ...options, workerKey: options.workerKey ?? base.workerKey };
  const supabase = createSupabase(base);
  const events = createEventReader(supabase);
  return createApp({
    ...base,
    app: 'food',
    slug: 'food-api',
    origins: base.origins ?? FOOD_ORIGINS,
    uploads: base.uploads ?? FOOD_UPLOADS,
    hooks: {
      beforeCommit: async (operations, ctx) => {
        const issue = validateOperations(operations);
        if (issue) fail(422, issue.code, issue.message, issue.details);
        await checkRecipePhotos(supabase, operations, ctx);
        await checkNewMenus(events, operations, ctx);
        await checkMenuCalls(supabase, events, operations, ctx);
      },
      // La carta: las ventas registradas mueven el stock de Recursos (carta.ts). Un fallo no deshace las ventas.
      afterCommit: async (result) => { await afterCartaSales(supabase, result); },
    },
    routes: [...eventRoutes(events), ...tasksRoutes(supabase, options), ...voteRoutes(supabase), ...cartaRoutes(supabase, events), ...stockRoutes(supabase), ...cartaImageRoutes(options), ...eventShoppingRoutes(supabase, events, options)],
    // R5c, P17: el consumo vencido se descuenta en el servidor (lo programa `core.schedule_tick`, migración 1100).
    // Tanda 27: el estado de las peticiones de máquina en Tasks, para «En reparación» (migración 1106).
    workerRoutes: [...(base.workerRoutes ?? []), { method: 'POST', pattern: 'consumption/tick', handler: () => runConsumptionTick(supabase) },
      { method: 'POST', pattern: 'equipment/tick', handler: () => runEquipmentTick(supabase, { workerKey: base.workerKey, fetch: options.tasksFetch }) }],
  });
}
