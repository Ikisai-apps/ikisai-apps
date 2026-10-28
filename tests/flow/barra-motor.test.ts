/**
 * Flow · la barra sobre el motor genérico (migración 0957), sobre PGlite: cada pedido tiene su unidad `operation` que recorre
 * los carriles de los puestos (caja → cocina → servicio) y se cierra al entregar; la preparación va en «cocina»; el cierre del
 * día es una unidad `result`; el pedido de la carta también nace con su unidad. La v1 congelada no se toca. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const PROJECT = '0f10a000-0000-4000-8000-000000000001';
const SERRANO = '0f10a000-0000-4000-8000-000000000101';
const AGUA = '0f10a000-0000-4000-8000-000000000301';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `bm-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const r = await commit(operations); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0]?.result; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const q = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;
const orderUnit = async (order: string) => (await q(`select * from flow.units where source_ref = 'flow.orders:' || $1 and kind = 'order' and deleted_at is null`, [order]))[0];
/** La barra de la semilla, ya no congelada (el guard no deja descongelar por SQL: sin disparadores). */
async function unfreeze(extra = ''): Promise<void> {
  await app.t.db.query(`set session_replication_role = replica`);
  try { await app.t.db.query(`update flow.projects set frozen = false${extra} where id = $1`, [PROJECT]); }
  finally { await app.t.db.query(`set session_replication_role = origin`); }
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

test('barra genérica · la v1 congelada no tiene unidades de pedido', async () => {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: PROJECT, origin: 'counter' } }]);
  assert.equal(await orderUnit(id), undefined);
});

test('barra genérica · pedido → caja → cocina → servicio → entregado; preparación en «cocina»; cierre como resultado', async () => {
  // La barra de la semilla, ya no congelada: sobre el motor.
  await unfreeze();
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: PROJECT, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: SERRANO, quantity: 1, position: 1 } }]);
  let u = await orderUnit(id);
  assert.deepEqual([u.class, u.lane_key, u.status], ['operation', 'caja', 'pending']);
  // Llega a los dispositivos: está en el registro de cambios del núcleo.
  assert.equal((await q(`select count(*)::int n from core.changes where app = 'flow' and row_id = $1`, [u.id]))[0].n > 0, true);

  const o = (await q(`select revision from flow.orders where id = $1`, [id]))[0];
  await ok([call(PROCEDURES.confirmPayment, { order_id: id, method: 'cash', expected_revision: o.revision })]);
  u = await orderUnit(id);
  const preps = await q(`select * from flow.units where order_id = $1 and kind = 'prep' and deleted_at is null`, [id]);
  assert.ok(preps.length > 0 && preps.every((p: any) => p.lane_key === 'cocina'));
  assert.deepEqual([u.lane_key, u.status, u.pay_seq != null], ['cocina', 'in_progress', true]);

  for (const p of preps) {
    await ok([call(PROCEDURES.unitStep, { unit_id: p.id, from: 'pending' })]);
    await ok([call(PROCEDURES.unitStep, { unit_id: p.id, from: 'in_progress' })]);
  }
  u = await orderUnit(id);
  assert.deepEqual([u.lane_key, u.status], ['servicio', 'in_progress']);

  const o2 = (await q(`select revision from flow.orders where id = $1`, [id]))[0];
  await ok([call(PROCEDURES.deliverOrder, { order_id: id, ident: 'number', confirm_exception: true, expected_revision: o2.revision })]);
  u = await orderUnit(id);
  assert.deepEqual([u.lane_key, u.status], ['servicio', 'done']);

  // Cierre del día → unidad `result` con su enlace, una sola vez aunque se repita el cierre.
  const closed = await ok([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })]);
  await ok([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })]);
  const results = await q(`select * from flow.units where project_id = $1 and kind = 'closure' and deleted_at is null`, [PROJECT]);
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].class, results[0].lane_key, results[0].status, results[0].result_link.id], ['result', 'caja', 'done', closed.closure_id]);
});

test('barra genérica · el pedido de la carta (lote público) nace con su unidad en «caja»', async () => {
  await unfreeze(', serves_public = true');
  const c = await app.call('/api/v1/public/customer', { token: null, body: {} });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const r = await app.call('/api/v1/public/orders', { token: null, body: { lines: [{ productId: AGUA, quantity: 1 }] }, headers: { 'X-Flow-Customer': c.data.token } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = await orderUnit(r.data.orderId);
  assert.deepEqual([u.class, u.lane_key, u.status], ['operation', 'caja', 'pending']);
});
