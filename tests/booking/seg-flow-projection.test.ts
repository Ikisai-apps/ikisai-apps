/** Booking · seguridad B3 (0495): la vista de huéspedes para Flow no se lee de fuera; Flow sigue con flow_guests_of. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { READS } from '../../supabase/functions/_domain/booking/mod.ts';

let t: TestDatabase;
test.before(async () => { t = await createTestDatabase(); });
test.after(async () => { await t.close(); });

async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}

test('B3 · flow_guests_projection: ni lector, ni editor, ni owner de Booking la leen por read', async () => {
  for (const role of ['reader', 'editor', 'owner']) {
    const actor = await t.createUser();
    await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, $2)`, [actor, role]);
    assert.equal(await code(t.rpc('core_read', { p_app: 'booking', p_actor: actor, p_name: READS.flowGuestsProjection, p_args: {} })), 'INVALID_OPERATION', role);
  }
  const reg = await t.db.query(`select 1 from core.allowed_reads where name = $1`, [READS.flowGuestsProjection]);
  assert.equal(reg.rows.length, 0, 'fuera del registro de lecturas');
  const fn = await t.db.query(`select 1 from core.allowed_reads where app = 'flow' and name = $1`, [READS.flowGuestsOf]);
  assert.equal(fn.rows.length, 1, 'Flow sigue leyendo un evento de su ámbito');
});
