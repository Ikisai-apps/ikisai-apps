/** Booking · peticiones de Organizers B1–B3: detalle de la reserva, `declared` y alta idempotente. */
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
  const res = await app.call('/api/v1/commands', { body: { requestId: `org-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const invoke = (actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: 'organizers', p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: 'organizers', p_actor: actor, p_name: name, p_args: args }) as Promise<any>;

test('organizers · detalle sin datos personales, declared y alta idempotente', async () => {
  const res = uuid(); const event = uuid(); const room = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro organizador', status: 'pre_reservada', start_date: '2028-02-01', end_date: '2028-02-03',
    expected_guests: 12, minors_count: 2, meal_plan_requested: 'pension_completa', menu_style_requested: 'vegetariano', uses_accommodation: true, requires_meals: true,
    contact_name: 'Persona Organizadora', contact_phone: '600000000', internal_notes: 'nota interna' } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const rev = Number((await app.t.db.query<{ revision: string }>(`select revision from booking.events where id = $1`, [event])).rows[0]!.revision);
  await ok([
    { op: 'update', table: TABLES.events, id: event, expectedRevision: rev, fields: { arrival_time: '17:00', departure_time: '12:00', final_guests: 11, menu_style_confirmed: 'vegano' } },
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'Habitación grande 1', kind: 'habitacion', zone: 'Casa' } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: room, group_label: 'Grupo A', persons: 6 } },
  ]);
  const organizer = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [organizer, JSON.stringify({ grants: [{ reservation_id: res }] })]);

  // B1
  const detail = await read(organizer, 'booking.portal_reservation_detail', { reservation_id: res });
  assert.equal(detail.arrival_time.slice(0, 5), '17:00'); assert.equal(detail.departure_time.slice(0, 5), '12:00');
  assert.deepEqual([detail.final_guests, detail.minors_count, detail.meal_plan, detail.meal_plan_confirmed, detail.menu_style, detail.menu_style_confirmed],
    [11, 2, 'pension_completa', false, 'vegano', true]);
  assert.deepEqual(detail.lodging, [{ space: 'Habitación grande 1', kind: 'habitacion', zone: 'Casa', persons: 6 }]);
  const text = JSON.stringify(detail);
  for (const secret of ['nota interna', '600000000', 'Persona Organizadora', 'Grupo A']) assert.ok(!text.includes(secret), secret);
  await assert.rejects(read(organizer, 'booking.portal_reservation_detail', { reservation_id: uuid() }), (e: any) => e.code === 'OUT_OF_SCOPE');

  // B2
  assert.equal((await read(organizer, 'booking.portal_guests', { reservation_id: res })).declared, false);
  const guest = uuid();
  const first = await invoke(organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guest, fields: { first_name: 'Ana' }, declaration: true });
  assert.ok(first.cursor);
  assert.equal((await read(organizer, 'booking.portal_guests', { reservation_id: res })).declared, true);

  // B3: el mismo alta otra vez (reintento) → éxito sin duplicar; otro organizador con ese id → ROW_EXISTS
  const again = await invoke(organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guest, fields: { first_name: 'Ana' } });
  assert.deepEqual(again, { guest_id: guest, cursor: null, existing: true });
  assert.equal((await app.t.db.query(`select 1 from booking.guests where event_id = $1`, [event])).rows.length, 1);
  const other = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [other, JSON.stringify({ grants: [{ reservation_id: res }] })]);
  await assert.rejects(invoke(other, 'booking.portal_add_guest', { reservation_id: res, guest_id: guest, fields: { first_name: 'Otra' }, declaration: true }), (e: any) => e.code === 'ROW_EXISTS');
});
