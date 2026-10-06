/** Ikisai Booking · reglas puras: valores derivados que no se guardan (docs/booking/API.md §2.1, §2.1.1 y §2.2). */
import { STATUSES_REQUIRING_EVENT, STATUSES_WITHOUT_DATES, type ReservationStatus } from './catalog.ts';

export interface ReservationLike {
  status: ReservationStatus;
  start_date: string | null;
  end_date: string | null;
  expected_guests: number | null;
  archived_at?: string | null;
  deleted_at?: string | null;
}

export interface FinanceLike {
  deposit_required: number | string | null;
  deposit_paid: number | string | null;
}

export interface EventLike {
  preparation_status: string;
  closed_at: string | null;
  deleted_at?: string | null;
}

export type DepositStatus = 'no_aplica' | 'pendiente' | 'parcial' | 'completado';
export type EventPhase = 'pendiente_preparacion' | 'preparado' | 'en_ejecucion' | 'cerrado' | 'cancelado';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Día civil (sin zona horaria) como número de días desde la época; null si la fecha no es válida. */
export function dayNumber(date: string | null | undefined): number | null {
  const m = typeof date === 'string' ? DATE.exec(date) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / 86_400_000);
}

export function isValidDate(date: unknown): date is string {
  return typeof date === 'string' && dayNumber(date) !== null;
}

/** Noches de la estancia: `end_date - start_date`. null si falta alguna fecha. */
export function nights(startDate: string | null, endDate: string | null): number | null {
  const a = dayNumber(startDate);
  const b = dayNumber(endDate);
  if (a === null || b === null || b < a) return null;
  return b - a;
}

function amount(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Estado de la señal (C03 §7). PostgREST devuelve `numeric` como número o texto: se aceptan ambos. */
export function depositStatus(finance: FinanceLike | null | undefined): DepositStatus {
  const required = amount(finance?.deposit_required);
  if (required <= 0) return 'no_aplica';
  const paid = amount(finance?.deposit_paid);
  if (paid <= 0) return 'pendiente';
  return paid < required ? 'parcial' : 'completado';
}

export function isArchived(reservation: { archived_at?: string | null }): boolean {
  return reservation.archived_at !== null && reservation.archived_at !== undefined;
}

export function requiresEvent(status: ReservationStatus): boolean {
  return STATUSES_REQUIRING_EVENT.includes(status);
}

/** Campos que faltan para poder pre-reservar o confirmar (mismos que exige `booking.confirm_reservation`). */
export function missingForConfirmation(reservation: ReservationLike): Array<'start_date' | 'end_date' | 'expected_guests'> {
  const missing: Array<'start_date' | 'end_date' | 'expected_guests'> = [];
  if (!reservation.start_date) missing.push('start_date');
  if (!reservation.end_date) missing.push('end_date');
  if (reservation.expected_guests === null || reservation.expected_guests === undefined) missing.push('expected_guests');
  return missing;
}

/** ¿Puede la reserva pasar a `status` con los datos que tiene? (restricción `reservations_dates_required`). */
export function canHoldStatus(reservation: ReservationLike, status: ReservationStatus): boolean {
  return STATUSES_WITHOUT_DATES.includes(status) || missingForConfirmation(reservation).length === 0;
}

/** Fase del evento operativo (el `estado_evento` de C04), derivada de la reserva y del propio evento. */
export function eventPhase(reservation: Pick<ReservationLike, 'status'>, event: EventLike): EventPhase {
  if (reservation.status === 'cancelada' || reservation.status === 'perdida') return 'cancelado';
  if (event.closed_at || reservation.status === 'cerrada') return 'cerrado';
  if (reservation.status === 'en_ejecucion') return 'en_ejecucion';
  return event.preparation_status === 'hecha' ? 'preparado' : 'pendiente_preparacion';
}
