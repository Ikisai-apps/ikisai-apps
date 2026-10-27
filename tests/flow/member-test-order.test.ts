/**
 * Flow · pedido de un miembro (migración 0952, vg-48, con el núcleo 0115), sobre PGlite: el pedido de un cliente cuyo
 * visitante está atado a una persona del equipo nace marcado (`test_by`, `test_name`) y no se puede desmarcar. Fuera del
 * horario del evento es de prueba (`test_excluded`) y no cuenta en el resumen del día (cierre, Food y Finance); durante el
 * evento cuenta y sale en `member_orders` para el ajuste de Finance. «Mis pedidos» lo dice. Datos sintéticos.
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
  await app.t.db.query(`update core.memberships set scopes = $1::jsonb where app = 'flow' and role in ('editor','reader')`, [JSON.stringify({ projects: [PROJECT] })]);
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

test('pedido de un miembro · fuera del horario es de prueba y no cuenta; durante el evento cuenta y sale para el ajuste de Finance', async () => {
  const db = app.t.db;
  const member = await app.t.createUser();
  await db.query(`insert into core.memberships (app, user_id, role) values ('flow', $1, 'editor') on conflict do nothing`, [member]);
  await db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Marga') on conflict (user_id) do update set display_name = 'Marga'`, [member]);
  const guest = await customerWith(null);
  const staff = await customerWith(member);
  const summary = async () => (await ok([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })])).data;
  const units = (d: any) => (d.units_by_product as any[]).reduce((n, u) => n + u.units, 0);
  const window = (on: boolean) => db.query(`update flow.projects set booking_event_id = null, starts_on = $2::date, ends_on = $2::date where id = $1`,
    [PROJECT, on ? today() : '2020-01-01']);

  // Fuera del horario del evento: de prueba.
  await window(false);
  const before = await summary();
  const real = await paidOrder(guest.id);
  const fake = await paidOrder(staff.id);
  assert.equal((await order(real)).test_by, null);
  const f = await order(fake);
  assert.deepEqual([f.test_by, f.test_name, f.test_excluded], [member, 'Marga', true]);
  // El servidor la pone y nadie la cambia: no es columna escribible.
  assert.notEqual((await commit([{ op: 'update', table: TABLES.orders, id: fake, expectedRevision: f.revision, fields: { test_excluded: false } }])).status, 200);
  assert.equal((await order(fake)).test_excluded, true);
  // Solo cuenta el de verdad: un pedido más y su importe; el de prueba, ni dinero ni unidades.
  const after = await summary();
  assert.equal(after.orders - before.orders, 1);
  assert.equal(after.sales_cents - before.sales_cents, (await order(real)).total_cents);
  assert.equal(units(after) - units(before), 2);
  assert.deepEqual(after.member_orders, before.member_orders);

  // Durante el evento: cuenta como cualquiera y sale en la lista para que Finance reste su pago.
  await window(true);
  const during = await paidOrder(staff.id);
  const d = await order(during);
  assert.deepEqual([d.test_by, d.test_excluded], [member, false]);
  const last = await summary();
  assert.equal(last.orders - after.orders, 1);
  assert.equal(last.sales_cents - after.sales_cents, d.total_cents);
  assert.deepEqual(last.member_orders.find((m: any) => m.order_id === during), { order_id: during, name: 'Marga', amount_cents: d.total_cents });
  assert.equal(last.member_cents - (after.member_cents ?? 0), d.total_cents);

  // «Mis pedidos» de la carta lo dice.
  const mine = await app.call('/api/v1/public/mine', { token: null, headers: { 'X-Flow-Customer': staff.token } });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  const byId = (id: string) => mine.data.orders.find((o: any) => o.id === id);
  assert.deepEqual([byId(fake).testName, byId(fake).testExcluded, byId(during).testExcluded], ['Marga', true, false]);
});
