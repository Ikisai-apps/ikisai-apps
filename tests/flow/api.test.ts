/**
 * Flow · `flow-api` y migración 0900 de punta a punta (docs/flow/API.md), sobre PGlite. La conformidad del núcleo va en
 * `conformance.test.ts`. Aquí, la carta pública, la guarda de columnas y los procedimientos, con los criterios del canon V1
 * §15 que se pueden automatizar sin navegador (7–12, 14, 19–21). Datos ficticios; el catálogo es la semilla del §8.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { applyPublicOperations, createSupabase } from '../../supabase/functions/_kit/mod.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const PROJECT = '0f10a000-0000-4000-8000-000000000001';
/** Productos de la semilla: Serrano (clásico A, 2,50), Payoyo (gourmet β, 3,00), Agua (barra A, 1,00), Cerveza (barra C, 2,00). */
const P = {
  serrano: '0f10a000-0000-4000-8000-000000000101',
  payoyo: '0f10a000-0000-4000-8000-000000000202',
  agua: '0f10a000-0000-4000-8000-000000000301',
  cerveza: '0f10a000-0000-4000-8000-000000000303',
};
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  // Acceso por proyecto (0902): el editor y el lector trabajan en la barra; el owner lo ve todo.
  await app.t.db.query(`update core.memberships set scopes = $1::jsonb where app = 'flow' and role in ('editor','reader')`, [JSON.stringify({ projects: [PROJECT] })]);
});
test.after(async () => { await app.close(); });

