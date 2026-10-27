/** Ikisai Booking · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, createStorage, createSupabase, ensureServiceActor, fail, messageFor, r2ConfigFromEnv, sha256Hex, type AppConfig, type AppRoute, type PublicRoute, type CommitResult, type Operation, type RequestContext, type Supabase, type WorkerRoute } from '../_kit/mod.ts';
import { bookingAgentRisk, canSeeGuests, montage, TABLES, validateOperations, walkinFinanceEntry, type WalkinForSend } from '../_domain/booking/mod.ts';
import type { CalendarAdapter } from './calendar/adapter.ts';
import { createSesTransport, sesTlsPing, type SesTransport } from './ses/transport.ts';
import { portalTick, type PortalTasksRequest } from './portal/notices.ts';
import { createTasksPost, tasksTick, type TasksPost } from './tasks/sync.ts';
import { createTasksNotifier, sesCancel, sesCommunicateGuestReport, sesCommunicateReservation, sesTick, type SesDeps } from './ses/service.ts';
import { CALENDAR_RETRY, CALENDAR_STATUS, healthForCode, runCalendarTick, runStayCalendarTick, type CalendarHealth, type CalendarInvoke, type StayCalendarAdapters } from './calendar/worker.ts';

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
  /** Rutas de worker de Tasks para el proyecto del retiro y sus extras (B13); por defecto, las reales si hay `IKISAI_WORKER_KEY`. */
  tasksPost?: TasksPost | null;
  /** Aviso a Tasks (`booking.ses_deadline`); por defecto, la ruta de worker de Tasks si hay `IKISAI_WORKER_KEY`. */
  notifyTasks?: SesDeps['notifyTasks'] | null;
}

