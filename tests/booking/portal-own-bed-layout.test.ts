/** Booking · la posición de la cama propia en las lecturas de portal (1421, petición de Guests): huésped y outsider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `ob-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res.data; }
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
async function member(appId: string, grants: unknown[] | null, level: string | null = null) {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)`, [appId, user, grants ? JSON.stringify({ grants }) : null]);
  if (level) await app.t.db.query(`insert into core.house_levels (user_id, level) values ($1, $2)`, [user, level]);
  return user;
}

test('la cama propia lleva su sitio y el de su habitación: huésped (mine) y outsider (estancias y cama por defecto)', async () => {
  const space = uuid(); const placed = uuid(); const loose = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Dormitorio propio', kind: 'habitacion', capacity: 2, layout: { cols: 4, rows: 6 } } },
    { op: 'insert', table: TABLES.beds, id: placed, fields: { space_id: space, label: 'Cama 1', cell: { x: 1, y: 2, rot: 90 } } },
    { op: 'insert', table: TABLES.beds, id: loose, fields: { space_id: space, label: 'Cama 2' } },
  ]);

  // huésped de un retiro con la cama asignada por el personal (la habitación no está abierta a elegir)
  const res = uuid(); const event = uuid(); const ana = uuid(); const bea = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro con plano', status: 'pre_reservada', start_date: '2038-03-01', end_date: '2038-03-03', expected_guests: 4 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await ok([
    { op: 'insert', table: TABLES.guests, id: ana, fields: { event_id: event, first_name: 'Ana' } },
    { op: 'insert', table: TABLES.guests, id: bea, fields: { event_id: event, first_name: 'Bea' } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, bed_id: placed, guest_id: ana, persons: 1 } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, bed_id: loose, guest_id: bea, persons: 1 } },
  ]);
  const gAna = await member('guests', [{ reservation_id: res, guest_id: ana }]);
  const mine = (await read('guests', gAna, 'booking.portal_lodging', { guest_id: ana })).mine;
  assert.deepEqual([mine.bed_label, mine.room_layout, mine.bed_layout], ['Cama 1', { cols: 4, rows: 6 }, { x: 1, y: 2, rot: 90 }]);
  const gBea = await member('guests', [{ reservation_id: res, guest_id: bea }]);
  const hers = (await read('guests', gBea, 'booking.portal_lodging', { guest_id: bea })).mine;
  assert.deepEqual([hers.room_layout, hers.bed_layout], [{ cols: 4, rows: 6 }, null], 'cama sin colocar: null');

  // outsider: su cama por defecto y su estancia
  const marta = await member('guests', null, 'outsider');
  await ok([{ op: 'insert', table: TABLES.outsiderDefaults, id: uuid(), fields: { account_id: marta, bed_id: placed } }]);
  await invoke('guests', marta, 'booking.portal_stay_save', { id: uuid(), from: '2038-04-05', to: '2038-04-08' });
  const stays = await read('guests', marta, 'booking.portal_my_stays', { from: '2038-04-01', to: '2038-05-01' });
  assert.deepEqual([stays.default_bed.room_layout, stays.default_bed.bed_layout], [{ cols: 4, rows: 6 }, { x: 1, y: 2, rot: 90 }]);
  assert.deepEqual([stays.items[0].room_layout, stays.items[0].bed_layout], [{ cols: 4, rows: 6 }, { x: 1, y: 2, rot: 90 }]);
});
