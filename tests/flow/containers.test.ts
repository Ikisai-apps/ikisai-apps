/**
 * Flow · recipientes y rendimiento (migración 0918), sobre PGlite. Previsión sintética: tomate en rodajas, 2 por montadito;
 * mesa 24, nevera 24 y fresco 8 rodajas; 1 tomate = 8 rodajas (yield de Food #774). Mesa con 3 recipientes × 8 rodajas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const LINE = crypto.randomUUID();
const TOMATE = 'c-tomate';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let v2 = '';
const TOTALS = [{ component_key: TOMATE, name: 'Tomate', unit: 'rodaja', mesa: 24, nevera: 24, fresco: 8, convertible: true, yield: 8, purchase_unit: 'unidad', prep_unit: 'rodaja' }];
const RULES = [{ line_id: LINE, component_key: TOMATE, name: 'Tomate', unit: 'rodaja', per_unit: 2, convertible: true }];

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `r-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const buffer = async (place: string) => (await rows(TABLES.buffers)).find((b) => b.project_id === v2 && b.key === `${TOMATE}:${place}`);
const proposed = async () => (await rows(TABLES.units)).filter((u) => u.project_id === v2 && u.column_key === 'ingredients' && u.status === 'proposed');
async function step(id: string) { const u = (await rows(TABLES.units)).find((x) => x.id === id); return ok([call(PROCEDURES.unitStep, { unit_id: id, from: u.status })]); }

test('recipientes · generar guarda el rendimiento de Food; el owner pone 3 × 8 en la mesa y la capacidad sale de ahí', async () => {
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
  const product = (await rows(TABLES.products)).find((p) => p.project_id === v2 && p.scope === 'clasico' && p.code === 'A');
  await ok([{ op: 'update', table: TABLES.products, id: product.id, expectedRevision: product.revision, fields: { source_line_id: LINE } }]);
  await ok([call(PROCEDURES.generateIngredientTasks, { project_id: v2, totals: TOTALS, rules: RULES })]);
  let mesa = await buffer('mesa');
  assert.equal(Number(mesa.yield), 8); assert.equal(mesa.purchase_unit, 'unidad'); assert.equal(mesa.prep_unit, 'rodaja');
  assert.ok(await buffer('fresco'), 'el punto fresco se crea con el fresco de Food');
  assert.equal((await commit([call(PROCEDURES.setBufferContainers, { buffer_id: mesa.id, containers: 3, per_container: 8 })], app.tokens.editor)).status, 403);
  assert.equal((await commit([call(PROCEDURES.setBufferContainers, { buffer_id: mesa.id, containers: 3, per_container: null })])).data.error.code, 'INVALID_OPERATION');
  await ok([call(PROCEDURES.setBufferContainers, { buffer_id: mesa.id, containers: 3, per_container: 8 })]);
  mesa = await buffer('mesa');
  assert.equal(Number(mesa.capacity), 24); assert.equal(mesa.containers, 3);
});

test('recipientes · la reposición habla en recipientes y traduce; «Comprar» en unidades de compra', async () => {
  for (const u of await proposed()) for (let i = 0; i < 3; i++) await step(u.id); // preparar mesa y nevera
  const product = (await rows(TABLES.products)).find((p) => p.project_id === v2 && p.scope === 'clasico' && p.code === 'A');
  const order = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id: order, fields: { project_id: v2, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: order, product_id: product.id, quantity: 10 } }]);
  const o = (await rows(TABLES.orders)).find((x) => x.id === order);
  await ok([call(PROCEDURES.confirmPayment, { order_id: order, method: 'cash', expected_revision: o.revision })]);
  for (const u of (await rows(TABLES.units)).filter((x) => x.order_id === order)) { await step(u.id); await step(u.id); }
  // Mesa: 24 − 20 = 4 < 6 → reponer 20 rodajas = 3 recipientes ≈ 2,5 tomates.
  let open = await proposed();
  assert.equal(open.length, 1);
  assert.match(open[0].label, /^Reponer mesa: 3 recipientes de Tomate \(20 rodaja ≈ 2\.5 unidad\)$/);
  assert.equal(open[0].payload.containers, 3);
  for (let i = 0; i < 3; i++) await step(open[0].id);
  // Nevera 4 → reponer desde fresco (8 → −12): fresco bajo umbral → «Comprar Tomate · 1 unidad» (8 rodajas ÷ 8).
  open = await proposed();
  assert.equal(open.length, 1); assert.match(open[0].label, /^Reponer Tomate a nevera desde fresco/);
  for (let i = 0; i < 3; i++) await step(open[0].id);
  open = await proposed();
  assert.equal(open.length, 1);
  assert.equal(open[0].label, 'Comprar Tomate · 1 unidad');
  assert.equal(open[0].payload.purchase, true); assert.equal(open[0].payload.purchase_qty, 1); assert.equal(open[0].payload.purchase_unit, 'unidad');
});

test('recipientes · regenerar con otra previsión no pisa la capacidad que sale de los recipientes', async () => {
  await ok([call(PROCEDURES.generateIngredientTasks, { project_id: v2, totals: [{ ...TOTALS[0], mesa: 30 }], rules: RULES })]);
  assert.equal(Number((await buffer('mesa')).capacity), 24);
  assert.equal(Number((await buffer('nevera')).capacity), 24); // sin recipientes: la de Food (no cambió)
});
