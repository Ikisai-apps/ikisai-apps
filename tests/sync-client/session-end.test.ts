/** sync-client 0.4: `onSessionEnd` avisa al cerrar sesión, con el userId de quien se va (borradores del feedback, contrato §3.7). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

test('onSessionEnd se dispara una vez al cerrar sesión, con el userId; darse de baja lo silencia', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch.bind(server) as typeof fetch, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  await client.login('user@example.com', 'secret');
  await client.start();
  const userId = client.bootstrap()!.profile.userId;
  const ended: string[] = [];
  const silenced: string[] = [];
  client.onSessionEnd((id) => { ended.push(id); });
  const off = client.onSessionEnd((id) => { silenced.push(id); });
  off();
  await client.logout();
  assert.deepEqual(ended, [userId]);
  assert.deepEqual(silenced, []);
  client.stop();
});
