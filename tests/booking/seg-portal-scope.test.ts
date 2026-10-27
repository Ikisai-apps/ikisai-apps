/** Booking · seguridad B4 (core 0104): enlaces de Guests desde Booking solo con el ámbito de huéspedes; el lector no los lista. */
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
let n = 0;
const digest = () => (++n).toString(16).padStart(64, '0');
const issue = async (actor: string, app: 'guests' | 'organizers', scope: Record<string, string>) =>
  t.rpc('core_portal_link_issue', { p_issuer_app: 'booking', p_actor: actor, p_app: app, p_user: await t.createUser(), p_digest: digest(), p_scope: scope, p_label: null, p_display_name: 'Persona sintética' });
const list = (actor: string, reservation: string) => t.rpc('core_portal_links_list', { p_issuer_app: 'booking', p_actor: actor, p_reservation: reservation });

test('B4 · enlace de Guests: owner o editor con ámbito; el editor sin ámbito, FORBIDDEN', async () => {
  const reservation = crypto.randomUUID();
  const guest = { reservation_id: reservation, guest_id: crypto.randomUUID() };
  const plain = await member('editor');
  const scoped = await member('editor', { guests: true });
  const owner = await member('owner');
  const reader = await member('reader');
  assert.equal(await code(issue(plain, 'guests', guest)), 'FORBIDDEN', 'editor sin ámbito');
  assert.equal(await code(issue(scoped, 'guests', guest)), 'OK', 'editor con ámbito');
  assert.equal(await code(issue(owner, 'guests', guest)), 'OK', 'owner');
  assert.equal(await code(issue(reader, 'guests', guest)), 'FORBIDDEN', 'lector, como siempre');
  // el enlace del organizador no depende del ámbito de huéspedes
  assert.equal(await code(issue(plain, 'organizers', { reservation_id: reservation })), 'OK');

  // la lista: editor y owner sí; el lector ya no
  assert.equal(await code(list(reader, reservation)), 'FORBIDDEN');
  const items = (await list(plain, reservation)) as Array<{ app: string }>;
  assert.equal(items.length, 3);
  assert.equal(((await list(owner, reservation)) as unknown[]).length, 3);
});
