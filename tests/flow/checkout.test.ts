/**
 * Flow · caja profunda (migración 0917, «C»), sobre PGlite: pay_orders con un solo justificante o uno por pedido, métodos
 * nuevos (Bitcoin), «Enviar a Finance» como apunte fiscal y el cierre (proceso) sin lo ya enviado; ajustes del proyecto.
 * Finance se simula con `appsFetch`. Datos sintéticos.
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
let customer = '';
const sent: any[] = [];
const sentHeaders: Headers[] = [];

test.before(async () => {
  const appsFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}'))); sentHeaders.push(new Headers(init?.headers));
    return Response.json({ results: [{ result: { status: 'created' } }] });
  }) as typeof fetch;
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN], workerKey: 'clave-worker-de-prueba' }, { appsFetch }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `c-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const code = async (operations: unknown[], token = app.tokens.owner) => (await commit(operations, token)).data.error?.code;
const madrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

async function openOrder(project: string, n: number, customerId: string | null = null): Promise<string> {
  const product = (await rows(TABLES.products)).find((p) => p.project_id === project && p.prepared && p.active);
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: project, origin: 'counter', customer_id: customerId } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: product.id, quantity: n } }]);
  return id;
}

test('caja · la v2 nace con deep_checkout; la v1 no puede usar pay_orders', async () => {
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
  const cols = await rows(TABLES.columns);
  assert.equal(cols.find((c) => c.project_id === v2 && c.key === 'order').config.deep_checkout, true);
  const o = await openOrder(V1, 1);
  assert.equal(await code([call(PROCEDURES.payOrders, { order_ids: [o], method: 'cash' })]), 'INVALID_OPERATION');
});

test('caja · un solo justificante para varios pedidos: cada uno con su número de cobro y sus unidades', async () => {
  customer = (await ok([call(PROCEDURES.assignGuestNumbers, { project_id: v2, guests: [{ guest_id: uuid(), display_name: 'Ana P.' }] })])).customers[0].guest_id;
  const c = (await rows(TABLES.customers)).find((x) => x.guest_id === customer);
  const a = await openOrder(v2, 2, c.id); const b = await openOrder(v2, 1, c.id);
  assert.equal(await code([call(PROCEDURES.payOrders, { order_ids: [a, b], method: 'cheque' })]), 'INVALID_OPERATION');
  const out = await ok([call(PROCEDURES.payOrders, { order_ids: [a, b], method: 'btc_ln', unify: true })]);
  assert.equal(out.receipts.length, 1); assert.equal(out.orders.length, 2);
  assert.notEqual(out.orders[0].pay_seq, out.orders[1].pay_seq);
  const receipt = (await rows(TABLES.receipts)).find((r) => r.id === out.receipts[0].receipt_id);
  assert.equal(receipt.method, 'btc_ln'); assert.equal(receipt.customer_id, c.id);
  assert.equal(receipt.total_cents, out.orders[0].total_cents + out.orders[1].total_cents);
  const pays = (await rows(TABLES.payments)).filter((p) => p.receipt_id === receipt.id);
  assert.equal(pays.length, 2); assert.ok(pays.every((p) => p.method === 'btc_ln' && p.kind === 'charge'));
  assert.equal((await rows(TABLES.units)).filter((u) => u.order_id === a || u.order_id === b).length, 3);
  assert.equal(await code([call(PROCEDURES.payOrders, { order_ids: [a], method: 'cash' })]), 'ORDER_NOT_OPEN');
});

test('caja · pedidos independientes: un justificante por pedido; los justificantes solo por procedimiento', async () => {
  const a = await openOrder(v2, 1); const b = await openOrder(v2, 1);
  const out = await ok([call(PROCEDURES.payOrders, { order_ids: [a, b], method: 'cash', unify: false })]);
  assert.equal(out.receipts.length, 2);
  assert.equal(await code([{ op: 'insert', table: TABLES.receipts, id: uuid(), fields: { project_id: v2, method: 'cash', order_ids: [a] } }]), 'PROCEDURE_ONLY');
});

test('caja · «Enviar a Finance» manda ese cobro como fiscal; el cierre (proceso) ya no lo incluye', async () => {
  const receipt = (await rows(TABLES.receipts)).find((r) => r.method === 'btc_ln');
  const res = await app.call(`/api/v1/receipts/${receipt.id}/send/finance`, { body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const args = sent.at(-1).operations[0].args;
  assert.equal(args.nature, 'fiscal'); assert.equal(args.source_ref, `flow:receipt:${receipt.id}`);
  // FL1: identidad de servicio de Flow ante Finance, además del token de la persona.
  assert.equal(sentHeaders.at(-1)!.get('x-ikisai-worker-key'), 'clave-worker-de-prueba'); assert.equal(sentHeaders.at(-1)!.get('x-ikisai-caller'), 'flow');
  assert.equal(sentHeaders.at(-1)!.get('authorization'), 'Bearer ' + app.tokens.owner);
  assert.equal(args.amount_cents, receipt.total_cents); assert.deepEqual(args.methods, { bitcoin: receipt.total_cents });
  const seqs = (await rows(TABLES.orders)).filter((o) => receipt.order_ids.includes(o.id)).map((o) => o.pay_seq).sort((x: number, y: number) => x - y);
  assert.equal(args.receipt_kind, 'ticket'); assert.equal(args.receipt_number, seqs.join('+')); assert.equal(seqs.length, 2);
  assert.equal(args.detail.reduce((s: number, d: any) => s + d.amount_cents, 0), receipt.total_cents);
  // El estado lo anotó flow-api (servidor); el cliente no puede tocarlo.
  const marked = (await rows(TABLES.receipts)).find((r) => r.id === receipt.id);
  assert.equal(marked.finance_status, 'sent');
  const other = (await rows(TABLES.receipts)).find((r) => r.id !== receipt.id);
  assert.equal(await code([{ op: 'update', table: TABLES.receipts, id: other.id, expectedRevision: other.revision, fields: { finance_status: 'sent' } }]), 'PROCEDURE_ONLY');
  // Cierre del día: el resumen va como proceso, sin el justificante fiscal.
  const closed = await ok([call(PROCEDURES.closeDay, { project_id: v2, day: madrid() })]);
  const fin = await app.call(`/api/v1/closures/${closed.closure_id}/send/finance`, { body: {} });
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  const pargs = sent.at(-1).operations[0].args;
  assert.equal(pargs.nature, 'process');
  assert.equal(pargs.amount_cents, closed.data.sales_cents - receipt.total_cents);
  assert.equal(pargs.methods.bitcoin ?? 0, 0);
  assert.equal(pargs.detail.reduce((s: number, d: any) => s + d.amount_cents, 0) + pargs.pending_refunds_cents, pargs.amount_cents);
});

test('caja · ajustes del proyecto: solo el owner pone las direcciones; formatos válidos', async () => {
  assert.notEqual((await commit([{ op: 'insert', table: TABLES.projectSettings, id: uuid(), fields: { project_id: v2, lightning_address: 'barra@walletofsatoshi.com' } }], app.tokens.editor)).status, 200);
  const bad = await commit([{ op: 'insert', table: TABLES.projectSettings, id: uuid(), fields: { project_id: v2, bitcoin_address: 'no-es-una-direccion' } }]);
  assert.notEqual(bad.status, 200);
  await ok([{ op: 'insert', table: TABLES.projectSettings, id: uuid(), fields: { project_id: v2, lightning_address: 'barra@walletofsatoshi.com',
    bitcoin_address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' } }]);
  assert.equal((await rows(TABLES.projectSettings)).filter((s) => s.project_id === v2).length, 1);
});
