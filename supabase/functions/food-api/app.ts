/** Ikisai Food · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, createSupabase, fail, isFault, stable, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import {
  eventSnapshot, FOOD_PROCEDURES, menuWarnings, PHOTO_MAX_BYTES, PHOTO_MIME, RECIPE_FILE_FIELDS, requiredAcknowledgements, validateOperations,
  type AcknowledgedWarning, type FoodEvent, type Menu, type MenuGraph,
} from '../_domain/food/mod.ts';

export const FOOD_ORIGINS = ['https://food.ikisai.com', 'https://ikisai-food.pages.dev'];

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

/** Un menú nace contra un evento que existe y contra una revisión que el evento ya ha alcanzado. */
async function checkNewMenus(events: EventReader, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    if (op.op !== 'insert' || op.table !== 'food.menus' || !op.fields) continue;
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

export function createFoodApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins' | 'uploads'>>) {
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
    },
    routes: eventRoutes(events),
  });
}
