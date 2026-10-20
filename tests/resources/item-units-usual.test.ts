/** Recursos · el envase habitual y su precio (migración 0810, MUELA-093 y 094). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const uuid = () => crypto.randomUUID();
const UNITS = 'resources.item_units';
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) =>
  app.call('/api/v1/resources/commands', { token, body: { requestId: `iu-${++seq}`, operations } });
const rev = async (id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from resources.item_units where id = $1`, [id])).rows[0]!.revision);

test.before(async () => {
  app = await createTestApp({ app: 'food', slug: 'food-api', origin: 'https://food.ikisai.com',
    createHandler: (config) => createApp({ ...config, app: 'food', slug: 'food-api' }) });
});
test.after(async () => { await app.close(); });

test('envase · uno habitual por artículo; cambiarlo en un commit; precio no negativo', async () => {
  const arroz = uuid(); const kilo = uuid(); const saco = uuid();
  const ok = await commit([
    { op: 'insert', table: 'resources.items', id: arroz, fields: { name: 'Arroz', kind: 'ingrediente', base_unit: 'g' } },
    { op: 'insert', table: UNITS, id: kilo, fields: { item_id: arroz, unit: 'paquete', factor: 1000, usual: true, price: 1.45 } },
    { op: 'insert', table: UNITS, id: saco, fields: { item_id: arroz, unit: 'saco', factor: 5000, price: 6.2 } },
  ], app.tokens.editor);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  // Dos habituales a la vez, no.
  const two = await commit([{ op: 'update', table: UNITS, id: saco, expectedRevision: await rev(saco), fields: { usual: true } }], app.tokens.editor);
  assert.equal(two.status, 422, JSON.stringify(two.data));

  // El último guardado pasa a ser el habitual: se marca el nuevo antes de quitar el anterior, en el mismo commit.
  const swap = await commit([
    { op: 'update', table: UNITS, id: saco, expectedRevision: await rev(saco), fields: { usual: true } },
    { op: 'update', table: UNITS, id: kilo, expectedRevision: await rev(kilo), fields: { usual: false } },
  ], app.tokens.editor);
  assert.equal(swap.status, 200, JSON.stringify(swap.data));
  const rows = (await app.t.db.query<{ unit: string; usual: boolean; price: string }>(`select unit, usual, price from resources.item_units where item_id = $1 order by unit`, [arroz])).rows;
  assert.deepEqual(rows.map((r) => [r.unit, r.usual, Number(r.price)]), [['paquete', false, 1.45], ['saco', true, 6.2]]);

  assert.ok((await commit([{ op: 'update', table: UNITS, id: kilo, expectedRevision: await rev(kilo), fields: { price: -1 } }], app.tokens.editor)).status >= 400);
  // Otro artículo puede tener su propio habitual.
  const sal = uuid();
  assert.equal((await commit([
    { op: 'insert', table: 'resources.items', id: sal, fields: { name: 'Sal', kind: 'ingrediente', base_unit: 'g' } },
    { op: 'insert', table: UNITS, id: uuid(), fields: { item_id: sal, unit: 'bolsa', factor: 1000, usual: true } },
  ], app.tokens.editor)).status, 200);
  // El lector lo ve en su snapshot y no lo cambia.
  const snap = await app.call(`/api/v1/resources/snapshot?tables=${UNITS}`, { token: app.tokens.reader });
  assert.ok(snap.data.tables[0].rows.some((r: any) => r.id === saco && r.usual === true && Number(r.price) === 6.2));
  assert.equal((await commit([{ op: 'update', table: UNITS, id: saco, expectedRevision: await rev(saco), fields: { price: 1 } }], app.tokens.reader)).status, 403);
});
