/**
 * Recursos · quién pone el origen de los movimientos (migración 0820, FO4; `core.batch_origin()` del núcleo, 0118): del
 * navegador, la app del lote; de un servidor, el que declare si es una app conocida; inmutable al editar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const WORKER_KEY = 'clave-de-worker-de-pruebas';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let item = ''; let space = '';
const commit = (operations: unknown[], server = false, token?: string) => app.call('/api/v1/resources/commands', {
  token: token ?? app.tokens.editor, body: { requestId: `so-${++seq}`, operations },
  ...(server ? { headers: { 'X-Ikisai-Worker-Key': WORKER_KEY, 'X-Ikisai-Caller': 'invoices' } } : {}),
});
const sourceOf = async (id: string) => (await app.t.db.query<{ s: string | null }>(`select source_app s from resources.movements where id = $1`, [id])).rows[0]?.s ?? null;
const entry = (id: string, source_app?: string) => ({ op: 'insert', table: 'resources.movements', id,
  fields: { item_id: item, space_id: space, quantity: 1, kind: 'entrada_manual', ...(source_app ? { source_app, source_ref: `ref:${id}` } : {}) } });

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api', workerKey: WORKER_KEY }),
  });
  const a3 = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3'`)).rows[0]!.id;
  const building = uuid(); space = uuid(); item = uuid();
  const res = await commit([
    { op: 'insert', table: 'resources.spaces', id: building, fields: { parent_id: a3, kind: 'edificio', name: 'Casa del origen' } },
    { op: 'insert', table: 'resources.spaces', id: space, fields: { parent_id: building, kind: 'almacen', name: 'Despensa del origen' } },
    { op: 'insert', table: 'resources.items', id: item, fields: { name: 'Sal', kind: 'ingrediente', base_unit: 'g' } },
  ], false, app.tokens.owner); // crear espacios es del owner
  assert.equal(res.status, 200, JSON.stringify(res.data));
});
test.after(async () => { await app.close(); });

test('origen · del navegador no cuenta lo que manda el cliente; de servidor, el declarado si la app existe', async () => {
  const fromBrowser = uuid(); const fromServer = uuid();
  assert.equal((await commit([entry(fromBrowser, 'invoices')])).status, 200);
  assert.equal(await sourceOf(fromBrowser), null, 'en un lote de Recursos desde el navegador, ningún origen');
  assert.equal((await commit([entry(fromServer, 'invoices')], true)).status, 200);
  assert.equal(await sourceOf(fromServer), 'invoices');
  const bad = await commit([entry(uuid(), 'nadie')], true);
  assert.equal(bad.status, 422, JSON.stringify(bad.data));
  // Fuera de un lote (SQL directo), como siempre.
  const direct = uuid();
  await app.t.db.query(`insert into resources.movements (id, item_id, space_id, quantity, kind, source_app, source_ref) values ($1, $2, $3, 1, 'entrada_manual', 'food', 'ref:x')`, [direct, item, space]);
  assert.equal(await sourceOf(direct), 'food');
  // Y un arreglo a mano por SQL también vale (Central fija así el origen en sus pruebas).
  await app.t.db.query(`update resources.movements set source_app = 'invoices' where id = $1`, [fromBrowser]);
  assert.equal(await sourceOf(fromBrowser), 'invoices');
});

test('origen · cuadrar entradas solo desde servidor; consumir desde el navegador apunta la app del lote', async () => {
  const rec = (server: boolean) => commit([{ op: 'call', procedure: 'resources.reconcile_entries', args: { source_app: 'invoices', entries: [{ source_ref: 'line:Z', item_id: item, space_id: space, quantity: 5 }] } }], server);
  const refused = await rec(false);
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal((await rec(true)).status, 200);
  const consumed = await commit([{ op: 'call', procedure: 'resources.consume', args: { item_id: item, quantity: 1, kind: 'consumo_servicio', source_app: 'food', source_ref: 'menu_item:Z' } }]);
  assert.equal(consumed.status, 200, JSON.stringify(consumed.data));
  const ids = (consumed.data.results[0].result.movements as Array<{ id: string }>).map((m) => m.id);
  for (const id of ids) assert.equal(await sourceOf(id), null, 'consumo desde el navegador en Recursos: sin origen');
});
