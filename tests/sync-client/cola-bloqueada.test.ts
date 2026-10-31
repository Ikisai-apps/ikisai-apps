/**
 * Flow, 31-10 (prueba de la barra con VG): tras errores del servidor los equipos tienen que poder seguir sincronizando.
 * 1) Cabeza de cola: un lote que el servidor responde siempre con 5xx (p. ej. un procedimiento que agota la Edge) bloqueaba
 *    para siempre todo lo que el dispositivo hiciera después. Tras MAX_SERVER_FAILURES ciclos pasa a `rejected` y la cola sigue.
 * 2) Estado de red: tras un fallo pasajero, `network` se quedaba en offline/error hasta el siguiente ciclo aunque la cola
 *    estuviera vacía. Ahora se reintenta solo y vuelve a `online`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

function fail503(): Response {
  return new Response(JSON.stringify({ error: { code: 'BACKEND_UNAVAILABLE', message: 'La Edge agotó el tiempo', details: null } }), {
    status: 503, headers: { 'content-type': 'application/json' },
  });
}

test('cabeza de cola: un lote con 5xx seguidos pasa a rechazado tras cinco ciclos y la cola sigue', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  let broken = true;
  const hits = new Map<string, number>(); // intentos de /commands por id de la fila del lote
  const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (broken && url.endsWith('/commands')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { operations?: Array<{ id?: string }> };
      const id = body.operations?.[0]?.id ?? '?';
      hits.set(id, (hits.get(id) ?? 0) + 1);
      return fail503();
    }
    return server.fetch(input, init);
  }) as typeof fetch;
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: flaky, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();

  const stuck = crypto.randomUUID();
  await client.commit([{ op: 'insert', table: TABLE, id: stuck, fields: { name: 'Atascado' } }]);
  const next = crypto.randomUUID();
  await client.commit([{ op: 'insert', table: TABLE, id: next, fields: { name: 'Detrás' } }]);

  // Los ciclos los disparan tanto sync() como los reintentos automáticos; se cuenta por intentos, no por llamadas.
  await client.sync().catch(() => undefined);
  assert.equal(client.status().network, 'error', 'el estado refleja el fallo del servidor');
  assert.equal(client.status().pendingCommands, 2, 'tras el primer 5xx los dos lotes siguen en la cola');
  assert.equal(client.status().rejected, 0);
  const until = Date.now() + 5000;
  while (client.status().rejected === 0 && Date.now() < until) await client.sync().catch(() => undefined);
  const rejected = await client.rejected();
  assert.equal(rejected.length, 1, 'solo el lote en cabeza se aparta');
  assert.equal(rejected[0]!.error.status, 503);
  assert.equal(rejected[0]!.operations[0]!.id, stuck);
  assert.equal(hits.get(stuck), 5, 'exactamente cinco 5xx seguidos antes de apartarlo');
  assert.ok((hits.get(next) ?? 0) >= 1, 'el siguiente lote ya intenta subir');
  assert.equal(client.status().pendingCommands, 1, 'el segundo lote sigue en la cola, con su propio contador');

  broken = false;
  await client.sync();
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().network, 'online');
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name), ['Detrás'], 'el rechazado no está en el espejo; el de detrás sí llegó');
  client.stop();
});

test('estado de red: un fallo pasajero con la cola vacía se recupera solo', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  let dropOnce = true;
  const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (dropOnce && url.includes('/changes')) { dropOnce = false; throw new TypeError('Failed to fetch'); }
    return server.fetch(input, init);
  }) as typeof fetch;
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: flaky, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync().catch(() => undefined);
  assert.equal(client.status().network, 'offline', 'el fallo de red se refleja en el momento');
  assert.equal(client.status().pendingCommands, 0);
  const until = Date.now() + 3000;
  while (client.status().network !== 'online' && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.equal(client.status().network, 'online', 'sin que nadie toque nada, el reintento devuelve el estado a online');
  client.stop();
});
