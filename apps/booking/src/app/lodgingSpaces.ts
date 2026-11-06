/**
 * Qué espacios enseña Booking (1431, booking-U1, VG 06-11-2026): en montaje, árbol y asignación, los que tienen el uso
 * «alojamiento» en Recursos (lo edita Central; el espejo lo copia en `booking.spaces.uses`), los que tienen camas (por
 * seguridad) y, dentro de un evento, los marcados en él (`booking.event_spaces`). Funciones puras (sin DOM ni red).
 */

type Row = Record<string, any>;
const live = (rows: readonly Row[]) => rows.filter((r) => !r.deleted_at);

export const LODGING_USE = 'alojamiento';

/** Ids de Booking de los espacios que se enseñan. */
export function lodgingSpaceIds(spaces: readonly Row[], beds: readonly Row[], markedSpaceIds: Iterable<string> = []): Set<string> {
  const withBeds = new Set(live(beds).map((b) => b.space_id));
  const marked = new Set(markedSpaceIds);
  return new Set(live(spaces).filter((s) => (Array.isArray(s.uses) && s.uses.includes(LODGING_USE)) || withBeds.has(s.id) || marked.has(s.id)).map((s) => s.id as string));
}

/** Los mismos, por su id de Recursos (el árbol y el plano leen Recursos). */
export function lodgingResourceIds(spaces: readonly Row[], beds: readonly Row[], markedSpaceIds: Iterable<string> = []): Set<string> {
  const ids = lodgingSpaceIds(spaces, beds, markedSpaceIds);
  return new Set(live(spaces).filter((s) => ids.has(s.id) && s.resource_id).map((s) => s.resource_id as string));
}

/** Filtro de una fila de Recursos (árbol o plano): la cama va con su habitación. */
export function showsResource(allowed: ReadonlySet<string>, row: { id: string; parentId: string | null; kind: string }): boolean {
  return row.kind === 'cama' ? row.parentId !== null && allowed.has(row.parentId) : allowed.has(row.id);
}
