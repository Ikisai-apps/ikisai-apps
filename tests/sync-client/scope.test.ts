/** fl-22: el cliente manda su ámbito en X-Ikisai-Scope, lo guarda en el dispositivo y, al cambiarlo, rehace el espejo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

/** Servidor que respeta `{ names: [...] }`: filtra snapshot y changes como haría el hook `visible` de la app. */
function scopedFetch(server: FakeServer, seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const raw = headers.get('X-Ikisai-Scope');
    if (raw) seen.push(raw);
    const res = await server.fetch(input, init);
    if (!raw || !res.ok || !(/\/snapshot\?|\/changes\?/.test(url))) return res;
    const names = (JSON.parse(raw) as { names?: string[] }).names ?? null;
    const body = await res.json() as any;
    if (url.includes('/snapshot')) for (const t of body.tables) t.rows = t.rows.filter((r: any) => names === null || names.includes(r.name));
    else body.items = body.items.filter((c: any) => c.after === null || names === null || names.includes(c.after.name));
    return Response.json(body, { status: res.status });
  }) as typeof fetch;
}

test('setScope: viaja en la cabecera, se guarda y rehace el espejo con lo del nuevo ámbito', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  server.seed(TABLE, { name: 'Alfa' }); server.seed(TABLE, { name: 'Beta' });
  const seen: string[] = [];
  const idb = new IDBFactory();
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: scopedFetch(server, seen), indexedDB: idb, pullIntervalMs: 0, scope: { names: ['Alfa'] } });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();
  assert.deepEqual(client.scope(), { names: ['Alfa'] });
  assert.ok(seen.length > 0 && seen.every((s) => JSON.parse(s).names[0] === 'Alfa'), 'todas las peticiones llevan el ámbito');
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name), ['Alfa']);

  await client.setScope({ names: ['Beta'] });
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name), ['Beta'], 'tras cambiar el ámbito el espejo es el nuevo');
  assert.ok(client.session(), 'la sesión sigue');

  await client.setScope({ names: ['Beta'] });
  const before = seen.length;
  await client.setScope({ names: ['Beta'] });
  assert.equal(seen.length, before, 'sin cambio no hace nada');

  await client.setScope(null);
  assert.deepEqual((await client.list(TABLE)).map((r) => r.name).sort(), ['Alfa', 'Beta'], 'sin ámbito baja todo');
  client.stop();

  // El ámbito se recuerda en el dispositivo aunque la opción inicial diga otra cosa.
  await client.setScope({ names: ['Alfa'] });
  client.stop();
  const again = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: scopedFetch(server, seen), indexedDB: idb, pullIntervalMs: 0, scope: { names: ['Beta'] } });
  await again.start();
  assert.deepEqual(again.scope(), { names: ['Alfa'] }, 'manda el guardado en el dispositivo');
  again.stop();
});

test('setScope con cambios sin enviar avisa (PENDING_CHANGES) y solo rehace con discardPending', async () => {
  const server = new FakeServer({ tables: [TABLE] });
  const client = createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch.bind(server) as typeof fetch, indexedDB: new IDBFactory(), pullIntervalMs: 0 });
  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();
  server.commandsDown = true;
  await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Pendiente' } }]);
  await client.sync().catch(() => undefined);
  await assert.rejects(client.setScope({ names: ['x'] }), (e: any) => e.code === 'PENDING_CHANGES');
  assert.equal(client.scope(), null, 'el ámbito no cambió');
  server.commandsDown = false;
  await client.setScope({ names: ['x'] }, { discardPending: true });
  assert.deepEqual(client.scope(), { names: ['x'] });
  assert.equal(client.status().pendingCommands, 0);
  client.stop();
});
