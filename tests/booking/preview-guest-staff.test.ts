/** Booking · «Vista previa como huésped» desde Booking (1429, B-33): el huésped de muestra sin el ámbito del organizador. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `pv-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const preview = (reservation_id: string) => app.call('/api/v1/invoke/booking.preview_guest', { body: { reservation_id } });

test('vista previa: crea una vez el huésped de muestra del evento, fuera de las listas; sin evento, 422', async () => {
  const res = uuid(); const event = uuid(); const draft = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro de muestra', status: 'pre_reservada', start_date: '2037-05-01', end_date: '2037-05-03', expected_guests: 10 } },
    { op: 'insert', table: TABLES.reservations, id: draft, fields: { title: 'Sin evento', status: 'en_estudio' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);

  const first = await preview(res);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.created, true);
  const again = await preview(res);
  assert.deepEqual([again.data.guest_id, again.data.created], [first.data.guest_id, false], 'una sola muestra por evento');
  const row = (await app.t.db.query<any>(`select event_id, preview, first_name from booking.guests where id = $1`, [first.data.guest_id])).rows[0];
  assert.deepEqual(row, { event_id: event, preview: true, first_name: 'Huésped' });

  assert.equal((await preview(draft)).status, 422, 'sin evento no hay vista previa');
  assert.equal((await preview('no-es-un-uuid')).status, 422);
});
