/**
 * Flow · cuenta del cliente y huéspedes (migración 0910, paso 4), sobre PGlite. Solo la v2 lleva cuentas (`accounts` en su
 * caja, por plantilla). Datos sintéticos: huéspedes y reservas con uuid al azar, nombres inventados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const KEY = 'clave-de-prueba-solo-para-pglite';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let v2 = '';
let account = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `a-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const code = async (operations: unknown[], token = app.tokens.owner) => (await commit(operations, token)).data.error?.code;
const madrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

/** Un pedido abierto en `project` con `n` del primer producto preparado. */
async function openOrder(project: string, n: number, extra: Record<string, unknown> = {}): Promise<string> {
  const product = (await rows(TABLES.products)).find((p) => p.project_id === project && p.prepared && p.active);
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: project, origin: 'counter', ...extra } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: product.id, quantity: n } }]);
  return id;
}
async function summary(project: string): Promise<any> {
  const out = await ok([call(PROCEDURES.closeDay, { project_id: project, day: madrid() })]);
  return out.data;
}

test('cuentas · la v1 no las lleva; la v2 nace con accounts en su caja', async () => {
  v2 = uuid();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2 })]);
  // El editor trabaja en la v2 (ámbito por proyecto, 0902).
  await app.t.db.query("update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($1::text)) where app = 'flow' and user_id = $2", [v2, app.users.editor]);
  const cols = await rows(TABLES.columns);
  assert.equal(cols.find((c) => c.project_id === v2 && c.key === 'order').config.accounts, true);
  assert.equal(cols.find((c) => c.project_id === V1 && c.key === 'order').config?.accounts, undefined);
  assert.equal(await code([call(PROCEDURES.openAccount, { project_id: V1, holder: 'Mesa 3' })]), 'ACCOUNTS_DISABLED');
});

test('cuentas · abrir, cargar con número de cobro y unidades, sin dinero; ni corregir ni anular mientras está abierta', async () => {
  const before = await summary(v2);
  account = (await ok([call(PROCEDURES.openAccount, { project_id: v2, holder: 'Mesa 3' })], app.tokens.editor)).account_id;
  const order = await openOrder(v2, 3);
  const o = await row(TABLES.orders, order);
  // Cargar a cuenta es por procedimiento; el cliente no pone account_id.
  assert.equal(await code([{ op: 'update', table: TABLES.orders, id: order, expectedRevision: o.revision, fields: { account_id: account } }]), 'PROCEDURE_ONLY');
  const out = await ok([call(PROCEDURES.chargeToAccount, { order_id: order, account_id: account, expected_revision: o.revision })], app.tokens.editor);
  assert.ok(out.pay_seq >= 1); assert.equal(out.units, 3);
  const charged = await row(TABLES.orders, order);
  assert.equal(charged.status, 'paid'); assert.equal(charged.pay_method, 'account'); assert.equal(charged.account_id, account);
  assert.equal((await rows(TABLES.payments)).filter((p) => p.order_id === order).length, 0);
  // Un cobro normal después sigue la misma secuencia.
  const next = await openOrder(v2, 1);
  const paid = await ok([call(PROCEDURES.confirmPayment, { order_id: next, method: 'cash', expected_revision: (await row(TABLES.orders, next)).revision })]);
  assert.equal(paid.pay_seq, out.pay_seq + 1);
  // Mientras está abierta: no cuenta en el día, y no se corrige ni se anula.
  const mid = await summary(v2);
  assert.equal(mid.orders, before.orders + 1);
  assert.equal(await code([call(PROCEDURES.reversePayment, { order_id: order, reason: 'prueba', expected_revision: charged.revision })]), 'ACCOUNT_OPEN');
  const line = (await rows(TABLES.orderLines)).find((l) => l.order_id === order);
  assert.equal(await code([call(PROCEDURES.adjustPaidOrder, { order_id: order, lines: [{ line_id: line.id, quantity: 1 }], method: 'cash', expected_revision: charged.revision })]), 'ACCOUNT_OPEN');
});

