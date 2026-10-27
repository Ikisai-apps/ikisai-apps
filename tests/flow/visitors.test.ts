/**
 * Flow · visitantes por QR (migración 0915, FL2), sobre PGlite: visitor_join (ruta pública del kit con X-Visitor),
 * «Mi pedido» (flow_visitor_customer), enlace a la carta de un solo uso y la guarda del lote público. Datos sintéticos.
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
let code = '';
let visitor = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  await app.t.db.exec(`set flow.portal_key = '${KEY}'`);
  // Un evento de Booking sintético, ligado a la barra v1 (que atiende la carta).
  const reservation = uuid(); const event = uuid();
  await app.t.db.query(`insert into booking.reservations (id, title, status, start_date, end_date, expected_guests, requires_meals, meal_plan_requested, menu_style_requested)
    values ($1, 'Encuentro de prueba', 'confirmada', '2026-10-30', '2026-11-01', 20, true, 'pension_completa', 'vegetariano')`, [reservation]);
  await app.t.db.query(`insert into booking.events (id, reservation_id) values ($1, $2)`, [event, reservation]);
  code = (await app.t.db.query<{ code: string }>(`select code from booking.events where id = $1`, [event])).rows[0]!.code;
  await app.t.db.query(`update flow.projects set booking_event_id = $1 where id = $2`, [event, V1]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `v-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
const pub = (path: string, init: { body?: unknown; method?: string; visitor?: string; customer?: string } = {}) =>
  app.call(`/api/v1/public/${path}`, { token: null, body: init.body, method: init.method,
    headers: { ...(init.visitor ? { 'X-Visitor': init.visitor } : {}), ...(init.customer ? { 'X-Flow-Customer': init.customer } : {}) } });

test('visitantes · alta del visitante del kit y visitor_join: número una vez por visitante', async () => {
  const issued = await pub('visitor', { body: { eventCode: code } });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  visitor = issued.data.token;
  assert.equal((await pub('visitor_join', { body: { event_code: code } })).data.error.code, 'VISITOR_REQUIRED');
  assert.equal((await pub('visitor_join', { body: { event_code: 'NOEXISTE' }, visitor })).data.error.code, 'NO_FLOW');
  const first = await pub('visitor_join', { body: { event_code: code }, visitor });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.ok(first.data.number >= 100); assert.deepEqual(first.data.orders, []); assert.equal(first.data.account_open, false);
  const again = await pub('visitor_join', { body: { event_code: code }, visitor });
  assert.equal(again.data.number, first.data.number);
  const rows = (await app.t.db.query<{ n: number }>(`select count(*)::int as n from flow.customers where origin = 'visitor'`)).rows[0]!.n;
  assert.equal(rows, 1);
});

test('visitantes · «Mi pedido»: lectura pública con el visitante del kit; sin visitante, nada', async () => {
  const none = await pub(`flow_visitor_customer?event_code=${code}`);
  assert.equal(none.status, 200); assert.equal(none.data.number, null);
  const forged = await pub(`flow_visitor_customer?event_code=${code}&visitor_id=${uuid()}`); // el visitor_id del cliente se descarta
  assert.equal(forged.data.number, null);
  const mine = await pub(`flow_visitor_customer?event_code=${code}`, { visitor });
  assert.ok(mine.data.number >= 100);
  assert.match(mine.data.carta_url, /^https:\/\/flow\.ikisai\.com\/\?invitacion=/);
});

test('visitantes · el enlace a la carta es de un solo uso (firma con revisión) y deja el navegador como ese cliente', async () => {
  const mine = await pub(`flow_visitor_customer?event_code=${code}`, { visitor });
  const invitation = new URL(mine.data.carta_url).searchParams.get('invitacion')!;
  const parts = invitation.split('.');
  assert.equal(parts.length, 4);
  assert.equal(parts[3], createHmac('sha256', KEY).update(parts.slice(0, 3).join('.')).digest('hex'));
  const redeemed = await pub('invitation', { body: { invitation } });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
  assert.equal(redeemed.data.number, mine.data.number);
  const used = await pub('invitation', { body: { invitation } });
  assert.equal(used.status, 410); assert.equal(used.data.error.code, 'INVITATION_USED');
  // Con ese token pide desde la carta y su pedido sale en «Mi pedido».
  const menu = await pub('menu', { method: 'GET' });
  const product = menu.data.products[0];
  const order = await pub('orders', { body: { lines: [{ productId: product.id, quantity: 2 }] }, customer: redeemed.data.token });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  const after = await pub(`flow_visitor_customer?event_code=${code}`, { visitor });
  assert.equal(after.data.orders.length, 1);
  assert.equal(after.data.orders[0].status, 'open'); assert.equal(after.data.orders[0].summary, `2 ${product.code}`);
});

test('visitantes · el lote público no crea clientes de otro visitante ni cambia más que el token', async () => {
  const other = uuid();
  const r = await app.t.db.query(`select core.apply_public_operations('flow', $1::jsonb)`,
    [JSON.stringify([{ op: 'insert', table: TABLES.customers, id: uuid(), fields: { project_id: V1, token_hash: 'b'.repeat(64), origin: 'visitor', visitor_id: other } }])]).catch((e) => e);
  assert.match(String(r), /FORBIDDEN|VISITOR_INVALID/);
  const c = (await app.t.db.query<any>(`select * from flow.customers where origin = 'visitor' limit 1`)).rows[0];
  const r2 = await app.t.db.query(`select core.apply_public_operations('flow', $1::jsonb)`,
    [JSON.stringify([{ op: 'update', table: TABLES.customers, id: c.id, expectedRevision: Number(c.revision), fields: { visitor_id: uuid() } }])]).catch((e) => e);
  assert.match(String(r2), /FORBIDDEN/);
});

test('visitantes · el enlace de huésped también es de un solo uso (portal_customer)', async () => {
  const guest = uuid(); const reservation = uuid();
  await ok([call(PROCEDURES.assignGuestNumbers, { project_id: V1, guests: [{ guest_id: guest, display_name: 'Ana P.' }] })]);
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2::jsonb)`,
    [app.users.reader, JSON.stringify({ grants: [{ reservation_id: reservation, guest_id: guest }] })]);
  const out = (await app.t.db.query<{ out: any }>(`select core.read('guests', $1, 'flow.portal_customer', $2::jsonb) as out`,
    [app.users.reader, JSON.stringify({ reservation_id: reservation, guest_id: guest })])).rows[0]!.out;
  const invitation = new URL(out.carta_url).searchParams.get('invitacion')!;
  assert.equal(invitation.split('.').length, 4);
  assert.equal((await pub('invitation', { body: { invitation } })).status, 200);
  assert.equal((await pub('invitation', { body: { invitation } })).data.error.code, 'INVITATION_USED');
});

test('visitantes · FL10: un enlace de tres partes (de antes de la 0915), aunque esté bien firmado y en plazo, no vale', async () => {
  const guest = uuid();
  const out = await ok([call(PROCEDURES.assignGuestNumbers, { project_id: V1, guests: [{ guest_id: guest, display_name: 'Luis E.' }] })]);
  const customer = (await app.t.db.query<{ id: string }>(`select id from flow.customers where guest_id = $1`, [guest])).rows[0]!.id;
  assert.ok(out);
  const msg = `${customer}.${Math.floor(Date.now() / 1000) + 600}`;
  const invitation = `${msg}.${createHmac('sha256', KEY).update(msg).digest('hex')}`;
  const res = await pub('invitation', { body: { invitation } });
  assert.equal(res.status, 404); assert.equal(res.data.error.code, 'INVITATION_INVALID');
});

const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