type Token = string | null;
async function commit(operations: unknown[], token: Token = app.tokens.editor, requestId = `t-${++seq}-${uuid()}`) {
  return app.call('/api/v1/commands', { token, body: { requestId, operations } });
}
async function ok(operations: unknown[], token: Token = app.tokens.editor) {
  const res = await commit(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const code = (res: { data: any }) => res.data?.error?.code;

async function rows(table: string, where: (r: any) => boolean = () => true): Promise<any[]> {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows.filter(where);
}
const row = async (table: string, id: string) => (await rows(table, (r) => r.id === id))[0];

/** Pedido abierto con sus líneas: `[producto, cantidad]`. */
async function openOrder(lines: Array<[string, number]>, origin: 'counter' | 'public' = 'counter'): Promise<{ id: string; lines: string[] }> {
  const id = uuid();
  const lineIds = lines.map(() => uuid());
  await ok([
    { op: 'insert', table: TABLES.orders, id, fields: { project_id: PROJECT, origin } },
    ...lines.map(([product, quantity], i) => ({ op: 'insert', table: TABLES.orderLines, id: lineIds[i], fields: { order_id: id, product_id: product, quantity, position: i + 1 } })),
  ]);
  return { id, lines: lineIds };
}
async function pay(orderId: string, method = 'cash', token: Token = app.tokens.editor) {
  const order = await row(TABLES.orders, orderId);
  const res = await ok([call(PROCEDURES.confirmPayment, { order_id: orderId, method, expected_revision: order.revision })], token);
  return res.results[0].result;
}
const unitsOf = (orderId: string) => rows(TABLES.units, (u) => u.order_id === orderId).then((us) => us.sort((a, b) => a.idx - b.idx));

test('flow · health y bootstrap con las 9 tablas de Flow', async () => {
  const health = await app.call('/api/v1/health', { token: null });
  assert.equal(health.status, 200); assert.equal(health.data.app, 'flow');
  const boot = await app.call('/api/v1/bootstrap');
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  assert.deepEqual(boot.data.tables.map((t: any) => t.table).sort(), Object.values(TABLES).sort());
});

test('flow · carta pública sin sesión: 13 productos activos del §8, sin pedidos ni personas; origen ajeno 403', async () => {
  const res = await app.call('/api/v1/public/menu', { token: null });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.project, 'Barra · Evento de octubre');
  assert.equal(res.data.products.length, 13);
  const byKey = new Map(res.data.products.map((p: any) => [`${p.scope}:${p.code}`, p]));
  assert.equal((byKey.get('clasico:A') as any).name, 'Serrano');
  assert.equal((byKey.get('clasico:A') as any).priceCents, 250);
  assert.equal((byKey.get('barra:A') as any).name, 'Agua, botella pequeña');
  assert.equal((byKey.get('gourmet:δ') as any).priceCents, 300);
  assert.deepEqual(Object.keys(res.data.products[0]).sort(), ['code', 'description', 'id', 'imageKey', 'name', 'position', 'priceCents', 'scope']);
  assert.equal((byKey.get('clasico:A') as any).imageKey, 'montaditos/serrano');
  assert.equal((byKey.get('clasico:B') as any).imageKey, null);
  assert.equal(res.data.projectId, undefined); // el id del proyecto no sale al navegador
  assert.equal((await app.call('/api/v1/public/menu', { token: null, origin: 'https://foreign.example' })).status, 403);
});

test('flow · catálogo: solo el owner lo cambia; (ámbito, código) único; desactivar lo saca de la carta', async () => {
  const agua = await row(TABLES.products, P.agua);
  const denied = await commit([{ op: 'update', table: TABLES.products, id: P.agua, expectedRevision: agua.revision, fields: { price_cents: 1 } }]);
  assert.equal(denied.status, 403);
  const dup = await commit([{ op: 'insert', table: TABLES.products, id: uuid(), fields: { project_id: PROJECT, scope: 'barra', code: 'A', name: 'Otra agua', price_cents: 100 } }], app.tokens.owner);
  assert.equal(dup.status, 422); assert.equal(code(dup), 'CONSTRAINT_VIOLATION');
  // El mismo código en otro ámbito es otro producto (§8): ya existe clasico:A y barra:A.
  const off = await commit([{ op: 'update', table: TABLES.products, id: P.agua, expectedRevision: agua.revision, fields: { active: false } }], app.tokens.owner);
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const menu = await app.call('/api/v1/public/menu', { token: null });
  assert.equal(menu.data.products.some((p: any) => p.id === P.agua), false);
  const back = await row(TABLES.products, P.agua);
  await ok([{ op: 'update', table: TABLES.products, id: P.agua, expectedRevision: back.revision, fields: { active: true } }], app.tokens.owner);
});

test('flow · guarda: el cliente no escribe estado, número de cobro, precio cerrado, pagos ni eventos', async () => {
  const order = await openOrder([[P.serrano, 1]]);
  const o = await row(TABLES.orders, order.id);
  assert.equal(code(await commit([{ op: 'update', table: TABLES.orders, id: order.id, expectedRevision: o.revision, fields: { status: 'paid', pay_seq: 99 } }])), 'PROCEDURE_ONLY');
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.orders, id: uuid(), fields: { project_id: PROJECT, status: 'paid' } }])), 'PROCEDURE_ONLY');
  const l = await row(TABLES.orderLines, order.lines[0]!);
  assert.equal(code(await commit([{ op: 'update', table: TABLES.orderLines, id: l.id, expectedRevision: l.revision, fields: { unit_price_cents: 1 } }])), 'PROCEDURE_ONLY');
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.payments, id: uuid(), fields: { order_id: order.id, kind: 'charge', method: 'cash', amount_cents: 250 } }])), 'PROCEDURE_ONLY');
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.events, id: uuid(), fields: { project_id: PROJECT, kind: 'paid' } }])), 'PROCEDURE_ONLY');
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.units, id: uuid(), fields: { project_id: PROJECT, column_key: 'prep', kind: 'prep', status: 'done' } }])), 'PROCEDURE_ONLY');
  const pr = await row(TABLES.projects, PROJECT);
  assert.equal((await commit([{ op: 'update', table: TABLES.projects, id: PROJECT, expectedRevision: pr.revision, fields: { name: 'x' } }])).status, 403);
});

test('flow · §15.6–7: pedido de caja y del público se corrige antes de cobrar; nada entra en Preparación sin cobro', async () => {
  const order = await openOrder([[P.serrano, 2], [P.agua, 1]], 'public');
  const line = await row(TABLES.orderLines, order.lines[0]!);
  await ok([{ op: 'update', table: TABLES.orderLines, id: line.id, expectedRevision: line.revision, fields: { quantity: 3 } }]);
  assert.equal((await unitsOf(order.id)).length, 0);
  assert.equal((await row(TABLES.orders, order.id)).status, 'open');
  const empty = await openOrder([]);
  const e = await row(TABLES.orders, empty.id);
  assert.equal(code(await commit([call(PROCEDURES.confirmPayment, { order_id: empty.id, method: 'cash', expected_revision: e.revision })])), 'ORDER_EMPTY');
  assert.equal((await commit([call(PROCEDURES.confirmPayment, { order_id: order.id, method: 'cash', expected_revision: 1 })], app.tokens.reader)).status, 403);
});

