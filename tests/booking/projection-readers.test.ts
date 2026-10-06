/** Booking · quién puede leer `booking.food_event_projection`: Food, Invoices y la propia Booking; nadie más. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, RpcError } from '../../packages/test-kit/src/pglite.ts';

const PROJECTION = 'booking.food_event_projection';

test('proyección de eventos: la leen Food, Invoices y Booking; Tasks no', async () => {
  const t = await createTestDatabase();
  const owner = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
  const reservation = crypto.randomUUID();
  const event = crypto.randomUUID();
  const commit = (requestId: string, operations: unknown[]) =>
    t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: requestId, p_digest: requestId, p_expected_cursor: null, p_operations: operations });
  await commit('r1', [{ op: 'insert', table: 'booking.reservations', id: reservation, fields: { title: 'Retiro Sintético', status: 'pre_reservada', start_date: '2027-03-05', end_date: '2027-03-07', expected_guests: 20 } }]);
  await commit('r2', [{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: reservation, event_id: event, from_status: 'pre_reservada' } }]);

  const apps = (await t.db.query<{ id: string }>('select id from core.apps')).rows.map((row) => row.id);
  for (const app of ['food', 'invoices', 'booking']) {
    assert.ok(apps.includes(app), `la app ${app} está registrada`);
    const reader = await t.createUser();
    await t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'reader')`, [app, reader]);
    const out = (await t.rpc('core_read', { p_app: app, p_actor: reader, p_name: PROJECTION, p_args: { where: { event_id: event } } })) as any;
    assert.equal(out.rows.length, 1, app);
    assert.deepEqual([out.rows[0].title, out.rows[0].guest_count, out.rows[0].reservation_status], ['Retiro Sintético', 20, 'confirmada']);
  }

  if (apps.includes('tasks')) {
    const stranger = await t.createUser();
    await t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'owner')`, [stranger]);
    await assert.rejects(
      t.rpc('core_read', { p_app: 'tasks', p_actor: stranger, p_name: PROJECTION, p_args: {} }),
      (error: unknown) => error instanceof RpcError && error.code === 'INVALID_OPERATION',
    );
  }
  await t.close();
});
