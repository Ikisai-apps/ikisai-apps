/** Booking · carriles de Recepción (traspaso §4.3): la misma estancia filtrada, con cuatro indicadores independientes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneCards, receptionCards, type ReceptionInput } from '../../apps/booking/src/app/receptionLanes.ts';
import { missingForSes } from '../../supabase/functions/_domain/booking/mod.ts';

const TODAY = '2032-06-05';
const NOW = Date.parse('2032-06-05T12:00:00Z');
const base = (): ReceptionInput => ({
  today: TODAY, now: NOW, seesGuests: true,
  reservations: [{ id: 'r', event_type: 'jornadas_abiertas', status: 'confirmada', start_date: '2032-06-04', end_date: '2032-06-07' },
    { id: 'r2', event_type: 'retiro', status: 'confirmada', start_date: '2032-06-04', end_date: '2032-06-07' }],
  events: [{ id: 'e', reservation_id: 'r' }, { id: 'e2', reservation_id: 'r2' }],
  spaces: [{ id: 's', name: 'Hab 1', public_name: 'Pinar' }],
  beds: [{ id: 'b1', space_id: 's', label: 'Cama 1' }, { id: 'b2', space_id: 's', label: 'Cama 2' }, { id: 'b3', space_id: 's', label: 'Cama 3' }],
  requests: [], guests: [], assignments: [], charges: [], drafts: [],
});
const complete = { first_name: 'Ana', last_name_1: 'S', birth_date: '1990-01-01', residence_address: 'C', residence_postal_code: '0', residence_city: 'X', residence_country: 'ESP', email: 'a@example.invalid', document_type: 'Pasaporte', document_number: 'P1' };
// los euros llevan espacio duro: se comparan con espacios normales
const cards = (i: ReceptionInput) => receptionCards(i, (g) => missingForSes(g as never)).map((c) => ({ ...c, cobro: { ...c.cobro, text: c.cobro.text.replace(/\s/g, ' ') } }));

test('Por confirmar: solicitudes con número; caducada también en Excepciones', () => {
  const i = base();
  i.requests = [
    { id: 'q1', kind: 'stay', status: 'pendiente', event_id: 'e', number: 7, name: 'Lucía', persons: 1, total_cents: 1800, pay_mode: 'hold', hold_until: '2032-06-05T13:00:00Z', hold_bed_ids: ['b1'] },
    { id: 'q2', kind: 'stay', status: 'pendiente', event_id: 'e', number: 8, name: 'Leo', persons: 1, total_cents: 1800, pay_mode: 'hold', hold_until: '2032-06-05T11:00:00Z', hold_bed_ids: ['b2'] },
    { id: 'q3', kind: 'stay', status: 'pendiente', event_id: 'e2', number: 9, name: 'Otro evento', persons: 1, total_cents: 1, pay_mode: 'hold', hold_until: '2032-06-05T13:00:00Z' },
  ];
  i.drafts = [{ request_id: 'q1', position: 1, ...complete }];
  const all = cards(i);
  assert.deepEqual(laneCards(all, 'confirmar').map((c) => c.number), [7, 8], 'solo jornadas abiertas');
  const q1 = all.find((c) => c.number === 7)!;
  assert.deepEqual([q1.plaza.text, q1.cobro.text, q1.docs.text, q1.presencia.text], ['Retenida: Pinar · Cama 1', 'Por cobrar 18,00 €', 'Completa', 'Por llegar']);
  assert.deepEqual(laneCards(all, 'excepciones').map((c) => c.number), [8]);
  assert.equal(all.find((c) => c.number === 8)!.plaza.tone, 'alert');
  assert.deepEqual(laneCards(all, 'confirmar', '8').map((c) => c.number), [8], 'buscar por número');
});

test('entradas, estancia, salidas y excepciones de huéspedes: los indicadores no dependen unos de otros', () => {
  const i = base();
  i.guests = [
    { id: 'llega', event_id: 'e', first_name: 'Llega', ...{} },
    { id: 'dentro', event_id: 'e', arrived_at: '2032-06-04T18:00:00Z', ...complete, first_name: 'Dentro' },
    { id: 'sale', event_id: 'e', arrived_at: '2032-06-04T18:00:00Z', ...complete, first_name: 'Sale' },
    { id: 'salio', event_id: 'e', arrived_at: '2032-06-04T18:00:00Z', left_at: '2032-06-05T09:00:00Z', ...complete, first_name: 'Salió' },
    { id: 'dia', event_id: 'e', arrived_at: '2032-06-05T10:00:00Z', ses_status: 'no_aplica', data_status: 'no_aplica', first_name: 'Día' },
    { id: 'equipo', event_id: 'e', portal_role: 'staff', first_name: 'Equipo' },
  ];
  i.assignments = [
    { id: 'a-llega', guest_id: 'llega', bed_id: 'b1', from_date: TODAY, to_date: '2032-06-06' },
    { id: 'a-dentro', guest_id: 'dentro', bed_id: 'b2', from_date: '2032-06-04', to_date: '2032-06-07' },
    { id: 'a-sale', guest_id: 'sale', bed_id: 'b3', from_date: '2032-06-04', to_date: TODAY },
    { id: 'a-salio', guest_id: 'salio', bed_id: 'b3', from_date: '2032-06-04', to_date: TODAY, planned_to_date: '2032-06-06' },
  ];
  i.charges = [
    { id: 'c-llega', assignment_id: 'a-llega', amount_cents: 1800 },
    { id: 'c-dentro', assignment_id: 'a-dentro', amount_cents: 5400 },
    { id: 'c-sale', assignment_id: 'a-sale', amount_cents: 1800, paid_at: '2032-06-04T18:00:00Z', finance_sent_at: '2032-06-04T18:01:00Z' },
  ];
  const all = cards(i);
  const names = (lane: Parameters<typeof laneCards>[1]) => laneCards(all, lane).map((c) => c.title.split(' ')[0]).sort();
  assert.deepEqual(names('entradas'), ['Llega']);
  assert.deepEqual(names('estancia'), ['Dentro', 'Día', 'Sale']);
  assert.deepEqual(names('salidas'), ['Sale', 'Salió']);
  // Dentro: cobro pendiente con la cama ocupada; Llega: datos incompletos el día que entra; Día: sin cama, pero sin SES
  assert.deepEqual(names('excepciones'), ['Dentro', 'Día', 'Llega']);
  const dentro = all.find((c) => c.guestId === 'dentro')!;
  assert.deepEqual([dentro.plaza.tone, dentro.cobro.text, dentro.docs.text, dentro.presencia.text], ['ok', 'Pendiente 54,00 €', 'Completa', 'Dentro'], 'bien de plaza y datos, pendiente de cobro');
  const dia = all.find((c) => c.guestId === 'dia')!;
  assert.deepEqual([dia.docs.text, dia.why], ['Sin pernocta · sin SES', ['Sin cama']]);
  assert.equal(all.find((c) => c.guestId === 'sale')!.presencia.text, 'Dentro · sale hoy');
  assert.equal(all.find((c) => c.guestId === 'salio')!.presencia.text, 'Ha salido · limpieza pedida');
  assert.ok(!all.some((c) => c.guestId === 'equipo'), 'las fichas de equipo no salen');
});

test('sin el ámbito de huéspedes: ni nombres ni documentación', () => {
  const i = base();
  i.seesGuests = false;
  i.guests = [{ id: 'g', event_id: 'e', first_name: 'Secreta' }];
  i.assignments = [{ id: 'a', guest_id: 'g', bed_id: 'b1', from_date: TODAY, to_date: '2032-06-06' }];
  const [card] = cards(i);
  assert.deepEqual([card!.title, card!.docs.text], ['Huésped', '—']);
});

test('pagado en línea (1413): sale «Pagado en línea» y no caduca aunque haya pasado la retención', () => {
  const i = base();
  i.requests = [{ id: 'q9', kind: 'stay', status: 'pendiente', event_id: 'e', number: 12, name: 'Lía', persons: 1, total_cents: 5000, pay_mode: 'online', hold_until: '2032-06-05T11:00:00Z', hold_bed_ids: ['b1'] }];
  i.payments = [{ id: 'p', request_id: 'q9', status: 'paid' }];
  const [card] = cards(i);
  assert.deepEqual([card!.cobro.tone, card!.cobro.text, card!.plaza.tone, card!.why], ['ok', 'Pagado en línea 50,00 €', 'warn', []]);
});

