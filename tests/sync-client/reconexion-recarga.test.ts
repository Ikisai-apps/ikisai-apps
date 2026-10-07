/**
 * P18: recargar sin red con la outbox guardada y que vuelva la red (evento `online`)
 * debe enviar la cola al instante, sin esperar al pull periódico.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

test('P18: recarga sin red con outbox guardada; al llegar `online` la cola se envía en menos de 2 s', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const idb = new IDBFactory();
  const make = () => createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch, indexedDB: idb, pullIntervalMs: 0 });

  // Sesión con red y snapshot inicial.
  const a = make();
  await a.login('user@example.com', 'secret');
  await a.start();
  await a.sync();
  a.stop();

  // Sin red: la fila queda en la outbox.
  const g = globalThis as Record<string, unknown>;
  const nav = Object.getOwnPropertyDescriptor(g, 'navigator');
  const hadAdd = Object.getOwnPropertyDescriptor(g, 'addEventListener');
  const hadRemove = Object.getOwnPropertyDescriptor(g, 'removeEventListener');
  const listeners = new Map<string, Set<() => void>>();
  const nv = { onLine: false };
  Object.defineProperty(g, 'navigator', { value: nv, configurable: true, writable: true });
  Object.defineProperty(g, 'addEventListener', { configurable: true, writable: true, value: (t: string, f: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f); } });
  Object.defineProperty(g, 'removeEventListener', { configurable: true, writable: true, value: (t: string, f: () => void) => { listeners.get(t)?.delete(f); } });
  server.down = true;
  let b: ReturnType<typeof make> | undefined;
  try {
    const offline = make();
    await offline.start();
    const id = crypto.randomUUID();
    await offline.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Creada sin red' } }]);
    assert.equal(offline.status().pendingCommands, 1);
    offline.stop();

    // Recarga sin red: instancia nueva sobre la misma base.
    b = make();
    await b.start();
    assert.equal(b.status().pendingCommands, 1);
    assert.equal(b.status().network, 'offline');

    // Vuelve la red.
    server.down = false;
    nv.onLine = true;
    for (const f of [...(listeners.get('online') ?? [])]) f();

    const t0 = Date.now();
    // La cola se vacía y el ciclo termina (tras el envío viene el pull: un instante en 'syncing' es correcto).
    while ((b.status().pendingCommands > 0 || b.status().network === 'syncing') && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.status().pendingCommands, 0, 'la cola debe vaciarse sin esperar al pull periódico');
    assert.equal(b.status().network, 'online');
  } finally {
    b?.stop();
    for (const [k, d] of [['navigator', nav], ['addEventListener', hadAdd], ['removeEventListener', hadRemove]] as const) {
      if (d) Object.defineProperty(g, k, d); else delete g[k];
    }
  }
});

test('P18: navigator.onLine sigue en true (no habrá evento `online`); tras recargar con la red caída la cola se envía sola al volver', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const idb = new IDBFactory();
  const make = () => createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch, indexedDB: idb, pullIntervalMs: 0 });

  const a = make();
  await a.login('user@example.com', 'secret');
  await a.start();
  await a.sync();
  server.down = true;
  await a.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Creada sin red' } }]);
  a.stop();

  // Recarga con la red caída pero sin que el navegador lo sepa: start() falla con TypeError.
  const b = make();
  try {
    await b.start();
    assert.equal(b.status().pendingCommands, 1);
    assert.equal(b.status().network, 'offline');

    server.down = false; // vuelve la red y no se dispara ningún evento
    const t0 = Date.now();
    while (b.status().pendingCommands > 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.status().pendingCommands, 0, 'la cola debe vaciarse sin esperar al pull periódico');
  } finally {
    b.stop();
  }
});