test('flow · §15.7, 9: el cobro cierra precios, da número y crea una unidad por montadito; el reintento no duplica', async () => {
  const order = await openOrder([[P.serrano, 3], [P.payoyo, 1], [P.cerveza, 2]]);
  const o = await row(TABLES.orders, order.id);
  const requestId = `pay-${uuid()}`;
  const ops = [call(PROCEDURES.confirmPayment, { order_id: order.id, method: 'bizum', expected_revision: o.revision })];
  const first = await commit(ops, app.tokens.editor, requestId);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const result = first.data.results[0].result;
  assert.equal(result.total_cents, 3 * 250 + 300 + 2 * 200);
  assert.equal(result.units, 4);
  const again = await commit(ops, app.tokens.editor, requestId);
  assert.equal(again.status, 200); assert.equal(again.data.replayed, true);
  const units = await unitsOf(order.id);
  assert.equal(units.length, 4);
  assert.deepEqual(units.map((u) => u.idx), [1, 2, 3, 4]);
  assert.ok(units.every((u) => u.status === 'pending' && u.pay_seq === result.pay_seq && u.column_key === 'prep'));
  const payments = await rows(TABLES.payments, (p) => p.order_id === order.id);
  assert.equal(payments.length, 1); assert.equal(payments[0].amount_cents, result.total_cents); assert.equal(payments[0].method, 'bizum');
  const paid = await row(TABLES.orders, order.id);
  assert.equal(paid.status, 'paid'); assert.equal(paid.pay_seq, result.pay_seq); assert.equal(paid.paid_by, app.users.editor);
  // Con el pedido cobrado, la línea ya no se cambia desde el cliente (solo la cantidad entregada).
  const line = await row(TABLES.orderLines, order.lines[0]!);
  assert.equal(line.unit_price_cents, 250);
  assert.equal(code(await commit([{ op: 'update', table: TABLES.orderLines, id: line.id, expectedRevision: line.revision, fields: { quantity: 1 } }])), 'ORDER_NOT_OPEN');
  await ok([{ op: 'update', table: TABLES.orderLines, id: line.id, expectedRevision: line.revision, fields: { delivered_qty: 1 } }]);
  assert.equal(code(await commit([call(PROCEDURES.confirmPayment, { order_id: order.id, method: 'cash', expected_revision: paid.revision })])), 'ORDER_NOT_OPEN');
});

test('flow · §15.8: dos cobros simultáneos reciben números únicos y consecutivos', async () => {
  const a = await openOrder([[P.serrano, 1]]);
  const b = await openOrder([[P.payoyo, 1]]);
  const [ra, rb] = await Promise.all([pay(a.id, 'cash', app.tokens.editor), pay(b.id, 'bizum', app.tokens.owner)]);
  assert.notEqual(ra.pay_seq, rb.pay_seq);
  assert.equal(Math.abs(ra.pay_seq - rb.pay_seq), 1);
});

test('flow · §15.10: cambiar el precio no toca ventas cobradas; el total lo calcula siempre el servidor', async () => {
  const order = await openOrder([[P.cerveza, 2]]);
  const sold = await pay(order.id);
  assert.equal(sold.total_cents, 400);
  const cerveza = await row(TABLES.products, P.cerveza);
  await ok([{ op: 'update', table: TABLES.products, id: P.cerveza, expectedRevision: cerveza.revision, fields: { price_cents: 250 } }], app.tokens.owner);
  assert.equal((await row(TABLES.orders, order.id)).total_cents, 400);
  assert.equal((await row(TABLES.orderLines, order.lines[0]!)).unit_price_cents, 200);
  const next = await openOrder([[P.cerveza, 2]]);
  assert.equal((await pay(next.id)).total_cents, 500);
  const restored = await row(TABLES.products, P.cerveza);
  await ok([{ op: 'update', table: TABLES.products, id: P.cerveza, expectedRevision: restored.revision, fields: { price_cents: 200 } }], app.tokens.owner);
});

