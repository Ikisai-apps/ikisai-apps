/** Ikisai Booking · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, createSupabase, ensureServiceActor, fail, messageFor, type AppConfig, type AppRoute, type CommitResult, type Operation, type RequestContext, type Supabase, type WorkerRoute } from '../_kit/mod.ts';
import { bookingAgentRisk, canSeeGuests, TABLES, validateOperations } from '../_domain/booking/mod.ts';
import type { CalendarAdapter } from './calendar/adapter.ts';
import { createSesTransport, sesTlsPing, type SesTransport } from './ses/transport.ts';
import { createTasksNotifier, sesCancel, sesCommunicateReservation, sesTick, type SesDeps } from './ses/service.ts';
import { CALENDAR_RETRY, CALENDAR_STATUS, healthForCode, runCalendarTick, type CalendarHealth, type CalendarInvoke } from './calendar/worker.ts';

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

/** SES.HOSPEDAJES (API.md §17): transporte y secretos. En la Edge, `Deno.env`; en las pruebas, un SES simulado. */
export interface BookingSesConfig {
  transport?: SesTransport;
  env?: (name: string) => string | undefined;
  /** Aviso a Tasks (`booking.ses_deadline`); por defecto, la ruta de worker de Tasks si hay `IKISAI_WORKER_KEY`. */
  notifyTasks?: SesDeps['notifyTasks'] | null;
}

// deno-lint-ignore no-explicit-any
const denoEnv = (name: string): string | undefined => (globalThis as any).Deno?.env?.get?.(name);
const sesDeps = (supabase: Supabase, ses: BookingSesConfig): SesDeps => ({
  invoke: (name, args) => supabase.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: name, p_args: args }),
  transport: ses.transport ?? createSesTransport(),
  env: ses.env ?? denoEnv,
  notifyTasks: withServiceActor(supabase, ses.notifyTasks === null ? undefined : ses.notifyTasks ?? createTasksNotifier(ses.env ?? denoEnv)),
});

/** Antes de pedir nada a Tasks, la cuenta de servicio `booking` debe existir (Tasks escribe como `core.service_actor('booking')`). */
function withServiceActor(supabase: Supabase, notify: SesDeps['notifyTasks']): SesDeps['notifyTasks'] {
  if (!notify) return undefined;
  let ready: Promise<unknown> | null = null;
  return async (request) => {
    ready ??= ensureServiceActor(supabase, 'booking').catch((error) => { ready = null; throw error; });
    try { await ready; } catch { return false; }
    return notify(request);
  };
}

export interface BookingCalendarConfig {
  /** Adaptador de calendario. Sin él la integración está apagada (`health: 'not_configured'`) y nada se marca como sincronizado. */
  adapter?: CalendarAdapter | null;
  /** Tras cada commit que toque reservas o eventos, procesa su cola sin esperar al planificador. */
  syncOnCommit?: boolean;
}

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const systemInvoke = (supabase: Supabase): CalendarInvoke => (name, args) => supabase.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: name, p_args: args });

/** Ruta de sistema para el planificador de Core: `POST /api/v1/worker/calendar/tick` con `X-Ikisai-Worker-Key`. */
export function bookingWorkerRoutes(calendar: BookingCalendarConfig = {}, supabase?: Supabase, ses: BookingSesConfig = {}): WorkerRoute[] {
  return [{
    method: 'POST', pattern: 'calendar/tick',
    handler: async ({ invoke, json }) => {
      const body = await json().catch(() => ({}));
      const limit = Number.isInteger(body?.limit) ? Math.min(Math.max(body.limit, 1), 50) : 10;
      return runCalendarTick({ invoke: (name, args) => invoke(name, args), adapter: calendar.adapter ?? null, limit });
    },
  }, {
    // Prueba de TLS contra SES PRE sin credenciales (API.md §17.3): dice qué vía del runtime acepta el intermedio de la FNMT.
    method: 'POST', pattern: 'ses/ping',
    handler: () => sesTlsPing(),
  }, {
    // Envía lo preparado y consulta los lotes en proceso; si no hay nada pendiente, no llama a SES.
    method: 'POST', pattern: 'ses/tick',
    handler: async ({ json }) => {
      if (!supabase) return { sent: 0, checked: 0, skipped: 0, notices: 0 };
      const body = await json().catch(() => ({}));
      const limit = Number.isInteger(body?.limit) ? Math.min(Math.max(body.limit, 1), 50) : 10;
      return sesTick(sesDeps(supabase, ses), limit);
    },
  }];
}

