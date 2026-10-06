/**
 * Fallo de Booking en Android: al confirmar una reserva (`call` a booking.confirm_reservation) el núcleo devuelve también el
 * registro del procedimiento (op 'call', sin id). Sin tablas configuradas, el cliente lo intentaba guardar como fila y
 * IndexedDB fallaba con «Evaluating the object store's key path did not yield a value»; el lote quedaba pendiente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';
const CALL = { table: 'booking.confirm_reservation', id: null, op: 'call', revision: null, after: { status: 'confirmada' }, actorId: null, requestId: null, at: new Date().toISOString() };

test('los registros de procedimiento (op call) de /changes y /commands no van al espejo ni bloquean la cola', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const inject = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await server.fetch(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (!res.ok || !(/\/changes\?|\/commands$/.test(url))) return res;
    const body = await res.json() as any;
    const list = url.includes('/changes') ? body.items : body.changes;
    if (Array.isArray(list)) {
      const cursor = url.includes('/changes') ? (body.cursor ?? 0) : body.cursor;
      list.push({ ...CALL, cursor, seq: 99 });
    }
    return Response.json(body, { status: res.status });
  }) as typeof fetch;
  // Sin `tables`: el cliente sigue todas las tablas legibles (como Booking).
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: inject, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();
  const id = crypto.randomUUID();
  await client.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Tras confirmar' } }]);
  await client.sync();
  server.seed(TABLE, { name: 'Remota' });
  await client.sync();
  assert.equal(client.status().lastError, null, JSON.stringify(client.status().lastError));
  assert.equal(client.status().pendingCommands, 0);
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name).sort(), ['Remota', 'Tras confirmar']);
  client.stop();
});
