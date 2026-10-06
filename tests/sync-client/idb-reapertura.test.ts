/**
 * Fallo de Tasks en Android («No se puede guardar en este navegador» al volver a abrir la PWA minimizada): la base IndexedDB
 * se cerraba (otra ventana subía de versión o el navegador la cerraba en segundo plano) o la apertura quedaba «bloqueada»
 * por una instancia congelada, y el cliente fallaba en vez de reabrir o esperar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';
const open = (idb: IDBFactory, name: string, version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const req = version === undefined ? idb.open(name) : idb.open(name, version);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

test('si otra ventana sube de versión y cierra nuestra conexión, la siguiente operación reabre la base', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const idb = new IDBFactory();
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch, indexedDB: idb, pullIntervalMs: 0, databaseName: 'reabrir' });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();
  // Otra ventana abre con una versión mayor: nuestro onversionchange cierra la conexión.
  const current = await open(idb, 'reabrir');
  const version = current.version;
  current.close();
  const other = await open(idb, 'reabrir', version + 1);
  other.close();
  server.seed(TABLE, { name: 'Tras reabrir' });
  await client.sync();
  assert.equal(client.status().lastError, null, JSON.stringify(client.status().lastError));
  await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Nueva' } }]);
  await client.sync();
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name).sort(), ['Nueva', 'Tras reabrir']);
  client.stop();
});

test('una apertura bloqueada por una instancia congelada espera a que se libere en vez de fallar al instante', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const idb = new IDBFactory();
  // Instancia «congelada»: tiene la base abierta y no atiende versionchange.
  const frozen = await open(idb, 'bloqueo', 1);
  frozen.onversionchange = null;
  setTimeout(() => frozen.close(), 600);
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch, indexedDB: idb, pullIntervalMs: 0, databaseName: 'bloqueo' });
  const t0 = Date.now();
  await client.login('user@example.com', 'secret');   // necesita crear los stores: sube de versión y queda bloqueada
  assert.ok(Date.now() - t0 >= 500, 'esperó a que la otra instancia cerrara');
  await client.start();
  await client.sync();
  assert.equal(client.status().lastError, null);
  client.stop();
});
