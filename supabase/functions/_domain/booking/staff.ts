/**
 * Ikisai Booking · personal en eventos (docs/booking/API.md §15.3): turnos y necesidades de refuerzo. Reglas puras para la interfaz.
 */
import { dayNumber } from './rules.ts';

export interface StaffAssignmentLike {
  id: string;
  event_id: string;
  status: string;
  work_date: string | null;
  planned_hours: number | string | null;
  actual_hours: number | string | null;
  deleted_at?: string | null;
}
export interface StaffNeedLike { id: string; event_id: string; persons: number; priority: string; status: string; deleted_at?: string | null }

const hours = (value: number | string | null): number | null => {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Turnos que cuentan: vivos y no cancelados. */
export function activeShifts<T extends StaffAssignmentLike>(rows: readonly T[]): T[] {
  return rows.filter((r) => !r.deleted_at && r.status !== 'cancelada');
}

/** Horas previstas y reales de un evento (los turnos cancelados no suman). */
export function staffTotals(rows: readonly StaffAssignmentLike[]): { shifts: number; planned: number; actual: number } {
  const live = activeShifts(rows);
  return {
    shifts: live.length,
    planned: round2(live.reduce((sum, r) => sum + (hours(r.planned_hours) ?? 0), 0)),
    actual: round2(live.reduce((sum, r) => sum + (hours(r.actual_hours) ?? 0), 0)),
  };
}

/** Turnos sin horas reales: el aviso que da la ficha al anotar el cierre operativo. */
export function shiftsWithoutActualHours<T extends StaffAssignmentLike>(rows: readonly T[]): T[] {
  return activeShifts(rows).filter((r) => hours(r.actual_hours) === null);
}

/**
 * Necesidades de refuerzo sin cubrir en eventos que están en curso o empiezan en los próximos `days` días.
 * `eventDates` da las fechas de la reserva de cada evento; los eventos sin fechas no avisan.
 */
export function uncoveredNeedsSoon<T extends StaffNeedLike>(
  needs: readonly T[],
  eventDates: ReadonlyMap<string, { start_date: string | null; end_date: string | null }>,
  today: string,
  days = 7,
): T[] {
  const now = dayNumber(today);
  if (now === null) return [];
  return needs.filter((n) => {
    if (n.deleted_at || n.status === 'cubierto') return false;
    const dates = eventDates.get(n.event_id);
    const start = dayNumber(dates?.start_date ?? null);
    const end = dayNumber(dates?.end_date ?? null) ?? start;
    return start !== null && end !== null && end >= now && start <= now + days;
  });
}
