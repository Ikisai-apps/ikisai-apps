/**
 * Flow · pedido de prueba de un miembro (migración 0952, con el núcleo 0115), sobre PGlite: el pedido de un cliente cuyo
 * visitante está atado a una persona del equipo nace marcado (`test_by`, `test_name`), no se puede desmarcar, sale en «Mis
 * pedidos» y no cuenta en el resumen del día (cierre, Food y Finance). Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const PROJECT = '0f10a000-0000-4000-8000-000000000001';
const SERRANO = '0f10a000-0000-4000-8000-000000000101';
const uuid = () => crypto.randomUUID();
const hex = () => randomBytes(32).toString('hex');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `m-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0]?.result; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const order = async (id: string) => (await app.t.db.query<any>(`select * from flow.orders where id = $1`, [id])).rows[0];

/** Un cliente de la carta con su visitante; `member`: el visitante está atado a una persona del equipo. */
async function customerWith(member: string | null): Promise<{ id: string; token: string }> {
  const db = app.t.db;
  const visitor = uuid();
  await db.query(`insert into core.visitors (id, token_hash, auth_user_id) values ($1, $2, $3)`, [visitor, sha(hex()), member]);
  const id = uuid(); const token = hex();
  await db.query(`set session_replication_role = replica`);
  try {
    await db.query(`insert into flow.customers (id, project_id, number, token_hash, origin, visitor_id) values ($1, $2, $3, $4, 'visitor', $5)`,
      [id, PROJECT, 900 + ++seq, sha(token), visitor]);
  } finally { await db.query(`set session_replication_role = origin`); }
  return { id, token };
}

async function paidOrder(customer: string): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: PROJECT, origin: 'counter', customer_id: customer } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: SERRANO, quantity: 2, position: 1 } }], app.tokens.editor);
  await ok([call(PROCEDURES.confirmPayment, { order_id: id, method: 'cash', expected_revision: (await order(id)).revision })], app.tokens.editor);
  return id;
}

test('pedido de prueba · el de un miembro nace marcado, no se desmarca, sale en «Mis pedidos» y no cuenta en el día', async () => {
  const member = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('flow', $1, 'editor') on conflict do nothing`, [member]);
  await app.t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Marga') on conflict (user_id) do update set display_name = 'Marga'`, [member]);
  const guest = await customerWith(null);
  const staff = await customerWith(member);

  const summary = async () => (await ok([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })])).data;
  const before = await summary();
  const real = await paidOrder(guest.id);
  const fake = await paidOrder(staff.id);
  assert.equal((await order(real)).test_by, null);
  const f = await order(fake);
  assert.equal(f.test_by, member); assert.equal(f.test_name, 'Marga');

  // El servidor la pone y nadie la cambia: no es columna escribible.
  const r = await commit([{ op: 'update', table: TABLES.orders, id: fake, expectedRevision: f.revision, fields: { test_by: null } }]);
  assert.notEqual(r.status, 200);
  assert.equal((await order(fake)).test_by, member);

  // Solo cuenta el de verdad: un pedido más y su importe; el de prueba, ni dinero ni unidades.
  const after = await summary();
  assert.equal(after.orders - before.orders, 1);
  assert.equal(after.sales_cents - before.sales_cents, (await order(real)).total_cents);
  const units = (d: any) => (d.units_by_product as any[]).reduce((n, u) => n + u.units, 0);
  assert.equal(units(after) - units(before), 2);

  // «Mis pedidos» de la carta lo dice.
  const mine = await app.call('/api/v1/public/mine', { token: null, headers: { 'X-Flow-Customer': staff.token } });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.data.orders.find((o: any) => o.id === fake).testName, 'Marga');
});
