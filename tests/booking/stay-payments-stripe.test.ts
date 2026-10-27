/** Booking · venta en línea con Stripe (1420): el envoltorio sobre la pasarela compartida de Finance, con su Stripe falso. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { stripeBookingProvider } from '../../supabase/functions/booking-api/payments.ts';
import { createFakeStripe } from '../../supabase/functions/_domain/payments/fake.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const SECRET = 'whsec_sintetico';
const WORKER_KEY = 'clave-worker-stripe';
const stripe = createFakeStripe();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY,
    payments: stripeBookingProvider({ gateway: stripe, webhookSecret: SECRET }) }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `st-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const hook = async (id: string, type: 'checkout.session.completed' | 'checkout.session.expired' | 'charge.refunded', eventId?: string) => {
  const w = await stripe.webhook(id, type, SECRET, eventId ? { eventId } : {});
  return post('payments/stripe', w.body, { 'Stripe-Signature': w.signature });
};
const reconcile = async (body: Record<string, unknown> = {}) => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/payments/reconcile`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: JSON.stringify(body) }))).json();
const payment = async (requestId: string) => (await app.t.db.query<Record<string, any>>(`select provider_ref, provider_payment_ref, status, refunded_cents from booking.stay_payments where request_id = $1`, [requestId])).rows[0]!;

test('Stripe: sesión de Booking, aviso firmado que aloja, avisos ajenos ignorados, devolución casada por el pago y caducidad a mano', async () => {
  const res = uuid(); const event = uuid(); const space = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas con Stripe', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2037-07-01', end_date: '2037-07-03', expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online' } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab Stripe', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 2', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama Stripe', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2037-07-01', valid_to: '2037-07-03' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;

  // la sesión: importe del servidor, metadatos de Booking, al menos 31 minutos y vuelta a ven.ikisai.com
  const v = await issueVisitor(db(), code);
  const stay = await (await post('stay', { event_code: code, from: '2037-07-01', to: '2037-07-03', persons: 1, name: 'Pau', email: 'pau@example.invalid' }, { 'X-Visitor': v.token })).json();
  const pay = await (await post('stay/pay', { stay_id: stay.id }, { 'X-Visitor': v.token })).json();
  assert.match(pay.redirect_url, /^https:\/\/checkout\.stripe\.com\//);
  const req = stripe.requests.at(-1)!;
  assert.deepEqual([req.amountCents, req.currency, req.metadata.app, req.metadata.reference], [4000, 'eur', 'booking', `booking-stay-${stay.id}`]);
  assert.ok(req.expiresAt.getTime() - Date.now() >= 31 * 60_000);
  assert.match(req.successUrl, /^https:\/\/ven\.ikisai\.com\//);

  // firma mala: 400; un aviso de otra app (Finance) de la misma cuenta: 200 sin tocar nada
  assert.equal((await post('payments/stripe', '{"id":"evt_x","type":"checkout.session.completed","data":{"object":{}}}', { 'Stripe-Signature': 't=1,v1=00' })).status, 400);
  const foreign = await stripe.createCheckout({ amountCents: 999, currency: 'eur', description: 'Factura sintética', metadata: { app: 'invoices', issued_invoice_id: uuid() },
    expiresAt: new Date(Date.now() + 60 * 60_000), successUrl: 'https://example.invalid/ok', cancelUrl: 'https://example.invalid/ko', idempotencyKey: uuid() });
  stripe.pay(foreign.id);
  const ignored = await hook(foreign.id, 'checkout.session.completed');
  assert.equal(ignored.status, 200);
  assert.equal((await ignored.json()).ignored, true);

  // pagado: el aviso aloja y guarda el pago (pi_…)
  const ref = (await payment(stay.id)).provider_ref;
  stripe.pay(ref);
  const paid = await (await hook(ref, 'checkout.session.completed')).json();
  assert.deepEqual([paid.status, paid.accepted], ['paid', true]);
  const pi = (await payment(stay.id)).provider_payment_ref;
  assert.match(pi, /^pi_test_/);

  // cancelar: devuelve por Stripe y el aviso charge.refunded (solo trae el pago) se casa con la sesión
  const done = await (await post('stay/cancel', { stay_id: stay.id, confirm: true }, { 'X-Visitor': v.token })).json();
  assert.deepEqual([done.status, done.refund_cents], ['cancelada', 4000]);
  const refunded = await (await hook(ref, 'charge.refunded')).json();
  assert.equal(refunded.status, 'refunded');
  assert.deepEqual([(await payment(stay.id)).status, (await payment(stay.id)).refunded_cents], ['refunded', 4000]);

  // la cama se guarda 20 minutos y la sesión dura 31: al vencer la retención, el worker caduca la sesión a mano
  const w = await issueVisitor(db(), code);
  const late = await (await post('stay', { event_code: code, from: '2037-07-02', to: '2037-07-03', persons: 1, name: 'Quim', email: 'quim@example.invalid' }, { 'X-Visitor': w.token })).json();
  assert.equal((await post('stay/pay', { stay_id: late.id }, { 'X-Visitor': w.token })).status, 200);
  const lateRef = (await payment(late.id)).provider_ref;
  assert.deepEqual(await reconcile({ older_minutes: 0 }), { checked: 1, applied: 0, expired: 0 }, 'aún dentro de la retención');
  await app.t.db.query(`select set_config('booking.visitor_procedure', 'on', false)`);
  await app.t.db.query(`update booking.visitor_requests set hold_until = now() - interval '1 minute' where id = $1`, [late.id]);
  await app.t.db.query(`select set_config('booking.visitor_procedure', '', false)`);
  assert.deepEqual(await reconcile({ older_minutes: 0 }), { checked: 1, applied: 1, expired: 1 });
  assert.equal(stripe.sessions.get(lateRef)!.status, 'expired');
  assert.equal((await payment(late.id)).status, 'expired');
});
