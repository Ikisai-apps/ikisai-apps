/**
 * Una versión nueva de la app añade una tabla a un dispositivo ya sincronizado (petición de Finance, tanda 27:
 * `invoices.item_labels`): al arrancar, esa tabla recibe su snapshot sin rehacer el resto ni tocar el cursor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const OLD: TableName = 'invoices.suppliers';
const NEW: TableName = 'invoices.item_labels' as TableName;

test('tabla nueva en un dispositivo ya sincronizado: llegan sus filas antiguas y las de después', async () => {
  const server = new FakeServer({ tables: [OLD, NEW] });
  const before = server.seed(NEW, { name: 'Harina' });
  server.seed(OLD, { name: 'Proveedor' });
  const idb = new IDBFactory();
  const make = (tables: TableName[]) => createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch, indexedDB: idb, pullIntervalMs: 0, tables });

  // Versión de antes: solo la tabla vieja.
  const a = make([OLD]);
  await a.login('user@example.com', 'secret');
  await a.start();
  await a.sync();
  a.stop();

  // Versión nueva: la misma base, con la tabla nueva.
  const b = make([OLD, NEW]);
  await b.start();
  await b.sync();
  const labels = await b.list(NEW);
  assert.deepEqual(labels.map((r: any) => r.id), [before.id], 'la fila de antes del cursor llega con el snapshot de la tabla nueva');
  assert.equal((await b.list(OLD)).length, 1, 'la tabla vieja no se duplica ni se vacía');

  // Lo que cambia después llega por el pull, como siempre.
  const after = server.seed(NEW, { name: 'Azúcar' });
  await b.sync();
  assert.deepEqual((await b.list(NEW)).map((r: any) => r.id).sort(), [before.id, after.id].sort());
  b.stop();

  // Un arranque más no vuelve a pedir el snapshot de la tabla (ya está registrada).
  let snapshots = 0;
  const fetchCounting: typeof fetch = (input, init) => {
    if (String(input).includes('/snapshot')) snapshots++;
    return server.fetch(input, init);
  };
  const c = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: fetchCounting, indexedDB: idb, pullIntervalMs: 0, tables: [OLD, NEW] });
  await c.start();
  await c.sync();
  assert.equal(snapshots, 0);
  c.stop();
});
