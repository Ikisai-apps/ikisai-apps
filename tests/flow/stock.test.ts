/**
 * Flow · gasto real y aviso de compra (migración 0909, paso 3), sobre PGlite. Solo en la v2 (`fresh_stock` por
 * plantilla): punto «fresco» por ingrediente; reponer la nevera lo descuenta; bajo su umbral se propone «Comprar X».
 * Previsión sintética: jamón 0,015 kg por montadito; mesa 0,3, nevera 0,3 y fresco 0,3 kg; umbral 25 %.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const LINE = crypto.randomUUID();
const JAMON = 'c-jamon';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let v2 = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `k-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const level = async (place: string) => Number((await rows(TABLES.buffers)).find((b) => b.project_id === v2 && b.key === `${JAMON}:${place}`)?.level);
const ingredientUnits = async () => (await rows(TABLES.units)).filter((u) => u.project_id === v2 && u.column_key === 'ingredients').sort((a, b) => Number(!!a.payload?.purchase) - Number(!!b.payload?.purchase) || a.created_at.localeCompare(b.created_at)); // la compra, al final (aunque otra unidad nazca después en el mismo milisegundo)
async function step(id: string) { const u = await row(TABLES.units, id); return ok([call(PROCEDURES.unitStep, { unit_id: id, from: u.status })]); }
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('stock · la v2 nace con fresh_stock en Ingredientes; la v1, no', async () => {
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
  const cols = await rows(TABLES.columns);
  assert.equal(cols.find((c) => c.project_id === v2 && c.key === 'ingredients').config.fresh_stock, true);
  assert.equal(cols.find((c) => c.project_id === V1 && c.key === 'ingredients').config.fresh_stock, undefined);
});

test('stock · generar crea también el punto «fresco», lleno', async () => {
  const serrano = (await rows(TABLES.products)).find((p) => p.project_id === v2 && p.scope === 'clasico' && p.code === 'A');
  await ok([{ op: 'update', table: TABLES.products, id: serrano.id, expectedRevision: serrano.revision, fields: { source_line_id: LINE } }]);
  const out = (await ok([call(PROCEDURES.generateIngredientTasks, { project_id: v2,
    totals: [{ component_key: JAMON, name: 'Jamón serrano', unit: 'kg', mesa: 0.3, nevera: 0.3, fresco: 0.3, convertible: true }],
    rules: [{ line_id: LINE, component_key: JAMON, name: 'Jamón serrano', unit: 'kg', per_unit: 0.015, convertible: true }] })])).results[0].result;
  assert.equal(out.fresh, 1);
  assert.ok(near(await level('fresco'), 0.3));
});

test('stock · mesa ← nevera ← fresco; fresco bajo umbral propone «Comprar X» (compra, al final); hacerla repone fresco', async () => {
  for (const u of await ingredientUnits()) for (let i = 0; i < 3; i++) await step(u.id); // preparar mesa y nevera
  const serrano = (await rows(TABLES.products)).find((p) => p.project_id === v2 && p.scope === 'clasico' && p.code === 'A');
  const order = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id: order, fields: { project_id: v2, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: order, product_id: serrano.id, quantity: 16 } }]);
  const o = await row(TABLES.orders, order);
  await ok([call(PROCEDURES.confirmPayment, { order_id: order, method: 'cash', expected_revision: o.revision })]);
  for (const u of (await rows(TABLES.units)).filter((x) => x.order_id === order)) { await step(u.id); await step(u.id); }
  // Mesa 0,06 → reponer desde nevera (0,24).
  let open = (await ingredientUnits()).filter((u) => u.status === 'proposed');
  assert.equal(open.length, 1); assert.equal(open[0].label, 'Reponer Jamón serrano a mesa desde nevera');
  for (let i = 0; i < 3; i++) await step(open[0].id);
  assert.ok(near(await level('mesa'), 0.3)); assert.ok(near(await level('nevera'), 0.06));
  // Nevera 0,06 → reponer desde fresco (0,24), que descuenta fresco.
  open = (await ingredientUnits()).filter((u) => u.status === 'proposed');
  assert.equal(open.length, 1); assert.equal(open[0].label, 'Reponer Jamón serrano a nevera desde fresco');
  for (let i = 0; i < 3; i++) await step(open[0].id);
  assert.ok(near(await level('nevera'), 0.3)); assert.ok(near(await level('fresco'), 0.06));
  // Fresco 0,06 < 0,075 → «Comprar Jamón serrano», como compra y al final de la columna.
  open = (await ingredientUnits()).filter((u) => u.status === 'proposed');
  assert.equal(open.length, 1); assert.equal(open[0].label, 'Comprar Jamón serrano');
  assert.equal(open[0].payload.purchase, true); assert.ok(near(open[0].payload.qty, 0.24));
  const all = await ingredientUnits();
  assert.equal(all[all.length - 1].id, open[0].id);
  for (let i = 0; i < 3; i++) await step(open[0].id);
  assert.ok(near(await level('fresco'), 0.3));
});

test('stock · Existencias: mesa, nevera y fresco por ingrediente, con lo consumido hoy; fuera de ámbito, nada', async () => {
  const res = await app.call('/api/v1/read/flow.stock_view', { body: { project_id: v2 } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const jamon = res.data.find((i: any) => i.item_key === JAMON);
  assert.deepEqual(Object.keys(jamon.places).sort(), ['fresco', 'mesa', 'nevera']);
  assert.ok(near(jamon.consumed_today, 0.24)); // 16 × 0,015
  const other = await app.call('/api/v1/read/flow.stock_view', { token: app.tokens.editor, body: { project_id: v2 } });
  assert.deepEqual(other.data, []);
});
