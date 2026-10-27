/** Booking · seguridad B2 (0494): las lecturas con datos de huéspedes exigen el ámbito de huéspedes también en el SQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';

let t: TestDatabase;
test.before(async () => { t = await createTestDatabase(); });
test.after(async () => { await t.close(); });

async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}
async function member(role: string, scopes: Record<string, unknown> = {}) {
  const id = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, $2, $3)`, [id, role, JSON.stringify(scopes)]);
  return id;
}
const read = (actor: string, name: string, args: Record<string, unknown>) => t.rpc('core_read', { p_app: 'booking', p_actor: actor, p_name: name, p_args: args });

test('B2 · ses_guest_report_source y guest_signature_file: sin el ámbito de huéspedes, FORBIDDEN; con él, como siempre', async () => {
  const plain = await member('editor');
  const scoped = await member('editor', { guests: true });
  const owner = await member('owner');
  const res = crypto.randomUUID(); const guest = crypto.randomUUID();
  for (const [name, args] of [['booking.ses_guest_report_source', { reservation_id: res }], ['booking.guest_signature_file', { guest_id: guest }]] as const) {
    assert.equal(await code(read(plain, name, args)), 'FORBIDDEN', `${name}: editor sin ámbito`);
    assert.notEqual(await code(read(scoped, name, args)), 'FORBIDDEN', `${name}: editor con ámbito`);
    assert.notEqual(await code(read(owner, name, args)), 'FORBIDDEN', `${name}: owner`);
  }
  assert.equal(await code(read(owner, 'booking.ses_guest_report_source_base', { reservation_id: res })), 'INVALID_OPERATION', 'la de base no se lee de fuera');
  // el tick de SES (sistema) no tiene persona que comprobar
  assert.notEqual(await code(t.db.query(`select booking.ses_guest_report_source_system(jsonb_build_object('args', jsonb_build_object('reservation_id', $1::text)))`, [res])), 'FORBIDDEN');
});
