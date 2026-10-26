/**
 * Booking · reglas de acceso a los portales (encargo de VG del 26-10-2026, migración 0481):
 * - el organizador y el personal con cuenta son huéspedes de su retiro en Guests (conciliación por tick, idempotente);
 * - si desaparece el origen, la ficha se va salvo que tenga cama; nada en retiros terminados;
 * - la conservación ya no quita el permiso de Guests;
 * - dirección («todos»): ve los retiros no visibles, se apunta sin aprobación y nunca actúa por otro huésped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `pa-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const rpc = (name: string, args: Record<string, unknown>) => app.t.rpc(name, args) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args });
const invoke = (appId: string, actor: string, name: string, args: unknown) => rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args });
async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}
const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/portal-access/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();
async function member(appId: string, grants: unknown[] | null = null, role = 'editor') {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, $3, $4::jsonb)
    on conflict (app, user_id) do update set scopes = excluded.scopes`, [appId, user, role, grants ? JSON.stringify({ grants }) : null]);
  return user;
}
async function grant(appId: string, user: string, scope: Record<string, unknown>) {
  await app.t.db.query(`select core.portal_grant($1, $2, $3::jsonb, 'Persona Sintética')`, [appId, user, JSON.stringify(scope)]);
}
async function retreat(title: string, opts: { start?: string; end?: string; visible?: boolean } = {}) {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title, status: 'pre_reservada', start_date: opts.start ?? '2033-03-04', end_date: opts.end ?? '2033-03-06', expected_guests: 10, guests_visible: opts.visible ?? false } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}
const guestsOf = async (event: string) => (await app.t.db.query<{ id: string; portal_role: string | null; first_name: string; deleted_at: string | null }>(
  `select id, portal_role, first_name, deleted_at from booking.guests where event_id = $1 order by created_at`, [event])).rows;
const guestGrants = async (user: string) => ((await app.t.db.query<{ g: any }>(`select scopes -> 'grants' g from core.memberships where app = 'guests' and user_id = $1`, [user])).rows[0]?.g ?? []) as any[];

test('organizador: con acceso a Organizers queda como huésped de la reserva en Guests; la conciliación es idempotente', async () => {
  const { res, event } = await retreat('Retiro con organizadora');
  const org = await member('organizers');
  await grant('organizers', org, { reservation_id: res });
  const first = await tick();
  assert.ok(first.created >= 1, JSON.stringify(first));
  const rows = (await guestsOf(event)).filter((g) => !g.deleted_at);
  assert.deepEqual(rows.map((g) => g.portal_role), ['organizer']);
  assert.deepEqual((await guestGrants(org)).filter((g) => g.reservation_id === res), [{ reservation_id: res, guest_id: rows[0]!.id }]);
  assert.equal((await tick()).created, 0, 'la segunda vuelta no hace nada');

  // En Organizers: `as` y `as_guest_id`; en Guests, «Mis retiros».
  const mine = (await read('organizers', org, 'booking.portal_reservations', {})).items.find((i: any) => i.id === res);
  assert.deepEqual([mine.as, mine.as_guest_id], ['organizer', rows[0]!.id]);
  const retreats = await read('guests', org, 'booking.portal_my_retreats', {});
  assert.ok(retreats.items.some((i: any) => i.reservation_id === res && i.guest_id === rows[0]!.id));

  // Sin el acceso a Organizers, la ficha (sin cama) se va y el permiso de Guests también.
  await app.t.db.query(`select core.portal_revoke_scope('organizers', 'reservation_id', $1)`, [res]);
  assert.equal((await tick()).removed, 1);
  assert.ok((await guestsOf(event)).every((g) => g.deleted_at));
  assert.equal((await guestGrants(org)).filter((g) => g.reservation_id === res).length, 0);
});

test('personal: un turno con cuenta da ficha de huésped (staff u outsider); sin turno se va, salvo con cama elegida', async () => {
  const { event } = await retreat('Retiro con personal');
  const staff = await member('booking');
  const outsider = await app.t.createUser();
  await app.t.db.query(`insert into core.house_levels (user_id, level) values ($1, 'outsider')`, [outsider]);
  const s1 = uuid(); const s2 = uuid();
  await ok([
    { op: 'insert', table: TABLES.staffAssignments, id: s1, fields: { event_id: event, person_name: 'Lucía Sintética', function: 'cocina', member_user_id: staff } },
    { op: 'insert', table: TABLES.staffAssignments, id: s2, fields: { event_id: event, person_name: 'Pablo Sintético', function: 'apoyo_logistico', member_user_id: outsider } },
    { op: 'insert', table: TABLES.staffAssignments, id: uuid(), fields: { event_id: event, person_name: 'Sin cuenta', function: 'limpieza_previa' } },
  ]);
  assert.equal((await tick()).created, 2);
  const live = (await guestsOf(event)).filter((g) => !g.deleted_at);
  assert.deepEqual(live.map((g) => [g.first_name, g.portal_role]).sort(), [['Lucía Sintética', 'staff'], ['Pablo Sintético', 'outsider']]);

  // Pablo ya tiene cama: al cancelar su turno, se queda; Lucía, sin cama, se va.
  const space = uuid(); const bed = uuid();
  await ok([{ op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab sintética', kind: 'habitacion' } }, { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 1' } }]);
  const pablo = live.find((g) => g.portal_role === 'outsider')!;
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, bed_id: bed, guest_id: pablo.id, persons: 1 } }]);
  await app.t.db.query(`update booking.staff_assignments set status = 'cancelada' where id = any($1::uuid[])`, [[s1, s2]]);
  assert.equal((await tick()).removed, 1);
  const after = (await guestsOf(event)).filter((g) => !g.deleted_at);
  assert.deepEqual(after.map((g) => g.portal_role), ['outsider']);
});

test('retiros terminados: no se crean fichas; la conservación ya no quita el permiso de Guests', async () => {
  const { res, event } = await retreat('Retiro pasado', { start: '2021-01-08', end: '2021-01-10' });
  const org = await member('organizers');
  await grant('organizers', org, { reservation_id: res });
  await tick();
  assert.equal((await guestsOf(event)).length, 0);

  const guest = uuid();
  await ok([{ op: 'insert', table: TABLES.guests, id: guest, fields: { event_id: event, first_name: 'Ana', last_name_1: 'Sintética' } }]);
  const account = await member('guests');
  await grant('guests', account, { reservation_id: res, guest_id: guest });
  await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/retention/tick`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }));
  const row = (await app.t.db.query<{ anonymized_at: string | null; first_name: string }>(`select anonymized_at, first_name from booking.guests where id = $1`, [guest])).rows[0]!;
  assert.ok(row.anonymized_at, 'anonimizada (6 meses sin SES)');
  assert.deepEqual(await guestGrants(account), [{ reservation_id: res, guest_id: guest }], 'el permiso sigue');
  const retreats = await read('guests', account, 'booking.portal_my_retreats', {});
  assert.deepEqual(retreats.items.map((i: any) => [i.title, i.name]), [['Retiro pasado', 'Huésped anonimizado']]);
});

test('dirección: ve los retiros no visibles, se apunta sin aprobación, elige siempre y nunca actúa por otro huésped', async () => {
  const { res, event } = await retreat('Retiro privado', { visible: false });
  const boss = await member('guests', [{ all: true }]);
  const plain = await member('guests');
  const range = { from: '2033-01-01', to: '2033-12-31' };
  const seen = await read('guests', boss, 'booking.portal_open_retreats', range);
  assert.equal(seen.direction, true);
  assert.ok(seen.items.some((i: any) => i.reservation_id === res));
  assert.ok(!(await read('guests', plain, 'booking.portal_open_retreats', range)).items.some((i: any) => i.reservation_id === res));

  assert.equal(await code(invoke('guests', plain, 'booking.portal_join_direction', { reservation_id: res })), 'OUT_OF_SCOPE');
  const joined = await invoke('guests', boss, 'booking.portal_join_direction', { reservation_id: res });
  assert.equal(joined.guest_ids.length, 1, JSON.stringify(joined));
  const mine = joined.guest_ids[0];
  assert.deepEqual((await guestsOf(event)).map((g) => g.portal_role), ['direccion']);
  assert.equal((await invoke('guests', boss, 'booking.portal_join_direction', { reservation_id: res })).guest_ids.length, 0, 'no se apunta dos veces');

  // Su ficha: elige siempre, sin «Habitaciones abiertas»
  const lodging = await read('guests', boss, 'booking.portal_lodging', { guest_id: mine });
  assert.deepEqual([lodging.choice, lodging.open, lodging.direction], ['choose', true, true]);

  // Otro huésped del mismo retiro: «todos» no le deja leerlo ni tocarlo
  const other = uuid();
  await ok([{ op: 'insert', table: TABLES.guests, id: other, fields: { event_id: event, first_name: 'Otra' } }]);
  assert.equal(await code(read('guests', boss, 'booking.portal_lodging', { guest_id: other })), 'OUT_OF_SCOPE');
  // No apunta a un retiro cerrado
  await app.t.db.query(`update booking.reservations set status = 'cerrada' where id = $1`, [res]);
  assert.equal(await code(invoke('guests', boss, 'booking.portal_join_direction', { reservation_id: res })), 'RESERVATION_NOT_OPEN');
});