test('flow · §15.12, 14: toques pendiente → en curso → terminado → pendiente; dos toques a la vez, gana uno', async () => {
  const order = await openOrder([[P.serrano, 1]]);
  await pay(order.id);
  const [unit] = await unitsOf(order.id);
  const step = (from: string, token: Token) => commit([call(PROCEDURES.unitStep, { unit_id: unit.id, from })], token);
  const [x, y] = await Promise.all([step('pending', app.tokens.editor), step('pending', app.tokens.owner)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const lost = x.status === 409 ? x : y;
  assert.equal(code(lost), 'UNIT_CHANGED'); assert.equal(lost.data.error.details.status, 'in_progress');
  const winner = x.status === 200 ? app.users.editor : app.users.owner;
  let u = await row(TABLES.units, unit.id);
  assert.equal(u.status, 'in_progress'); assert.equal(u.assigned_to, winner);
  // Ayuda cruzada: la cierra la otra persona y queda como quien la terminó (nota 5 de Core).
  const helper = winner === app.users.editor ? app.tokens.owner : app.tokens.editor;
  assert.equal((await step('in_progress', helper)).status, 200);
  u = await row(TABLES.units, unit.id);
  assert.equal(u.status, 'done'); assert.equal(u.done_by, winner === app.users.editor ? app.users.owner : app.users.editor); assert.equal(u.assigned_to, winner);
  assert.equal((await step('done', app.tokens.editor)).status, 200);
  u = await row(TABLES.units, unit.id);
  assert.equal(u.status, 'pending'); assert.equal(u.assigned_to, null); assert.equal(u.idx, 1); assert.equal(u.pay_seq, (await row(TABLES.orders, order.id)).pay_seq);
  const reverted = await rows(TABLES.events, (e) => e.unit_id === unit.id && e.kind === 'unit_reverted');
  assert.equal(reverted.length, 1); assert.equal(reverted[0].actor, app.users.editor);
});

test('flow · §15.11 y FLOW-DIR-001 §3: reducir un pedido cobrado solo toca esa línea; devolución pendiente hasta confirmarla', async () => {
  const order = await openOrder([[P.serrano, 3], [P.payoyo, 2]]);
  await pay(order.id, 'cash', app.tokens.owner);
  let units = await unitsOf(order.id);
  // Serrano 1 terminado, serrano 2 en curso, serrano 3 pendiente; payoyos pendientes.
  const [s1, s2] = units;
  await ok([call(PROCEDURES.unitStep, { unit_id: s1.id, from: 'pending' })]);
  await ok([call(PROCEDURES.unitStep, { unit_id: s1.id, from: 'in_progress' })]);
  await ok([call(PROCEDURES.unitStep, { unit_id: s2.id, from: 'pending' })]);
  let o = await row(TABLES.orders, order.id);
  // Subir o añadir tras cobrar va en una ampliación.
  assert.equal(code(await commit([call(PROCEDURES.adjustPaidOrder, { order_id: order.id, method: 'cash', expected_revision: o.revision, lines: [{ line_id: order.lines[0], quantity: 4 }] })], app.tokens.owner)), 'USE_EXTENSION');
  // P-2: devolver dinero, solo el owner o quien cobró (aquí cobró el owner).
  const oneLess = { order_id: order.id, method: 'cash', expected_revision: o.revision, lines: [{ line_id: order.lines[1], quantity: 1 }] };
  assert.equal(code(await commit([call(PROCEDURES.adjustPaidOrder, oneLess)])), 'MONEY_BACK_FORBIDDEN');
  const adjusted = await ok([call(PROCEDURES.adjustPaidOrder, oneLess)], app.tokens.owner);
  assert.equal(adjusted.results[0].result.diff_cents, -300);
  units = await unitsOf(order.id);
  assert.equal(units.find((u) => u.id === s1.id).status, 'done');
  assert.equal(units.find((u) => u.id === s2.id).status, 'in_progress');
  assert.equal(units.filter((u) => u.status === 'cancelled').length, 1);
  assert.equal(units.find((u) => u.status === 'cancelled').line_id, order.lines[1]);
  assert.equal((await row(TABLES.orders, order.id)).total_cents, 3 * 250 + 300);
  const refunds = await rows(TABLES.payments, (p) => p.order_id === order.id && p.kind === 'refund');
  assert.equal(refunds.length, 1); assert.equal(refunds[0].amount_cents, -300); assert.equal(refunds[0].settled_at, null);
  // Quitar dos serranos: solo queda uno pendiente → pide confirmación y dice qué trabajo toca.
  o = await row(TABLES.orders, order.id);
  const twoLess = { order_id: order.id, method: 'cash', expected_revision: o.revision, lines: [{ line_id: order.lines[0], quantity: 1 }] };
  const needs = await commit([call(PROCEDURES.adjustPaidOrder, twoLess)], app.tokens.owner);
  assert.equal(code(needs), 'REDUCTION_NEEDS_CONFIRMATION');
  assert.ok(needs.data.error.details.affected[0].units.length >= 1);
  await ok([call(PROCEDURES.adjustPaidOrder, { ...twoLess, confirm_started: true })], app.tokens.owner);
  units = await unitsOf(order.id);
  // Primero la pendiente, luego la que estaba en curso; la terminada se conserva.
  assert.equal(units.find((u) => u.id === s1.id).status, 'done');
  assert.equal(units.find((u) => u.id === s2.id).status, 'cancelled');
  const ev = await rows(TABLES.events, (e) => e.order_id === order.id && e.kind === 'units_cancelled');
  assert.ok(ev.some((e) => e.data.units.some((x: any) => x.status === 'in_progress' && x.assignedTo === app.users.editor)));
  // La devolución se confirma cuando se hace de verdad.
  const pending = await rows(TABLES.payments, (p) => p.order_id === order.id && p.kind === 'refund' && !p.settled_at);
  assert.equal(pending.length, 2);
  assert.equal(code(await commit([call(PROCEDURES.confirmRefund, { payment_id: pending[0].id })])), 'MONEY_BACK_FORBIDDEN');
  await ok([call(PROCEDURES.confirmRefund, { payment_id: pending[0].id })], app.tokens.owner);
  assert.ok((await row(TABLES.payments, pending[0].id)).settled_at);
  assert.equal(code(await commit([call(PROCEDURES.confirmRefund, { payment_id: pending[0].id })], app.tokens.owner)), 'REFUND_NOT_PENDING');
});

test('flow · FLOW-DIR-001 §3: una ampliación se cobra aparte, con número propio al final de la cola; la original no cambia', async () => {
  const parent = await openOrder([[P.serrano, 1]]);
  const first = await pay(parent.id);
  const other = await openOrder([[P.payoyo, 1]]);
  const second = await pay(other.id);
  const extId = uuid();
  await ok([call(PROCEDURES.createExtension, { parent_order_id: parent.id, order_id: extId, lines: [{ product_id: P.serrano, quantity: 2 }, { product_id: P.agua, quantity: 1 }] })]);
  const ext = await row(TABLES.orders, extId);
  assert.equal(ext.status, 'open'); assert.equal(ext.parent_id, parent.id);
  assert.equal((await unitsOf(extId)).length, 0); // sin unidades hasta cobrarla
  const paidExt = await pay(extId);
  assert.ok(paidExt.pay_seq > second.pay_seq);
  assert.equal(paidExt.units, 2);
  assert.equal((await row(TABLES.orders, parent.id)).pay_seq, first.pay_seq);
  assert.ok((await unitsOf(extId)).every((u) => u.pay_seq === paidExt.pay_seq));
  // Sobre un pedido sin cobrar no hay ampliación: se edita directamente.
  const open = await openOrder([[P.agua, 1]]);
  assert.equal(code(await commit([call(PROCEDURES.createExtension, { parent_order_id: open.id, order_id: uuid(), lines: [{ product_id: P.agua, quantity: 1 }] })])), 'ORDER_NOT_PAID');
});

test('flow · §15.20 y P-2: anular cobro (owner o quien cobró) conserva el cargo; el recobro va al final con número nuevo', async () => {
  const order = await openOrder([[P.serrano, 2]]);
  const first = await pay(order.id, 'cash', app.tokens.owner);
  const [u1] = await unitsOf(order.id);
  await ok([call(PROCEDURES.unitStep, { unit_id: u1.id, from: 'pending' })]);
  await ok([call(PROCEDURES.unitStep, { unit_id: u1.id, from: 'in_progress' })]);
  const o = await row(TABLES.orders, order.id);
  const denied = await commit([call(PROCEDURES.reversePayment, { order_id: order.id, reason: 'error de caja', expected_revision: o.revision })]);
  assert.equal(denied.status, 403); assert.equal(code(denied), 'MONEY_BACK_FORBIDDEN');
  await ok([call(PROCEDURES.reversePayment, { order_id: order.id, reason: 'error de caja', expected_revision: o.revision })], app.tokens.owner);
  const reopened = await row(TABLES.orders, order.id);
  assert.equal(reopened.status, 'open'); assert.equal(reopened.pay_seq, null);
  const payments = await rows(TABLES.payments, (p) => p.order_id === order.id);
  assert.deepEqual(payments.map((p) => [p.kind, p.amount_cents]).sort(), [['charge', 500], ['reversal', -500]]);
  const units = await unitsOf(order.id);
  assert.equal(units.find((u) => u.id === u1.id).status, 'done');
  assert.ok(units.filter((u) => u.id !== u1.id).every((u) => u.status === 'cancelled'));
  const ev = await rows(TABLES.events, (e) => e.order_id === order.id && e.kind === 'payment_reversed');
  assert.equal(ev[0].data.paySeq, first.pay_seq);
  // Quien cobró (un editor) puede anular su propio cobro.
  const again = await pay(order.id);
  assert.ok(again.pay_seq > first.pay_seq);
  const o2 = await row(TABLES.orders, order.id);
  await ok([call(PROCEDURES.reversePayment, { order_id: order.id, reason: 'otra vez', expected_revision: o2.revision })]);
  assert.equal((await rows(TABLES.payments, (p) => p.order_id === order.id)).length, 4);
});

test('flow · §15.18–20: entrega parcial y con excepción confirmada; omitir identificación queda registrado; reabrir no toca el dinero', async () => {
  const order = await openOrder([[P.serrano, 1], [P.agua, 1]]);
  await pay(order.id);
  let o = await row(TABLES.orders, order.id);
  const needs = await commit([call(PROCEDURES.deliverOrder, { order_id: order.id, ident: 'skipped', expected_revision: o.revision })]);
  assert.equal(code(needs), 'DELIVERY_NEEDS_CONFIRMATION');
  assert.equal(needs.data.error.details.pendingUnits, 1); assert.equal(needs.data.error.details.undeliveredItems, 2);
  await ok([call(PROCEDURES.deliverOrder, { order_id: order.id, ident: 'skipped', confirm_exception: true, expected_revision: o.revision })]);
  o = await row(TABLES.orders, order.id);
  assert.equal(o.status, 'delivered'); assert.equal(o.delivery_exception, true); assert.equal(o.delivery_ident, 'skipped');
  const delivered = await rows(TABLES.events, (e) => e.order_id === order.id && e.kind === 'delivered');
  assert.equal(delivered[0].data.ident, 'skipped'); assert.equal(delivered[0].data.exception, true); assert.equal(delivered[0].actor, app.users.editor);
  await ok([call(PROCEDURES.reopenOrder, { order_id: order.id, reason: 'faltaba el agua', expected_revision: o.revision })]);
  o = await row(TABLES.orders, order.id);
  assert.equal(o.status, 'paid'); assert.equal(o.delivered_at, null);
  assert.equal((await rows(TABLES.payments, (p) => p.order_id === order.id)).length, 1);
  assert.equal((await rows(TABLES.events, (e) => e.order_id === order.id && e.kind === 'order_reopened')).length, 1);
  // Todo listo y revisado: se entrega sin confirmar excepción.
  const [u] = await unitsOf(order.id);
  await ok([call(PROCEDURES.unitStep, { unit_id: u.id, from: 'pending' })]);
  await ok([call(PROCEDURES.unitStep, { unit_id: u.id, from: 'in_progress' })]);
  for (const id of order.lines) { const l = await row(TABLES.orderLines, id); await ok([{ op: 'update', table: TABLES.orderLines, id, expectedRevision: l.revision, fields: { delivered_qty: l.quantity } }]); }
  o = await row(TABLES.orders, order.id);
  const clean = await ok([call(PROCEDURES.deliverOrder, { order_id: order.id, ident: 'number', expected_revision: o.revision })]);
  assert.equal(clean.results[0].result.exception, false);
});

test('flow · §15.21: tareas de Logística se crean, se asignan, se terminan y se reabren', async () => {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.units, id, fields: { project_id: PROJECT, column_key: 'logistics', kind: 'task', label: 'Reponer tomate fresco', priority: true } }]);
  for (const from of ['pending', 'in_progress', 'done']) await ok([call(PROCEDURES.unitStep, { unit_id: id, from })]);
  const task = await row(TABLES.units, id);
  assert.equal(task.status, 'pending'); assert.equal(task.label, 'Reponer tomate fresco');
  // Texto y prioridad, sí; el estado, no.
  await ok([{ op: 'update', table: TABLES.units, id, expectedRevision: task.revision, fields: { label: 'Reponer tomate', priority: false } }]);
  const t2 = await row(TABLES.units, id);
  assert.equal(code(await commit([{ op: 'update', table: TABLES.units, id, expectedRevision: t2.revision, fields: { status: 'done' } }])), 'PROCEDURE_ONLY');
});

