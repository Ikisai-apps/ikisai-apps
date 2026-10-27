/**
 * QA de extremo a extremo del servicio del sábado (encargo de Core, 27-10), con las Edges reales de Flow, Food, Finance y
 * Booking sobre la misma base PGlite y la sesión de la misma persona (como tests/invoices/cadena-compra.test.ts):
 *  1. Booking: evento con huéspedes. Food: la carta de octubre con su previsión.
 *  2. Flow: «Nuevo flujo» desde la plantilla barra (v2) ligado al evento; carta desde Food; ingredientes y recipientes.
 *  3. Pedidos: público con número y de visitante (X-Visitor, enlace de un solo uso).
 *  4. Caja: cobro en metálico, pago unificado de dos pedidos, cuenta abierta y liquidada.
 *  5. Entrega: «Dar por hecho y entregar» (deliver_all); reposición propuesta.
 *  6. Finance: un cobro como fiscal; cierre del día a Food (consumo) y a Finance como proceso, sin lo ya enviado.
 *  7. Huéspedes: número para cada uno y check-in (llegada en Booking).
 * Lo que aún falta se dice con t.diagnostic('PENDIENTE (…)') y está en docs/flow/PETICIONES.md. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { PROCEDURES, TABLES, pickMenu, planSync, type CartaLine, type CartaMenu } from '../../supabase/functions/_domain/flow/mod.ts';

type Handler = (request: Request) => Promise<Response>;
const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const KEY = 'clave-de-prueba-solo-para-pglite';
const uuid = () => crypto.randomUUID();
const RESERVATION = uuid(), EVENT = uuid(), BARRA = uuid(), LLEGADAS = uuid();
const GUESTS = [uuid(), uuid()];
let app: TestApp;
let food: Handler, finance: Handler, booking: Handler;
let seq = 0;
let eventCode = '';
const madrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

test.before(async () => {
  const base = () => ({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
  // Flow llama a Food, Finance y Booking por su API con el token de la persona: aquí, a sus Edges sobre la misma base.
  const appsFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const [handler, origin] = url.includes('/food-api/') ? [food, FOOD_ORIGINS[0]!] : url.includes('/invoices-api/') ? [finance, INVOICES_ORIGINS[0]!] : [booking, BOOKING_ORIGINS[0]!];
    return handler(new Request(url, { method: init?.method, body: init?.body, headers: { ...(init?.headers as Record<string, string>), Origin: origin } }));
  }) as typeof fetch;
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }, { appsFetch }) });
  food = createFoodApp({ ...base(), origins: [FOOD_ORIGINS[0]!] } as never) as unknown as Handler;
  finance = createInvoicesApp({ ...base(), origins: [INVOICES_ORIGINS[0]!], drive: { api: null } } as never) as unknown as Handler;
  booking = createBookingApp({ ...base(), origins: [BOOKING_ORIGINS[0]!] } as never) as unknown as Handler;
  // La misma persona: owner en Flow (ya), Food y Finance; editora en Booking (llegadas y salidas).
  for (const [a, role] of [['food', 'owner'], ['invoices', 'owner'], ['booking', 'editor']]) {
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, $3) on conflict (app, user_id) do update set role = $3`, [a, app.users.owner, role]);
  }
  await app.t.db.exec(`set flow.portal_key = '${KEY}'`);
  // Booking: el evento y dos huéspedes (los escribe su app; aquí, directo en la base).
  await app.t.db.query(`insert into booking.reservations (id, title, status, start_date, end_date, expected_guests, requires_meals, meal_plan_requested, menu_style_requested)
    values ($1, 'Encuentro de prueba', 'confirmada', '2026-10-30', '2026-11-01', 40, true, 'pension_completa', 'vegetariano')`, [RESERVATION]);
  await app.t.db.query(`insert into booking.events (id, reservation_id) values ($1, $2)`, [EVENT, RESERVATION]);
  eventCode = (await app.t.db.query<{ code: string }>(`select code from booking.events where id = $1`, [EVENT])).rows[0]!.code;
  await app.t.db.query(`insert into booking.guests (id, event_id, first_name, last_name_1) values ($1, $3, 'Ana', 'Prueba'), ($2, $3, 'Luis', 'Ensayo')`, [GUESTS[0], GUESTS[1], EVENT]);
  // Food: la carta de octubre con su previsión (la semilla necesita el artículo Tomate de Recursos, como en Food).
  const TOMATE = '3a3d080c-417e-4174-a87f-9f28fc62ec90';
  if (!(await app.t.db.query(`select 1 from resources.items where id = $1`, [TOMATE])).rows.length) {
    const res = await food(new Request(`${app.supabase.url}/functions/v1/food-api/api/v1/resources/commands`, { method: 'POST',
      headers: { Origin: FOOD_ORIGINS[0]!, Authorization: 'Bearer ' + app.tokens.owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'sab-tomate', operations: [{ op: 'insert', table: 'resources.items', id: TOMATE, fields: { name: 'Tomate', kind: 'ingrediente', base_unit: 'kg' } }] }) }));
    assert.equal(res.status, 200, await res.text());
  }
  await app.t.db.query(`select food.seed_carta_octubre()`);
  // La previsión de unidades por línea (la pone Food en su pantalla; aquí, directa): 30 de cada.
  await app.t.db.query(`update food.carta_lines set expected_units = 30 where menu_id = 'f00dca7a-0000-4000-8000-000000000001'`);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `sab-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0]?.result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const pub = (path: string, init: { body?: unknown; method?: string; visitor?: string; customer?: string } = {}) =>
  app.call(`/api/v1/public/${path}`, { token: null, body: init.body, method: init.method,
    headers: { ...(init.visitor ? { 'X-Visitor': init.visitor } : {}), ...(init.customer ? { 'X-Flow-Customer': init.customer } : {}) } });
async function openOrder(lines: Array<[string, number]>, customerId: string | null = null): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: BARRA, origin: 'counter', customer_id: customerId } },
    ...lines.map(([product, q], i) => ({ op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: product, quantity: q, position: i + 1 } }))]);
  return id;
}
const order = async (id: string) => (await rows(TABLES.orders)).find((o) => o.id === id);

test('servicio del sábado · de la carta de Food al cierre del día, con huéspedes y check-in', async (t) => {
  // 2. «Nuevo flujo» desde la plantilla barra, ligado al evento: nace v2 (cuentas, caja profunda, entregar de una vez) y con «Pan».
  const created = await ok([call(PROCEDURES.createFlow, { template_key: 'barra', project_id: BARRA, booking_event_id: EVENT, starts_on: '2026-10-30', ends_on: '2026-11-01' })]);
  assert.equal(created.template_version, 2, JSON.stringify(created));
  const cols = (await rows(TABLES.columns)).filter((c) => c.project_id === BARRA);
  const cfg = (k: string) => cols.find((c) => c.key === k)?.config ?? {};
  assert.equal(cfg('order').accounts, true); assert.equal(cfg('order').deep_checkout, true);
  assert.equal(cfg('service').complete_on_delivery, true); assert.equal(cfg('ingredients').fresh_stock, true);
  assert.ok((await rows(TABLES.units)).some((u) => u.project_id === BARRA && u.kind === 'station'), 'el puesto «Pan»');

  // Carta desde Food (como «Actualizar carta desde Food»).
  const carta = await app.call('/api/v1/read/food.carta_projection?limit=2000');
  assert.equal(carta.status, 200, JSON.stringify(carta.data));
  const menus = new Map<string, CartaMenu>();
  for (const line of carta.data.rows as CartaLine[]) {
    const m = menus.get(line.menu_id) ?? { id: line.menu_id, name: line.menu_name, eventId: line.event_id, lines: [] };
    m.lines.push(line); menus.set(line.menu_id, m);
  }
  const project = (await rows(TABLES.projects)).find((p) => p.id === BARRA);
  const menu = pickMenu([...menus.values()], project) ?? [...menus.values()][0]!;
  assert.ok(menu, 'Food tiene una carta');
  await ok(planSync(project, menu, await rows(TABLES.products)).operations);
  const products = (await rows(TABLES.products)).filter((p) => p.project_id === BARRA && p.active);
  assert.ok(products.length >= 4, `productos de la carta: ${products.length}`);
  const prepared = products.filter((p) => p.prepared);
  const drink = products.find((p) => !p.prepared) ?? products[0]!;
  assert.ok(prepared.length >= 2, 'montaditos que se preparan');

  // Ingredientes desde la previsión de Food (como «Generar tareas de ingredientes»).
  const totals = await app.call(`/api/v1/read/food.carta_prep_totals_projection?where[menu_id]=${menu.id}&limit=2000`);
  const lines = await app.call(`/api/v1/read/food.carta_prep_projection?where[menu_id]=${menu.id}&limit=2000`);
  assert.equal(totals.status, 200, JSON.stringify(totals.data)); assert.equal(lines.status, 200, JSON.stringify(lines.data));
  await ok([call(PROCEDURES.generateIngredientTasks, { project_id: BARRA, day: madrid(),
    totals: totals.data.rows.map((x: any) => ({ component_key: x.component_key, name: x.name, unit: x.unit, mesa: x.mesa, nevera: x.nevera, convertible: x.convertible,
      ...(x.fresco != null ? { fresco: x.fresco } : {}), ...(x.yield != null ? { yield: x.yield } : {}), ...(x.purchase_unit ? { purchase_unit: x.purchase_unit } : {}) })),
    rules: lines.data.rows.map((x: any) => ({ line_id: x.line_id, component_key: x.component_key, name: x.name, unit: x.unit, per_unit: x.per_unit, convertible: x.convertible })) })]);
  const buffers = (await rows(TABLES.buffers)).filter((b) => b.project_id === BARRA);
  t.diagnostic(`previsión de Food: ${totals.data.rows.length} componentes; convertibles ${totals.data.rows.filter((x: any) => x.convertible).length}; con mesa ${totals.data.rows.filter((x: any) => x.mesa != null).length}; líneas ${lines.data.rows.length}; ejemplo ${JSON.stringify(totals.data.rows[0] ?? null)}`);
  if (!buffers.length) t.diagnostic('PENDIENTE (Food): la previsión de la carta de octubre no da cantidades convertibles: no hay puntos de existencias.');
  else {
    assert.ok(buffers.some((b) => b.location === 'fresco'), 'el punto «fresco» (la app ya pasa fresco)');
    const mesa = buffers.find((b) => b.location === 'mesa')!;
    await ok([call(PROCEDURES.setBufferContainers, { buffer_id: mesa.id, containers: 2, per_container: Math.max(1, Math.ceil(Number(mesa.capacity) / 2)) })]);
    // Preparar mesa y nevera (las propuestas de la generación).
    for (const u of (await rows(TABLES.units)).filter((x) => x.project_id === BARRA && x.column_key === 'ingredients' && x.status === 'proposed')) {
      for (const from of ['proposed', 'pending', 'in_progress']) await ok([call(PROCEDURES.unitStep, { unit_id: u.id, from })]);
    }
  }

  // La barra del evento atiende la carta pública (y la v1 deja de hacerlo).
  const [p1, p2] = [(await rows(TABLES.projects)).find((p) => p.id === V1), (await rows(TABLES.projects)).find((p) => p.id === BARRA)];
  await ok([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: p1.revision, fields: { serves_public: false } },
    { op: 'update', table: TABLES.projects, id: BARRA, expectedRevision: p2.revision, fields: { serves_public: true } }]);

  // 3. Pedido público con número.
  const me = await pub('customer', { body: {} });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  const publicOrder = await pub('orders', { body: { lines: [{ productId: prepared[0]!.id, quantity: 2 }] }, customer: me.data.token });
  assert.equal(publicOrder.status, 200, JSON.stringify(publicOrder.data));
  // Visitante por QR: número, enlace de un solo uso y su pedido.
  const visitor = (await pub('visitor', { body: { eventCode } })).data.token as string;
  const joined = await pub('visitor_join', { body: { event_code: eventCode }, visitor });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  const invitation = new URL(joined.data.carta_url).searchParams.get('invitacion')!;
  const redeemed = await pub('invitation', { body: { invitation } });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
  assert.equal((await pub('invitation', { body: { invitation } })).data.error.code, 'INVITATION_USED');
  const visitorOrder = await pub('orders', { body: { lines: [{ productId: prepared[1]!.id, quantity: 1 }, { productId: drink.id, quantity: 1 }] }, customer: redeemed.data.token });
  assert.equal(visitorOrder.status, 200, JSON.stringify(visitorOrder.data));
  const mine = await pub(`flow_visitor_customer?event_code=${eventCode}`, { visitor });
  assert.equal(mine.data.orders.length, 1);

  // 4. Caja: el público en metálico; el visitante y uno de caja, unificados; una cuenta abierta y liquidada con tarjeta.
  const cash = await ok([call(PROCEDURES.payOrders, { order_ids: [publicOrder.data.orderId], method: 'cash' })]);
  assert.equal(cash.receipts.length, 1);
  const counter = await openOrder([[prepared[0]!.id, 1]]);
  const unified = await ok([call(PROCEDURES.payOrders, { order_ids: [visitorOrder.data.orderId, counter], method: 'bizum', unify: true })]);
  assert.equal(unified.receipts.length, 1); assert.equal(unified.orders.length, 2);
  const account = (await ok([call(PROCEDURES.openAccount, { project_id: BARRA, holder: 'Mesa del equipo' })])).account_id;
  const onAccount = await openOrder([[prepared[1]!.id, 2]]);
  await ok([call(PROCEDURES.chargeToAccount, { order_id: onAccount, account_id: account, expected_revision: (await order(onAccount)).revision })]);
  const settled = await ok([call(PROCEDURES.settleAccount, { account_id: account, method: 'card' })]);
  assert.ok(settled.total_cents > 0);

  // 5. Entrega: lo del público, aún en cocina, se da por hecho y se entrega de una vez.
  const delivered = await ok([call(PROCEDURES.deliverAll, { order_id: publicOrder.data.orderId, ident: 'number' })]);
  assert.equal(delivered.completed_units, 2); assert.equal((await order(publicOrder.data.orderId)).status, 'delivered');
  if (buffers.length) {
    const consumed = (await rows(TABLES.units)).some((u) => u.order_id === publicOrder.data.orderId && (u.payload?.applied ?? []).length);
    if (!consumed) t.diagnostic('PENDIENTE (Flow/Food): las unidades terminadas no descontaron existencias (reglas de consumo sin la línea del producto).');
    const proposals = (await rows(TABLES.units)).filter((u) => u.project_id === BARRA && u.column_key === 'ingredients' && u.status === 'proposed');
    t.diagnostic(`reposición propuesta tras el servicio: ${proposals.map((u) => u.label).join(' | ') || 'ninguna (aún sobre el umbral)'}`);
  }

  // 6. Finance: el cobro unificado como fiscal (Finance real).
  const receipt = unified.receipts[0].receipt_id as string;
  const fiscal = await app.call(`/api/v1/receipts/${receipt}/send/finance`, { body: {} });
  assert.equal(fiscal.status, 200, JSON.stringify(fiscal.data));
  assert.equal((await rows(TABLES.receipts)).find((r) => r.id === receipt).finance_status, 'sent');
  const entries = async () => (await app.t.db.query<any>(`select * from invoices.app_entries where source_app = 'flow'`)).rows;
  const fiscalEntry = (await entries()).find((e) => e.source_ref === `flow:receipt:${receipt}`);
  assert.ok(fiscalEntry, 'Finance guarda el apunte fiscal del justificante');
  assert.equal(fiscalEntry.nature, 'fiscal');
  assert.equal(fiscalEntry.receipt_kind, 'ticket'); assert.match(fiscalEntry.receipt_number, /^\d+(\+\d+)*$/);

  // Cierre del día: consumo a Food, resumen a Finance como proceso, sin el cobro ya enviado.
  const closed = await ok([call(PROCEDURES.closeDay, { project_id: BARRA, day: madrid() })]);
  const toFood = await app.call(`/api/v1/closures/${closed.closure_id}/send/food`, { body: {} });
  assert.equal(toFood.status, 200, JSON.stringify(toFood.data));
  const toFinance = await app.call(`/api/v1/closures/${closed.closure_id}/send/finance`, { body: {} });
  assert.equal(toFinance.status, 200, JSON.stringify(toFinance.data));
  const processEntry = (await entries()).find((e) => e.source_ref === `flow:project:${BARRA}:${madrid()}`);
  assert.ok(processEntry, 'Finance guarda el apunte de proceso del día');
  assert.equal(processEntry.nature, 'process');
  const unifiedTotal = (await rows(TABLES.receipts)).find((r) => r.id === receipt).total_cents;
  assert.equal(Number(processEntry.amount_cents), closed.data.sales_cents - unifiedTotal, 'el cierre no repite el cobro fiscal');

  // 7. Huéspedes: número para cada uno (lista de Booking, solo de un evento del ámbito) y check-in con llegada en Booking.
  const guests = await app.call('/api/v1/read/booking.flow_guests_of', { body: { event_id: EVENT } });
  assert.equal(guests.status, 200, JSON.stringify(guests.data));
  assert.equal(guests.data.items.length, 2);
  const numbered = await ok([call(PROCEDURES.assignGuestNumbers, { project_id: BARRA, guests: guests.data.items.map((g: any) => ({ guest_id: g.guest_id, display_name: g.display_name })) })]);
  assert.equal(numbered.created, 2);
  await ok([call(PROCEDURES.createFlow, { template_key: 'checkin', project_id: LLEGADAS, booking_event_id: EVENT })]);
  const list = await app.call(`/api/v1/checkin/${LLEGADAS}/guests`);
  assert.equal(list.status, 200, JSON.stringify(list.data)); assert.equal(list.data.rows.length, 2);
  const arrive = await app.call(`/api/v1/checkin/${LLEGADAS}/guests/${GUESTS[0]}/arrive`, { body: {} });
  assert.equal(arrive.status, 200, JSON.stringify(arrive.data));
  const arrived = (await app.t.db.query<{ a: string | null }>(`select arrived_at::text a from booking.guests where id = $1`, [GUESTS[0]])).rows[0]!.a;
  assert.ok(arrived, 'la llegada queda en Booking');
  await ok([call(PROCEDURES.markPresence, { project_id: LLEGADAS, guest_id: GUESTS[0], step: 'bed' })]);

  // Capacidades que Flow ofrece a otras apps (catálogo 0097): el resumen del día y crear una tarea de Logística.
  const caps = (await app.call('/api/v1/capabilities')).data.items as Array<{ id: string; allowed: boolean }>;
  assert.ok(caps.some((c) => c.id === 'flow.day_summary' && c.allowed) && caps.some((c) => c.id === 'flow.logistics_task' && c.allowed), JSON.stringify(caps.map((c) => c.id)));
  const summary = await app.call('/api/v1/day-summary', { body: { project_id: BARRA, day: madrid() } });
  assert.equal(summary.status, 200, JSON.stringify(summary.data)); assert.equal(summary.data.sales_cents, closed.data.sales_cents);
  const task = { requestId: 'tasks-aviso-hielo', project_id: BARRA, label: 'Llega el hielo a las 19:00', priority: true };
  const first = await app.call('/api/v1/logistics-task', { body: task });
  const again = await app.call('/api/v1/logistics-task', { body: task });
  assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(again.data.id, first.data.id); assert.equal(again.data.replayed, true);
  assert.ok((await rows(TABLES.units)).some((u) => u.id === first.data.id && u.column_key === 'logistics' && u.priority));
});
