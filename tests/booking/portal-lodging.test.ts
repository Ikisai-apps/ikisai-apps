/** Booking · fase 5 de los portales: alojamiento delegable (Organizers B17, Guests BG10). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `f5-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const fails = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (err: any) => JSON.stringify(err?.data ?? err?.message ?? err).includes(code));
};
const member = async (appId: string, grants: unknown[]) => {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)`, [appId, user, JSON.stringify({ grants })]);
  return user;
};
const assignments = async (guest: string) => (await app.t.db.query<{ bed_id: string; status: string; source: string }>(
  `select bed_id, status, source from booking.room_assignments where guest_id = $1 and deleted_at is null`, [guest])).rows;

test('alojamiento · abrir habitaciones con baño, elegir cama atómica, pedir y aprobar, preferencias y nada de nombres ajenos', async () => {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro camas', status: 'pre_reservada', start_date: '2028-07-01', end_date: '2028-07-04', expected_guests: 6 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);

  // inventario: una habitación con baño de 3 y una sin baño, asignadas al retiro por el personal; otra con baño fuera del retiro
  const suite = uuid(); const plain = uuid(); const foreign = uuid();
  const [b1, b2, b3, p1] = [uuid(), uuid(), uuid(), uuid()];
  await ok([
    { op: 'insert', table: TABLES.spaces, id: suite, fields: { name: 'H-12 interna', public_name: 'Habitación Encina', kind: 'habitacion', capacity: 3, en_suite: true } },
    { op: 'insert', table: TABLES.spaces, id: plain, fields: { name: 'H-20', kind: 'habitacion', capacity: 2 } },
    { op: 'insert', table: TABLES.spaces, id: foreign, fields: { name: 'H-30', kind: 'habitacion', capacity: 2, en_suite: true } },
    { op: 'insert', table: TABLES.beds, id: b1, fields: { space_id: suite, label: 'Cama 1' } },
    { op: 'insert', table: TABLES.beds, id: b2, fields: { space_id: suite, label: 'Cama 2' } },
    { op: 'insert', table: TABLES.beds, id: b3, fields: { space_id: suite, label: 'Cama 3' } },
    { op: 'insert', table: TABLES.beds, id: p1, fields: { space_id: plain, label: 'Cama A' } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: foreign, label: 'Cama X' } },
  ]);
  await ok([
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: suite, group_label: 'Retiro camas', persons: 3 } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: plain, group_label: 'Retiro camas', persons: 2 } },
  ]);

  const organizer = await member('organizers', [{ reservation_id: res }]);
  const [ana, bea, carla] = [uuid(), uuid(), uuid()];
  for (const [id, name] of [[ana, 'Ana'], [bea, 'Bea'], [carla, 'Carla']] as const) {
    await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: id, declaration: true, fields: { first_name: name } });
  }
  const gAna = await member('guests', [{ reservation_id: res, guest_id: ana }]);
  const gBea = await member('guests', [{ reservation_id: res, guest_id: bea }]);
  const gCarla = await member('guests', [{ reservation_id: res, guest_id: carla }]);

  // sin abrir nada, el huésped solo ve su habitación (ninguna) y no puede elegir
  const before = await read('guests', gAna, 'booking.portal_lodging', { guest_id: ana });
  assert.deepEqual([before.choice, before.mine, before.rooms], ['off', null, []]);
  await fails(invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: b1 }), 'NOT_OFFERED');

  // solo se abren habitaciones con baño del retiro
  await fails(invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choice: 'choose', rooms: [{ space_id: plain }] }), 'NOT_OFFERED');
  await fails(invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choice: 'choose', rooms: [{ space_id: foreign }] }), 'NOT_OFFERED');
  await invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choice: 'choose', preferences: true, rooms: [{ space_id: suite, option_key: 'doble_bano', supplement: true }] });

  const offer = await read('guests', gAna, 'booking.portal_lodging', { guest_id: ana });
  assert.equal(offer.open, true);
  assert.deepEqual(offer.rooms.map((r: any) => [r.name, r.option_key, r.beds_total, r.beds_free, r.small_en_suite]), [['Habitación Encina', 'doble_bano', 3, 3, true]]);

  // elegir: una cama de una habitación no abierta, no; la elegida queda confirmada y la vieja se sustituye
  await fails(invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: p1 }), 'NOT_OFFERED');
  const c1 = await invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: b1 });
  assert.equal(c1.status, 'confirmed');
  await invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: b2 });
  assert.deepEqual(await assignments(ana), [{ bed_id: b2, status: 'confirmed', source: 'guest' }]);

  // dos a la vez a la misma cama: uno la consigue y el otro recibe BED_TAKEN (la fila de la cama se bloquea)
  const race = await Promise.allSettled([
    invoke('guests', gBea, 'booking.portal_choose_bed', { guest_id: bea, bed_id: b3 }),
    invoke('guests', gCarla, 'booking.portal_choose_bed', { guest_id: carla, bed_id: b3 }),
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = (race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
  assert.ok(JSON.stringify(lost?.data ?? lost?.message ?? lost).match(/BED_TAKEN|BED_OVERBOOKED/), String(lost?.message ?? lost));
  await fails(invoke('guests', gCarla, 'booking.portal_choose_bed', { guest_id: carla, bed_id: b2 }), 'BED_TAKEN');

  // el huésped nunca ve de quién es una cama; el organizador, por guest_id
  const forCarla = await read('guests', gCarla, 'booking.portal_lodging', { guest_id: carla });
  assert.ok(!JSON.stringify(forCarla).includes(ana) && !JSON.stringify(forCarla).includes(bea));
  assert.equal(forCarla.rooms[0].beds_free, 1);
  const rooms = await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res });
  assert.equal(rooms.rooms.length, 2);
  assert.equal(rooms.rooms.find((r: any) => r.space_id === suite).beds.find((b: any) => b.bed_id === b2).guest_id, ana);

  // soltar mientras está abierta; pasado el plazo, cerrada
  await invoke('guests', gAna, 'booking.portal_release_bed', { guest_id: ana });
  assert.deepEqual(await assignments(ana), []);
  await invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choose_until: '2020-01-01' });
  await fails(invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: b1 }), 'CHOICE_CLOSED');

  // con aprobación: queda pendiente y el organizador la aprueba o la rechaza
  await invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choice: 'request', choose_until: '' });
  const req = await invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: b1 });
  assert.equal(req.status, 'requested');
  assert.equal((await read('guests', gAna, 'booking.portal_lodging', { guest_id: ana })).mine.status, 'requested');
  const pending = (await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res })).pending;
  assert.deepEqual(pending.map((x: any) => x.guest_id), [ana]);
  await invoke('organizers', organizer, 'booking.portal_approve_bed', { reservation_id: res, assignment_id: pending[0].assignment_id, approve: true });
  assert.deepEqual(await assignments(ana), [{ bed_id: b1, status: 'confirmed', source: 'guest' }]);

  // el organizador reparte: cualquier cama del retiro (también sin baño), nunca una ocupada; null la quita
  await invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: ana, bed_id: p1 });
  assert.deepEqual(await assignments(ana), [{ bed_id: p1, status: 'confirmed', source: 'organizer' }]);
  const taken = (await assignments(bea))[0]?.bed_id ?? (await assignments(carla))[0]!.bed_id;
  await fails(invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: ana, bed_id: taken }), 'BED_TAKEN');
  await invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: ana, bed_id: null });
  assert.deepEqual(await assignments(ana), []);

  // preferencias: las ven el organizador y el personal
  await invoke('guests', gBea, 'booking.portal_room_preference', { guest_id: bea, text: 'Con Carla, si puede ser', ground_floor: true });
  const prefs = (await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res })).preferences;
  assert.deepEqual(prefs.map((x: any) => [x.guest_id, x.text, x.ground_floor]), [[bea, 'Con Carla, si puede ser', true]]);

  // la muestra no ocupa camas; otro retiro no ve nada
  const preview = await invoke('organizers', organizer, 'booking.portal_preview_guest', { reservation_id: res });
  await fails(invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: preview.guest_id, bed_id: b1 }), 'PREVIEW_READ_ONLY');
  const stranger = await member('organizers', [{ reservation_id: uuid() }]);
  await fails(read('organizers', stranger, 'booking.portal_rooms', { reservation_id: res }), 'OUT_OF_SCOPE');
});