test('flow · FLOW-DIR-001 §1: el público pide número, envía su pedido y solo ve lo suyo; caja lo encuentra y lo cobra', async () => {
  const pub = (path: string, init: { body?: unknown; token?: string; method?: string } = {}) =>
    app.call(`/api/v1/public/${path}`, { token: null, body: init.body, method: init.method, headers: init.token ? { 'X-Flow-Customer': init.token } : {} });
  const a = await pub('customer', { body: {} });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.match(a.data.token, /^[0-9a-f]{64}$/); assert.ok(a.data.number >= 100);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  const b = await pub('customer', { body: {} });
  assert.equal(b.data.number, a.data.number + 1);
  // El token nunca se guarda: solo su resumen.
  const stored = await app.t.db.query<{ token_hash: string }>(`select token_hash from flow.customers where number = $1`, [a.data.number]);
  assert.notEqual(stored.rows[0]!.token_hash, a.data.token);
  // Sin cabecera o con un token desconocido, nada.
  assert.equal((await pub('mine')).status, 401);
  assert.equal((await pub('orders', { body: { lines: [{ productId: P.serrano, quantity: 1 }] } })).status, 401);
  assert.equal((await pub('mine', { token: 'f'.repeat(64) })).data.error.code, 'CUSTOMER_UNKNOWN');
  const sent = await pub('orders', { token: a.data.token, body: { lines: [{ productId: P.serrano, quantity: 2 }, { productId: P.agua, quantity: 1 }] } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.number, a.data.number);
  assert.equal((await pub('orders', { token: a.data.token, body: { lines: [{ productId: P.serrano, quantity: 0 }] } })).status, 422);
  const mineA = await pub('mine', { token: a.data.token });
  assert.equal(mineA.data.number, a.data.number);
  assert.equal(mineA.data.orders.length, 1); assert.equal(mineA.data.orders[0].status, 'open');
  assert.equal(mineA.data.customerId, undefined); assert.equal(mineA.data.projectId, undefined);
  assert.equal((await pub('mine', { token: b.data.token })).data.orders.length, 0);
  // Caja: el pedido está abierto, con su cliente; se cobra como cualquier otro y el cliente lo ve preparando.
  const order = await row(TABLES.orders, sent.data.orderId);
  assert.equal(order.origin, 'public'); assert.equal(order.status, 'open');
  const customer = (await rows(TABLES.customers, (c) => c.id === order.customer_id))[0];
  assert.equal(customer.number, a.data.number);
  await pay(order.id);
  const after = await pub('mine', { token: a.data.token });
  assert.equal(after.data.orders[0].status, 'paid'); assert.equal(after.data.orders[0].preparing, true);
  const serrano = after.data.orders[0].lines.find((l: any) => l.code === 'A' && l.prepared);
  assert.equal(serrano.preparedQty, 0); assert.equal(serrano.quantity, 2);
});

test('flow · lote público: solo crea su cliente, su pedido abierto y sus líneas; nada de cobros ni de tocar lo cobrado', async () => {
  const supabase = createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
  const tryPublic = async (operations: any[]) => { try { await applyPublicOperations(supabase, 'flow', operations); return 'ok'; } catch (e: any) { return e.code ?? String(e); } };
  const cust = await app.call('/api/v1/public/customer', { token: null, body: {} });
  const customerId = (await rows(TABLES.customers, (c) => c.number === cust.data.number))[0].id;
  assert.equal(await tryPublic([{ op: 'insert', table: TABLES.orders, id: uuid(), fields: { project_id: PROJECT, origin: 'public', customer_id: customerId, status: 'paid' } }]), 'FORBIDDEN');
  assert.equal(await tryPublic([{ op: 'insert', table: TABLES.payments, id: uuid(), fields: { order_id: uuid(), kind: 'charge', amount_cents: 1 } }]), 'FORBIDDEN');
  const paid = await openOrder([[P.agua, 1]]);
  await pay(paid.id);
  assert.equal(await tryPublic([{ op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: paid.id, product_id: P.agua, quantity: 5 } }]), 'FORBIDDEN');
  // Solo productos activos de la carta.
  const own = uuid();
  assert.equal(await tryPublic([{ op: 'insert', table: TABLES.orders, id: own, fields: { project_id: PROJECT, origin: 'public', customer_id: customerId } }]), 'ok');
  const agua = await row(TABLES.products, P.agua);
  await ok([{ op: 'update', table: TABLES.products, id: P.agua, expectedRevision: agua.revision, fields: { active: false } }], app.tokens.owner);
  assert.equal(await tryPublic([{ op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: own, product_id: P.agua, quantity: 1 } }]), 'FORBIDDEN');
  const off = await row(TABLES.products, P.agua);
  await ok([{ op: 'update', table: TABLES.products, id: P.agua, expectedRevision: off.revision, fields: { active: true } }], app.tokens.owner);
  assert.equal(await tryPublic([{ op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: own, product_id: P.agua, quantity: 1 } }]), 'ok');
  // El número lo pone el servidor aunque el lote mande otro.
  assert.equal(await tryPublic([{ op: 'insert', table: TABLES.customers, id: uuid(), fields: { project_id: PROJECT, token_hash: 'a'.repeat(64), number: 5 } }]), 'ok');
  assert.ok((await rows(TABLES.customers, (c) => c.number === 5)).length === 0);
});

