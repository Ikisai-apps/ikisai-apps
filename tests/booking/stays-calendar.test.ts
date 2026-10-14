/**
 * Booking · O2, parte 2 (migración 0468):
 * - estancias en Google: las de outsider en su calendario y las del staff en el suyo, con «Marta (+1)» y sin contacto
 *   ni notas; sin calendario configurado no se proyectan y las reservas siguen en el suyo, como siempre;
 * - retiros visibles para huéspedes: `portal_open_retreats` con título, fechas y resumen, sin precio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createFakeCalendarAdapter } from '../../supabase/functions/booking-api/calendar/adapter.ts';
import { TABLES, stayCalendarTitle } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const reservations = createFakeCalendarAdapter('reservas@calendar.invalid');
const outsiders = createFakeCalendarAdapter('outsiders@calendar.invalid');
const staff = createFakeCalendarAdapter('staff@calendar.invalid');
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY,
      calendar: { adapter: reservations, stays: { outsider: outsiders, staff } } }),
  });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `sc-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/calendar/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();
async function outsider() {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [user]);
  await app.t.db.query(`insert into core.house_levels (user_id, level) values ($1, 'outsider')`, [user]);
  return user;
}

test('título: nombre de pila y cuántos más', () => {
  assert.equal(stayCalendarTitle({ kind: 'outsider', first: 'Marta', count: 2 }), 'Marta (+1)');
  assert.equal(stayCalendarTitle({ kind: 'outsider', first: 'Marta', count: 1 }), 'Marta');
  assert.equal(stayCalendarTitle({ kind: 'staff', first: null, count: 0 }), 'Staff');
});

test('estancias en Google: cada una a su calendario; mover, renombrar y quitar', async () => {
  const marta = await outsider();
  const stay = uuid();
  await invoke('guests', marta, 'booking.portal_stay_save', { id: stay, from: '2032-01-10', to: '2032-01-12', persons: [{ name: 'Marta Ruiz' }, { name: 'Nico' }] });
  const ana = await app.t.createUser();
  await app.t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Ana López') on conflict (user_id) do update set display_name = excluded.display_name`, [ana]);
  await ok([{ op: 'insert', table: TABLES.stays, id: uuid(), fields: { kind: 'staff', account_id: ana, from_date: '2032-01-11', to_date: '2032-01-13' } }]);

  const out = await tick();
  assert.equal(out.stays.processed, 2, JSON.stringify(out));
  assert.deepEqual(out.stays.kinds, ['outsider', 'staff']);
  const [o] = [...outsiders.events.values()];
  assert.deepEqual([o!.summary, o!.start, o!.end, o!.colorId], ['Marta (+1)', { date: '2032-01-10' }, { date: '2032-01-13' }, '3']);
  assert.equal(o!.extendedProperties.private.ikisaiStayId, stay);
  assert.equal(/Nico|Ruiz|@/.test(o!.description), false, 'sin más nombres ni contacto');
  const [s] = [...staff.events.values()];
  assert.equal(s!.summary, 'Ana');
  assert.equal(reservations.events.size, 0, 'nada de esto va al calendario de reservas');

  // sin cambios no se llama a Google
  const calls = outsiders.calls.upsert;
  await tick();
  assert.equal(outsiders.calls.upsert, calls);

  // mover y quitar a una persona
  await invoke('guests', marta, 'booking.portal_stay_save', { id: stay, from: '2032-01-11', to: '2032-01-12',
    persons: (await read('guests', marta, 'booking.portal_my_stays', { from: '2032-01-01', to: '2032-02-01' })).items[0].persons.slice(0, 1) });
  await tick();
  const [moved] = [...outsiders.events.values()];
  assert.deepEqual([moved!.summary, moved!.start], ['Marta', { date: '2032-01-11' }]);

  await invoke('guests', marta, 'booking.portal_stay_remove', { id: stay });
  await tick();
  assert.equal(outsiders.events.size, 0, 'quitada, se borra de Google');
});

test('sin calendario de estancias: la respuesta del tick y las reservas, como siempre', async () => {
  const other = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, calendar: { adapter: createFakeCalendarAdapter('r@calendar.invalid') } }),
  });
  try {
    const res = await other.handler(new Request(`${other.supabase.url}/functions/v1/booking-api/api/v1/worker/calendar/tick`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }));
    assert.deepEqual(Object.keys(await res.json()).sort(), ['failed', 'health', 'pending', 'processed']);
  } finally { await other.close(); }
});

test('retiros visibles para huéspedes: título, fechas y resumen, sin precio', async () => {
  const open = uuid(); const hidden = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: open, fields: { title: 'Retiro abierto', status: 'pre_reservada', start_date: '2032-03-05', end_date: '2032-03-07', expected_guests: 10, guests_visible: true, public_summary: 'Meditación y paseos.' } },
    { op: 'insert', table: TABLES.reservations, id: hidden, fields: { title: 'Retiro privado', status: 'pre_reservada', start_date: '2032-03-12', end_date: '2032-03-14', expected_guests: 10 } },
  ]);
  const huesped = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [huesped]);
  const out = await read('guests', huesped, 'booking.portal_open_retreats', { from: '2032-03-01', to: '2032-04-01' });
  assert.deepEqual(out.items, [{ reservation_id: open, title: 'Retiro abierto', start_date: '2032-03-05', end_date: '2032-03-07', summary: 'Meditación y paseos.', joined: false }]);
  const tooLong = await commit([{ op: 'update', table: TABLES.reservations, id: open, expectedRevision: 1, fields: { public_summary: 'x'.repeat(501) } }]);
  assert.equal(tooLong.status, 422);
});
