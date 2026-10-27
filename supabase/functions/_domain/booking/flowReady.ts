/**
 * «Listo para Flow» (Core, 27-10-2026; lectura `booking.flow_readiness`, 0492): si Flow verá los huéspedes del evento
 * con `booking.flow_guests_of` (0486) y, si no, la condición que falla en una línea. Sin DOM ni red.
 */

/** Lo que devuelve `booking.flow_readiness`. */
export interface FlowReadiness {
  event_id: string | null;
  failing: 'reservation_closed' | 'no_event' | 'no_guests' | null;
  status: string; guests: number; preview: number; anonymized: number;
}

/** Flujos de Flow enlazados al evento: un número, o `null` si Flow aún no lo publica a Booking o no se pudo leer. */
export type FlowLinks = number | null;

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** La línea del indicador: `ok` solo si todo lo comprobable se cumple y hay flujo enlazado. */
export function flowReadyLine(r: FlowReadiness, flows: FlowLinks): { ok: boolean; unknown: boolean; text: string } {
  if (r.failing === 'reservation_closed') return { ok: false, unknown: false, text: `No: la reserva está ${r.status}; Flow no ve a sus huéspedes.` };
  if (r.failing === 'no_event') return { ok: false, unknown: false, text: 'No: la reserva no tiene evento; se crea al confirmarla.' };
  if (flows === 0) return { ok: false, unknown: false, text: 'No: ningún flujo de Flow está enlazado a este evento. En Flow, elige este evento en el flujo.' };
  if (r.failing === 'no_guests') {
    const hidden = [r.preview ? n(r.preview, 'de muestra', 'de muestra') : null, r.anonymized ? n(r.anonymized, 'anonimizado', 'anonimizados') : null].filter(Boolean);
    return { ok: false, unknown: false, text: `No: el evento no tiene huéspedes que Flow pueda ver${hidden.length ? ` (no cuentan: ${hidden.join(' y ')})` : ''}.` };
  }
  const who = n(r.guests, 'huésped', 'huéspedes');
  if (flows === null) return { ok: false, unknown: true, text: `Booking está listo (${who}); falta comprobar en Flow que hay un flujo enlazado a este evento.` };
  return { ok: true, unknown: false, text: `Sí: Flow ve ${who} en ${n(flows, 'flujo', 'flujos')}. Cada persona necesita el flujo en su ámbito.` };
}