test('flow · acceso por proyecto (0902): fuera de sus ámbitos, ni se ve ni se toca; el owner lo ve todo', async () => {
  const other = uuid();
  await ok([{ op: 'insert', table: TABLES.projects, id: other, fields: { name: 'Otro evento', starts_on: '2026-12-01', ends_on: '2026-12-02' } }], app.tokens.owner);
  const orderId = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id: orderId, fields: { project_id: other, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: orderId, product_id: P.agua, quantity: 1 } }], app.tokens.owner);
  // Lo ve el owner; el editor no ve ni el proyecto ni sus filas.
  assert.ok((await rows(TABLES.projects)).some((p) => p.id === other));
  const snap = await app.call(`/api/v1/snapshot?tables=${TABLES.projects},${TABLES.orders},${TABLES.orderLines}`, { token: app.tokens.editor });
  const all = snap.data.tables.flatMap((t: any) => t.rows);
  assert.equal(all.some((r: any) => r.id === other || r.project_id === other), false);
  assert.ok(all.some((r: any) => r.id === PROJECT));
  // Ni escribir filas ni llamar a procedimientos sobre él.
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.orders, id: uuid(), fields: { project_id: other, origin: 'counter' } }])), 'PROJECT_OUT_OF_SCOPE');
  assert.equal(code(await commit([call(PROCEDURES.confirmPayment, { order_id: orderId, method: 'cash', expected_revision: 1 })])), 'PROJECT_OUT_OF_SCOPE');
  // Las líneas heredan el proyecto de su pedido, aunque el cliente no lo mande.
  const line = (await rows(TABLES.orderLines, (l) => l.order_id === orderId))[0];
  assert.equal(line.project_id, other);
});
