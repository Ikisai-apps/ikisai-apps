/** Booking · venta en línea (1419, vg-38): cancelar noches pagadas en línea con la política de VG. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { fakePaymentProvider } from '../../supabase/functions/booking-api/payments.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { TABLES, stayCancelPercent, stayCancelRefund } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const gateway = fakePaymentProvider('firma-cancelar');
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], payments: gateway }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `sc-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));

test('la regla: 100 % hasta 7 días antes, 50 % hasta 48 h, nada después; evento cancelado, 100 %', () => {
  assert.deepEqual(stayCancelPercent('2036-07-01', new Date('2036-06-20T10:00:00Z')), { percent: 100, tier: 'full' });
  assert.deepEqual(stayCancelPercent('2036-07-01', new Date('2036-06-27T10:00:00Z')), { percent: 50, tier: 'half' });
  assert.deepEqual(stayCancelPercent('2036-07-01', new Date('2036-06-30T10:00:00Z')), { percent: 0, tier: 'none' });
  assert.deepEqual(stayCancelPercent('2036-07-01', new Date('2036-06-30T10:00:00Z'), true), { percent: 100, tier: 'event_cancelled' });
  // la llegada son las 00:00 de Madrid (22:00 UTC del día antes en verano): 7 días justos antes aún es el 100 %
  assert.equal(stayCancelPercent('2036-07-01', new Date('2036-06-23T22:00:00Z')).percent, 100);
  assert.equal(stayCancelPercent('2036-07-01', new Date('2036-06-23T22:00:01Z')).percent, 50);
  assert.equal(stayCancelRefund(4000, 0, 50), 2000);
  assert.equal(stayCancelRefund(4000, 3000, 50), 0);
});

test('pagado en línea y alojado solo: cancela, devuelve por la pasarela y suelta la cama; la base dice lo mismo que la regla', async () => {
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas que se cancelan', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2036-07-01', end_date: '2036-07-03', expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online' } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab cancelable', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama cancelable', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2036-07-01', valid_to: '2036-07-03' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  const v = await issueVisitor(db(), code);
  const stay = await (await post('stay', { event_code: code, from: '2036-07-01', to: '2036-07-03', persons: 1, bed_id: bed,
    traveler: { first_name: 'Olga', last_name_1: 'Sintética', email: 'olga@example.invalid' } }, { 'X-Visitor': v.token })).json();

  // sin pagar no hay nada que cancelar por aquí
  assert.equal((await post('stay/cancel', { stay_id: stay.id }, { 'X-Visitor': v.token })).status, 409);

  assert.equal((await post('stay/pay', { stay_id: stay.id }, { 'X-Visitor': v.token })).status, 200);
  const ref = (await app.t.db.query<{ r: string }>(`select provider_ref r from booking.stay_payments where request_id = $1`, [stay.id])).rows[0]!.r;
  const paid = await (await post('payments/fake', { eventId: 'ev-cancel', providerRef: ref, status: 'paid' }, { 'X-Fake-Signature': 'firma-cancelar' })).json();
  assert.equal(paid.accepted, true);

  // la base y la regla compartida dan lo mismo en cada tramo
  for (const at of ['2036-06-20T10:00:00Z', '2036-06-27T10:00:00Z', '2036-06-30T10:00:00Z', '2036-06-23T22:00:00Z']) {
    const q = (await app.t.db.query<{ q: any }>(`select booking.stay_cancel_quote_of(q, $2::timestamptz) q from booking.visitor_requests q where id = $1`, [stay.id, at])).rows[0]!.q;
    assert.equal(q.percent, stayCancelPercent('2036-07-01', new Date(at)).percent, at);
  }

  // otro visitante no la ve
  const other = await issueVisitor(db(), code);
  assert.equal((await post('stay/cancel', { stay_id: stay.id }, { 'X-Visitor': other.token })).status, 404);

  // el visitante ve la propuesta en su solicitud y al preguntar
  const seen = await app.t.rpc('core_public_read', { p_name: 'booking_visitor_stay', p_args: { visitor_id: v.visitorId, event_code: code } }) as any;
  assert.deepEqual([seen.cancel?.percent, seen.cancel?.refund_cents], [100, 4000]);
  const quote = await (await post('stay/cancel', { stay_id: stay.id }, { 'X-Visitor': v.token })).json();
  assert.deepEqual([quote.status, quote.percent, quote.refund_cents], ['quote', 100, 4000]);
  assert.equal(gateway.refunds.length, 0);

  const guest = (await app.t.db.query<{ g: string }>(`select guest_id g from booking.visitor_requests where id = $1`, [stay.id])).rows[0]!.g;
  // dos confirmaciones a la vez: una sola devolución
  const [r1, r2] = await Promise.all([post('stay/cancel', { stay_id: stay.id, confirm: true }, { 'X-Visitor': v.token }), post('stay/cancel', { stay_id: stay.id, confirm: true }, { 'X-Visitor': v.token })]);
  const both = [await r1.json(), await r2.json()];
  const done = both.find((x) => x.status === 'cancelada' && !x.replayed) ?? both[0];
  assert.deepEqual([done.status, done.refund_cents], ['cancelada', 4000], JSON.stringify(both));
  assert.deepEqual(gateway.refunds, [{ providerRef: ref, cents: 4000 }]);
  assert.equal((await app.t.db.query<{ s: string }>(`select status s from booking.visitor_requests where id = $1`, [stay.id])).rows[0]!.s, 'descartada');
  assert.equal((await app.t.db.query(`select 1 from booking.guests where id = $1 and deleted_at is null`, [guest])).rows.length, 0);
  assert.equal((await app.t.db.query(`select 1 from booking.room_assignments where guest_id = $1 and deleted_at is null`, [guest])).rows.length, 0);
  const charge = (await app.t.db.query<Record<string, any>>(`select refund_cents, refund_method from booking.walkin_charges where guest_id = $1`, [guest])).rows[0]!;
  assert.deepEqual([charge.refund_cents, charge.refund_method], [4000, 'online']);
  assert.ok((await app.t.db.query(`select 1 from booking.free_beds('2036-07-01', '2036-07-03') where bed_id = $1`, [bed])).rows.length === 1);

  // repetir no devuelve dos veces
  const again = await (await post('stay/cancel', { stay_id: stay.id, confirm: true }, { 'X-Visitor': v.token })).json();
  assert.equal(again.replayed, true);
  assert.equal(gateway.refunds.length, 1);
});
