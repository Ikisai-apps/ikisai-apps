/** Ikisai Booking · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, createSupabase, fail, messageFor, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase } from '../_kit/mod.ts';
import { canSeeGuests, TABLES, validateOperations } from '../_domain/booking/mod.ts';
import type { CalendarAdapter } from './calendar/adapter.ts';
import { CALENDAR_RETRY, CALENDAR_STATUS, runCalendarTick, type CalendarInvoke } from './calendar/worker.ts';

export const BOOKING_ORIGINS = ['https://booking.ikisai.com', 'https://ikisai-booking.pages.dev'];

/** Validación de dominio antes de `core.commit` (docs/booking/API.md §4.1). Las reglas viven en `_domain/booking`. */
export function validateBookingOperations(operations: Operation[], ctx: RequestContext): void {
  const [issue] = validateOperations(operations, { role: ctx.membership.role, canSeeGuests: canSeeGuests(ctx.membership) });
  if (issue) fail(issue.status, issue.code, issue.message, issue.details);
}

/** Visibilidad (docs/booking/API.md §5.1): los huéspedes solo los ve un propietario o un editor con `scopes.guests`. */
export function visibleBookingRow(table: string, _row: Record<string, unknown>, ctx: RequestContext): boolean {
  return table !== TABLES.guests || canSeeGuests(ctx.membership);
}

export interface BookingCalendarConfig {
  /** Adaptador de calendario. Sin él la integración está apagada (`health: 'not_configured'`) y nada se marca como sincronizado. */
  adapter?: CalendarAdapter | null;
}

function requireEditor(ctx: RequestContext): void {
  if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
}

/**
 * Rutas propias (docs/booking/API.md §6). El tick necesita lógica en TypeScript (payload, hash, adaptador), y las
 * acciones del núcleo son solo SQL: por eso es una ruta propia y no `invoke/booking.calendar_tick`.
 * `claim` y `report` se ejecutan como sistema (actor null); el permiso del usuario se comprueba aquí.
 */
export function bookingRoutes(supabase: Supabase, calendar: BookingCalendarConfig = {}): AppRoute[] {
  const adapter = calendar.adapter ?? null;
  const system: CalendarInvoke = (name, args) => supabase.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: name, p_args: args });
  return [
    {
      method: 'POST', pattern: 'calendar/tick',
      handler: async ({ ctx, json }) => {
        requireEditor(ctx);
        const body = await json().catch(() => ({}));
        const limit = Number.isInteger(body?.limit) ? Math.min(Math.max(body.limit, 1), 50) : 10;
        const reservationIds = Array.isArray(body?.reservationIds) ? body.reservationIds.filter((id: unknown) => typeof id === 'string') : undefined;
        return runCalendarTick({ invoke: system, adapter, limit, reservationIds });
      },
    },
    {
      method: 'GET', pattern: 'calendar/status',
      handler: async ({ ctx, url }) => {
        const ids = url.searchParams.get('reservationIds')?.split(',').filter(Boolean);
        const out = await supabase.rpc<{ items: unknown[] }>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: CALENDAR_STATUS, p_args: ids?.length ? { reservationIds: ids } : {} });
        return { configured: !!adapter, calendarId: adapter?.calendarId ?? null, health: adapter ? 'ok' : 'not_configured', items: out.items };
      },
    },
    {
      method: 'POST', pattern: 'calendar/:reservationId/retry',
      handler: async ({ ctx, params }) => {
        requireEditor(ctx);
        return supabase.rpc('core_invoke', { p_app: 'booking', p_actor: ctx.user.id, p_name: CALENDAR_RETRY, p_args: { reservationId: params.reservationId } });
      },
    },
  ];
}

export function createBookingApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins'>> & { calendar?: BookingCalendarConfig }) {
  const { calendar, ...config } = base;
  return createApp({
    ...config,
    app: 'booking',
    slug: 'booking-api',
    origins: base.origins ?? BOOKING_ORIGINS,
    uploads: { bucket: 'booking-documents', maxBytes: 15 * 1024 * 1024, allowedMime: ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'] },
    hooks: { beforeCommit: validateBookingOperations, visible: visibleBookingRow },
    routes: bookingRoutes(createSupabase(config), calendar),
  });
}
