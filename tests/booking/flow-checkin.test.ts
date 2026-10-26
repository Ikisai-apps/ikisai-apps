/** Booking · llegada y salida desde Flow (0486, VG 27-10-2026): la vista de huéspedes y guest_arrive / guest_leave. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { PROCEDURES, READS } from '../../supabase/functions/_domain/booking/mod.ts';

let t: TestDatabase;
let editor: string;
let seq = 0;
test.before(async () => {
  t = await createTestDatabase();
  editor = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'editor')`, [editor]);
});
test.after(async () => { await t.close(); });

const commit = (operations: unknown[], actor = editor) => {
  const id = `fc-${++seq}`;
  return t.rpc('core_commit', { p_app: 'booking', p_actor: actor, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }) as Promise<any>;
};
const call = (procedure: string, args: Record<string, unknown>, actor = editor) => commit([{ op: 'call', procedure, args }], actor);
async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}

test('flow_guests_projection: huéspedes del evento con cama y noches, nombre corto y sin datos personales', async () => {
  const res = crypto.randomUUID(); const event = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Jornadas sintéticas', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2031-10-30', end_date: '2031-11-01', expected_guests: 50 } }]);
  await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const space = crypto.randomUUID(); const bed = crypto.randomUUID(); const ana = crypto.randomUUID(); const luis = crypto.randomUUID();
  await commit([
    { op: 'insert', table: 'booking.spaces', id: space, fields: { name: 'Hab sintética', kind: 'habitacion' } },
    { op: 'insert', table: 'booking.beds', id: bed, fields: { space_id: space, label: 'Cama 2' } },
    { op: 'insert', table: 'booking.guests', id: ana, fields: { event_id: event, first_name: 'Ana', last_name_1: 'Ruiz', phone: '600000000', email: 'ana@example.invalid' } },
    { op: 'insert', table: 'booking.guests', id: luis, fields: { event_id: event, first_name: 'Luis' } },
    { op: 'insert', table: 'booking.room_assignments', id: crypto.randomUUID(), fields: { event_id: event, space_id: space, bed_id: bed, guest_id: ana, persons: 1, from_date: '2031-10-31', to_date: '2031-11-01' } },
  ]);
  const reader = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('flow', $1, 'reader')`, [reader]);
  const rows = ((await t.rpc('core_read', { p_app: 'flow', p_actor: reader, p_name: READS.flowGuestsProjection, p_args: { where: { event_id: event } } })) as any).rows
    .sort((a: any, b: any) => a.display_name.localeCompare(b.display_name));
  assert.deepEqual(rows.map((r: any) => [r.display_name, r.space_name, r.bed_label, r.from_date, r.to_date, r.arrived_at, r.left_at, r.signed, r.portal_role]), [
    ['Ana R.', 'Hab sintética', 'Cama 2', '2031-10-31', '2031-11-01', null, null, false, null],
    ['Luis', null, null, '2031-10-30', '2031-11-01', null, null, false, null],
  ]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['arrived_at', 'bed_label', 'display_name', 'event_id', 'from_date', 'guest_id', 'guest_revision', 'left_at', 'portal_role', 'signed', 'space_name', 'to_date']);
  assert.ok(!JSON.stringify(rows).includes('600000000') && !JSON.stringify(rows).includes('example.invalid'));

  // llegada y salida: idempotentes y con su reverso
  const arrived = await call(PROCEDURES.guestArrive, { guest_id: ana });
  const at = (await t.db.query<{ a: string | null; l: string | null }>(`select arrived_at::text a, left_at::text l from booking.guests where id = $1`, [ana])).rows[0]!;
  assert.ok(at.a, JSON.stringify(arrived));
  await call(PROCEDURES.guestArrive, { guest_id: ana });
  assert.equal((await t.db.query<{ a: string }>(`select arrived_at::text a from booking.guests where id = $1`, [ana])).rows[0]!.a, at.a, 'repetir no cambia la hora');
  await call(PROCEDURES.guestLeave, { guest_id: ana });
  assert.ok((await t.db.query<{ l: string | null }>(`select left_at::text l from booking.guests where id = $1`, [ana])).rows[0]!.l);
  assert.equal(await code(call(PROCEDURES.guestArrive, { guest_id: ana, undo: true })), 'GUEST_ALREADY_LEFT');
  await call(PROCEDURES.guestLeave, { guest_id: ana, undo: true });
  await call(PROCEDURES.guestArrive, { guest_id: ana, undo: true });
  const back = (await t.db.query<{ a: string | null; l: string | null }>(`select arrived_at::text a, left_at::text l from booking.guests where id = $1`, [ana])).rows[0]!;
  assert.deepEqual([back.a, back.l], [null, null]);

  // comunicado a SES: la llegada ya no se deshace; una ficha de equipo no marca llegada; el lector no escribe
  await call(PROCEDURES.guestArrive, { guest_id: luis });
  await t.db.query(`update booking.guests set ses_status = 'enviado_SES', ses_sent_at = now() where id = $1`, [luis]);
  assert.equal(await code(call(PROCEDURES.guestArrive, { guest_id: luis, undo: true })), 'SES_ALREADY_REGISTERED');
  const org = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.guests', id: org, fields: { event_id: event, first_name: 'Org' } }]);
  await t.db.query(`update booking.guests set portal_role = 'organizer' where id = $1`, [org]);
  assert.equal(await code(call(PROCEDURES.guestArrive, { guest_id: org })), 'TEAM_GUEST');
  const bookingReader = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'reader')`, [bookingReader]);
  assert.notEqual(await code(call(PROCEDURES.guestLeave, { guest_id: ana }, bookingReader)), 'OK');
  assert.equal(await code(call(PROCEDURES.guestArrive, { guest_id: crypto.randomUUID() })), 'NOT_FOUND');
});
