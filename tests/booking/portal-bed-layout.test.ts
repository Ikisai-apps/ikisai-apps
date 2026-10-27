/** Booking · la posición de las camas en las lecturas de portal (1417): un solo modelo, el de Booking (layout y cell). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';

test('booking_public_beds y portal_room_json llevan layout en la habitación y en cada cama (null si no hay)', async () => {
  const t = await createTestDatabase();
  try {
    const owner = await t.createUser();
    await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
    let seq = 0;
    const commit = (operations: unknown[]) => { const id = `pb-${++seq}`; return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }); };
    const res = crypto.randomUUID(); const event = crypto.randomUUID(); const space = crypto.randomUUID(); const placed = crypto.randomUUID(); const loose = crypto.randomUUID();
    await commit([
      { op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Jornadas con plano', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-08-05', end_date: '2033-08-07', expected_guests: 30, guests_visible: true } },
      { op: 'insert', table: 'booking.spaces', id: space, fields: { name: 'Dormitorio con plano', kind: 'habitacion', layout: { cols: 4, rows: 6 } } },
      { op: 'insert', table: 'booking.beds', id: placed, fields: { space_id: space, label: 'Cama 1', cell: { x: 0, y: 2, rot: 0 } } },
      { op: 'insert', table: 'booking.beds', id: loose, fields: { space_id: space, label: 'Cama 2' } },
      { op: 'insert', table: 'booking.rates', id: crypto.randomUUID(), fields: { name: 'Cama', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'] } },
    ]);
    await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
    const code = (await t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;

    const pub = await t.rpc('core_public_read', { p_name: 'booking_public_beds', p_args: { event_code: code, from: '2033-08-05', to: '2033-08-06' } }) as any;
    const room = pub.rooms.find((r: any) => r.id === space);
    assert.deepEqual(room.layout, { cols: 4, rows: 6 });
    assert.deepEqual(Object.fromEntries(room.beds.map((b: any) => [b.label, b.layout])), { 'Cama 1': { x: 0, y: 2, rot: 0 }, 'Cama 2': null });

    const portal = (await t.db.query<{ r: any }>(`select booking.portal_room_json($1, $2, null, false) r`, [space, event])).rows[0]!.r;
    assert.deepEqual(portal.layout, { cols: 4, rows: 6 });
    assert.deepEqual(Object.fromEntries(portal.beds.map((b: any) => [b.label, b.layout])), { 'Cama 1': { x: 0, y: 2, rot: 0 }, 'Cama 2': null });
  } finally {
    await t.close();
  }
});
