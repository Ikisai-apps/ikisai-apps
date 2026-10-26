/**
 * Booking · reglas de acceso a los portales (encargo de VG del 26-10-2026, migración 0481):
 * - el organizador y el personal (no outsider) con cuenta son huéspedes de su retiro en Guests (conciliación por tick);
 * - esas fichas no cuentan para cocina ni recuentos, no van a SES y no eligen cama (aún no hay camas de equipo);
 * - si desaparece el origen, la ficha y el acceso se quedan; nada en retiros terminados;
 * - la conservación ya no quita el permiso de Guests;
 * - dirección («todos»): ve todos los retiros, se apunta a los vivos sin aprobación y nunca actúa por otro huésped.
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

  // No cuenta: sus restricciones no llegan a cocina, ni sale en los recuentos; no va a SES ni marca llegada; no elige cama
  await ok([{ op: 'insert', table: TABLES.restrictions, id: uuid(), fields: { event_id: event, guest_id: rows[0]!.id, restriction_type: 'intolerancia', subject: 'lactosa' } }]);
  const food = (await app.t.db.query<{ d: any[] }>(`select dietary_restrictions d from booking.food_event_projection where event_id = $1`, [event])).rows[0]!.d;
  assert.deepEqual(food, []);
  assert.equal(mine.guests, 0);
  const g = (await app.t.db.query<{ ses_status: string }>(`select ses_status from booking.guests where id = $1`, [rows[0]!.id])).rows[0]!;
  assert.equal(g.ses_status, 'no_aplica');
  await assert.rejects(app.t.db.query(`update booking.guests set arrived_at = now() where id = $1`, [rows[0]!.id]));
  const lodging = await read('guests', org, 'booking.portal_lodging', { guest_id: rows[0]!.id });
  assert.deepEqual([lodging.choice, lodging.team, lodging.rooms], ['off', true, []]);
  assert.equal(await code(invoke('guests', org, 'booking.portal_choose_bed', { guest_id: rows[0]!.id, bed_id: uuid() })), 'NOT_OFFERED');

  // Sin el acceso a Organizers, la ficha y el permiso de Guests se quedan (propuesta de Core, pendiente de VG).
  await app.t.db.query(`select core.portal_revoke_scope('organizers', 'reservation_id', $1)`, [res]);
  assert.equal((await tick()).created, 0);
  assert.equal((await guestsOf(event)).filter((x) => !x.deleted_at).length, 1);
  assert.equal((await guestGrants(org)).filter((x) => x.reservation_id === res).length, 1);
});

test('personal: un turno con cuenta da ficha de huésped (staff); un outsider con turno viene a trabajar y no es huésped', async () => {
  const { event } = await retreat('Retiro con personal');
  const staff = await member('booking');
  const outsider = await app.t.createUser();
  await app.t.db.query(`insert into core.house_levels (user_id, level) values ($1, 'outsider')`, [outsider]);
  await ok([
    { op: 'insert', table: TABLES.staffAssignments, id: uuid(), fields: { event_id: event, person_name: 'Lucía Sintética', function: 'cocina', member_user_id: staff } },
    { op: 'insert', table: TABLES.staffAssignments, id: uuid(), fields: { event_id: event, person_name: 'Pablo Sintético', function: 'apoyo_logistico', member_user_id: outsider } },
    { op: 'insert', table: TABLES.staffAssignments, id: uuid(), fields: { event_id: event, person_name: 'Sin cuenta', function: 'limpieza_previa' } },
  ]);
  assert.equal((await tick()).created, 1);
  const live = (await guestsOf(event)).filter((g) => !g.deleted_at);
  assert.deepEqual(live.map((g) => [g.first_name, g.portal_role]), [['Lucía Sintética', 'staff']]);
  assert.equal((await guestGrants(outsider)).length, 0);
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

test('dirección: ve todos los retiros (también cerrados), se apunta a los vivos sin aprobación y nunca actúa por otro huésped', async () => {
  const { res, event } = await retreat('Retiro privado', { visible: false });
  const boss = await member('guests', [{ all: true }]);
  const plain = await member('guests');
  const range = { from: '2033-01-01', to: '2033-12-31' };
  const seen = await read('guests', boss, 'booking.portal_open_retreats', range);
  assert.equal(seen.direction, true);
  assert.equal(seen.items.find((i: any) => i.reservation_id === res)?.joinable, true);
  assert.ok(!(await read('guests', plain, 'booking.portal_open_retreats', range)).items.some((i: any) => i.reservation_id === res));
  // lo recorre sin estar apuntada (lecturas comunes del retiro)
  assert.equal((await code(read('guests', boss, 'booking.portal_program', { reservation_id: res }))), 'OK');
  assert.equal((await code(read('guests', plain, 'booking.portal_program', { reservation_id: res }))), 'OUT_OF_SCOPE');

  assert.equal(await code(invoke('guests', plain, 'booking.portal_join_direction', { reservation_id: res })), 'OUT_OF_SCOPE');
  const joined = await invoke('guests', boss, 'booking.portal_join_direction', { reservation_id: res });
  assert.equal(joined.guest_ids.length, 1, JSON.stringify(joined));
  const mine = joined.guest_ids[0];
  assert.deepEqual((await guestsOf(event)).map((g) => g.portal_role), ['direccion']);
  assert.equal((await invoke('guests', boss, 'booking.portal_join_direction', { reservation_id: res })).guest_ids.length, 0, 'no se apunta dos veces');
  const lodging = await read('guests', boss, 'booking.portal_lodging', { guest_id: mine });
  assert.deepEqual([lodging.choice, lodging.team], ['off', true]);

  // Otro huésped del mismo retiro: «todos» no le deja leerlo ni tocarlo
  const other = uuid();
  await ok([{ op: 'insert', table: TABLES.guests, id: other, fields: { event_id: event, first_name: 'Otra' } }]);
  assert.equal(await code(read('guests', boss, 'booking.portal_lodging', { guest_id: other })), 'OUT_OF_SCOPE');
  // Cerrado: lo sigue viendo, pero ya no se apunta
  await app.t.db.query(`update booking.reservations set status = 'cerrada' where id = $1`, [res]);
  assert.equal((await read('guests', boss, 'booking.portal_open_retreats', range)).items.find((i: any) => i.reservation_id === res)?.joinable, false);
  assert.equal(await code(invoke('guests', boss, 'booking.portal_join_direction', { reservation_id: res })), 'RESERVATION_NOT_OPEN');
});

// 0483: camas de equipo (VG y Core, 26-10-2026). Las fichas de equipo solo eligen entre ellas; los huéspedes no las ven.
test('camas de equipo: la organizadora elige solo una de equipo; un huésped ni la ve ni la puede elegir', async () => {
  const { res, event } = await retreat('Retiro con camas de equipo');
  const org = await member('organizers');
  await grant('organizers', org, { reservation_id: res });
  await tick();
  const team = (await guestsOf(event)).find((g) => g.portal_role === 'organizer')!;
  const space = uuid(); const teamBed = uuid(); const guestBed = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab con equipo', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: teamBed, fields: { space_id: space, label: 'Cama equipo', team_bed: true } },
    { op: 'insert', table: TABLES.beds, id: guestBed, fields: { space_id: space, label: 'Cama huésped' } },
    // la habitación es del evento (asignada al grupo)
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, group_label: 'Grupo', persons: 1 } },
  ]);
  const lodging = await read('guests', org, 'booking.portal_lodging', { guest_id: team.id });
  assert.deepEqual([lodging.choice, lodging.open, lodging.team], ['choose', true, true]);
  assert.deepEqual(lodging.rooms.flatMap((r: any) => r.beds.map((b: any) => b.label)), ['Cama equipo']);
  assert.equal(await code(invoke('guests', org, 'booking.portal_choose_bed', { guest_id: team.id, bed_id: guestBed })), 'NOT_OFFERED');
  const chosen = await invoke('guests', org, 'booking.portal_choose_bed', { guest_id: team.id, bed_id: teamBed });
  assert.equal(chosen.status, 'confirmed', JSON.stringify(chosen));

  // un huésped normal (con las habitaciones abiertas) no ve ni elige la de equipo
  const guest = uuid();
  await ok([{ op: 'insert', table: TABLES.guests, id: guest, fields: { event_id: event, first_name: 'Huésped' } }]);
  const account = await member('guests');
  await grant('guests', account, { reservation_id: res, guest_id: guest });
  await app.t.db.query(`insert into booking.lodging_settings (event_id, choice) values ($1, 'choose')
    on conflict (event_id) do update set choice = 'choose'`, [event]).catch(() => null);
  await app.t.db.query(`insert into booking.open_rooms (event_id, space_id) values ($1, $2)`, [event, space]).catch(() => null);
  const seen = await read('guests', account, 'booking.portal_lodging', { guest_id: guest });
  assert.ok(!JSON.stringify(seen).includes('Cama equipo'));
  assert.equal(await code(invoke('guests', account, 'booking.portal_choose_bed', { guest_id: guest, bed_id: teamBed })), 'NOT_OFFERED');
});

