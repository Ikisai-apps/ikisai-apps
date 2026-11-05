/**
 * «Rehacer los datos de este dispositivo» (VG, 5-11, K-06 / K-08 b): el espejo se borra y se vuelve a bajar sin cerrar sesión;
 * si hay cambios sin enviar, el cliente avisa (PENDING_CHANGES) y solo borra con `discardPending: true`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

test('resetMirror: espejo inconsistente → se rehace desde el servidor con la sesión intacta', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch.bind(server) as typeof fetch, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  await client.login('user@example.com', 'secret');
  await client.start();
  server.seed(TABLE, { name: 'Real' });
  await client.sync();
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name), ['Real']);
  // Un cambio en el servidor que el cliente no verá por /changes (se simula un espejo que se quedó atrás: cursor por delante).
  const ghost = server.seed(TABLE, { name: 'Perdida' });
  server.changes.length = 0; // el servidor «olvida» el cambio incremental: solo un snapshot lo trae
  await client.sync();
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name), ['Real'], 'el espejo se quedó atrás');

  await client.resetMirror();
  assert.ok(client.session(), 'la sesión sigue abierta');
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name).sort(), ['Perdida', 'Real'], 'tras rehacer, el espejo trae la fila que faltaba');
  assert.equal(client.status().network, 'online');
  assert.ok(server.row(TABLE, ghost.id));
  client.stop();
});

test('resetMirror: con cambios sin enviar avisa (PENDING_CHANGES) y solo borra con discardPending', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch.bind(server) as typeof fetch, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();
  server.commandsDown = true;
  await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Sin enviar' } }]);
  await client.sync().catch(() => undefined);
  assert.equal(client.status().pendingCommands, 1);

  await assert.rejects(client.resetMirror(), (e: any) => e.code === 'PENDING_CHANGES' && e.details.pendingCommands === 1);
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name), ['Sin enviar'], 'sin confirmar no se borra nada');

  server.commandsDown = false;
  await client.resetMirror({ discardPending: true });
  assert.equal(client.status().pendingCommands, 0);
  assert.deepEqual(await client.list(TABLE), [], 'lo no enviado se descarta y el espejo es el del servidor');
  assert.ok(client.session());
  client.stop();
});