/**
 * `afterCommit`: empuja la cola de las reservas tocadas por el lote. En la Edge va en segundo plano
 * (`EdgeRuntime.waitUntil`) para no retrasar la respuesta; el guardado nunca depende de Google.
 */
export function calendarAfterCommit(supabase: Supabase, calendar: BookingCalendarConfig) {
  return async (result: CommitResult): Promise<void> => {
    if (!calendar.adapter || !calendar.syncOnCommit) return;
    const ids = new Set<string>();
    for (const change of result.changes) {
      if (change.table === TABLES.reservations && change.id) ids.add(change.id);
      const reservationId = change.table === TABLES.events ? change.after?.reservation_id : null;
      if (typeof reservationId === 'string') ids.add(reservationId);
    }
    if (ids.size === 0) return;
    const work = runCalendarTick({ invoke: systemInvoke(supabase), adapter: calendar.adapter, limit: 10, reservationIds: [...ids] }).then(() => undefined, () => undefined);
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime) EdgeRuntime.waitUntil(work);
    else await work;
  };
}

function requireEditor(ctx: RequestContext): void {
  if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
}

/**
 * Rutas propias (docs/booking/API.md §6). El tick necesita lógica en TypeScript (payload, hash, adaptador), y las
 * acciones del núcleo son solo SQL: por eso es una ruta propia y no `invoke/booking.calendar_tick`.
 * `claim` y `report` se ejecutan como sistema (actor null); el permiso del usuario se comprueba aquí.
 */
const ENTITY_PROJECTION = 'central.common_entity_projection';
const GUEST_SIGNATURE = 'booking.guest_signature_file';
const ENTITY_LOGO_BUCKET = 'central-documents';

