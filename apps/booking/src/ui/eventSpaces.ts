/**
 * «Espacios de este evento» (1430, booking-U1, VG 06-11-2026): el personal marca qué espacios usa esta reserva. Va en
 * Operación. Solo editor u owner marcan; el resto lo ve.
 * Debajo de cada marca, «También para todos los eventos» (1432, VG 06-11): con confirmación, Booking pide a Central que el
 * espacio sea de alojamiento para todos (booking-api → `worker/space-use`). Booking no escribe en Recursos; si falla, la
 * marca del evento se queda y se avisa.
 */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, el, fieldAttrs, plural, toast } from '@ikisai/ui-kit';
import { EVENT_SPACES, describeError } from '../app/client.ts';
import { eventSpaceItems, eventSpaceOp, type EventSpaceItem } from '../app/eventSpaces.ts';

type Row = SyncedRow & Record<string, any>;

export function renderEventSpaces(o: { client: SyncClient; event: Row; spaces: Row[]; marks: Row[]; editable: boolean; run: (ops: RowOperation[], message: string) => Promise<boolean> }): HTMLElement {
  const eventId = String(o.event.id);
  const items = eventSpaceItems(o.spaces, o.marks, eventId);
  const count = items.filter((i) => i.marked).length;
  const rows = items.map((item) => {
    const box = el('input', { type: 'checkbox', ...fieldAttrs({ id: 'booking.reserva.espacios.marca', entity: 'booking.event_spaces', prop: 'space_id', label: 'Espacio de este evento', confirm: 'event' }), checked: item.marked, disabled: !o.editable, 'data-space': item.id, 'aria-label': item.name });
    box.addEventListener('change', () => {
      const op = eventSpaceOp(item, eventId, box.checked, () => crypto.randomUUID(), EVENT_SPACES);
      if (op) void o.run([op as RowOperation], box.checked ? `${item.name}: marcado para este evento.` : `${item.name}: ya no se usa en este evento.`);
    });
    return el('li', null, el('label', { class: 'check' }, box, el('span', null, item.name), item.zone ? el('span', { class: 'hint' }, ` · ${item.zone}`) : null),
      item.marked && item.fromResources ? allEvents(item) : null);
  });
  function allEvents(item: EventSpaceItem): HTMLElement {
    const box = el('input', { type: 'checkbox', ...fieldAttrs({ id: 'booking.reserva.espacios.todos', entity: 'resources.spaces', prop: 'uses', label: 'También para todos los eventos', confirm: 'event' }),
      checked: item.lodging, disabled: !o.editable || item.lodging, 'aria-label': `${item.name}: también para todos los eventos` }) as HTMLInputElement;
    box.addEventListener('change', async () => {
      if (!box.checked) return;
      const go = await confirmDialog({ title: 'También para todos los eventos', text: `Se pedirá a Central que ${item.name} sea de alojamiento para todos los eventos.`, confirmLabel: 'Pedir a Central' });
      if (!go) { box.checked = false; return; }
      box.disabled = true;
      try {
        await o.client.api(`/event-spaces/${item.markId}/all-events`, { method: 'POST', json: {} });
        toast(`Pedido a Central: ${item.name} será de alojamiento para todos los eventos.`);
      } catch (error) {
        box.checked = false; box.disabled = false;
        toast(`No se ha podido pedir a Central (${describeError(error)}). La marca de este evento se mantiene.`);
      }
    });
    return el('label', { class: 'check small' }, box, el('span', null, item.lodging ? 'De alojamiento para todos los eventos' : 'También para todos los eventos'));
  }
  return el('article', { class: 'card', id: 'blockEventSpaces', 'data-feedback-id': 'booking.reserva.espacios', 'data-feedback-label': 'Espacios de este evento' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Espacios de este evento')),
    el('p', { class: 'hint', id: 'eventSpacesCount' }, count ? plural(count, 'espacio marcado', 'espacios marcados') : 'Ningún espacio marcado todavía.'),
    items.length ? el('ul', { class: 'plain', id: 'eventSpacesList' }, rows) : el('p', { class: 'hint' }, 'No hay espacios en Recursos.'));
}
