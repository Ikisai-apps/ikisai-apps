/**
 * Booking · estancias de outsider y del staff (O2, API.md §26). Regla pura, espejo de `booking.stay_clashes`
 * (migración 0467; la prueba compara las dos): con qué choca una estancia en su cama, o en su habitación si un retiro la
 * tiene entera sin cama. Un choque es un aviso, nunca un bloqueo.
 */
import type { StayKind } from './catalog.ts';

export interface StayLike {
  id: string;
  kind: StayKind;
  account_id: string;
  from_date: string;
  to_date: string;
  space_id: string | null;
  bed_id: string | null;
  deleted_at?: string | null;
}

export interface ClashAssignment {
  event_id: string;
  space_id: string | null;
  bed_id: string | null;
  from_date?: string | null;
  to_date?: string | null;
  deleted_at?: string | null;
}

export interface ClashReservation {
  id: string;
  title: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
}

export type StayClash =
  | { kind: 'retiro'; reservation_id: string; title: string; from: string; to: string }
  | { kind: 'estancia'; stay_id: string; from: string; to: string };

const DEAD = ['cancelada', 'perdida'];

/** Noches [desde, hasta) que se solapan. */
const overlaps = (aFrom: string, aTo: string, bFrom: string, bTo: string) => aFrom < bTo && bFrom < aTo;

export function stayClashes(
  stay: StayLike,
  data: { assignments: readonly ClashAssignment[]; events: ReadonlyArray<{ id: string; reservation_id: string; deleted_at?: string | null }>; reservations: readonly ClashReservation[]; stays: readonly StayLike[] },
): StayClash[] {
  if (stay.deleted_at || !stay.space_id) return [];
  const reservationOf = new Map(data.reservations.filter((r) => !r.deleted_at && !r.archived_at && !DEAD.includes(r.status)).map((r) => [r.id, r]));
  const eventRes = new Map(data.events.filter((e) => !e.deleted_at && reservationOf.has(e.reservation_id)).map((e) => [e.id, reservationOf.get(e.reservation_id)!]));
  const out = new Map<string, StayClash>();
  for (const a of data.assignments) {
    if (a.deleted_at) continue;
    const r = eventRes.get(a.event_id);
    if (!r) continue;
    const here = (stay.bed_id !== null && a.bed_id === stay.bed_id) || (a.bed_id === null && a.space_id === stay.space_id);
    const from = a.from_date ?? r.start_date; const to = a.to_date ?? r.end_date;
    if (!here || !from || !to || !overlaps(from, to, stay.from_date, stay.to_date)) continue;
    out.set(`${r.id}|${from}|${to}`, { kind: 'retiro', reservation_id: r.id, title: r.title, from, to });
  }
  if (stay.bed_id) {
    for (const s of data.stays) {
      if (s.id === stay.id || s.deleted_at || s.bed_id !== stay.bed_id || !overlaps(s.from_date, s.to_date, stay.from_date, stay.to_date)) continue;
      out.set(`s|${s.id}`, { kind: 'estancia', stay_id: s.id, from: s.from_date, to: s.to_date });
    }
  }
  return [...out.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.kind < b.kind ? -1 : 1));
}

/** Estancias vivas que usan una cama en alguna de las noches [desde, hasta) (aviso en la ficha › Alojamiento). */
export function staysOnBed(bedId: string, from: string | null, to: string | null, stays: readonly StayLike[]): StayLike[] {
  if (!from || !to) return [];
  return stays.filter((s) => !s.deleted_at && s.bed_id === bedId && overlaps(s.from_date, s.to_date, from, to))
    .sort((a, b) => (a.from_date < b.from_date ? -1 : 1));
}

/** Días [desde, hasta) con alguien del staff en casa. */
export function staffPresentDays(stays: readonly StayLike[], from: string, to: string): Set<string> {
  const days = new Set<string>();
  for (const s of stays) {
    if (s.deleted_at || s.kind !== 'staff') continue;
    for (let d = s.from_date > from ? s.from_date : from; d < s.to_date && d < to; d = nextDay(d)) days.add(d);
  }
  return days;
}

export function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}
