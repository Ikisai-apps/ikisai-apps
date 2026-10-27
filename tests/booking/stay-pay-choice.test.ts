/** Booking · venta en línea (1418, vg-38): el visitante elige pagar en línea o en recepción; para pagar en línea, correo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { fakePaymentProvider } from '../../supabase/functions/booking-api/payments.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], payments: fakePaymentProvider('firma-elegir') }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `pc-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));

async function openDays(onSite: boolean, year: number) {
  const res = uuid(); const event = uuid(); const space = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: `Jornadas ${year}`, event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: `${year}-07-01`, end_date: `${year}-07-03`, expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online', lodging_pay_on_site: onSite } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: `Hab ${year}`, kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 2', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: `Cama ${year}`, layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: `${year}-07-01`, valid_to: `${year}-07-03` } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
}

test('en línea o en recepción: el visitante elige; la oferta dice las dos; en línea pide correo', async () => {
  const code = await openDays(true, 2034);
  const offer = await app.t.rpc('core_public_read', { p_name: 'booking_public_lodging', p_args: { event_code: code, from: '2034-07-01', to: '2034-07-03' } }) as any;
  assert.deepEqual(offer.pay_options, ['online', 'on_site']);
  assert.equal(offer.hold_minutes, 20);
  assert.ok(offer.hold_hours >= 1);

  // en recepción: se guarda la plaza las horas del evento y no se paga en línea
  const a = await issueVisitor(db(), code);
  const onSite = await (await post('stay', { event_code: code, from: '2034-07-01', to: '2034-07-02', persons: 1, name: 'Ana', pay: 'on_site' }, { 'X-Visitor': a.token })).json();
  assert.equal(onSite.pay, 'hold');
  assert.ok(Date.parse(onSite.hold_until) - Date.now() > 50 * 60 * 1000);
  assert.equal((await post('stay/pay', { stay_id: onSite.id }, { 'X-Visitor': a.token })).status, 409);

  // en línea: sin correo no se paga; con el correo del borrador, sí
  const b = await issueVisitor(db(), code);
  const online = await (await post('stay', { event_code: code, from: '2034-07-01', to: '2034-07-02', persons: 1, name: 'Bruno', pay: 'online' }, { 'X-Visitor': b.token })).json();
  assert.equal(online.pay, 'online');
  const noMail = await post('stay/pay', { stay_id: online.id }, { 'X-Visitor': b.token });
  assert.equal(noMail.status, 422);
  assert.equal((await noMail.json()).error?.code, 'EMAIL_REQUIRED');
  assert.equal((await post('stay/traveler', { stay_id: online.id, traveler: { first_name: 'Bruno', email: 'bruno@example.invalid' } }, { 'X-Visitor': b.token })).status, 200);
  assert.equal((await post('stay/pay', { stay_id: online.id }, { 'X-Visitor': b.token })).status, 200);

  // sin elegir, el del evento (en línea); con el correo suelto vale
  const c = await issueVisitor(db(), code);
  const plain = await (await post('stay', { event_code: code, from: '2034-07-02', to: '2034-07-03', persons: 1, name: 'Carla', email: 'carla@example.invalid' }, { 'X-Visitor': c.token })).json();
  assert.equal(plain.pay, 'online');
  assert.equal((await post('stay/pay', { stay_id: plain.id }, { 'X-Visitor': c.token })).status, 200);
});

test('solo en línea: pedir pagar en recepción se rechaza', async () => {
  const code = await openDays(false, 2035);
  const offer = await app.t.rpc('core_public_read', { p_name: 'booking_public_lodging', p_args: { event_code: code, from: '2035-07-01', to: '2035-07-03' } }) as any;
  assert.deepEqual(offer.pay_options, ['online']);
  assert.equal(offer.hold_hours, null);
  const v = await issueVisitor(db(), code);
  const res = await post('stay', { event_code: code, from: '2035-07-01', to: '2035-07-02', persons: 1, name: 'Dani', pay: 'on_site' }, { 'X-Visitor': v.token });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error?.code, 'PAY_MODE_NOT_ALLOWED');
  const bad = await post('stay', { event_code: code, from: '2035-07-01', to: '2035-07-02', persons: 1, name: 'Dani', pay: 'bitcoin' }, { 'X-Visitor': v.token });
  assert.equal(bad.status, 422);
});
