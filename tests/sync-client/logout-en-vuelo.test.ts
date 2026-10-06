/** Nota de Invoices: `logout()` con un pull en vuelo no debe dejar filas en el espejo después de borrarlo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

test('logout espera al ciclo en vuelo antes de vaciar el espejo (clearOnLogout)', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  let gate: (() => void) | null = null;
  let held = false;
  const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (held && url.includes('/changes')) await new Promise<void>((r) => { gate = r; });
    return server.fetch(input, init);
  }) as typeof fetch;
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: slowFetch, indexedDB: new IDBFactory(), pullIntervalMs: 0, clearOnLogout: true });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();
  server.seed(TABLE, { name: 'Llega tarde' });
  held = true;
  const cycle = client.sync();
  while (!gate) await new Promise((r) => setTimeout(r, 5));
  let logoutDone = false;
  const out = client.logout().then(() => { logoutDone = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(logoutDone, false, 'logout no debe terminar (ni borrar) mientras un ciclo sigue en vuelo');
  (gate as () => void)();
  await out;
  await cycle.catch(() => undefined);
  assert.equal(client.session(), null);
  assert.deepEqual(await client.list(TABLE), [], 'el espejo queda vacío aunque el pull terminara después del logout');
  client.stop();
});
