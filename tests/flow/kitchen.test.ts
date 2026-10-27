/**
 * Flow · cocina sin tocar el móvil (migración 0912, «B») y resolutor de ámbito para Booking, sobre PGlite. Solo la v2
 * lleva `complete_on_delivery` en Servicio; la v1 entrega como siempre. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedBookingEvent } from './booking-event.ts';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const EVENT = crypto.randomUUID();
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let v2 = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  await seedBookingEvent(app.t.db, EVENT, [app.users.owner]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `k-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

/** Pedido cobrado en `project` con `n` del primer producto preparado y una línea de algo no preparado. */
async function paid(project: string, n: number): Promise<string> {
  const products = (await rows(TABLES.products)).filter((p) => p.project_id === project && p.active);
  const prepared = products.find((p) => p.prepared);
  const plain = products.find((p) => !p.prepared);
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: project, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: prepared.id, quantity: n, position: 1 } },
    ...(plain ? [{ op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: plain.id, quantity: 1, position: 2 } }] : [])]);
  await ok([call(PROCEDURES.confirmPayment, { order_id: id, method: 'cash', expected_revision: (await row(TABLES.orders, id)).revision })]);
  return id;
}

test('cocina · la v2 nace con complete_on_delivery en Servicio; la v1, no, y no puede usarlo', async () => {
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
  const cols = await rows(TABLES.columns);
  assert.equal(cols.find((c) => c.project_id === v2 && c.key === 'service').config.complete_on_delivery, true);
  assert.equal(cols.find((c) => c.project_id === V1 && c.key === 'service').config?.complete_on_delivery, undefined);
  const order = await paid(V1, 1);
  const r = await commit([call(PROCEDURES.deliverAll, { order_id: order, ident: 'number' })]);
  assert.equal(r.data.error.code, 'INVALID_OPERATION');
});

test('cocina · «Dar por hecho y entregar» termina lo que quede a nombre de quien entrega y entrega sin excepción', async () => {
  const order = await paid(v2, 3);
  const units = (await rows(TABLES.units)).filter((u) => u.order_id === order).sort((a, b) => a.idx - b.idx);
  assert.equal(units.length, 3);
  await ok([call(PROCEDURES.unitStep, { unit_id: units[0].id, from: 'pending' })]); // uno ya en curso
  const out = await ok([call(PROCEDURES.deliverAll, { order_id: order, ident: 'presence' })]);
  assert.equal(out.completed_units, 3); assert.equal(out.exception, false);
  const o = await row(TABLES.orders, order);
  assert.equal(o.status, 'delivered'); assert.equal(o.delivery_exception, false); assert.equal(o.delivery_ident, 'presence');
  for (const u of (await rows(TABLES.units)).filter((x) => x.order_id === order)) { assert.equal(u.status, 'done'); assert.equal(u.done_by, app.users.owner); }
  for (const l of (await rows(TABLES.orderLines)).filter((x) => x.order_id === order)) assert.equal(l.delivered_qty, l.quantity);
  const again = await commit([call(PROCEDURES.deliverAll, { order_id: order, ident: 'number' })]);
  assert.equal(again.data.error.code, 'ORDER_ALREADY_DELIVERED');
});

test('cocina · resolutor de ámbito: booking_event verdadero solo para quien tiene un flujo de ese evento', async () => {
  const p = await row(TABLES.projects, v2);
  await ok([{ op: 'update', table: TABLES.projects, id: v2, expectedRevision: p.revision, fields: { booking_event_id: EVENT } }]);
  const q = async (actor: string, kind: string, id: string) =>
    (await app.t.db.query<{ v: boolean }>(`select flow.in_scope($1::uuid, $2::text, $3::text) as v`, [actor, kind, id])).rows[0]!.v;
  assert.equal(await q(app.users.owner, 'booking_event', EVENT), true);
  assert.equal(await q(app.users.editor, 'booking_event', EVENT), false); // sin la v2 en su ámbito
  await app.t.db.query(`update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($1::text)) where app = 'flow' and user_id = $2`, [v2, app.users.editor]);
  assert.equal(await q(app.users.editor, 'booking_event', EVENT), true);
  assert.equal(await q(app.users.owner, 'booking_event', uuid()), false);
  assert.equal(await q(app.users.owner, 'otra_cosa', EVENT), false);
  // Por el núcleo, como lo pregunta Booking (core 0098).
  const viaCore = (await app.t.db.query<{ v: boolean }>("select core.reader_in_scope('flow', $1::uuid, 'booking_event', $2) as v", [app.users.owner, EVENT])).rows[0]!.v;
  assert.equal(viaCore, true);
});