test('cuentas · liquida el owner o quien la abrió, con un pago único; cuenta el día en que se liquida', async () => {
  const before = await summary(v2);
  const a = await row(TABLES.accounts, account);
  // El reader no puede; otro editor tampoco (la abrió el editor: aquí la intenta un owner, que sí puede, después).
  assert.equal((await commit([call(PROCEDURES.settleAccount, { account_id: account, method: 'card' })], app.tokens.reader)).status, 403);
  const out = await ok([call(PROCEDURES.settleAccount, { account_id: account, method: 'card', expected_revision: a.revision })], app.tokens.editor);
  const total = (await rows(TABLES.orders)).filter((o) => o.account_id === account).reduce((s, o) => s + o.total_cents, 0);
  assert.equal(out.total_cents, total); assert.equal(out.orders, 1);
  const pay = (await rows(TABLES.payments)).find((p) => p.account_id === account);
  assert.equal(pay.order_id, null); assert.equal(pay.method, 'card'); assert.equal(pay.amount_cents, total); assert.equal(pay.project_id, v2);
  const after = await summary(v2);
  assert.equal(after.orders, before.orders + 1);
  assert.equal(after.sales_cents, before.sales_cents + total);
  assert.equal(after.sales_by_method.card, total);
  assert.equal(await code([call(PROCEDURES.settleAccount, { account_id: account, method: 'cash' })]), 'ACCOUNT_NOT_OPEN');
  // Liquidada: no se anula (su dinero está en el pago de la cuenta).
  const order = (await rows(TABLES.orders)).find((o) => o.account_id === account);
  assert.equal(await code([call(PROCEDURES.reversePayment, { order_id: order.id, reason: 'prueba', expected_revision: order.revision })]), 'ACCOUNT_SETTLED');
});

test('cuentas · solo quien la abrió o el owner la liquida', async () => {
  const id = (await ok([call(PROCEDURES.openAccount, { project_id: v2, holder: 'Grupo B' })])).account_id; // la abre el owner
  assert.equal(await code([call(PROCEDURES.settleAccount, { account_id: id, method: 'cash' })], app.tokens.editor), 'SETTLE_FORBIDDEN');
  await ok([call(PROCEDURES.settleAccount, { account_id: id, method: 'cash' })]);
  assert.equal((await rows(TABLES.payments)).filter((p) => p.account_id === id).length, 0); // vacía: sin pago
});

