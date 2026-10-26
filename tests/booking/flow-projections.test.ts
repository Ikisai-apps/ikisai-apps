/** Booking · el evento y su personal para Flow (migración 0480, encargo de VG del 26-10-2026). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, RpcError, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { READS } from '../../supabase/functions/_domain/booking/mod.ts';

let t: TestDatabase;
let owner: string;
let seq = 0;
test.before(async () => {
  t = await createTestDatabase();
  owner = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
});
test.after(async () => { await t.close(); });

const commit = (operations: unknown[]) => {
  const id = `fp-${++seq}`;
  return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations });
};
async function event(title: string, start: string, end: string, guests = 40): Promise<{ reservation: string; event: string }> {
  const reservation = crypto.randomUUID(); const ev = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.reservations', id: reservation, fields: { title, event_type: 'encuentro', status: 'pre_reservada', start_date: start, end_date: end, expected_guests: guests } }]);
  await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: reservation, event_id: ev, from_status: 'pre_reservada' } }]);
  return { reservation, event: ev };
}
async function member(app: string, role: string): Promise<string> {
  const user = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, $3)`, [app, user, role]);
  return user;
}
const read = async (app: string, actor: string, name: string, where: Record<string, unknown> = {}) =>
  ((await t.rpc('core_read', { p_app: app, p_actor: actor, p_name: name, p_args: { where } })) as any).rows as any[];

test('event_projection · Flow (y Booking) leen el evento con sus fechas y su aforo, sin importes ni personas', async () => {
  const { event: ev } = await event('Encuentro de otoño (sintético)', '2026-10-30', '2026-11-01', 120);
  for (const [app, role] of [['flow', 'reader'], ['flow', 'editor'], ['flow', 'owner'], ['booking', 'reader']] as const) {
    const rows = await read(app, await member(app, role), READS.eventProjection, { event_id: ev });
    assert.equal(rows.length, 1, `${app} ${role}`);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['ends_on', 'event_code', 'event_id', 'event_revision', 'expected_attendance', 'kind', 'name', 'starts_on', 'status']);
    assert.deepEqual([rows[0].name, rows[0].kind, rows[0].status, rows[0].starts_on, rows[0].ends_on, rows[0].expected_attendance],
      ['Encuentro de otoño (sintético)', 'encuentro', 'confirmada', '2026-10-30', '2026-11-01', 120]);
    assert.match(rows[0].event_code, /^EVT_/);
  }
  // el aforo final manda sobre el previsto
  await t.db.query(`update booking.events set final_guests = 95 where id = $1`, [ev]);
  assert.equal((await read('flow', await member('flow', 'reader'), READS.eventProjection, { event_id: ev }))[0].expected_attendance, 95);
});

test('event_projection · una reserva cancelada no sale; otra app sin registro no la lee', async () => {
  const { reservation, event: ev } = await event('Retiro cancelado (sintético)', '2026-12-04', '2026-12-06');
  await t.db.query(`update booking.reservations set status = 'cancelada' where id = $1`, [reservation]);
  assert.equal((await read('flow', await member('flow', 'reader'), READS.eventProjection, { event_id: ev })).length, 0);
  await assert.rejects(read('tasks', await member('tasks', 'owner'), READS.eventProjection),
    (error: unknown) => error instanceof RpcError && error.code === 'INVALID_OPERATION');
});

test('event_staff_projection · nombre corto, cuenta y ficha de Central; sin cancelados ni horas; solo editor y owner de Flow', async () => {
  const { event: ev } = await event('Encuentro con barra (sintético)', '2027-01-15', '2027-01-17');
  const account = await t.createUser();
  const central = crypto.randomUUID();
  await commit([
    { op: 'insert', table: 'booking.staff_assignments', id: crypto.randomUUID(), fields: { event_id: ev, person_name: '  Marta   Ruiz Gómez ', function: 'apoyo_logistico', work_date: '2027-01-16', planned_hours: 8, member_user_id: account, person_ref_app: 'central', person_ref_id: central, notes: 'nota interna' } },
    { op: 'insert', table: 'booking.staff_assignments', id: crypto.randomUUID(), fields: { event_id: ev, person_name: 'Lucas', function: 'coordinacion_general' } },
    { op: 'insert', table: 'booking.staff_assignments', id: crypto.randomUUID(), fields: { event_id: ev, person_name: 'Persona Cancelada', function: 'cocina', status: 'cancelada' } },
  ]);
  const rows = (await read('flow', await member('flow', 'editor'), READS.eventStaffProjection, { event_id: ev }))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  assert.deepEqual(rows, [
    { event_id: ev, user_id: null, central_person_id: null, display_name: 'Lucas', role: 'coordinacion_general', day: null },
    { event_id: ev, user_id: account, central_person_id: central, display_name: 'Marta R.', role: 'apoyo_logistico', day: '2027-01-16' },
  ]);
  assert.equal((await read('flow', await member('flow', 'owner'), READS.eventStaffProjection, { event_id: ev })).length, 2);
  await assert.rejects(read('flow', await member('flow', 'reader'), READS.eventStaffProjection, { event_id: ev }));
});
