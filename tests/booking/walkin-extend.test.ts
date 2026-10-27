/** Booking · ampliar o cambiar la estancia de un alojamiento a la carta (aceptación C): el lote que manda «Ampliar…». */
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
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `we-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const rev = async (table: string, id: string) => Number((await app.t.db.query<{ r: string }>(`select revision r from ${table} where id = $1`, [id])).rows[0]!.r);

test('ampliar a dos noches en otra cama: asignación y cobro juntos; sobre una cama ocupada, nada a medias', async () => {
  const res = uuid(); const event = uuid(); const space = uuid(); const [b1, b2] = [uuid(), uuid()];
  const [ana, luis] = [uuid(), uuid()]; const [aAna, aLuis] = [uuid(), uuid()]; const charge = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas para ampliar', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-06-03', end_date: '2033-06-06', expected_guests: 40 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Albergue para ampliar', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: b1, fields: { space_id: space, label: 'Cama 1' } },
    { op: 'insert', table: TABLES.beds, id: b2, fields: { space_id: space, label: 'Cama 2' } },
    { op: 'insert', table: TABLES.guests, id: ana, fields: { event_id: event, first_name: 'Ana' } },
    { op: 'insert', table: TABLES.guests, id: luis, fields: { event_id: event, first_name: 'Luis' } },
    { op: 'insert', table: TABLES.roomAssignments, id: aAna, fields: { event_id: event, space_id: space, bed_id: b1, guest_id: ana, persons: 1, from_date: '2033-06-03', to_date: '2033-06-04' } },
    // Luis tiene la cama 1 la segunda noche
    { op: 'insert', table: TABLES.roomAssignments, id: aLuis, fields: { event_id: event, space_id: space, bed_id: b1, guest_id: luis, persons: 1, from_date: '2033-06-04', to_date: '2033-06-05' } },
    { op: 'insert', table: TABLES.walkinCharges, id: charge, fields: { event_id: event, assignment_id: aAna, guest_id: ana, nights: 1, price_cents: 2000, amount_cents: 2000, method: 'cash', paid_at: '2033-06-03T18:00:00Z' } },
  ]);
  await ok([{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: await rev('booking.walkin_charges', charge), fields: { finance_sent_at: new Date().toISOString() } }]);

  const extend = async (bed: string, to: string, nights: number) => commit([
    { op: 'update', table: TABLES.roomAssignments, id: aAna, expectedRevision: await rev('booking.room_assignments', aAna), fields: { to_date: to, bed_id: bed, space_id: space } },
    { op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: await rev('booking.walkin_charges', charge), fields: { nights, amount_cents: nights * 2000 } },
  ]);

  // en la misma cama, la segunda noche es de Luis: BED_OVERBOOKED y no cambia nada
  const clash = await extend(b1, '2033-06-05', 2);
  assert.equal(clash.data?.error?.code, 'BED_OVERBOOKED', JSON.stringify(clash.data));
  const still = (await app.t.db.query<{ t: string; n: number }>(`select a.to_date::text t, c.nights n from booking.room_assignments a join booking.walkin_charges c on c.assignment_id = a.id where a.id = $1`, [aAna])).rows[0]!;
  assert.deepEqual(still, { t: '2033-06-04', n: 1 }, 'ni la cama ni el cobro');

  // cambiando a la cama 2, entra entero: dos noches, 40 €, y por reenviar a Finance
  assert.equal((await extend(b2, '2033-06-05', 2)).status, 200);
  const now = (await app.t.db.query<Record<string, any>>(`select a.bed_id, a.to_date::text t, c.nights, c.amount_cents, c.finance_sent_at from booking.room_assignments a join booking.walkin_charges c on c.assignment_id = a.id where a.id = $1`, [aAna])).rows[0]!;
  assert.deepEqual([now.bed_id, now.t, now.nights, now.amount_cents, now.finance_sent_at], [b2, '2033-06-05', 2, 4000, null]);
});