// deno-lint-ignore no-explicit-any
const denoEnv = (name: string): string | undefined => (globalThis as any).Deno?.env?.get?.(name);
const sesDeps = (supabase: Supabase, ses: BookingSesConfig): SesDeps => ({
  invoke: (name, args) => supabase.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: name, p_args: args }),
  transport: ses.transport ?? createSesTransport(),
  env: ses.env ?? denoEnv,
  notifyTasks: withServiceActor(supabase, ses.notifyTasks === null ? undefined : ses.notifyTasks ?? createTasksNotifier(ses.env ?? denoEnv, fetch, supabase.base)),
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
  /** Estancias (O2): calendario de outsiders y del staff. Sin ellos, las estancias no se proyectan. */
  stays?: StayCalendarAdapters;
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
      const result = await runCalendarTick({ invoke: (name, args) => invoke(name, args), adapter: calendar.adapter ?? null, limit });
      // las estancias, solo si hay algún calendario suyo (la respuesta de siempre no cambia)
      if (!calendar.stays?.outsider && !calendar.stays?.staff) return result;
      return { ...result, stays: await runStayCalendarTick({ invoke: (name, args) => invoke(name, args), adapters: calendar.stays, limit }) };
    },
  }, {
    // Prueba de TLS contra SES PRE sin credenciales (API.md §17.3): dice qué vía del runtime acepta el intermedio de la FNMT.
    method: 'POST', pattern: 'ses/ping',
    handler: () => sesTlsPing(),
  }, {
    // Conservación del registro de viajeros (API.md §20): anonimiza a los huéspedes vencidos, una vuelta por llamada.
    // R2: con el interruptor en `resources`, espejo de espacios y camas desde Recursos (cambios hechos desde otras apps).
    method: 'POST', pattern: 'spaces/tick',
    handler: async () => {
      if (!supabase) return { applied: 0 };
      await ensureServiceActor(supabase, 'booking');
      return supabase.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: 'booking.spaces_mirror_apply', p_args: {} });
    },
  }, {
    // Reglas de acceso de VG (0481): organizador y personal con cuenta, huéspedes de su retiro en Guests.
    method: 'POST', pattern: 'portal-access/tick',
    handler: async () => {
      if (!supabase) return { created: 0, removed: 0 };
      await ensureServiceActor(supabase, 'booking');
      return supabase.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: 'booking.portal_access_run', p_args: {} });
    },
  }, {
    method: 'POST', pattern: 'retention/tick',
    handler: async () => {
      if (!supabase) return { anonymized: 0 };
      await ensureServiceActor(supabase, 'booking'); // el lote del sistema lo firma «Booking (sistema)»
      return supabase.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: 'booking.retention_run', p_args: { limit: 100 } });
    },
  }, {
    // Proyecto del retiro en Tasks y una tarea por extra contratado (B13), con la cuenta de servicio.
    method: 'POST', pattern: 'tasks/tick',
    handler: async () => {
      if (!supabase) return { projects: 0, extras: 0, waiting: 0 };
      const post = ses.tasksPost === null ? undefined : ses.tasksPost ?? createTasksPost(ses.env ?? denoEnv, fetch, supabase.base);
      if (post) await ensureServiceActor(supabase, 'booking');
      return tasksTick({ invoke: sesDeps(supabase, ses).invoke, post });
    },
  }, {
    // Avisos del portal al comercial (fechas, «Quiero confirmar», comentarios) como peticiones a Tasks.
    method: 'POST', pattern: 'portal/tick',
    handler: async () => {
      if (!supabase) return { notified: 0, pending: 0 };
      const deps = sesDeps(supabase, ses); // misma cuenta de servicio y mismo notificador de Tasks que SES
      return portalTick({ invoke: deps.invoke, notifyTasks: deps.notifyTasks as unknown as ((r: PortalTasksRequest) => Promise<boolean>) | undefined });
    },
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

const GUESTS_FORBIDDEN = 'Los datos de huéspedes están restringidos a los responsables designados.';
function requireGuests(ctx: RequestContext): void {
  if (!canSeeGuests(ctx.membership)) fail(403, 'FORBIDDEN', GUESTS_FORBIDDEN);
}

/**
 * Rutas propias (docs/booking/API.md §6). El tick necesita lógica en TypeScript (payload, hash, adaptador), y las
 * acciones del núcleo son solo SQL: por eso es una ruta propia y no `invoke/booking.calendar_tick`.
 * `claim` y `report` se ejecutan como sistema (actor null); el permiso del usuario se comprueba aquí.
 */
const ENTITY_PROJECTION = 'central.common_entity_projection';
const GUEST_SIGNATURE = 'booking.guest_signature_file';
const SES_OVERVIEW = 'booking.ses_overview';
const ENTITY_LOGO_BUCKET = 'central-documents';
const RETREAT_LOGOS = 'organizers.booking_logo_projection';
const RETREAT_LOGO_BUCKET = 'organizers-materials';

/**
 * Alojamiento a la carta (0487): el ingreso de un cobro a Finance (`invoices.record_app_entry`, idempotente por
 * `booking:stay:<id>`) con la sesión de la persona, que tiene que ser editor u owner en Finance (si no, `NEEDS_ACCESS`).
 * El resultado lo anota la app en el cobro (`finance_entry_id` y `finance_sent_at`, o `finance_error`).
 * Seguridad B5 (auditoría del 27-10; Finance #859): la llamada lleva además la prueba de que sale del servidor de Booking,
 * `X-Ikisai-Worker-Key` (la `IKISAI_WORKER_KEY`) y `X-Ikisai-Caller: booking`; un navegador no tiene la clave, así que
 * nadie más puede apuntar con `source_app: 'booking'`.
 */
function walkinRoutes(supabase: Supabase, appsFetch: typeof fetch, workerKey: string | undefined): AppRoute[] {
  const commandsOf = (slug: string) => `${supabase.base}/functions/v1/${slug}/api/v1/commands`;
  return [{
    method: 'POST', pattern: 'walkins/:id/send/finance',
    handler: async ({ ctx, params }) => {
      if (ctx.membership.role !== 'editor' && ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Solo el personal con permiso de escritura envía cobros a Finance.');
      const out = await supabase.rpc<{ charge: (WalkinForSend & { paid_at: string | null }) | null }>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: 'booking.walkin_charge_for_send', p_args: { id: params.id ?? '' } });
      const charge = out?.charge ?? null;
      if (!charge) fail(404, 'NOT_FOUND', 'Ese cobro no existe.');
      if (!charge.method || !charge.paid_day) fail(409, 'NOT_PAID', 'Todavía no está cobrado: cóbralo antes de enviarlo a Finance.');
      // el nombre del huésped solo sale si quien envía puede verlo (API.md §5.1)
      const args = walkinFinanceEntry(canSeeGuests(ctx.membership) ? charge : { ...charge, guest: null });
      let res: Response;
      try {
        res = await appsFetch(commandsOf('invoices-api'), {
          method: 'POST', headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': workerKey ?? '', 'X-Ikisai-Caller': 'booking' },
          body: JSON.stringify({ requestId: `booking:walkin:${charge.id}:${(await sha256Hex(JSON.stringify(args))).slice(0, 24)}`, operations: [{ op: 'call', procedure: 'invoices.record_app_entry', args }] }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        fail(503, 'APP_UNAVAILABLE', 'Finance no responde ahora mismo. Inténtalo más tarde.');
      }
      const body = await res.json().catch(() => ({})) as any;
      const code = body?.error?.code as string | undefined;
      if (res.status === 401 || res.status === 403 || code === 'NO_MEMBERSHIP') fail(403, 'NEEDS_ACCESS', 'Pide acceso a Finance: tu cuenta no puede enviarle cobros.', { app: 'invoices', code: code ?? null });
      if (!res.ok) fail(res.status === 409 ? 409 : 422, code ?? 'APP_REJECTED', body?.error?.message ?? 'Finance no ha aceptado el cobro.', { app: 'invoices', details: body?.error?.details ?? null });
      return { status: 'sent', result: body?.results?.[0]?.result ?? null };
    },
  }];
}

/**
 * «Montaje» del evento (0491): la ficha escribe la decoración del evento en Recursos (`resources.set_event_decor`) y
 * después llama aquí. Se lee la decoración con la persona (tiene que ser miembro de Recursos) y se manda a Tasks la madre
 * «Montaje del evento» con una hija por cambio, la lista ENTERA (Tasks crea, actualiza o retira). Sin cambios y sin nada
 * mandado antes, no se crea la madre. Sin proyecto del retiro en Tasks todavía: 409 PROJECT_NOT_READY.
 */
function montageRoutes(supabase: Supabase, ses: BookingSesConfig): AppRoute[] {
  return [{
    method: 'POST', pattern: 'montage/:reservationId/sync',
    handler: async ({ ctx, params }) => {
      if (ctx.membership.role !== 'editor' && ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Solo el personal con permiso de escritura cambia el montaje.');
      const out = await supabase.rpc<{ source: { reservation: { id: string; code: string | null; title: string; start_date: string | null }; event_id: string | null; project_id: string | null; montage_synced_at: string | null } | null }>(
        'core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: 'booking.montage_source', p_args: { reservation_id: params.reservationId ?? '' } });
      const source = out?.source ?? null;
      if (!source || !source.event_id) fail(404, 'NOT_FOUND', 'Esa reserva no tiene evento.');
      if (!source.reservation.code || !source.project_id) fail(409, 'PROJECT_NOT_READY', 'El proyecto del retiro aún no está en Tasks: el montaje se manda cuando exista.');
      let decor: Parameters<typeof montage.namesFrom>[0] & { decor?: montage.DecorRow[] };
      try {
        decor = await supabase.rpc('core_read', { p_app: 'resources', p_actor: ctx.user.id, p_name: 'resources.plans_with_decor', p_args: { event_id: source.event_id } });
      } catch {
        fail(403, 'NEEDS_ACCESS', 'Pide acceso a Recursos: tu cuenta no puede leer la decoración.', { app: 'resources' });
      }
      const changes = montage.eventChanges(decor.decor ?? [], source.event_id);
      if (!changes.length && !source.montage_synced_at) return { status: 'nothing', children: 0 };
      const post = ses.tasksPost === null ? undefined : ses.tasksPost ?? createTasksPost(ses.env ?? denoEnv, fetch, supabase.base);
      if (!post) fail(503, 'APP_UNAVAILABLE', 'Tasks no está conectado.');
      const body = montage.montageRequest({ ...source.reservation, code: source.reservation.code }, changes, montage.namesFrom(decor));
      let res: { status: number; data: any };
      try {
        await ensureServiceActor(supabase, 'booking');
        res = await post('requests/task', body);
      } catch {
        fail(503, 'APP_UNAVAILABLE', 'Tasks no responde ahora mismo. Inténtalo más tarde.');
      }
      if (res.status === 409) fail(409, res.data?.error?.code ?? 'PROJECT_NOT_READY', 'El proyecto del retiro aún no está en Tasks: el montaje se manda cuando exista.');
      if (res.status >= 400) fail(422, res.data?.error?.code ?? 'APP_REJECTED', res.data?.error?.message ?? 'Tasks no ha aceptado el montaje.', { app: 'tasks' });
      await systemInvoke(supabase)('booking.montage_mark', { reservation_id: source.reservation.id, task_id: res.data?.taskId ?? null, children: changes.length });
      return { status: 'sent', children: changes.length, taskId: res.data?.taskId ?? null };
    },
  }];
}

/**
 * C11 (BG18): un visitante del QR pide apuntarse o deja un dato: `POST /api/v1/public/join` con la cabecera X-Visitor.
 * El evento sale del código del QR (`event_code`, o el del token del visitante); el lote lo firma el visitante y la base
 * comprueba el resto (0489). Si ya tenía una pendiente de ese tipo, la devuelve. «Lo mío» lo sirve el kit
 * (`GET public/booking_visitor_requests`).
 */
export function bookingPublicRoutes(): PublicRoute[] {
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  return [{
    method: 'POST', pattern: 'join',
    handler: async ({ json, visitor, apply, read }) => {
      if (!visitor) fail(401, 'VISITOR_REQUIRED', messageFor('VISITOR_REQUIRED'));
      const body = (await json().catch(() => ({}))) as Record<string, unknown>;
      const code = text(body.event_code, 20) ?? visitor.eventCode ?? null;
      if (!code) fail(422, 'INVALID_FIELDS', 'Falta el código del evento.', { field: 'event_code' });
      const kind = body.kind === 'contact' ? 'contact' : 'join';
      const fields = { via_code: code, visitor_id: visitor.id, kind, name: text(body.name, 120), contact: text(body.contact, 200), note: text(body.note, 500) };
      try {
        await apply([{ op: 'insert', table: TABLES.visitorRequests, id: crypto.randomUUID(), fields }]);
      } catch (error) {
        // una pendiente del mismo tipo para ese evento: se devuelve la que hay
        const sqlstate = (error as { details?: { sqlstate?: string } } | null)?.details?.sqlstate;
        if (sqlstate !== '23505') throw error;
      }
      const mine = await read('booking_visitor_requests', { event_code: code }) as { items?: Array<Record<string, unknown>> } | null;
      const item = (mine?.items ?? []).find((i) => i.kind === kind) ?? null;
      return item ? { event_code: item.event_code, kind: item.kind, name: item.name, status: item.status, created_at: item.created_at } : null;
    },
  }, {
    // Alojamiento libre, tarjeta 2 (0499): el visitante pide noches. La base valida fechas, tarifa y plazas, calcula el
    // total y, si el evento reserva la plaza unas horas, la bloquea en el mismo lote (sin hueco, 409 NO_AVAILABILITY). Una
    // solicitud nueva del mismo visitante para el mismo evento sustituye a la anterior.
    method: 'POST', pattern: 'stay',
    handler: async ({ json, visitor, apply, read }) => {
      if (!visitor) fail(401, 'VISITOR_REQUIRED', messageFor('VISITOR_REQUIRED'));
      const body = (await json().catch(() => ({}))) as Record<string, unknown>;
      const code = text(body.event_code, 20) ?? visitor.eventCode ?? null;
      if (!code) fail(422, 'INVALID_FIELDS', 'Falta el código del evento.', { field: 'event_code' });
      const date = (value: unknown, field: string) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(422, 'INVALID_FIELDS', 'Fecha no válida.', { field });
        return value as string;
      };
      const persons = Number(body.persons ?? 1);
      if (!Number.isInteger(persons) || persons < 1 || persons > 20) fail(422, 'INVALID_FIELDS', 'Personas: de 1 a 20.', { field: 'persons' });
      const mode = typeof body.mode_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.mode_id) ? body.mode_id : null;
      if (!mode) fail(422, 'INVALID_FIELDS', 'Elige una modalidad.', { field: 'mode_id' });
      const name = text(body.name, 120);
      if (!name) fail(422, 'INVALID_FIELDS', 'Falta el nombre.', { field: 'name' });
      const id = crypto.randomUUID();
      await apply([{ op: 'insert', table: TABLES.visitorRequests, id, fields: {
        via_code: code, visitor_id: visitor.id, kind: 'stay', name, contact: text(body.contact, 200), note: text(body.note, 500),
        from_date: date(body.from, 'from'), to_date: date(body.to, 'to'), persons, rate_id: mode,
      } }]);
      const mine = await read('booking_visitor_requests', { event_code: code }) as { items?: Array<Record<string, unknown>> } | null;
      const item = (mine?.items ?? []).find((i) => i.id === id) ?? null;
      return item ? { id: item.id, event_code: item.event_code, status: item.status, from: item.from, to: item.to, persons: item.persons, mode_id: item.mode_id,
        total_cents: item.total_cents, pay: item.pay, hold_until: item.hold_until } : null;
    },
  }];
}

export function bookingRoutes(supabase: Supabase, calendar: BookingCalendarConfig = {}, ses: BookingSesConfig = {}, appsFetch: typeof fetch = fetch, workerKey: string | undefined = denoEnv('IKISAI_WORKER_KEY')): AppRoute[] {
  const adapter = calendar.adapter ?? null;
  const system = systemInvoke(supabase);
  // Archivos ajenos (logotipo de Central, firmas subidas desde Guests): siempre por la abstracción del kit (contrato §3.9)
  const storage = createStorage(supabase, { r2: r2ConfigFromEnv(denoEnv) });
  return [
    ...walkinRoutes(supabase, appsFetch, workerKey),
    ...montageRoutes(supabase, ses),
    {
      // Logotipo de cada retiro (Organizers, `materials.is_logo`) para las portadas de Inicio, Reservas y la ficha (tanda 27).
      // Todos los roles: es la imagen del retiro, no un dato personal. URL firmada de corta duración; el `sha256` deja al
      // cliente guardar la imagen para verla sin red y no volver a bajarla si no cambia.
      method: 'GET', pattern: 'logos',
      handler: async ({ ctx }) => {
        const out = await supabase.rpc<{ rows: Array<Record<string, any>> }>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: RETREAT_LOGOS, p_args: { limit: 500 } });
        const items = await Promise.all((out.rows ?? []).filter((r) => r.logo_bucket === RETREAT_LOGO_BUCKET && typeof r.logo_path === 'string' && r.logo_path)
          .map(async (r) => ({
            reservation_id: r.reservation_id as string, mime: r.logo_mime as string, sha256: r.logo_sha256 as string, updated_at: r.updated_at as string,
            url: await storage.readUrl({ bucket: RETREAT_LOGO_BUCKET, path: r.logo_path, storage_provider: r.logo_provider ?? null }, 600).catch(() => null),
          })));
        return { items: items.filter((i) => i.url) };
      },
    },
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
          // dónde vive el archivo lo dice su fila de core.files (contrato §3.9); la proyección de Central lo trae en logo_provider
          logoUrl = await storage.readUrl({ bucket: ENTITY_LOGO_BUCKET, path: entity.logo_path, storage_provider: entity.logo_provider ?? null }, 600).catch(() => null);
        }
        if (!entity) return { entity: null, logoUrl: null };
        const { logo_bucket: _b, logo_path: _p, logo_provider: _s, ...visible } = entity;
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
        return { configured: !!adapter, calendarId: adapter?.calendarId ?? null, health, items: out.items,
          // O2: calendarios de las estancias (null = sin configurar)
          stays: { outsider: calendar.stays?.outsider?.calendarId ?? null, staff: calendar.stays?.staff?.calendarId ?? null } };
      },
    },
    {
      // Firma del parte de un huésped (subida desde Guests o desde Booking): URL firmada de corta duración, solo para quien
      // puede ver huéspedes. No se guarda ni se devuelven bucket ni ruta.
      method: 'GET', pattern: 'guest-signature/:guestId',
      handler: async ({ ctx, params }) => {
        requireGuests(ctx);
        const file = await supabase.rpc<{ bucket: string; path: string; mime: string; storage_provider?: 'supabase' | 'r2' | null } | null>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: GUEST_SIGNATURE, p_args: { guest_id: params.guestId } });
        if (!file) fail(404, 'FILE_NOT_FOUND', messageFor('FILE_NOT_FOUND'));
        const url = await storage.readUrl(file!, 300);
        return { url, mime: file!.mime, expiresAt: new Date(Date.now() + 300_000).toISOString() };
      },
    },
    {
      // B2 (tanda 27): estado de SES de varias reservas en una llamada, para la bandeja y los avisos (editor y owner).
      // De los huéspedes, solo recuentos y solo para quien puede verlos.
      method: 'GET', pattern: 'ses',
      handler: ({ ctx }) => supabase.rpc('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: SES_OVERVIEW, p_args: {} }),
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
      // Huéspedes que han llegado, listos o con lo que les falta para el parte (editor y owner).
      // Trae nombres y documentos: solo quien puede ver huéspedes.
      method: 'GET', pattern: 'ses/:reservationId/pv',
      handler: ({ ctx, params }) => {
        requireGuests(ctx);
        return supabase.rpc('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: 'booking.ses_guest_report_source', p_args: { reservation_id: params.reservationId } });
      },
    },
    {
      // «Cerrar la entrada y comunicar» (o comunicar a quien llega tarde, con `guest_ids`): parte de viajeros de los listos.
      method: 'POST', pattern: 'ses/:reservationId/pv',
      handler: async ({ ctx, params, json }) => {
        requireEditor(ctx);
        requireGuests(ctx);
        const body = await json().catch(() => ({}));
        const guestIds = Array.isArray(body?.guest_ids) ? body.guest_ids.filter((id: unknown) => typeof id === 'string').slice(0, 200) : undefined;
        const source = await supabase.rpc<any>('core_read', { p_app: 'booking', p_actor: ctx.user.id, p_name: 'booking.ses_guest_report_source', p_args: { reservation_id: params.reservationId, ...(guestIds ? { guest_ids: guestIds } : {}) } });
        try {
          return await sesCommunicateGuestReport(sesDeps(supabase, ses), source, ctx.user.id);
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

export function createBookingApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads' | 'publicRoutes'> & Partial<Pick<AppConfig, 'origins'>> & { calendar?: BookingCalendarConfig; ses?: BookingSesConfig; appsFetch?: typeof fetch }) {
  const { calendar = {}, ses = {}, appsFetch = fetch, ...config } = base;
  const supabase = createSupabase(config);
  return createApp({
    ...config,
    app: 'booking',
    slug: 'booking-api',
    origins: base.origins ?? BOOKING_ORIGINS,
    // K3 para miembros: un archivo ajeno (justificante o firma de un huésped) solo lo lee por su id quien ve la fila que lo referencia
    uploads: { bucket: 'booking-documents', maxBytes: 15 * 1024 * 1024, allowedMime: ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'], membersK3: true },
    hooks: { beforeCommit: validateBookingOperations, visible: visibleBookingRow, afterCommit: calendarAfterCommit(supabase, calendar), agentRisk: (operations) => bookingAgentRisk(operations) },
    routes: bookingRoutes(supabase, calendar, ses, appsFetch, config.workerKey ?? denoEnv('IKISAI_WORKER_KEY')),
    publicRoutes: bookingPublicRoutes(),
    workerRoutes: bookingWorkerRoutes(calendar, supabase, ses),
    // enlaces personales de los portales Organizers y Guests (contrato §3.6): solo editor y owner
    portalIssuer: true,
  });
}
