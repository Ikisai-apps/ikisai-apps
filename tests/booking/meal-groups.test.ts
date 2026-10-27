/** Booking · grupo de comensal (0485, VG 27-10-2026, acordado con Food): recuento por grupo para las ofertas de comida. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { validateFields } from '../../supabase/functions/_domain/booking/mod.ts';

test('grupo de comensal: meal_groups en la proyección de Food y en guest_summary, sin fichas de equipo ni vacíos', async () => {
  const t = await createTestDatabase();
  const owner = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
  let seq = 0;
  const commit = (operations: unknown[]) => { const id = `mg-${++seq}`; return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }); };
  const res = crypto.randomUUID(); const event = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Encuentro sintético', status: 'pre_reservada', start_date: '2031-05-02', end_date: '2031-05-04', expected_guests: 30 } }]);
  await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const guest = (first_name: string, meal_group: string | null) => ({ op: 'insert', table: 'booking.guests', id: crypto.randomUUID(), fields: { event_id: event, first_name, ...(meal_group === null ? {} : { meal_group }) } });
  await commit([guest('Ana', 'VIP'), guest('Bea', ' VIP '), guest('Carla', 'Ponentes'), guest('Dani', null), guest('Eva', '')]);
  // una ficha de equipo (organizador) con grupo: no cuenta como plato
  const team = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.guests', id: team, fields: { event_id: event, first_name: 'Org', meal_group: 'VIP' } }]);
  await t.db.query(`update booking.guests set portal_role = 'organizer' where id = $1`, [team]);

  const row = (await t.db.query<{ g: any }>(`select meal_groups g from booking.food_event_projection where event_id = $1`, [event])).rows[0]!;
  assert.deepEqual(row.g, [{ group: 'Ponentes', guests: 1 }, { group: 'VIP', guests: 2 }]);
  // FO1 de Food (0497): el código público del evento (el del QR) también va en la proyección
  const codes = (await t.db.query<{ p: string | null; e: string | null }>(`select f.public_code p, e.public_code e from booking.food_event_projection f join booking.events e on e.id = f.event_id where f.event_id = $1`, [event])).rows[0]!;
  assert.equal(codes.p, codes.e);
  await t.db.query(`update booking.events set public_code = 'ABCDEFGH23' where id = $1`, [event]);
  assert.equal((await t.db.query<{ p: string }>(`select public_code p from booking.food_event_projection where event_id = $1`, [event])).rows[0]!.p, 'ABCDEFGH23');
  const summary = await t.rpc('core_read', { p_app: 'booking', p_actor: owner, p_name: 'booking.guest_summary', p_args: { event_id: event } }) as any;
  assert.deepEqual(summary.mealGroups, [{ group: 'Ponentes', guests: 1 }, { group: 'VIP', guests: 2 }]);
  assert.equal(summary.total, 5, 'la ficha de equipo tampoco cuenta en el total');
  // BG16: el huésped ve su grupo en su ficha de Guests
  const ana = (await t.db.query<{ id: string }>(`select id from booking.guests where first_name = 'Bea'`)).rows[0]!.id;
  const account = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2::jsonb)`, [account, JSON.stringify({ grants: [{ reservation_id: res, guest_id: ana }] })]);
  assert.equal((await t.rpc('core_read', { p_app: 'guests', p_actor: account, p_name: 'booking.portal_my_guest', p_args: { guest_id: ana } }) as any).meal_group, 'VIP');
  await t.close();
});

test('grupo de comensal: 40 caracteres como mucho (dominio)', () => {
  const field = (f: Record<string, unknown>) => validateFields('booking.guests', f, 'update').map((i) => i.details.field);
  assert.deepEqual(field({ meal_group: 'VIP' }), []);
  assert.deepEqual(field({ meal_group: 'x'.repeat(41) }), ['meal_group']);
});
