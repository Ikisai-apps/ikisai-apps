/**
 * Flow · pan v2 (migración 0913), sobre PGlite: demanda firme (cobrado sin hacer) + prevista (ritmo × horizonte, con la
 * política de confianza), tope de la máquina y suavizado; la histéresis de la app (steadyMetrics). Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';
import { steadyMetrics, type StationMetric } from '../../apps/flow/src/app/data.ts';

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

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `b-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const station = async () => (await rows(TABLES.units)).find((u) => u.project_id === v2 && u.kind === 'station');
async function metric(): Promise<any> {
  const res = await app.call('/api/v1/read/flow.station_metrics', { body: { project_id: v2 } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data[0].value;
}
async function params(p: Record<string, unknown>): Promise<void> {
  const s = await station();
  await ok([call(PROCEDURES.stationSetParams, { unit_id: s.id, params: p, expected_revision: s.revision })]);
}
/** Pedido cobrado con `n` montaditos del primer producto preparado. Devuelve sus unidades. */
async function paid(n: number): Promise<string[]> {
  const product = (await rows(TABLES.products)).find((p) => p.project_id === v2 && p.prepared);
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: v2, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: product.id, quantity: n } }]);
  const o = (await rows(TABLES.orders)).find((x) => x.id === id);
  await ok([call(PROCEDURES.confirmPayment, { order_id: id, method: 'cash', expected_revision: o.revision })]);
  return (await rows(TABLES.units)).filter((u) => u.order_id === id).map((u) => u.id);
}

test('pan v2 · la v2 nace con bread_v2 (parámetros nuevos); sin pedidos, nada', async () => {
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
  const s = await station();
  assert.equal(s.payload.metric, 'bread_v2');
  assert.equal(s.payload.params.smooth_min, 15); assert.equal(s.payload.params.hysteresis, 2); assert.equal(s.payload.params.per_order_cap, 4);
  const m = await metric();
  assert.equal(m.target, 0); assert.equal(m.firm, 0);
});

test('pan v2 · 7 en 5 min = 1,4/min (sin suavizado); firme + prevista con la política de confianza', async () => {
  await params({ smooth_weight: 0 });
  await paid(4); await paid(3); // 7 unidades cobradas, sin hacer
  let m = await metric();
  assert.equal(m.rate, 1.4); assert.equal(m.firm, 7);
  // 1,4/min ≤ 2 → −60 %: prevista 1,4 × 2 × 0,4 = 1,12 → ⌊1,12⌋ = 1; target 7 + 1.
  assert.equal(m.pct, 60); assert.equal(m.forecast, 1.1); assert.equal(m.target, 8);
  // Al hacerse unidades baja lo firme; la prevista sigue el ritmo.
  const units = (await rows(TABLES.units)).filter((u) => u.project_id === v2 && u.kind === 'prep' && u.status === 'pending').slice(0, 3);
  for (const u of units) {
    await ok([call(PROCEDURES.unitStep, { unit_id: u.id, from: 'pending' })]);
    await ok([call(PROCEDURES.unitStep, { unit_id: u.id, from: 'in_progress' })]);
  }
  m = await metric();
  assert.equal(m.firm, 4); assert.equal(m.target, 5);
});

test('pan v2 · tope de la máquina y suavizado con la ventana larga', async () => {
  await params({ machine_capacity: 3 });
  assert.equal((await metric()).target, 3);
  await params({ machine_capacity: 50, smooth_weight: 0.5 });
  const m = await metric(); // mismas 7 unidades en las dos ventanas: 0,5 × 7/5 + 0,5 × 7/15
  assert.equal(m.rate, Math.round((0.5 * 7 / 5 + 0.5 * 7 / 15) * 100) / 100);
});

test('pan v2 · histéresis de la app: no baila por menos de 2; nunca por debajo de lo firme', () => {
  const at = (target: number, firm: number): Map<string, StationMetric> =>
    new Map([['u', { unit_id: 'u', metric: 'bread_v2', value: { target, firm, rate: 1, window: 5, hysteresis: 2 } }]]);
  let shown = steadyMetrics(new Map(), at(8, 7));
  assert.equal(shown.get('u')!.value.target, 8);
  shown = steadyMetrics(shown, at(9, 7)); // +1: se queda en 8
  assert.equal(shown.get('u')!.value.target, 8);
  shown = steadyMetrics(shown, at(10, 7)); // +2: cambia
  assert.equal(shown.get('u')!.value.target, 10);
  shown = steadyMetrics(shown, at(11, 11)); // lo firme sube a 11: mostrar 10 sería poco
  assert.equal(shown.get('u')!.value.target, 11);
  const plain = new Map([['u', { unit_id: 'u', metric: 'bread_ahead', value: { target: 3, rate: 1, window: 5 } }]]) as Map<string, StationMetric>;
  assert.equal(steadyMetrics(at(9, 0), plain).get('u')!.value.target, 3); // sin histéresis, tal cual
});
