/**
 * Booking · caracterización de las supletorias antes de que el organizador pueda activarlas (tanda «supletorias por retiro»,
 * aprobada el 13-10-2026). Lo que aquí se comprueba tiene que seguir igual después: una supletoria sin activar no se ofrece
 * en los portales, no cuenta en las plazas de una habitación y, si el personal la ocupa, la propuesta la cobra.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES, extraBedsInUse, suggestLines } from '../../supabase/functions/_domain/booking/mod.ts';

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
  const res = await app.call('/api/v1/commands', { body: { requestId: `xc-${++seq}-${uuid()}`, operations } });
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
const rows = async (table: string) => (await app.t.db.query<Record<string, any>>(`select * from ${table}`)).rows;

test('supletorias · sin activar no se ofrecen ni cuentan; ocupadas por el personal se cobran', async () => {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro supletorias', status: 'pre_reservada', start_date: '2029-06-01', end_date: '2029-06-03', expected_guests: 3 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const room = uuid(); const [b1, b2, x1, x2] = [uuid(), uuid(), uuid(), uuid()];
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'Hab 7', kind: 'habitacion', capacity: 2, en_suite: true } },
    { op: 'insert', table: TABLES.beds, id: b1, fields: { space_id: room, label: 'Cama 1', position: 1 } },
    { op: 'insert', table: TABLES.beds, id: b2, fields: { space_id: room, label: 'Cama 2', position: 2 } },
    { op: 'insert', table: TABLES.beds, id: x1, fields: { space_id: room, label: 'Supletoria 1', kind: 'supletoria', capacity: 1, position: 3 } },
    { op: 'insert', table: TABLES.beds, id: x2, fields: { space_id: room, label: 'Supletoria 2', kind: 'supletoria', capacity: 1, position: 4 } },
  ]);
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: room, group_label: 'Retiro', persons: 2 } }]);

  const organizer = await member('organizers', [{ reservation_id: res }]);
  const ana = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: ana, declaration: true, fields: { first_name: 'Ana' } });
  const gAna = await member('guests', [{ reservation_id: res, guest_id: ana }]);
  await invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choice: 'choose', rooms: [{ space_id: room }] });

  // sin activar: ni en el portal del organizador ni en el del huésped, y fuera de las plazas
  const orgRoom = (await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res })).rooms[0];
  assert.deepEqual([orgRoom.beds_total, orgRoom.beds_free, orgRoom.beds.map((b: any) => b.label)], [2, 2, ['Cama 1', 'Cama 2']]);
  const guestRoom = (await read('guests', gAna, 'booking.portal_lodging', { guest_id: ana })).rooms[0];
  assert.deepEqual([guestRoom.beds_total, guestRoom.beds_free, guestRoom.beds.map((b: any) => b.label)], [2, 2, ['Cama 1', 'Cama 2']]);
  await fails(invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: x1 }), 'NOT_OFFERED');
  await fails(invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: ana, bed_id: x1 }), 'NOT_OFFERED');
  assert.equal(extraBedsInUse(event, await rows('booking.beds') as any, await rows('booking.room_assignments') as any).length, 0);

  // el personal ocupa una supletoria: se cobra como extra (por cama y noche) y no cambia las plazas fijas del portal
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: room, bed_id: x2, group_label: 'Extra', persons: 1 } }]);
  const inUse = extraBedsInUse(event, await rows('booking.beds') as any, await rows('booking.room_assignments') as any);
  assert.deepEqual(inUse.map((b) => b.id), [x2]);
  const rate = { id: 'sup', name: 'Supletoria', layer: 'extra', unit: 'noche', amount: 15, service: 'cama_supletoria', active: true, deleted_at: null, position: 1,
    min_persons: null, max_persons: null, event_types: null, valid_from: null, valid_to: null };
  const reservation = { start_date: '2029-06-01', end_date: '2029-06-03', expected_guests: 3, event_type: null, uses_accommodation: true } as any;
  assert.deepEqual(suggestLines(reservation, [rate] as any, { extraBeds: inUse.length }).map((l) => [l.rate_id, l.quantity]), [['sup', 2]]);
  const after = (await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res })).rooms[0];
  assert.deepEqual([after.beds_total, after.beds_free], [2, 2]);
});
