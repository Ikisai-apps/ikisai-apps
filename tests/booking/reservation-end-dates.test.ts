/** Booking · B18: `booking.reservation_end_dates` para la conservación de Organizers, sin datos personales. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('B18 · fin y estado de cada reserva, también las borradas; solo tres columnas', async () => {
  const live = uuid(); const gone = uuid();
  const res = await app.call('/api/v1/commands', { body: { requestId: `b18-${uuid()}`, operations: [
    { op: 'insert', table: TABLES.reservations, id: live, fields: { title: 'Retiro B18', status: 'pre_reservada', start_date: '2028-02-01', end_date: '2028-02-03', expected_guests: 4, contact_name: 'Persona Sintética' } },
    { op: 'insert', table: TABLES.reservations, id: gone, fields: { title: 'Retiro borrado', status: 'pre_reservada', start_date: '2028-03-01', end_date: '2028-03-02', expected_guests: 2 } },
  ] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  await app.t.db.query(`update booking.reservations set deleted_at = now() where id = $1`, [gone]);
  const rows = (await app.t.db.query<Record<string, any>>(`select * from booking.reservation_end_dates where reservation_id = any($1::uuid[]) order by status`, [[live, gone]])).rows;
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['end_date', 'reservation_id', 'status']);
  assert.deepEqual(rows.map((r) => [r.reservation_id, r.status]), [[gone, 'borrada'], [live, 'pre_reservada']]);
  assert.ok(String(rows[1]!.end_date).startsWith('2028-02-03') || new Date(rows[1]!.end_date).toISOString().startsWith('2028-02-0'));
});