export function bookingRoutes(supabase: Supabase, calendar: BookingCalendarConfig = {}, ses: BookingSesConfig = {}): AppRoute[] {
  const adapter = calendar.adapter ?? null;
  const system = systemInvoke(supabase);
  return [
    {
      // Datos de la entidad (Central) para la cabecera de la propuesta al organizador. El logotipo está en el bucket privado
      // de Central: se firma aquí con la clave de servicio, de corta duración, y no se guarda en ninguna parte.
      method: 'GET', pattern: 'entity',
      handler: async ({ ctx }) => {
        const out = await supabase.rpc<{ rows: Array<Record<string, any>> }>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: ENTITY_PROJECTION, p_args: { limit: 1 } });
        const row = out.rows?.[0] ?? null;
        const entity = row && (row.legal_name || row.tax_id) ? row : null;
        let logoUrl: string | null = null;
        if (entity?.logo_bucket === ENTITY_LOGO_BUCKET && typeof entity.logo_path === 'string' && entity.logo_path) {
          const path = entity.logo_path.split('/').map(encodeURIComponent).join('/');
          const signed = await supabase.remote(`/storage/v1/object/sign/${ENTITY_LOGO_BUCKET}/${path}`, { service: true, method: 'POST', body: { expiresIn: 600 } }).catch(() => null);
          const rel = typeof signed?.signedURL === 'string' ? signed.signedURL : typeof signed?.signedUrl === 'string' ? signed.signedUrl : null;
          logoUrl = rel ? supabase.base + '/storage/v1' + rel : null;
        }
        if (!entity) return { entity: null, logoUrl: null };
        const { logo_bucket: _b, logo_path: _p, ...visible } = entity;
        return { entity: visible, logoUrl };
      },
    },
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
        const out = await supabase.rpc<{ items: Array<{ lastError?: string | null }> }>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: CALENDAR_STATUS, p_args: ids?.length ? { reservationIds: ids } : {} });
        // La salud sale de lo que la cola dejó anotado: si algún trabajo está bloqueado por el acceso al calendario, se ve aquí.
        let health: CalendarHealth = adapter ? 'ok' : 'not_configured';
        if (adapter) for (const item of out.items) health = healthForCode(item.lastError) ?? health;
        return { configured: !!adapter, calendarId: adapter?.calendarId ?? null, health, items: out.items };
      },
    },
    {
      // Firma del parte de un huésped (subida desde Guests o desde Booking): URL firmada de corta duración, solo para quien
      // puede ver huéspedes. No se guarda ni se devuelven bucket ni ruta.
      method: 'GET', pattern: 'guest-signature/:guestId',
      handler: async ({ ctx, params }) => {
        if (!canSeeGuests(ctx.membership)) fail(403, 'FORBIDDEN', 'Los datos de huéspedes están restringidos a los responsables designados.');
        const file = await supabase.rpc<{ bucket: string; path: string; mime: string } | null>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: GUEST_SIGNATURE, p_args: { guest_id: params.guestId } });
        if (!file) fail(404, 'FILE_NOT_FOUND', messageFor('FILE_NOT_FOUND'));
        const path = file.path.split('/').map(encodeURIComponent).join('/');
        const signed = await supabase.remote(`/storage/v1/object/sign/${encodeURIComponent(file.bucket)}/${path}`, { service: true, method: 'POST', body: { expiresIn: 300 } });
        const rel = typeof signed?.signedURL === 'string' ? signed.signedURL : typeof signed?.signedUrl === 'string' ? signed.signedUrl : null;
        if (!rel) fail(503, 'STORAGE_UNAVAILABLE', messageFor('STORAGE_UNAVAILABLE'));
        return { url: supabase.base + '/storage/v1' + rel, mime: file.mime, expiresAt: new Date(Date.now() + 300_000).toISOString() };
      },
    },
    {
      // Estado de las comunicaciones a SES de una reserva (editor y owner).
      method: 'GET', pattern: 'ses/:reservationId',
      handler: ({ ctx, params }) => supabase.rpc('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: 'booking.ses_status', p_args: { reservation_id: params.reservationId } }),
    },
    {
      // «Comunicar reserva a SES»: solo con SES activo, reserva confirmada y pago registrado (lo comprueba la fuente).
      method: 'POST', pattern: 'ses/:reservationId/rh',
      handler: async ({ ctx, params }) => {
        requireEditor(ctx);
        const source = await supabase.rpc<any>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: 'booking.ses_reservation_source', p_args: { reservation_id: params.reservationId } });
        try {
          return await sesCommunicateReservation(sesDeps(supabase, ses), source, ctx.user.id);
        } catch (error) {
          const e = error as { name?: string; field?: string; message?: string };
          if (e?.name === 'SesDataError') fail(422, 'SES_DATA', e.message ?? 'Faltan datos para comunicar a SES.', { field: e.field });
          throw error;
        }
      },
    },
    {
      // «Anular en SES»: anula una comunicación aceptada de la reserva.
      method: 'POST', pattern: 'ses/:reservationId/cancel/:communicationId',
      handler: async ({ ctx, params }) => {
        requireEditor(ctx);
        const status = await supabase.rpc<{ items: Array<Record<string, any>> }>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: 'booking.ses_status', p_args: { reservation_id: params.reservationId } });
        const target = status.items.find((c) => c.id === params.communicationId);
        if (!target || target.status !== 'aceptada' || !target.ses_code) fail(422, 'SES_NOT_CANCELLABLE', 'Solo se anula una comunicación aceptada por SES.');
        return sesCancel(sesDeps(supabase, ses), { reservationId: params.reservationId!, communicationId: target.id, sesCode: target.ses_code, environment: target.environment, requestedBy: ctx.user.id });
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

export function createBookingApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins'>> & { calendar?: BookingCalendarConfig; ses?: BookingSesConfig }) {
  const { calendar = {}, ses = {}, ...config } = base;
  const supabase = createSupabase(config);
  return createApp({
    ...config,
    app: 'booking',
    slug: 'booking-api',
    origins: base.origins ?? BOOKING_ORIGINS,
    uploads: { bucket: 'booking-documents', maxBytes: 15 * 1024 * 1024, allowedMime: ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'] },
    hooks: { beforeCommit: validateBookingOperations, visible: visibleBookingRow, afterCommit: calendarAfterCommit(supabase, calendar), agentRisk: (operations) => bookingAgentRisk(operations) },
    routes: bookingRoutes(supabase, calendar, ses),
    workerRoutes: bookingWorkerRoutes(calendar, supabase, ses),
    // enlaces personales de los portales Organizers y Guests (contrato §3.6): solo editor y owner
    portalIssuer: true,
  });
}
