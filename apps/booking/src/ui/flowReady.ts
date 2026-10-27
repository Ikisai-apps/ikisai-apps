/**
 * «Listo para Flow» en la ficha del evento (Core, 27-10-2026): si Flow verá los huéspedes del evento y, si no, qué falla,
 * en una línea. Lee `booking.flow_readiness` (0492) y los flujos enlazados que publica Flow
 * (`flow.booking_event_flows_projection`, Flow 0922); si no se puede leer, lo dice en vez de dar un «sí» a ciegas.
 * Una lectura por evento y visita (como «Servicio de barra»), con red.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { el, replace } from '@ikisai/ui-kit';
import { flowReadyLine, READS, type FlowLinks, type FlowReadiness } from '@ikisai/domain-booking';
import { describeError } from '../app/client.ts';

export const FLOW_LINKS = 'flow.booking_event_flows_projection';

export function renderFlowReady(o: { client: SyncClient; reservationId: string; eventId: string }): HTMLElement {
  const line = el('p', { class: 'hint', id: 'flowReadyLine', 'aria-live': 'polite' }, 'Comprobando…');
  const card = el('article', { class: 'card', id: 'blockFlowReady', 'data-feedback-id': 'booking.reserva.flow_listo', 'data-feedback-label': 'Listo para Flow' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Listo para Flow')), line);

  async function load(): Promise<void> {
    if (!navigator.onLine) return void (line.textContent = 'Se comprueba con conexión.');
    let readiness: FlowReadiness;
    try {
      readiness = await o.client.api<FlowReadiness>(`/read/${READS.flowReadiness}`, { method: 'POST', json: { reservation_id: o.reservationId } });
    } catch (error) {
      return void (line.textContent = `No se puede comprobar: ${describeError(error)}`);
    }
    let flows: FlowLinks = null;
    try {
      flows = ((await o.client.api<{ rows: unknown[] }>(`/read/${FLOW_LINKS}?where[event_id]=${encodeURIComponent(o.eventId)}&limit=50`)).rows ?? []).length;
    } catch { flows = null; }
    const out = flowReadyLine(readiness, flows);
    replace(line, el('span', { class: `chip${out.ok ? ' ok' : out.unknown ? '' : ' alert'}` }, out.ok ? 'Listo' : out.unknown ? 'Sin comprobar' : 'No listo'), ` ${out.text}`);
  }

  void load();
  return card;
}
