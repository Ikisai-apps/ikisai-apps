/**
 * Espacios de un evento (1430, booking-U1, VG 06-11-2026): qué espacios usa ESTA reserva. Los usos generales de cada
 * espacio (alojamiento, eventos…) son de Recursos y los edita Central; aquí solo la marca del evento.
 * Funciones puras (sin DOM ni red).
 */

type Row = Record<string, any>;
const live = (rows: Row[]) => rows.filter((r) => !r.deleted_at);

export interface EventSpaceItem {
  id: string; name: string; zone: string | null; marked: boolean; markId: string | null; markRevision: number | null;
  /** Ya es de alojamiento para todos los eventos (uso general en Recursos, 1431). */
  lodging: boolean;
  /** Viene de Recursos: se puede pedir a Central su uso general (1432). */
  fromResources: boolean;
}

/** Los espacios vivos y activos, por zona y orden, con su marca para el evento. Un espacio inactivo ya marcado sigue saliendo. */
export function eventSpaceItems(spaces: Row[], marks: Row[], eventId: string): EventSpaceItem[] {
  const markOf = new Map(live(marks).filter((m) => m.event_id === eventId).map((m) => [m.space_id, m]));
  return live(spaces).filter((s) => s.active || markOf.has(s.id))
    .sort((a, b) => String(a.zone ?? '').localeCompare(String(b.zone ?? ''), 'es') || Number(a.position ?? 0) - Number(b.position ?? 0) || String(a.name).localeCompare(String(b.name), 'es'))
    .map((s) => {
      const m = markOf.get(s.id);
      return { id: s.id, name: s.public_name || s.name, zone: s.zone ?? null, marked: !!m, markId: m?.id ?? null, markRevision: m ? Number(m.revision) : null,
        lodging: Array.isArray(s.uses) && s.uses.includes('alojamiento'), fromResources: !!s.resource_id };
    });
}

/** Operación para marcar o desmarcar un espacio (ninguna si ya está así). */
export function eventSpaceOp(item: EventSpaceItem, eventId: string, on: boolean, newId: () => string, table = 'booking.event_spaces'): Row | null {
  if (on === item.marked) return null;
  return on
    ? { op: 'insert', table, id: newId(), fields: { event_id: eventId, space_id: item.id } }
    : { op: 'delete', table, id: item.markId, expectedRevision: item.markRevision };
}
