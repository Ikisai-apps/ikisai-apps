/** Booking · venta en línea, conciliación y devolución por la pasarela (1414), con la pasarela falsa. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { fakePaymentProvider } from '../../supabase/functions/booking-api/payments.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-conciliacion';
const gateway = fakePaymentProvider('firma');
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, payments: gateway }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `pr-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, token: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', 'X-Visitor': token }, body: JSON.stringify(body) }));
const reconcile = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/payments/reconcile`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();

test('un aviso perdido se concilia con la pasarela; la devolución en línea la pide la pasarela y no pasa de lo pagado', async () => {
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas conciliadas', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-05-06', end_date: '2033-05-07', expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online' } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab conciliada', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama conciliada', layer: 'por_persona', unit: 'persona_noche', amount: 30, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2033-05-06', valid_to: '2033-05-07' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  const v = await issueVisitor(db(), code);
  const stay = await (await post('stay', { event_code: code, from: '2033-05-06', to: '2033-05-07', persons: 1, bed_id: bed, name: 'Mia' }, v.token)).json();
  assert.equal((await post('stay/pay', { stay_id: stay.id }, v.token)).status, 200);
  const ref = (await app.t.db.query<{ r: string }>(`select provider_ref r from booking.stay_payments where request_id = $1`, [stay.id])).rows[0]!.r;

  // la pasarela lo cobró, pero su aviso no llegó: la conciliación (intentos de hace más de 10 min) lo aplica
  gateway.states.set(ref, 'paid');
  assert.deepEqual(await reconcile(), { checked: 0, applied: 0 }, 'aún reciente');
  // (la guarda de stay_payments solo deja escribir a la cuenta de servicio de Booking en un lote: la prueba lo imita)
  await app.t.db.exec(`select set_config('core.request_id', 'prueba-envejecer', false), set_config('core.actor', core.service_actor('booking')::text, false);
    update booking.stay_payments set created_at = now() - interval '11 minutes' where provider_ref = '${ref}';
    select set_config('core.request_id', '', false), set_config('core.actor', '', false);`);
  assert.deepEqual(await reconcile(), { checked: 1, applied: 1 });
  assert.equal((await app.t.db.query<{ s: string }>(`select status s from booking.stay_payments where provider_ref = $1`, [ref])).rows[0]!.s, 'paid');

  // alojado con «online» y devuelto en parte por la pasarela
  await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: stay.id, decision: 'accept', method: 'online' } }]);
  const charge = (await app.t.db.query<{ id: string }>(`select c.id from booking.walkin_charges c join booking.visitor_requests q on q.guest_id = c.guest_id where q.id = $1`, [stay.id])).rows[0]!.id;
  const tooMuch = await app.call(`/api/v1/walkins/${charge}/refund/online`, { body: { cents: 3001 } });
  assert.equal(tooMuch.status, 422);
  const refund = await app.call(`/api/v1/walkins/${charge}/refund/online`, { body: { cents: 1000 } });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  assert.deepEqual(gateway.refunds.at(-1), { providerRef: ref, cents: 1000 });
  // un lector no devuelve
  assert.equal((await app.call(`/api/v1/walkins/${charge}/refund/online`, { token: app.tokens.reader, body: { cents: 100 } })).status, 403);
});
