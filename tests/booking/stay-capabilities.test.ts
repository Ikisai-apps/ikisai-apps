/** Booking · capacidades del catálogo (1422): «Alojar en recepción» y «Cancelar noches pagadas en línea», con reads/writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { fakePaymentProvider } from '../../supabase/functions/booking-api/payments.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const gateway = fakePaymentProvider('firma-capacidades');
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], payments: gateway }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `cap-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));

test('las dos capacidades están en el catálogo con lo que leen y escriben', async () => {
  const caps = (await app.t.db.query<{ id: string; route: string; reads: string[]; writes: string[] }>(`select id, route, reads, writes from core.capabilities where id in ('booking.accept_stay', 'booking.cancel_stay_online') order by id`)).rows;
  assert.deepEqual(caps.map((c) => [c.id, c.route]), [['booking.accept_stay', 'POST stays/:id/accept'], ['booking.cancel_stay_online', 'POST stays/:id/cancel/online']]);
  for (const c of caps) {
    assert.ok(c.reads.length > 0 && c.writes.length > 0, c.id);
    for (const f of [...c.reads, ...c.writes]) assert.match(f, /^booking\.[a-z_]+\.[a-z_0-9]+$/, `${c.id}: ${f}`);
  }
});

test('alojar en recepción y cancelar lo pagado en línea, por las rutas del personal', async () => {
  const res = uuid(); const event = uuid(); const space = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas por capacidad', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2039-07-01', end_date: '2039-07-03', expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online' } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab capacidad', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 2', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama capacidad', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2039-07-01', valid_to: '2039-07-03' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;

  // alojar: sin pagar en línea no vale «online»; en efectivo sí, y repetir no aloja dos veces
  const a = await issueVisitor(db(), code);
  const ana = await (await post('stay', { event_code: code, from: '2039-07-01', to: '2039-07-02', persons: 1, name: 'Ana', email: 'ana@example.invalid' }, { 'X-Visitor': a.token })).json();
  const unpaid = await app.call(`/api/v1/stays/${ana.id}/accept`, { body: { method: 'online' } });
  assert.equal(unpaid.data?.error?.code, 'NOT_PAID_ONLINE');
  const accepted = await app.call(`/api/v1/stays/${ana.id}/accept`, { body: { method: 'cash', requestId: `acc-${ana.id}` } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.status, 'aceptada');
  const again = await app.call(`/api/v1/stays/${ana.id}/accept`, { body: { method: 'cash', requestId: `acc-${ana.id}` } });
  assert.equal(again.data.guest_id, accepted.data.guest_id);
  assert.equal((await app.t.db.query(`select 1 from booking.guests where event_id = $1 and deleted_at is null`, [event])).rows.length, 1);
  assert.equal((await app.call(`/api/v1/stays/no-es-un-id/accept`, { body: {} })).status, 422);

  // cancelar lo pagado en línea desde recepción: propuesta y después devolución
  const b = await issueVisitor(db(), code);
  const bea = await (await post('stay', { event_code: code, from: '2039-07-02', to: '2039-07-03', persons: 1, name: 'Bea', email: 'bea@example.invalid' }, { 'X-Visitor': b.token })).json();
  assert.equal((await post('stay/pay', { stay_id: bea.id }, { 'X-Visitor': b.token })).status, 200);
  const ref = (await app.t.db.query<{ r: string }>(`select provider_ref r from booking.stay_payments where request_id = $1`, [bea.id])).rows[0]!.r;
  assert.equal((await (await post('payments/fake', { eventId: 'ev-cap', providerRef: ref, status: 'paid' }, { 'X-Fake-Signature': 'firma-capacidades' })).json()).accepted, true);
  const quote = await app.call(`/api/v1/stays/${bea.id}/cancel/online`, { body: {} });
  assert.deepEqual([quote.data.status, quote.data.percent, quote.data.refund_cents], ['quote', 100, 2000]);
  const done = await app.call(`/api/v1/stays/${bea.id}/cancel/online`, { body: { confirm: true } });
  assert.deepEqual([done.data.status, done.data.refund_cents], ['cancelada', 2000]);
  assert.deepEqual(gateway.refunds, [{ providerRef: ref, cents: 2000 }]);
});
