/** SES.HOSPEDAJES (API §17.2, §17.4): comunicaciones de una reserva y reglas de plazo y de cambios. Sin DOM: lo usan la ficha y Inicio. */
import type { SyncClient } from '@ikisai/sync-client';

export type SesStatus = 'preparada' | 'enviando' | 'en_proceso' | 'aceptada' | 'rechazada' | 'anulada' | 'error';

export interface SesCommunication {
  id: string;
  kind: 'RH' | 'PV' | 'anulacion';
  status: SesStatus;
  environment: 'pre' | 'prod' | string;
  cancels_id: string | null;
  lot_id: string | null;
  ses_code: string | null;
  error_code: string | null;
  error_text: string | null;
  legal_start_at: string | null;
  snapshot: { start_date?: string | null; end_date?: string | null; persons?: number | string | null } | null;
  attempts: number | null;
  sent_at: string | null;
  accepted_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
}

/** Estados en que una comunicación de reserva sigue «viva»: impide crear otra. */
export const LIVE_STATUSES: readonly SesStatus[] = ['preparada', 'enviando', 'en_proceso', 'aceptada', 'error'];
/** Reservas que se pueden comunicar (el servidor responde `SES_NOT_CONFIRMED` con cualquier otro estado). */
export const COMMUNICABLE_STATUSES: readonly string[] = ['confirmada', 'en_ejecucion', 'cerrada'];

export const HOUR = 3_600_000;

export async function fetchSes(client: SyncClient, reservationId: string): Promise<SesCommunication[]> {
  const out = await client.api<{ items?: SesCommunication[] }>(`/ses/${encodeURIComponent(reservationId)}`);
  return [...(out.items ?? [])].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

/** Comunicaciones de reserva (RH), la más reciente primero (el orden de entrada ya lo es). */
export const reservationComms = (items: SesCommunication[]): SesCommunication[] => items.filter((c) => c.kind === 'RH');
export const liveReservationComm = (items: SesCommunication[]): SesCommunication | null => reservationComms(items).find((c) => LIVE_STATUSES.includes(c.status)) ?? null;
export const acceptedReservationComm = (items: SesCommunication[]): SesCommunication | null => reservationComms(items).find((c) => c.status === 'aceptada') ?? null;
/** Anulación en curso (aún no resuelta) de una comunicación. */
export const pendingCancellation = (items: SesCommunication[], id: string): SesCommunication | null =>
  items.find((c) => c.kind === 'anulacion' && c.cancels_id === id && ['preparada', 'enviando', 'en_proceso', 'error'].includes(c.status)) ?? null;

export type DeadlineLevel = 'ok' | 'warn' | 'alert' | 'expired';

/** Plazo legal de 24 h: aviso a las 12 h, alerta a las 18 h y vencido a las 24 h desde `startIso`. */
export function deadlineLevel(startIso: string | null | undefined, now = Date.now()): DeadlineLevel | null {
  const start = startIso ? Date.parse(startIso) : NaN;
  if (Number.isNaN(start)) return null;
  const hours = (now - start) / HOUR;
  return hours >= 24 ? 'expired' : hours >= 18 ? 'alert' : hours >= 12 ? 'warn' : 'ok';
}

export const DEADLINE_TEXT: Record<Exclude<DeadlineLevel, 'ok'>, string> = {
  warn: 'Quedan menos de 12 h para comunicar la reserva',
  alert: 'Quedan menos de 6 h para comunicar la reserva',
  expired: 'Plazo legal vencido',
};

const dayOf = (value: string): number => Date.parse(`${value.slice(0, 10)}T00:00:00Z`);

/** ¿Es la fecha de pago anterior en más de un día al momento en que se registró? (el plazo legal cuenta desde el registro). */
export function paymentDateIsOld(paymentDate: unknown, registeredAt: unknown): boolean {
  if (typeof paymentDate !== 'string' || !paymentDate || typeof registeredAt !== 'string' || !registeredAt) return false;
  const diff = (dayOf(registeredAt) - dayOf(paymentDate)) / (24 * HOUR);
  return Number.isFinite(diff) && diff > 1;
}

export interface ReservationShape { status: string; start_date: string | null; end_date: string | null; expected_guests: number | null }

/** ¿Cambió la reserva desde que se comunicó? Cancelada o perdida, o fechas o personas distintas de las de la comunicación aceptada. */
export function changedSinceCommunicated(reservation: ReservationShape, finalGuests: number | null | undefined, accepted: SesCommunication): boolean {
  if (['cancelada', 'perdida'].includes(reservation.status)) return true;
  const snap = accepted.snapshot;
  if (!snap) return false;
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const persons = finalGuests ?? reservation.expected_guests;
  const snapPersons = snap.persons === undefined || snap.persons === null ? null : Number(snap.persons);
  return !same(snap.start_date?.slice(0, 10), reservation.start_date?.slice(0, 10)) || !same(snap.end_date?.slice(0, 10), reservation.end_date?.slice(0, 10))
    || !same(snapPersons, persons === null || persons === undefined ? null : Number(persons));
}
