/** Booking · venta de noches en línea (booking-22; 1413), con una pasarela falsa: intento, aviso firmado, pagada y alojar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { bookingPublicRoutes, createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { fakePaymentProvider } from '../../supabase/functions/booking-api/payments.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const gateway = fakePaymentProvider('firma-falsa');
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], payments: gateway }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `sp-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));

async function onlineDays() {
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas en línea', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-04-02', end_date: '2033-04-04', expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online', lodging_online_minutes: 15 } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab en línea', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama en línea', layer: 'por_persona', unit: 'persona_noche', amount: 25, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2033-04-02', valid_to: '2033-04-04' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  return { res, event, bed, code };
}

test('en línea: retención corta, intento único, aviso firmado una vez, pagada, la cama se guarda y recepción aloja con «online»', async () => {
  const d = await onlineDays();
  const v = await issueVisitor(db(), d.code);
  const stay = await (await post('stay', { event_code: d.code, from: '2033-04-02', to: '2033-04-04', persons: 1, bed_id: d.bed, name: 'Lía' }, { 'X-Visitor': v.token })).json();
  assert.deepEqual([stay.pay, stay.total_cents], ['online', 5000]);
  assert.ok(Date.parse(stay.hold_until) <= Date.now() + 15 * 60_000 + 30_000, 'los 15 minutos del evento');

  // pagar: un intento con el importe del servidor; repetir vuelve al mismo
  const pay = await post('stay/pay', { stay_id: stay.id }, { 'X-Visitor': v.token });
  assert.equal(pay.status, 200, await pay.clone().text());
  const first = await pay.json();
  assert.match(first.redirect_url, /^https:\/\/pago\.example\.invalid\//);
  assert.equal(gateway.intents.at(-1)!.amountCents, 5000);
  const again = await (await post('stay/pay', { stay_id: stay.id }, { 'X-Visitor': v.token })).json();
  assert.deepEqual([again.redirect_url, again.reused], [first.redirect_url, true]);
  assert.equal(gateway.intents.length, 1, 'un solo intento en la pasarela');

  // el personal no puede alojar como «online» sin pago confirmado
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: stay.id, decision: 'accept', method: 'online' } }])).data?.error?.code, 'NOT_PAID_ONLINE');

  // aviso sin firma: fuera; con firma: pagada (una sola vez)
  const providerRef = (await app.t.db.query<{ r: string }>(`select provider_ref r from booking.stay_payments where request_id = $1`, [stay.id])).rows[0]!.r;
  assert.equal((await post('payments/fake', { eventId: 'ev-1', providerRef, status: 'paid' })).status, 400);
  const paid = await post('payments/fake', { eventId: 'ev-1', providerRef, status: 'paid', feeCents: 30 }, { 'X-Fake-Signature': 'firma-falsa' });
  assert.equal(paid.status, 200, await paid.clone().text());
  assert.equal((await paid.json()).status, 'paid');
  const replay = await (await post('payments/fake', { eventId: 'ev-1', providerRef, status: 'paid' }, { 'X-Fake-Signature': 'firma-falsa' })).json();
  assert.equal(replay.replayed, true);
  const row = (await app.t.db.query<Record<string, any>>(`select status, fee_cents, paid_at from booking.stay_payments where request_id = $1`, [stay.id])).rows[0]!;
  assert.deepEqual([row.status, row.fee_cents, !!row.paid_at], ['paid', 30, true]);

  // pagada: la cama se guarda hasta la salida (aunque pasen los 15 minutos) y el visitante lo ve
  const hold = (await app.t.db.query<{ h: string }>(`select hold_until::text h from booking.visitor_requests where id = $1`, [stay.id])).rows[0]!.h;
  assert.ok(Date.parse(hold) >= Date.parse('2033-04-04'), hold);
  const seen = await app.t.rpc('core_public_read', { p_name: 'booking_visitor_stay', p_args: { visitor_id: v.visitorId, event_code: d.code } }) as any;
  assert.deepEqual([seen.stay_status, seen.paid_online], ['pagada', true]);

  // recepción aloja con «online»: cobro ya cobrado con ese método
  await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: stay.id, decision: 'accept', method: 'online' } }]);
  const charge = (await app.t.db.query<{ m: string; a: number }>(`select c.method m, c.amount_cents a from booking.walkin_charges c join booking.visitor_requests q on q.guest_id = c.guest_id where q.id = $1`, [stay.id])).rows[0]!;
  assert.deepEqual([charge.m, charge.a], ['online', 5000]);

  // nadie escribe los pagos a mano
  const fake = await commit([{ op: 'update', table: 'booking.stay_payments', id: (await app.t.db.query<{ id: string }>(`select id from booking.stay_payments where request_id = $1`, [stay.id])).rows[0]!.id, expectedRevision: 2, fields: { status: 'refunded' } }]);
  assert.notEqual(fake.status, 200);
});

test('sin pasarela configurada, el pago en línea está apagado (503 PAYMENTS_OFF)', async () => {
  const route = bookingPublicRoutes(null).find((r) => r.pattern === 'stay/pay')!;
  await assert.rejects(route.handler({ visitor: { id: uuid() }, json: async () => ({ stay_id: uuid() }) } as never), (e: unknown) => (e as { code?: string }).code === 'PAYMENTS_OFF');
});
