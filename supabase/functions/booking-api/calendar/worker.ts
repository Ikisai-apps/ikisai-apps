/**
 * Booking · worker de Calendar (docs/booking/API.md §7.3, «Cola y reintentos»).
 * Reclama trabajos, calcula el payload con las filas actuales, llama al adaptador solo si hace falta y anota el resultado.
 */
import { calendarProjection, type CalendarEvent, type CalendarReservation } from '../../_domain/booking/mod.ts';
import { CalendarError, type CalendarAdapter } from './adapter.ts';

export const CALENDAR_CLAIM = 'booking.calendar_claim';
export const CALENDAR_REPORT = 'booking.calendar_report';
export const CALENDAR_STATUS = 'booking.calendar_status';
export const CALENDAR_RETRY = 'booking.calendar_retry';

export type CalendarHealth = 'ok' | 'not_configured' | 'auth_error' | 'calendar_not_found';
/** Ejecuta una acción registrada de Booking como sistema (actor null). */
export type CalendarInvoke = (name: string, args: Record<string, unknown>) => Promise<any>;

interface ClaimedLink {
  calendarId: string;
  providerEventId: string | null;
  generation: number;
  htmlLink: string | null;
  syncStatus: 'pending' | 'synced' | 'error' | 'deleted';
  payloadHash: string | null;
}
interface ClaimedJob {
  jobId: string;
  reservationId: string;
  attempts: number;
  reservation: (CalendarReservation & { revision: number }) | null;
  event: (CalendarEvent & { revision: number }) | null;
  link: ClaimedLink | null;
}

export interface CalendarTickOptions {
  invoke: CalendarInvoke;
  /** Sin adaptador la integración está apagada: no se reclama nada y los trabajos siguen en `pending`. */
  adapter: CalendarAdapter | null;
  limit?: number;
  reservationIds?: string[];
}
export interface CalendarTickResult {
  processed: number;
  failed: number;
  pending: number;
  health: CalendarHealth;
}

function healthFor(code: string): CalendarHealth {
  return /NOT_FOUND/.test(code) ? 'calendar_not_found' : 'auth_error';
}

export async function runCalendarTick({ invoke, adapter, limit = 10, reservationIds }: CalendarTickOptions): Promise<CalendarTickResult> {
  const scope = reservationIds?.length ? { reservationIds } : {};
  if (!adapter) {
    const { pending } = await invoke(CALENDAR_CLAIM, { limit: 0 });
    return { processed: 0, failed: 0, pending, health: 'not_configured' };
  }
  const claimed = await invoke(CALENDAR_CLAIM, { limit, ...scope });
  const result: CalendarTickResult = { processed: 0, failed: 0, pending: 0, health: 'ok' };
  for (const job of claimed.jobs as ClaimedJob[]) {
    const base = { jobId: job.jobId, calendarId: adapter.calendarId };
    try {
      const link = await syncJob(job, adapter);
      await invoke(CALENDAR_REPORT, { ...base, outcome: 'done', ...(link ? { link } : {}) });
      result.processed++;
    } catch (error) {
      // Un error que no venga del adaptador se trata como recuperable: el octavo intento lo deja en `error`.
      const known = error instanceof CalendarError ? error : new CalendarError('UNEXPECTED', true);
      await invoke(CALENDAR_REPORT, { ...base, outcome: known.recoverable ? 'retry' : 'fatal', error: known.code });
      if (!known.recoverable) result.health = healthFor(known.code);
      result.failed++;
    }
  }
  result.pending = (await invoke(CALENDAR_CLAIM, { limit: 0 })).pending;
  return result;
}

/** Devuelve el enlace que hay que guardar, o null si el trabajo no cambia nada (p. ej. reserva `cerrada`). */
async function syncJob(job: ClaimedJob, adapter: CalendarAdapter): Promise<Record<string, unknown> | null> {
  const { reservation, link } = job;
  if (!reservation) return null;
  const event = job.event && !job.event.deleted_at ? job.event : null;
  const generation = link?.generation ?? 1;
  const projection = await calendarProjection(reservation, event, generation);
  const revisions = { sourceReservationRevision: reservation.revision, sourceEventRevision: event?.revision ?? null };

  if (projection.desired === 'keep') return null;

  if (projection.desired === 'absent') {
    if (!link || link.syncStatus === 'deleted') return null;
    // Un enlace en error sin id puede haber dejado el evento creado (tiempo agotado tras crear): se borra por el id determinista.
    await adapter.remove(link.providerEventId ?? projection.eventId);
    return { syncStatus: 'deleted', providerEventId: link.providerEventId, generation, htmlLink: null, payloadHash: null, ...revisions };
  }

  // Guardar sin cambios: mismo hash y enlace al día → no se llama al calendario, solo se anotan las revisiones.
  if (link?.syncStatus === 'synced' && link.payloadHash === projection.payloadHash) {
    return { syncStatus: 'synced', providerEventId: link.providerEventId, generation, htmlLink: link.htmlLink, payloadHash: link.payloadHash, ...revisions };
  }

  // Primera sincronización: si ya hay un evento con el marcador de la reserva, se adopta en vez de duplicar.
  let eventId = link?.providerEventId ?? null;
  if (!eventId && reservation.code) eventId = (await adapter.findByMarker(reservation.code))?.id ?? null;
  const remote = await adapter.upsert(eventId ?? projection.eventId, projection.payload!);
  return { syncStatus: 'synced', providerEventId: remote.id, generation, htmlLink: remote.htmlLink, payloadHash: projection.payloadHash, ...revisions };
}
