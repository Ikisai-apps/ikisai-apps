/** Booking · agregados de huéspedes para los KPIs de Guests (0496): ventana de reservas y recuentos sin datos personales. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';

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
  const id = `gk-${++seq}`;
  return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }) as Promise<any>;
};
async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}

test('guests_kpi_projection: una fila por reserva de la ventana, con lo que cuenta Guests', async () => {
  const today = (await t.db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  async function reservation(start: number, end: number, confirm = true) {
    const res = crypto.randomUUID(); const event = crypto.randomUUID();
    await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Retiro KPI', status: 'pre_reservada', start_date: plus(start), end_date: plus(end), expected_guests: 10 } }]);
    if (confirm) await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
    return { res, event };
  }
  const near = await reservation(5, 7);
  const running = await reservation(-40, 2);
  const far = await reservation(45, 47);
  const pending = await reservation(3, 4, false);

  const g = () => crypto.randomUUID();
  const [ana, luis, eva, team, gone] = [g(), g(), g(), g(), g()];
  await commit([ana, luis, eva, team, gone].map((id, i) => ({ op: 'insert', table: 'booking.guests', id, fields: { event_id: near.event, first_name: `Huésped ${i + 1}` } })));
  await t.db.query(`update booking.guests set privacy_ack_at = now(), signed_at = now(), ses_status = 'enviado_SES', arrived_at = now() where id = $1`, [ana]);
  await t.db.query(`update booking.guests set privacy_ack_at = now(), arrived_at = now() where id = $1`, [luis]);
  await t.db.query(`update booking.guests set arrived_at = now(), ses_status = 'no_aplica' where id = $1`, [eva]);
  await t.db.query(`update booking.guests set portal_role = 'staff' where id = $1`, [team]);
  await t.db.query(`update booking.guests set anonymized_at = now() where id = $1`, [gone]);

  const rows = (await t.db.query<Record<string, any>>(`select * from booking.guests_kpi_projection`)).rows;
  const ids = rows.map((r) => r.reservation_id);
  assert.ok(ids.includes(near.res) && ids.includes(running.res), 'la de dentro de 5 días y la que está en curso');
  assert.ok(!ids.includes(far.res) && !ids.includes(pending.res), 'ni la de dentro de 45 días ni la pre-reservada');
  const row = rows.find((r) => r.reservation_id === near.res)!;
  // Ana (dentro, firmada, enviada), Luis (dentro, llegó, sin enviar), Eva (llegó, no aplica); fuera el equipo y el anonimizado
  assert.deepEqual([row.guests, row.entered, row.signed, row.unsigned, row.ses_sent, row.ses_pending], [3, 2, 1, 2, 1, 1]);
  assert.deepEqual(Object.keys(row).sort(), ['end_date', 'entered', 'guests', 'reservation_id', 'ses_pending', 'ses_sent', 'signed', 'start_date', 'unsigned']);
  assert.equal(rows.find((r) => r.reservation_id === running.res)!.guests, 0);

  // solo la lee service_role: no se abre por read
  assert.equal(await code(t.rpc('core_read', { p_app: 'booking', p_actor: owner, p_name: 'booking.guests_kpi_projection', p_args: {} })), 'INVALID_OPERATION');
});
