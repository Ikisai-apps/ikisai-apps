/**
 * «Espacios de este evento» (1430, booking-U1, VG 06-11-2026): el personal marca qué espacios usa esta reserva. Va en
 * Operación. Solo editor u owner marcan; el resto lo ve.
 */
import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import { el, fieldAttrs, plural } from '@ikisai/ui-kit';
import { EVENT_SPACES } from '../app/client.ts';
import { eventSpaceItems, eventSpaceOp } from '../app/eventSpaces.ts';

type Row = SyncedRow & Record<string, any>;

export function renderEventSpaces(o: { event: Row; spaces: Row[]; marks: Row[]; editable: boolean; run: (ops: RowOperation[], message: string) => Promise<boolean> }): HTMLElement {
  const eventId = String(o.event.id);
  const items = eventSpaceItems(o.spaces, o.marks, eventId);
  const count = items.filter((i) => i.marked).length;
  const rows = items.map((item) => {
    const box = el('input', { type: 'checkbox', ...fieldAttrs({ id: 'booking.reserva.espacios.marca', entity: 'booking.event_spaces', prop: 'space_id', label: 'Espacio de este evento', confirm: 'event' }), checked: item.marked, disabled: !o.editable, 'data-space': item.id, 'aria-label': item.name });
    box.addEventListener('change', () => {
      const op = eventSpaceOp(item, eventId, box.checked, () => crypto.randomUUID(), EVENT_SPACES);
      if (op) void o.run([op as RowOperation], box.checked ? `${item.name}: marcado para este evento.` : `${item.name}: ya no se usa en este evento.`);
    });
    return el('li', null, el('label', { class: 'check' }, box, el('span', null, item.name), item.zone ? el('span', { class: 'hint' }, ` · ${item.zone}`) : null));
  });
  return el('article', { class: 'card', id: 'blockEventSpaces', 'data-feedback-id': 'booking.reserva.espacios', 'data-feedback-label': 'Espacios de este evento' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Espacios de este evento')),
    el('p', { class: 'hint', id: 'eventSpacesCount' }, count ? plural(count, 'espacio marcado', 'espacios marcados') : 'Ningún espacio marcado todavía.'),
    items.length ? el('ul', { class: 'plain', id: 'eventSpacesList' }, rows) : el('p', { class: 'hint' }, 'No hay espacios en Recursos.'));
}
