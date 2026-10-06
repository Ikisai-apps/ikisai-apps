/** Sesión única (contrato §3.4): arrancar sin sesión con un pase válido en el dispositivo entra sin contraseña. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

function withSso(server: FakeServer, valid: () => boolean) {
  let calls = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/auth/sso')) {
      calls += 1;
      if (!valid()) return Response.json({ error: { code: 'NO_SSO', message: 'sin pase', details: null } }, { status: 401 });
      // El servidor simulado da una sesión como si hubiera entrado con contraseña.
      return server.fetch(url.replace('/auth/sso', '/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'user@example.com', password: 'secret' }) });
    }
    return server.fetch(input, init);
  }) as typeof fetch;
  return { fetch: f, calls: () => calls };
}

test('sin sesión y con pase válido, start() entra solo y sincroniza', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  server.seed(TABLE, { name: 'Visible tras sso' });
  const t = withSso(server, () => true);
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: t.fetch, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  const boot = await client.start();
  assert.ok(boot, 'arranca con bootstrap'); assert.ok(client.session()); assert.equal(t.calls(), 1);
  await client.sync();
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name), ['Visible tras sso']);
  client.stop();
});

test('sin pase (o sso desactivado), start() no entra y la app pide contraseña', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const t = withSso(server, () => false);
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: t.fetch, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  assert.equal(await client.start(), null); assert.equal(client.session(), null); assert.equal(t.calls(), 1);
  client.stop();
  const off = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: t.fetch, indexedDB: new IDBFactory(), pullIntervalMs: 0, sso: false });
  await off.start();
  assert.equal(t.calls(), 1, 'con sso: false no se intenta');
  off.stop();
});
