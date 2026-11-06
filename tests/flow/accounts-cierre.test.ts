/**
 * Flow · cuentas abiertas al cerrar el día (migración 0965, fl-27), sobre PGlite: el cierre no va a Finance con cuentas sin
 * decidir; pasar a Finance (pendiente de cobro con nombre) y reenviar al liquidar con el medio real; anular (solo el owner)
 * deja fuera sus pedidos. Finance se simula con `appsFetch`. Datos sintéticos.
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
const sent: any[] = [];

test.before(async () => {
  const appsFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    return Response.json({ results: [{ result: { status: 'created' } }] });
  }) as typeof fetch;
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }, { appsFetch }) });
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `ac-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
const code = async (operations: unknown[], token = app.tokens.owner) => (await commit(operations, token)).data.error?.code;
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const q = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;
const madrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

/** Una cuenta con un pedido cargado de `n` unidades del primer producto preparado. */
async function accountWithOrder(holder: string, n: number): Promise<{ account: string; order: string }> {
  const account = (await ok([call(PROCEDURES.openAccount, { project_id: v2, holder })])).account_id;
  const product = (await q(`select id from flow.products where project_id = $1 and prepared and active and deleted_at is null order by position limit 1`, [v2]))[0];
  const order = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id: order, fields: { project_id: v2, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: order, product_id: product.id, quantity: n, position: 1 } }]);
  const rev = (await q(`select revision from flow.orders where id = $1`, [order]))[0].revision;
  await ok([call(PROCEDURES.chargeToAccount, { order_id: order, account_id: account, expected_revision: rev })]);
  return { account, order };
}
const acc = async (id: string) => (await q(`select * from flow.accounts where id = $1`, [id]))[0];

test('cierre · con cuentas abiertas no va a Finance; pasar a Finance la deja pendiente con su nombre y, al liquidarla, el mismo apunte con el medio real', async () => {
  const { account } = await accountWithOrder('Mesa 7', 2);
  const closure = (await ok([call(PROCEDURES.closeDay, { project_id: v2, day: madrid() })])).closure_id;
  let r = await app.call(`/api/v1/closures/${closure}/send/finance`, { body: {} });
  assert.equal(r.status, 409, JSON.stringify(r.data)); assert.equal(r.data.error.code, 'ACCOUNTS_UNDECIDED');
  assert.equal(r.data.error.details.accounts[0].holder, 'Mesa 7');

  await ok([call(PROCEDURES.deferAccount, { account_id: account, expected_revision: (await acc(account)).revision })]);
  r = await app.call(`/api/v1/accounts/${account}/send/finance`, { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let args = sent.at(-1).operations[0].args;
  const total = (await q(`select sum(total_cents)::int t from flow.orders where account_id = $1 and deleted_at is null`, [account]))[0].t;
  assert.equal(args.source_ref, `flow:account:${account}`); assert.equal(args.nature, 'fiscal');
  assert.deepEqual(args.methods, { a_cobrar: total }); assert.equal(args.description, 'Cuenta de Mesa 7 · pendiente de cobro');
  assert.equal(args.detail.length, 1); assert.match(args.detail[0].order_code, /^P \d+$/);
  assert.equal((await acc(account)).finance_status, 'sent');
  // Ya decidida: el cierre puede ir a Finance.
  r = await app.call(`/api/v1/closures/${closure}/send/finance`, { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Pasada a Finance no se vuelve a pasar; sí se liquida después, y el apunte se reenvía con el medio real.
  assert.equal(await code([call(PROCEDURES.deferAccount, { account_id: account })]), 'ACCOUNT_NOT_OPEN');
  await ok([call(PROCEDURES.settleAccount, { account_id: account, method: 'bizum', expected_revision: (await acc(account)).revision })]);
  r = await app.call(`/api/v1/accounts/${account}/send/finance`, { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  args = sent.at(-1).operations[0].args;
  assert.equal(args.source_ref, `flow:account:${account}`); assert.deepEqual(args.methods, { bizum: total }); assert.equal(args.description, 'Cuenta de Mesa 7');
  // El estado de envío solo lo anota el servidor.
  assert.equal(await code([{ op: 'update', table: TABLES.accounts, id: account, expectedRevision: (await acc(account)).revision, fields: { finance_status: 'error' } }]), 'PROCEDURE_ONLY');
});

test('cierre · anular una cuenta (solo el owner, con motivo) deja fuera sus pedidos y su cuenta', async () => {
  const { account, order } = await accountWithOrder('Mesa 9', 1);
  assert.equal(await code([call(PROCEDURES.voidAccount, { account_id: account, reason: 'no fue real' })], app.tokens.editor), 'FORBIDDEN');
  assert.equal(await code([call(PROCEDURES.voidAccount, { account_id: account, reason: ' ' })]), 'INVALID_OPERATION');
  const out = await ok([call(PROCEDURES.voidAccount, { account_id: account, reason: 'no fue real' })]);
  assert.equal(out.orders, 1);
  assert.ok((await acc(account)).deleted_at);
  assert.ok((await q(`select deleted_at from flow.orders where id = $1`, [order]))[0].deleted_at);
  assert.equal((await q(`select count(*)::int n from flow.order_lines where order_id = $1 and deleted_at is null`, [order]))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from flow.units where order_id = $1 and deleted_at is null`, [order]))[0].n, 0);
  assert.equal(await code([call(PROCEDURES.voidAccount, { account_id: account, reason: 'otra vez' })]), 'NOT_FOUND');
});

test('cierre · una cuenta de otro flujo no se manda a Finance aunque se sepa su id (0967)', async () => {
  const { account } = await accountWithOrder('Mesa 11', 1);
  await ok([call(PROCEDURES.deferAccount, { account_id: account, expected_revision: (await acc(account)).revision })]);
  // El editor solo ve la v1: la cuenta (de la v2) no existe para él.
  await app.t.db.query("update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($1::text)) where app = 'flow' and user_id = $2", [V1, app.users.editor]);
  const before = sent.length;
  const r = await app.call(`/api/v1/accounts/${account}/send/finance`, { token: app.tokens.editor, body: {} });
  assert.equal(r.status, 404, JSON.stringify(r.data));
  assert.equal(sent.length, before);
  assert.equal((await acc(account)).finance_status, null);
});
