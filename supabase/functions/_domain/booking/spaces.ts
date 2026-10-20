/**
 * Ikisai Booking · espacios, camas y alojamiento (docs/booking/API.md §15.1): reglas puras para la interfaz.
 * La regla dura (una cama, una ocupación por noche) la impone también el hook SQL `booking.check_space_invariants`.
 */
import { dayNumber } from './rules.ts';

export interface SpaceLike { id: string; kind: string; capacity: number | null; active: boolean; bookable?: boolean; deleted_at?: string | null }
export interface BedLike { id: string; space_id: string; kind?: string; capacity: number; active: boolean; deleted_at?: string | null }
export interface AssignmentLike {
  id: string;
  event_id: string;
  space_id: string;
  bed_id: string | null;
  persons: number;
  from_date: string | null;
  to_date: string | null;
  deleted_at?: string | null;
}

const live = <T extends { deleted_at?: string | null }>(rows: readonly T[]): T[] => rows.filter((r) => !r.deleted_at);

export const isExtraBed = (bed: Pick<BedLike, 'kind'>): boolean => bed.kind === 'supletoria';

/** ¿Duerme gente aquí? Las habitaciones y, desde la tanda 36 (MUELA-049), cualquier estancia con camas. */
export const sleepsHere = (space: SpaceLike, beds: readonly BedLike[]): boolean =>
  space.kind === 'habitacion' || live(beds).some((b) => b.space_id === space.id);

/** Plazas base de un espacio: suma de camas activas no supletorias donde se duerme; `capacity` en salas y zonas sin camas. */
export function spaceCapacity(space: SpaceLike, beds: readonly BedLike[]): number {
  if (!sleepsHere(space, beds)) return space.capacity ?? 0;
  return live(beds).filter((b) => b.space_id === space.id && b.active && !isExtraBed(b)).reduce((sum, b) => sum + b.capacity, 0);
}

/** Plazas en camas supletorias activas de un espacio (no cuentan en la capacidad base). */
export function extraCapacity(space: SpaceLike, beds: readonly BedLike[]): number {
  return live(beds).filter((b) => b.space_id === space.id && b.active && isExtraBed(b)).reduce((sum, b) => sum + b.capacity, 0);
}

/** ¿Se ofrece para asignar? Activo y reservable. */
export const isBookable = (space: SpaceLike): boolean => !space.deleted_at && space.active && space.bookable !== false;

/** Camas supletorias que un evento tiene asignadas (activadas en esa reserva): la propuesta las cobra como extra. */
export function extraBedsInUse(eventId: string, beds: readonly BedLike[], assignments: readonly AssignmentLike[]): BedLike[] {
  const used = new Set(live(assignments).filter((a) => a.event_id === eventId && a.bed_id).map((a) => a.bed_id));
  return live(beds).filter((b) => isExtraBed(b) && used.has(b.id));
}

/** Supletoria activada para un evento (`booking.event_extra_beds`): por el organizador desde su portal o por el personal. */
export interface ExtraBedLike { id: string; event_id: string; bed_id: string; status: string; source?: string; deleted_at?: string | null }

/** Activadas que se cobran: `active` y, mientras Ikisai no la quite, `release_requested`. Las `requested` aún no. */
const CHARGED = new Set(['active', 'release_requested']);

/**
 * Supletorias que se cobran a un evento: las activadas (aunque nadie las ocupe) y las ocupadas sin activar, como hoy
 * (decisión del usuario, 13-10-2026). Sin filas de activación, igual que `extraBedsInUse`.
 */
export function extraBedsCharged(eventId: string, beds: readonly BedLike[], assignments: readonly AssignmentLike[], extraBeds: readonly ExtraBedLike[] = []): BedLike[] {
  const activated = new Set(live(extraBeds).filter((x) => x.event_id === eventId && CHARGED.has(x.status)).map((x) => x.bed_id));
  const used = new Set(extraBedsInUse(eventId, beds, assignments).map((b) => b.id));
  return live(beds).filter((b) => isExtraBed(b) && (activated.has(b.id) || used.has(b.id)));
}

/** Activaciones del evento pendientes de Ikisai (pedidas, o con la retirada pedida, tras aceptar la propuesta). */
export function extraBedsPending(eventId: string, extraBeds: readonly ExtraBedLike[]): ExtraBedLike[] {
  return live(extraBeds).filter((x) => x.event_id === eventId && (x.status === 'requested' || x.status === 'release_requested'));
}

export interface Occupancy { spaceId: string; persons: number; capacity: number; over: boolean }

/** Ocupación de cada espacio en un evento (personas asignadas frente a plazas). Pasarse es un aviso, no un error. */
export function eventOccupancy(eventId: string, spaces: readonly SpaceLike[], beds: readonly BedLike[], assignments: readonly AssignmentLike[], extraBeds: readonly ExtraBedLike[] = []): Occupancy[] {
  const mine = live(assignments).filter((a) => a.event_id === eventId);
  return live(spaces).filter((s) => mine.some((a) => a.space_id === s.id)).map((space) => {
    const persons = mine.filter((a) => a.space_id === space.id).reduce((sum, a) => sum + a.persons, 0);
    // las supletorias activadas u ocupadas en este evento suman a la capacidad base
    const extra = extraBedsCharged(eventId, beds, mine, extraBeds).filter((b) => b.space_id === space.id).reduce((sum, b) => sum + b.capacity, 0);
    const capacity = spaceCapacity(space, beds) + extra;
    return { spaceId: space.id, persons, capacity, over: persons > capacity };
  });
}

/** Noches [desde, hasta) de una asignación; sin fechas propias, las de la reserva. */
export function assignmentNights(a: Pick<AssignmentLike, 'from_date' | 'to_date'>, reservation: { start_date: string | null; end_date: string | null }): [number, number] | null {
  const from = dayNumber(a.from_date ?? reservation.start_date);
  const to = dayNumber(a.to_date ?? reservation.end_date);
  return from === null || to === null || to <= from ? null : [from, to];
}

/**
 * Asignaciones que ya ocupan la cama en alguna de esas noches (para avisar antes de guardar, también sin red).
 * `others` trae cada asignación con las fechas de su reserva; quien llama descarta reservas canceladas, perdidas o archivadas.
 */
export function bedConflicts(
  bedId: string,
  nights: [number, number],
  others: ReadonlyArray<{ assignment: AssignmentLike; reservation: { start_date: string | null; end_date: string | null } }>,
  exceptId?: string,
): AssignmentLike[] {
  return others.filter(({ assignment, reservation }) => {
    if (assignment.deleted_at || assignment.bed_id !== bedId || assignment.id === exceptId) return false;
    const other = assignmentNights(assignment, reservation);
    return other !== null && nights[0] < other[1] && other[0] < nights[1];
  }).map(({ assignment }) => assignment);
}