test('cuentas · el resumen de la v1 no cambia de forma (sin card si no hay tarjeta)', async () => {
  const s = await summary(V1);
  assert.deepEqual(Object.keys(s.sales_by_method).sort(), ['bizum', 'cash']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Huéspedes: número, enlace firmado para Guests y canje en la carta
// ---------------------------------------------------------------------------------------------------------------------
const guest = uuid();
const reservation = uuid();

test('huéspedes · dar número es del owner e idempotente; la cuenta se abre por número', async () => {
  const guests = [{ guest_id: guest, display_name: 'Ana P.' }, { guest_id: uuid(), display_name: 'Luis G.' }];
  assert.equal((await commit([call(PROCEDURES.assignGuestNumbers, { project_id: v2, guests })], app.tokens.editor)).status, 403);
  const first = await ok([call(PROCEDURES.assignGuestNumbers, { project_id: v2, guests })]);
  assert.equal(first.created, 2);
  const again = await ok([call(PROCEDURES.assignGuestNumbers, { project_id: v2, guests: [{ guest_id: guest, display_name: 'Ana P.' }] })]);
  assert.equal(again.created, 0); assert.equal(again.updated, 0);
  const c = (await rows(TABLES.customers)).find((x) => x.guest_id === guest);
  assert.equal(c.origin, 'guest'); assert.equal(c.display_name, 'Ana P.');
  const opened = await ok([call(PROCEDURES.openAccount, { project_id: v2, customer_number: String(c.number) })]);
  assert.equal(opened.holder, 'Ana P.');
  assert.equal(await code([call(PROCEDURES.openAccount, { project_id: v2, customer_number: String(c.number) })]), 'ACCOUNT_ALREADY_OPEN');
});

/** Lectura del portal de huéspedes (la hace Guests con su app; aquí, directo a core.read). */
async function portal(user: string, args: Record<string, unknown>): Promise<any> {
  const r = await app.t.db.query<{ out: any }>(`select core.read('guests', $1, 'flow.portal_customer', $2::jsonb) as out`, [user, JSON.stringify(args)]);
  return r.rows[0]!.out;
}

test('huéspedes · portal_customer: número y cuenta; sin clave no hay enlace; fuera de su reserva, nada', async () => {
  const user = app.users.reader;
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2::jsonb)`,
    [user, JSON.stringify({ grants: [{ reservation_id: reservation, guest_id: guest }] })]);
  const out = await portal(user, { reservation_id: reservation, guest_id: guest });
  assert.ok(out.number >= 100); assert.equal(out.account_open, true); assert.equal(out.carta_url, null);
  await assert.rejects(portal(user, { reservation_id: reservation, guest_id: uuid() }), /FORBIDDEN/);
});

test('huéspedes · con clave y la barra en la carta: enlace HMAC-SHA256 de 10 min; se canjea una vez y rota el token', async () => {
  await app.t.db.exec(`set flow.portal_key = '${KEY}'`);
  // v2 atiende la carta pública (y v1 deja de hacerlo).
  const [p1, p2] = [await row(TABLES.projects, V1), await row(TABLES.projects, v2)];
  await ok([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: p1.revision, fields: { serves_public: false } },
    { op: 'update', table: TABLES.projects, id: v2, expectedRevision: p2.revision, fields: { serves_public: true } }]);
  const out = await portal(app.users.reader, { reservation_id: reservation, guest_id: guest });
  const invitation = new URL(out.carta_url).searchParams.get('invitacion')!;
  // <cliente>.<caducidad>.<revisión>.<firma> desde la 0915 (un solo uso).
  const parts = invitation.split('.');
  const [id, exp] = parts; const sig = parts.at(-1)!;
  assert.equal(sig, createHmac('sha256', KEY).update(parts.slice(0, -1).join('.')).digest('hex'));
  assert.ok(Number(exp) - Date.now() / 1000 > 590 && Number(exp) - Date.now() / 1000 <= 601);

  const pub = (path: string, body: unknown, headers: Record<string, string> = {}) => app.call(`/api/v1/public/${path}`, { token: null, body, headers });
  assert.equal((await pub('invitation', { invitation: [...parts.slice(0, -1), '0'.repeat(64)].join('.') })).status, 404);
  const redeemed = await pub('invitation', { invitation });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
  assert.equal(redeemed.data.number, out.number);
  const mine = await app.call('/api/v1/public/mine', { token: null, headers: { 'X-Flow-Customer': redeemed.data.token } });
  assert.equal(mine.status, 200); assert.equal(mine.data.number, out.number);
  // El mismo enlace no vale dos veces; uno nuevo rota otra vez y el primer navegador deja de valer.
  assert.equal((await pub('invitation', { invitation })).data.error.code, 'INVITATION_USED');
  const fresh = new URL((await portal(app.users.reader, { reservation_id: reservation, guest_id: guest })).carta_url).searchParams.get('invitacion')!;
  const second = await pub('invitation', { invitation: fresh });
  assert.equal(second.status, 200);
  assert.equal((await app.call('/api/v1/public/mine', { token: null, headers: { 'X-Flow-Customer': redeemed.data.token } })).status, 401);
  // Caducado (firma buena, fecha pasada).
  const old = String(Math.floor(Date.now() / 1000) - 5);
  const expired = await pub('invitation', { invitation: `${id}.${old}.1.${createHmac('sha256', KEY).update(`${id}.${old}.1`).digest('hex')}` }); // cuatro partes (FL10)
  assert.equal(expired.status, 410); assert.equal(expired.data.error.code, 'INVITATION_EXPIRED');
});

test('huéspedes · el lote público no crea clientes de huésped ni toca los de la web', async () => {
  const c = (await rows(TABLES.customers)).find((x) => x.guest_id === guest);
  const r = await app.t.db.query<{ out: any }>(`select core.apply_public_operations('flow', $1::jsonb) as out`,
    [JSON.stringify([{ op: 'insert', table: TABLES.customers, id: uuid(), fields: { project_id: v2, token_hash: 'a'.repeat(64), origin: 'guest', guest_id: uuid() } }])]).catch((e) => e);
  assert.match(String(r), /FORBIDDEN/);
  const r2 = await app.t.db.query(`select core.apply_public_operations('flow', $1::jsonb)`,
    [JSON.stringify([{ op: 'update', table: TABLES.customers, id: c.id, expectedRevision: c.revision, fields: { display_name: 'Otro' } }])]).catch((e) => e);
  assert.match(String(r2), /FORBIDDEN/);
});
