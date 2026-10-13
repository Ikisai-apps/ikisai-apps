/** sync-client 0.6: cliente secundario con `sessionFrom` (módulo `resources` en `/api/v1/resources`, RECURSOS.md §3). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const APP_TABLE: TableName = 'tasks.tasks';
const SPACES: TableName = 'resources.spaces';

/** Dos servidores en el mismo origen: la app y el módulo, que aceptan los mismos tokens (misma sesión de Supabase). */
function pair() {
  const app = new FakeServer({ app: 'tasks', tables: [APP_TABLE] });
  const module = new FakeServer({ app: 'resources', apiBase: '/api/v1/resources', tables: [SPACES] });
  module.tokens = app.tokens;
  const fetchBoth = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://tasks.test');
    return url.pathname.startsWith('/api/v1/resources/') ? module.fetch(input, init) : app.fetch(input, init);
  }) as typeof fetch;
  const indexedDB = new IDBFactory();
  const primary = createSyncClient({ app: 'tasks', fetch: fetchBoth, indexedDB, pullIntervalMs: 0, sso: false });
  const secondary = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', fetch: fetchBoth, indexedDB, pullIntervalMs: 0, sessionFrom: primary, clearOnLogout: true });
  return { app, module, primary, secondary };
}

test('el secundario usa la sesión del principal: arranca, escribe y no inicia sesión por su cuenta', async () => {
  const { module, primary, secondary } = pair();
  await primary.login('user@example.com', 'secret');
  await primary.start();
  const boot = await secondary.start();
  assert.equal(boot?.app, 'resources');
  const id = crypto.randomUUID();
  await secondary.commit([{ op: 'insert', table: SPACES, id, fields: { kind: 'edificio', name: 'Albergue' } }]);
  await secondary.sync();
  assert.equal(module.row(SPACES, id)?.name, 'Albergue');
  assert.deepEqual(secondary.session(), primary.session());
  await assert.rejects(secondary.login('user@example.com', 'secret'), /sessionFrom/);
  assert.equal(module.calls.filter((c) => c.path.startsWith('/auth/')).length, 0);
  primary.stop(); secondary.stop();
});

test('un 401 en el secundario refresca a través del principal y reintenta', async () => {
  const { app, module, primary, secondary } = pair();
  await primary.login('user@example.com', 'secret');
  await primary.start();
  await secondary.start();
  const before = primary.session()!.token;
  module.tokens.delete(before); // el token caduca en el servidor
  const id = crypto.randomUUID();
  await secondary.commit([{ op: 'insert', table: SPACES, id, fields: { kind: 'sala', name: 'Sala Roble' } }]);
  await secondary.sync();
  assert.equal(app.refreshCount, 1);
  assert.notEqual(primary.session()!.token, before);
  assert.equal(module.row(SPACES, id)?.name, 'Sala Roble');
  primary.stop(); secondary.stop();
});

test('al cerrar sesión el principal, el secundario se cierra con él y borra su espejo', async () => {
  const { primary, secondary } = pair();
  await primary.login('user@example.com', 'secret');
  await primary.start();
  await secondary.start();
  await secondary.commit([{ op: 'insert', table: SPACES, id: crypto.randomUUID(), fields: { kind: 'sala', name: 'Sala Pino' } }]);
  await secondary.sync();
  assert.equal((await secondary.list(SPACES)).length, 1);
  const ended: string[] = [];
  secondary.onSessionEnd((userId) => { ended.push(userId); });
  await primary.logout();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ended.length, 1);
  assert.equal(secondary.session(), null);
  assert.equal((await secondary.list(SPACES)).length, 0);
  primary.stop(); secondary.stop();
});
