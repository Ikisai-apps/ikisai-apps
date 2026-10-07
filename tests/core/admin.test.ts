/** Administración común del ecosistema (contrato §3.5): rutas admin/* de la función de Central. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://central.ikisai.com';
let app: TestApp;

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'central', slug: 'central-api', origins: [ORIGIN], admin: true }) });
});
test.after(async () => { await app.close(); });

test('admin · solo el owner de central administra; editor y lector 403', async () => {
  assert.equal((await app.call('/api/v1/admin/accounts', { token: app.tokens.editor })).status, 403);
  assert.equal((await app.call('/api/v1/admin/accounts', { token: app.tokens.reader })).status, 403);
  const ok = await app.call('/api/v1/admin/accounts');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const owner = ok.data.items.find((a: any) => a.userId === app.users.owner);
  assert.match(owner.email, /@example\.invalid$/); // correo de auth.users del arnés assert.deepEqual(owner.memberships.map((m: any) => [m.app, m.role]), [['central', 'owner']]);
});

test('admin · dar, cambiar y quitar accesos en cualquier app; protecciones de propietario', async () => {
  const give = await app.call('/api/v1/admin/memberships', { body: { app: 'booking', userId: app.users.editor, role: 'editor', displayName: 'Editora' } });
  assert.equal(give.status, 200, JSON.stringify(give.data)); assert.equal(give.data.role, 'editor');
  const owner = await app.call('/api/v1/admin/memberships', { body: { app: 'booking', userId: app.users.editor, role: 'owner' } });
  assert.equal(owner.data.role, 'owner');
  const last = await app.call('/api/v1/admin/memberships', { body: { app: 'booking', userId: app.users.editor, role: null } });
  assert.equal(last.status, 422); assert.equal(last.data.error.code, 'LAST_OWNER');
  await app.call('/api/v1/admin/memberships', { body: { app: 'booking', userId: app.users.owner, role: 'owner' } });
  const removed = await app.call('/api/v1/admin/memberships', { body: { app: 'booking', userId: app.users.editor, role: null } });
  assert.equal(removed.status, 200); assert.equal(removed.data.removed, true);
  const self = await app.call('/api/v1/admin/memberships', { body: { app: 'central', userId: app.users.owner, role: null } });
  assert.equal(self.status, 422); assert.equal(self.data.error.code, 'CURRENT_ACCOUNT');
  const demote = await app.call('/api/v1/admin/memberships', { body: { app: 'central', userId: app.users.owner, role: 'editor' } });
  assert.equal(demote.data.error.code, 'CURRENT_ACCOUNT');
  const unknown = await app.call('/api/v1/admin/memberships', { body: { app: 'nope', userId: app.users.editor, role: 'editor' } });
  assert.equal(unknown.status, 404);
});

test('admin · alta de una persona con contraseña temporal y accesos iniciales', async () => {
  const inv = await app.call('/api/v1/admin/invite', { body: { email: 'Nueva@Example.invalid', displayName: 'Nueva', memberships: [{ app: 'tasks', role: 'editor' }, { app: 'food', role: 'reader' }] } });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  assert.equal(inv.data.created, true); assert.ok(inv.data.temporaryPassword); assert.equal(inv.data.email, 'nueva@example.invalid');
  const accounts = (await app.call('/api/v1/admin/accounts')).data.items;
  const nueva = accounts.find((a: any) => a.userId === inv.data.userId);
  assert.equal(nueva.displayName, 'Nueva'); assert.deepEqual(nueva.memberships.map((m: any) => [m.app, m.role]).sort(), [['food', 'reader'], ['tasks', 'editor']]);
  const again = await app.call('/api/v1/admin/invite', { body: { email: 'nueva@example.invalid', memberships: [{ app: 'booking', role: 'reader' }] } });
  assert.equal(again.data.created, false); assert.equal(again.data.temporaryPassword, null);
  assert.equal((await app.call('/api/v1/admin/invite', { token: app.tokens.editor, body: { email: 'x@example.invalid', memberships: [{ app: 'tasks', role: 'editor' }] } })).status, 403);
});

test('admin · agentes de todas las apps, revocación y registro de accesos transversal', async () => {
  // Agente creado en booking por su owner (el administrador lo es desde la prueba anterior).
  const agentId = await app.t.createUser();
  await app.t.rpc('core_agent_key_issue', { p_app: 'booking', p_actor: app.users.owner, p_user: agentId, p_name: 'Bot', p_role: 'editor', p_scopes: null, p_digest: 'b'.repeat(64), p_hint: 'bbbb', p_expires_at: null });
  const noOwner = await app.call('/api/v1/admin/memberships', { body: { app: 'tasks', userId: agentId, role: 'owner' } });
  assert.equal(noOwner.data.error.code, 'INVALID_ROLE');
  const noCentral = await app.call('/api/v1/admin/memberships', { body: { app: 'central', userId: agentId, role: 'reader' } });
  assert.equal(noCentral.data.error.code, 'INVALID_ROLE');
  const agents = await app.call('/api/v1/admin/agents');
  assert.equal(agents.data.items.length, 1); assert.deepEqual(agents.data.items[0].memberships.map((m: any) => m.app), ['booking']);
  const revoked = await app.call(`/api/v1/admin/agents/${agents.data.items[0].keyId}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200); assert.equal(revoked.data.revoked, true);
  const log = await app.call('/api/v1/admin/access-log?limit=50');
  const apps = new Set(log.data.items.map((e: any) => e.app));
  assert.ok(apps.has('booking') && apps.has('tasks'), JSON.stringify([...apps]));
  assert.ok(log.data.items.some((e: any) => e.event === 'key_revoked' && e.meta.by === 'central'));
  const onlyTasks = await app.call('/api/v1/admin/access-log?app=tasks');
  assert.ok(onlyTasks.data.items.every((e: any) => e.app === 'tasks'));
});

test('admin · la ruta agents del kit no puede dar acceso a Central a un agente', async () => {
  const res = await app.call('/api/v1/agents', { body: { name: 'Intruso', role: 'reader' } });
  assert.equal(res.status, 422, JSON.stringify(res.data)); assert.equal(res.data.error.details.reason, 'agents have no access to central');
});

test('admin · estado de cuenta, contraseña temporal nueva, desactivar y reactivar (sin desactivarse a uno mismo)', async () => {
  const accounts = (await app.call('/api/v1/admin/accounts')).data.items;
  const editor = accounts.find((a: any) => a.userId === app.users.editor);
  assert.equal(editor.disabled, false); assert.ok(editor.memberships[0].updatedAt);
  const reset = await app.call(`/api/v1/admin/accounts/${app.users.editor}/password`, { body: {} });
  assert.equal(reset.status, 200, JSON.stringify(reset.data)); assert.ok(reset.data.temporaryPassword);
  const off = await app.call(`/api/v1/admin/accounts/${app.users.editor}/disable`, { body: {} });
  assert.equal(off.status, 200); assert.equal(off.data.disabled, true);
  assert.equal((await app.call('/api/v1/admin/accounts')).data.items.find((a: any) => a.userId === app.users.editor).disabled, true);
  const on = await app.call(`/api/v1/admin/accounts/${app.users.editor}/enable`, { body: {} });
  assert.equal(on.data.disabled, false);
  assert.equal((await app.call('/api/v1/admin/accounts')).data.items.find((a: any) => a.userId === app.users.editor).disabled, false);
  const self = await app.call(`/api/v1/admin/accounts/${app.users.owner}/disable`, { body: {} });
  assert.equal(self.status, 422); assert.equal(self.data.error.code, 'CURRENT_ACCOUNT');
  assert.equal((await app.call(`/api/v1/admin/accounts/${app.users.reader}/disable`, { token: app.tokens.editor, body: {} })).status, 403);
});
