/** Ikisai Food · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, createSupabase, fail, isFault, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import { PHOTO_MAX_BYTES, PHOTO_MIME, RECIPE_FILE_FIELDS, validateOperations, type FoodEvent } from '../_domain/food/mod.ts';

export const FOOD_ORIGINS = ['https://food.ikisai.com', 'https://ikisai-food.pages.dev'];

export const FOOD_UPLOADS: UploadsConfig = { bucket: 'kitchen-media', maxBytes: PHOTO_MAX_BYTES, allowedMime: [...PHOTO_MIME] };

const BOOKING_PROJECTION = 'booking.food_event_projection';
/** Vista de pruebas con las mismas columnas; se usa solo mientras Booking no registre la suya para Food. */
const STUB_PROJECTION = 'food.event_projection_stub';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Lectura de eventos como lectura registrada del núcleo (contrato §5.1). Food nunca recibe huéspedes. */
function createEventReader(supabase: Supabase) {
  let booking = false; // pasa a true la primera vez que la proyección de Booking responde

  async function read(ctx: RequestContext, where?: Record<string, string>): Promise<FoodEvent[]> {
    for (const name of booking ? [BOOKING_PROJECTION] : [BOOKING_PROJECTION, STUB_PROJECTION]) {
      try {
        const out = await supabase.rpc<{ rows: FoodEvent[] }>('core_read', {
          p_app: ctx.app, p_actor: ctx.user.id, p_name: name, p_args: { ...(where ? { where } : {}), limit: 2000 },
        });
        if (name === BOOKING_PROJECTION) booking = true;
        return out.rows;
      } catch (error) {
        // Booking todavía no ha registrado su proyección para Food: se prueba con la de pruebas.
        if (name === BOOKING_PROJECTION && isFault(error) && error.code === 'INVALID_OPERATION') continue;
        throw error;
      }
    }
    fail(503, 'PROJECTION_UNAVAILABLE', 'No se pueden leer los eventos de Booking.');
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
      },
    },
    routes: eventRoutes(events),
  });
}
