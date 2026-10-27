/**
 * Flow · comportamiento «station» (puesto) y métrica `bread_ahead` (migración 0908), sobre PGlite. La v1 congelada no
 * tiene puesto; la v2 nace con «Pan» desde la plantilla. Valores por defecto: ventana 5 min, tope 4 por pedido,
 * 1 + 1 min por delante, tramos [≤2: −60 %, ≤8: −30 %, resto: 0 %]. (La v2 nace con bread_v2 desde la 0913: aquí se fuerza bread_ahead.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let v2 = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `s-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const station = async () => (await rows(TABLES.units)).find((u) => u.project_id === v2 && u.kind === 'station');
async function metric(): Promise<any> {
  const res = await app.call('/api/v1/read/flow.station_metrics', { body: { project_id: v2 } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data[0].value;
}
/** Un pedido cobrado en la v2 con `n` montaditos del primer producto preparado. */
async function paid(project: string, n: number): Promise<void> {
  const product = (await rows(TABLES.products)).find((p) => p.project_id === project && p.prepared);
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: project, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: product.id, quantity: n } }]);
  const o = await row(TABLES.orders, id);
  await ok([call(PROCEDURES.confirmPayment, { order_id: id, method: 'cash', expected_revision: o.revision })]);
}

test('station · la v1 no tiene puesto; la v2 nace con «Pan» desde la plantilla, en Logística', async () => {
  assert.equal((await rows(TABLES.units)).filter((u) => u.project_id === V1 && u.kind === 'station').length, 0);
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
  let s = await station();
  assert.equal(s.label, 'Pan'); assert.equal(s.column_key, 'logistics'); assert.equal(s.status, 'pending');
  // Desde la 0913 la v2 nace con bread_v2 (bread.test.ts); aquí se sigue probando bread_ahead, que no cambia.
  assert.equal(s.payload.metric, 'bread_v2');
  await app.t.db.exec(`begin; select set_config('flow.proc', 'on', true); update flow.units set payload = payload || '{"metric": "bread_ahead"}'::jsonb where id = '${s.id}'; commit;`);
  s = await station();
  assert.equal(s.payload.metric, 'bread_ahead');
});

test('station · un toque lo ocupa (para quien toca), otro lo suelta; nunca «hecho»', async () => {
  let s = await station();
  await ok([call(PROCEDURES.unitStep, { unit_id: s.id, from: 'pending' })]);
  s = await station();
  assert.equal(s.status, 'in_progress'); assert.equal(s.assigned_to, app.users.owner);
  await ok([call(PROCEDURES.unitStep, { unit_id: s.id, from: 'in_progress' })]);
  s = await station();
  assert.equal(s.status, 'pending'); assert.equal(s.assigned_to, null); assert.equal(s.done_at, null);
});

test('station · bread_ahead: demanda baja, tope por pedido, media y alta; lo de otro proyecto no cuenta', async () => {
  assert.equal((await metric()).target, 0);
  await paid(V1, 4); // otro proyecto: no cuenta
  await paid(v2, 2); // 2 → 0,4/min → 0,8 × (1 − 0,6) → 0
  let m = await metric();
  assert.equal(m.units, 2); assert.equal(m.rate, 0.4); assert.equal(m.target, 0);
  await paid(v2, 10); // tope 4 → 6 → 1,2/min
  m = await metric();
  assert.equal(m.units, 6); assert.equal(m.rate, 1.2); assert.equal(m.target, 0);
  for (let i = 0; i < 3; i++) await paid(v2, 4); // 18 → 3,6/min → 7,2 × 0,7 → 5
  m = await metric();
  assert.equal(m.units, 18); assert.equal(m.rate, 3.6); assert.equal(m.pct, 30); assert.equal(m.target, 5);
  for (let i = 0; i < 6; i++) await paid(v2, 4); // 42 → 8,4/min → 16,8 × 1 → 16
  m = await metric();
  assert.equal(m.units, 42); assert.equal(m.rate, 8.4); assert.equal(m.pct, 0); assert.equal(m.target, 16);
});

test('station · el owner cambia los parámetros desde la tarjeta; el resto no', async () => {
  const s = await station();
  assert.equal((await commit([call(PROCEDURES.stationSetParams, { unit_id: s.id, params: { warmup_min: 2 }, expected_revision: s.revision })], app.tokens.editor)).status, 403);
  await ok([call(PROCEDURES.stationSetParams, { unit_id: s.id, params: { warmup_min: 2 }, expected_revision: s.revision })]);
  const m = await metric(); // 8,4/min × (2 + 1) = 25,2 → 25
  assert.equal(m.target, 25);
  const s2 = await station();
  assert.equal(s2.payload.params.warmup_min, 2); assert.equal(s2.payload.params.per_order_cap, 4);
  assert.equal((await commit([call(PROCEDURES.stationSetParams, { unit_id: s.id, params: { lead_min: -1 }, expected_revision: s2.revision })])).data.error.code, 'INVALID_OPERATION');
});
