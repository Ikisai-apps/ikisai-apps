/** Booking · «Alójate aquí» (1428): el contacto que dejó el visitante vuelve en sus lecturas (B-32) y el pedido de prueba de un miembro (G-12). */
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
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], payments: fakePaymentProvider('firma-prueba') }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `tc-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));
const row = async (id: string) => (await app.t.db.query<any>(`select is_test, total_cents, pay_mode, contact from booking.visitor_requests where id = $1`, [id])).rows[0];

test('prueba de un miembro: sin cobro y nunca en línea; de un visitante cualquiera, se ignora; el contacto vuelve al visitante', async () => {
  const res = uuid(); const event = uuid(); const space = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas de prueba', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2036-07-01', end_date: '2036-07-04', expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online', lodging_pay_on_site: true } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab prueba', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 2', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama prueba', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2036-07-01', valid_to: '2036-07-04' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;

  // un visitante cualquiera: `test` no vale; se cobra como siempre
  const anyone = await issueVisitor(db(), code);
  const paid = await (await post('stay', { event_code: code, from: '2036-07-01', to: '2036-07-02', persons: 1, name: 'Ana', contact: '600 000 001', pay: 'online', test: true }, { 'X-Visitor': anyone.token })).json();
  assert.equal(paid.test, false);
  assert.deepEqual(await row(paid.id), { is_test: false, total_cents: 2000, pay_mode: 'online', contact: '600 000 001' });

  // un miembro del equipo: prueba, a 0 € y en recepción aunque pidiera en línea
  const member = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'editor') on conflict do nothing`, [member]);
  const staff = await issueVisitor(db(), code);
  await app.t.db.query(`update core.visitors set auth_user_id = $2 where id = $1`, [staff.visitorId, member]);
  const trial = await (await post('stay', { event_code: code, from: '2036-07-01', to: '2036-07-03', persons: 1, name: 'Marga', contact: 'marga@example.invalid', pay: 'online', test: true }, { 'X-Visitor': staff.token })).json();
  assert.equal(trial.test, true);
  assert.equal(trial.total_cents, 0);
  assert.equal(trial.pay, 'hold');
  assert.equal((await post('stay/pay', { stay_id: trial.id }, { 'X-Visitor': staff.token })).status, 409, 'una prueba no abre la pasarela');
  // sin `test`, el mismo miembro paga como cualquiera
  const real = await (await post('stay', { event_code: code, from: '2036-07-02', to: '2036-07-03', persons: 1, name: 'Marga', pay: 'online' }, { 'X-Visitor': staff.token })).json();
  assert.deepEqual([real.test, real.total_cents, real.pay], [false, 2000, 'online']);

  // B-32: cada visitante ve su propio contacto en sus lecturas, y solo el suyo
  const mine = await app.t.rpc('core_public_read', { p_name: 'booking_visitor_requests', p_args: { visitor_id: anyone.visitorId, event_code: code } }) as any;
  assert.deepEqual(mine.items.map((i: any) => [i.contact, i.test]), [['600 000 001', false]]);
  const stay = await app.t.rpc('core_public_read', { p_name: 'booking_visitor_stay', p_args: { visitor_id: staff.visitorId, event_code: code } }) as any;
  assert.equal(stay.contact, null, 'el último pedido del miembro no dejó contacto');

  // el pedido real del miembro sustituye a la prueba (uno pendiente por visitante y evento)
  const status = (await app.t.db.query<{ status: string }>(`select status from booking.visitor_requests where id = $1`, [trial.id])).rows[0]!.status;
  assert.equal(status, 'descartada');
});
