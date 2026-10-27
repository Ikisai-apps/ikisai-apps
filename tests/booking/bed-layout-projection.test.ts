/** Booking · la colocación de las camas en su habitación para Central (1416). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';

test('bed_layout_projection: celda de cada cama y cuadrantes de su habitación, con los ids de Recursos; legible por Central', async () => {
  const t = await createTestDatabase();
  try {
    const owner = await t.createUser();
    await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
    let seq = 0;
    const commit = (operations: unknown[]) => { const id = `bl-${++seq}`; return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }); };
    const space = crypto.randomUUID(); const placed = crypto.randomUUID(); const loose = crypto.randomUUID();
    await commit([
      { op: 'insert', table: 'booking.spaces', id: space, fields: { name: 'Dormitorio colocado', kind: 'habitacion', layout: { cols: 6, rows: 8 } } },
      { op: 'insert', table: 'booking.beds', id: placed, fields: { space_id: space, label: 'Cama 1', cell: { x: 2, y: 3, rot: 90 } } },
      { op: 'insert', table: 'booking.beds', id: loose, fields: { space_id: space, label: 'Cama sin colocar' } },
    ]);
    const resourceBed = crypto.randomUUID(); const resourceSpace = crypto.randomUUID();
    await t.db.query(`update booking.beds set resource_id = $2 where id = $1`, [placed, resourceBed]);
    await t.db.query(`update booking.spaces set resource_id = $2 where id = $1`, [space, resourceSpace]);
    const reader = await t.createUser();
    await t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'reader')`, [reader]);
    const out = await t.rpc('core_read', { p_app: 'central', p_actor: reader, p_name: 'booking.bed_layout_projection', p_args: { where: { space_id: space } } }) as any;
    const rows = (out.rows ?? out) as Array<Record<string, any>>;
    assert.equal(rows.length, 1, 'la cama sin celda no sale');
    assert.deepEqual([rows[0]!.bed_id, rows[0]!.resource_bed_id, rows[0]!.resource_space_id, rows[0]!.cols, rows[0]!.rows, rows[0]!.x, rows[0]!.y, rows[0]!.rot, rows[0]!.label],
      [placed, resourceBed, resourceSpace, 6, 8, 2, 3, 90, 'Cama 1']);
    // la leen también las apps que pintan el mapa de zonas (un solo modelo, el de Booking)
    for (const app of ['guests', 'tasks', 'organizers']) {
      const member = await t.createUser();
      await t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'reader')`, [app, member]);
      const got = await t.rpc('core_read', { p_app: app, p_actor: member, p_name: 'booking.bed_layout_projection', p_args: { where: { space_id: space } } }) as any;
      assert.equal(((got.rows ?? got) as unknown[]).length, 1, app);
    }
  } finally {
    await t.close();
  }
});
