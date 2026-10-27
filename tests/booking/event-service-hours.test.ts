/** Booking · horario de servicio de cada día en booking.event_projection (1425, petición de Flow, vg-48). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';

test('service_hours: por día, el primer inicio y el último fin del programa; sin programa con hora, null', async () => {
  const t = await createTestDatabase();
  try {
    const owner = await t.createUser();
    await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
    let seq = 0;
    const commit = (operations: unknown[]) => { const id = `sh-${++seq}`; return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }); };
    const res = crypto.randomUUID(); const event = crypto.randomUUID();
    await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Jornadas con horario', status: 'pre_reservada', start_date: '2041-05-02', end_date: '2041-05-04', expected_guests: 30 } }]);
    await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
    const hours = async () => (await t.db.query<{ h: any }>(`select service_hours h from booking.event_projection where event_id = $1`, [event])).rows[0]!.h;
    assert.equal(await hours(), null, 'sin programa');

    const item = (day: string, starts_at: string | null, ends_at: string | null, title: string) =>
      ({ op: 'insert', table: 'booking.program_items', id: crypto.randomUUID(), fields: { event_id: event, day, starts_at, ends_at, title } });
    await commit([
      item('2041-05-02', '10:00', '11:30', 'Bienvenida'),
      item('2041-05-02', '18:00', '20:15', 'Taller'),
      item('2041-05-03', '09:30', null, 'Paseo (sin fin)'),
      item('2041-05-03', '08:00', '09:00', 'Desayuno'),
      item('2041-05-04', null, null, 'Despedida sin hora'),
    ]);
    assert.deepEqual(await hours(), [
      { day: '2041-05-02', starts_at: '10:00', ends_at: '20:15' },
      { day: '2041-05-03', starts_at: '08:00', ends_at: '09:30' },
    ]);
  } finally {
    await t.close();
  }
});
