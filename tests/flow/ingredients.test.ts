/**
 * Flow · columna «Ingredientes» (migración 0904, diseño aprobado por Core el 27-10), sobre PGlite. Previsión sintética
 * (la de Food se lee con la sesión de Flow en la app): jamón serrano, 0,015 kg por montadito; 0,3 kg a mesa y 0,6 a nevera.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const PROJECT = '0f10a000-0000-4000-8000-000000000001';
const SERRANO = '0f10a000-0000-4000-8000-000000000101';
const LINE = crypto.randomUUID();
const JAMON = 'c-jamon';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  await app.t.db.query(`update core.memberships set scopes = $1::jsonb where app = 'flow' and role in ('editor','reader')`, [JSON.stringify({ projects: [PROJECT] })]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.editor) => app.call('/api/v1/commands', { token, body: { requestId: `i-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.editor) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const buffer = async (key: string) => (await rows(TABLES.buffers)).find((b) => b.key === key);
const ingredientUnits = async () => (await rows(TABLES.units)).filter((u) => u.column_key === 'ingredients').sort((a, b) => a.created_at.localeCompare(b.created_at));
async function step(id: string, token = app.tokens.editor) { const u = await row(TABLES.units, id); return ok([call(PROCEDURES.unitStep, { unit_id: id, from: u.status })], token); }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

const generate = () => ok([call(PROCEDURES.generateIngredientTasks, {
  project_id: PROJECT, day: today(),
  totals: [
    { component_key: JAMON, name: 'Jamón serrano', unit: 'kg', mesa: 0.3, nevera: 0.6, convertible: true },
    { component_key: 'c-rodajas', name: 'Tomate en rodajas', unit: 'kg', mesa: null, nevera: null, convertible: false },
  ],
  rules: [{ line_id: LINE, component_key: JAMON, name: 'Jamón serrano', unit: 'kg', per_unit: 0.015, convertible: true }],
})], app.tokens.owner);

test('ingredientes · la columna es dato: «Ingredientes», quick_steps con propuesta; el orden de la barra se mantiene', async () => {
  const cols = (await rows(TABLES.columns)).filter((c) => c.project_id === PROJECT).sort((a, b) => a.position - b.position);
  assert.deepEqual(cols.map((c) => c.key), ['order', 'prep', 'ingredients', 'service', 'logistics']);
  assert.deepEqual(cols.find((c) => c.key === 'ingredients').config, { proposal: true, manual: true });
});

test('ingredientes · generar (solo owner) crea propuestas, puntos y reglas; repetir no duplica; lo no convertible se avisa', async () => {
  const s = await row(TABLES.products, SERRANO);
  await ok([{ op: 'update', table: TABLES.products, id: SERRANO, expectedRevision: s.revision, fields: { source_line_id: LINE } }], app.tokens.owner);
  assert.equal((await commit([call(PROCEDURES.generateIngredientTasks, { project_id: PROJECT, totals: [], rules: [] })])).status, 403);
  const first = (await generate()).results[0].result;
  assert.equal(first.created, 2); assert.equal(first.rules, 1); assert.deepEqual(first.skipped.map((x: any) => x.name), ['Tomate en rodajas']);
  const again = (await generate()).results[0].result;
  assert.equal(again.created, 0);
  const units = await ingredientUnits();
  assert.equal(units.length, 2);
  assert.ok(units.every((u) => u.status === 'proposed'));
  assert.deepEqual(units.map((u) => u.label).sort(), ['Preparar Jamón serrano para mesa', 'Preparar Jamón serrano para nevera']);
  assert.equal((await buffer(`${JAMON}:mesa`)).capacity, 0.3);
});

test('ingredientes · cuatro toques: propuesta → confirmada → asignada → hecha; hacerla llena el punto', async () => {
  for (const u of await ingredientUnits()) {
    for (let i = 0; i < 3; i++) await step(u.id);
    assert.equal((await row(TABLES.units, u.id)).status, 'done');
  }
  assert.equal(Number((await buffer(`${JAMON}:mesa`)).level), 0.3);
  assert.equal(Number((await buffer(`${JAMON}:nevera`)).level), 0.6);
});

test('ingredientes · cada montadito hecho descuenta de la mesa; bajo el 25 % se propone reponer, una sola vez y al final', async () => {
  const order = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id: order, fields: { project_id: PROJECT, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: order, product_id: SERRANO, quantity: 17, position: 1 } }]);
  const o = await row(TABLES.orders, order);
  await ok([call(PROCEDURES.confirmPayment, { order_id: order, method: 'cash', expected_revision: o.revision })]);
  const prep = (await rows(TABLES.units)).filter((u) => u.order_id === order).sort((a, b) => a.idx - b.idx);
  for (const u of prep.slice(0, 15)) { await step(u.id); await step(u.id); }
  assert.ok(Math.abs(Number((await buffer(`${JAMON}:mesa`)).level) - 0.075) < 1e-9);
  assert.equal((await ingredientUnits()).filter((u) => u.status === 'proposed').length, 0); // justo en el umbral, aún no
  await step(prep[15].id); await step(prep[15].id);
  let open = (await ingredientUnits()).filter((u) => u.status === 'proposed');
  assert.equal(open.length, 1);
  assert.equal(open[0].label, 'Reponer Jamón serrano a mesa desde nevera');
  assert.ok(Math.abs(open[0].payload.qty - 0.24) < 1e-9);
  const all = await ingredientUnits();
  assert.equal(all[all.length - 1].id, open[0].id); // al final de la columna
  await step(prep[16].id); await step(prep[16].id);
  open = (await ingredientUnits()).filter((u) => u.status === 'proposed');
  assert.equal(open.length, 1); // se actualiza, no se duplica
  assert.ok(Math.abs(open[0].payload.qty - 0.255) < 1e-9);
  // Revisar la cantidad antes de confirmar.
  await ok([call(PROCEDURES.unitSetQty, { unit_id: open[0].id, qty: 0.2, expected_revision: open[0].revision })]);
  // Reponer: la mesa sube y la nevera baja.
  for (let i = 0; i < 3; i++) await step(open[0].id);
  assert.ok(Math.abs(Number((await buffer(`${JAMON}:mesa`)).level) - 0.245) < 1e-9); // 0,045 + 0,2
  assert.ok(Math.abs(Number((await buffer(`${JAMON}:nevera`)).level) - 0.4) < 1e-9);
  // Corregir un montadito hecho devuelve su consumo.
  await step(prep[16].id);
  assert.ok(Math.abs(Number((await buffer(`${JAMON}:mesa`)).level) - 0.26) < 1e-9);
  assert.ok((await rows(TABLES.events)).some((e) => e.kind === 'stock_reverted' && e.unit_id === prep[16].id));
});

test('ingredientes · a mano nace confirmada y sin movimientos; el cliente no toca nivel ni reglas; el cierre lleva el consumo', async () => {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.units, id, fields: { project_id: PROJECT, column_key: 'ingredients', kind: 'task', label: 'Cortar más tomate', payload: { qty: 1, unit: 'kg', moves: [{ buffer: `${JAMON}:mesa`, delta: 99 }] } } }]);
  const u = await row(TABLES.units, id);
  assert.equal(u.status, 'pending'); assert.equal(u.payload.moves, undefined);
  const b = await buffer(`${JAMON}:mesa`);
  assert.equal((await commit([{ op: 'update', table: TABLES.buffers, id: b.id, expectedRevision: b.revision, fields: { level: 5 } }], app.tokens.owner)).data.error.code, 'PROCEDURE_ONLY');
  await ok([{ op: 'update', table: TABLES.buffers, id: b.id, expectedRevision: b.revision, fields: { threshold_pct: 30 } }], app.tokens.owner);
  assert.equal((await commit([{ op: 'update', table: TABLES.buffers, id: b.id, expectedRevision: b.revision + 1, fields: { threshold_pct: 40 } }])).status, 403);
  const closed = await ok([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })], app.tokens.owner);
  const jamon = closed.results[0].result.data.consumption.find((c: any) => c.item_key === JAMON);
  assert.ok(Math.abs(jamon.qty - 0.24) < 1e-9); // 16 montaditos hechos × 0,015 kg
  assert.equal(jamon.unit, 'kg');
});
