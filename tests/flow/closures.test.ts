/**
 * Flow · integraciones (migración 0903): reflejo de la carta de Food y Cierre del día, sobre PGlite.
 * - El resumen del día (`flow.close_day`) con la base real: dinero movido por método, devoluciones pendientes aparte, lo
 *   vendido con su precio cerrado, y la regla del contrato con Finance (detalle + pendientes = importe).
 * - Los envíos a Food y Finance van por `appsFetch` capturado: se comprueba el contrato (procedimiento, argumentos,
 *   sesión de la persona, requestId estable), el modo pruebas y el aviso «Pide acceso». La llamada real a food-api e
 *   invoices-api se prueba en el ensayo con las apps desplegadas.
 * - La proyección para Booking y la lectura de la carta de Food con la sesión de Flow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { planSync, PROCEDURES, TABLES, type CartaMenu } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const PROJECT = '0f10a000-0000-4000-8000-000000000001';
const P = { serrano: '0f10a000-0000-4000-8000-000000000101', payoyo: '0f10a000-0000-4000-8000-000000000202', agua: '0f10a000-0000-4000-8000-000000000301' };
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
/** Lo que flow-api manda a las otras apps, y la respuesta que se simula. */
const calls: Array<{ url: string; auth: string | null; body: any; worker: string | null; caller: string | null }> = [];
let reply: (url: string) => Response = () => Response.json({ results: [{ result: { status: 'created' } }] });

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN], workerKey: 'clave-worker-de-prueba' }, {
    tasksApiBase: 'https://tasks.example.invalid',
    appsFetch: async (input, init) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      calls.push({ url, auth: h.get('authorization'), body: JSON.parse(String(init?.body ?? '{}')), worker: h.get('x-ikisai-worker-key'), caller: h.get('x-ikisai-caller') });
      return reply(url);
    },
  }) });
  await app.t.db.query(`update core.memberships set scopes = $1::jsonb where app = 'flow' and role in ('editor','reader')`, [JSON.stringify({ projects: [PROJECT] })]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.editor) => app.call('/api/v1/commands', { token, body: { requestId: `c-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.editor) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

async function paidOrder(lines: Array<[string, number]>, method: 'cash' | 'bizum', token = app.tokens.editor): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: PROJECT, origin: 'counter' } },
    ...lines.map(([product, quantity], i) => ({ op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: id, product_id: product, quantity, position: i + 1 } }))]);
  const o = await row(TABLES.orders, id);
  await ok([call(PROCEDURES.confirmPayment, { order_id: id, method, expected_revision: o.revision })], token);
  return id;
}

test('flow · la carta de Food se lee con la sesión de Flow (proyección abierta por Food)', async () => {
  const res = await app.call('/api/v1/read/food.carta_projection?limit=5');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(Array.isArray(res.data.rows));
});

test('flow · reflejo de la carta: crea, actualiza por línea de Food y retira lo que ya no está; el precio cobrado no cambia', async () => {
  const project = await row(TABLES.projects, PROJECT);
  const products = await rows(TABLES.products);
  const line = (scope: string, code: string, name: string, price: number, extra: Record<string, unknown> = {}) =>
    ({ menu_id: 'm1', menu_name: 'Barra · Evento de octubre', event_id: null, line_id: uuid(), scope, code, name, description: null, sale_price_cents: price,
       active: true, allergens: ['gluten'], allergens_checked: false, image_key: null, position: 1, ...extra }) as any;
  const sold = await paidOrder([[P.serrano, 1]], 'cash');
  const menu: CartaMenu = { id: uuid(), name: 'Barra · Evento de octubre', eventId: null, lines: [
    line('clasico', 'A', 'Serrano', 275, { image_key: 'montaditos/serrano' }),
    line('gourmet', 'β', 'Payoyo', 300),
    line('barra', 'A', 'Agua, botella pequeña', 100),
  ] };
  const plan = planSync(project, menu, products);
  assert.ok(plan.deactivated >= 10); // de la semilla del §8 quedan fuera los que no vienen
  assert.equal(plan.created, 0);
  assert.equal(plan.priced, 1);
  await ok(plan.operations, app.tokens.owner);
  const serrano = await row(TABLES.products, P.serrano);
  assert.equal(serrano.price_cents, 275); assert.equal(serrano.source_line_id, menu.lines[0]!.line_id); assert.deepEqual(serrano.allergens, ['gluten']);
  assert.equal((await row(TABLES.projects, PROJECT)).food_menu_id, menu.id);
  assert.equal((await rows(TABLES.orderLines)).find((l: any) => l.order_id === sold).unit_price_cents, 250);
  const menuNow = await app.call('/api/v1/public/menu', { token: null });
  assert.equal(menuNow.data.products.length, 3);
  assert.deepEqual(menuNow.data.products.find((p: any) => p.code === 'A' && p.scope === 'clasico').allergens, ['gluten']);
  // Repetir sin cambios no hace nada; solo el owner puede aplicarlo.
  const again = planSync(await row(TABLES.projects, PROJECT), menu, await rows(TABLES.products));
  assert.equal(again.operations.length, 0);
  // Volver a dejar activos los de la semilla para el resto de pruebas.
  const back = (await rows(TABLES.products)).filter((p: any) => !p.active).map((p: any) => ({ op: 'update', table: TABLES.products, id: p.id, expectedRevision: p.revision, fields: { active: true } }));
  await ok(back, app.tokens.owner);
});

test('flow · cierre del día: dinero por método, devolución pendiente aparte, vendido con su precio; se puede repetir', async () => {
  await paidOrder([[P.serrano, 2], [P.agua, 1]], 'cash', app.tokens.owner); // 2×2,75 + 1,00
  const reduced = await paidOrder([[P.payoyo, 2]], 'bizum', app.tokens.owner); // 6,00 → baja a 1 → devolución pendiente 3,00
  const o = await row(TABLES.orders, reduced);
  const line = (await rows(TABLES.orderLines)).find((l: any) => l.order_id === reduced);
  await ok([call(PROCEDURES.adjustPaidOrder, { order_id: reduced, method: 'bizum', expected_revision: o.revision, lines: [{ line_id: line.id, quantity: 1 }] })], app.tokens.owner);
  assert.equal((await commit([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })])).status, 403); // solo el owner
  const closed = await ok([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })], app.tokens.owner);
  const data = closed.results[0].result.data;
  assert.equal(data.refunds_pending_cents, 300);
  assert.equal(data.sales_by_method.cash + data.sales_by_method.bizum, data.sales_cents);
  const detail = data.units_by_product.reduce((s: number, u: any) => s + u.amount_cents, 0);
  assert.equal(detail + data.refunds_pending_cents, data.sales_cents); // contrato con Finance
  assert.ok(data.orders >= 3);
  // Repetir sustituye la misma fila.
  await ok([call(PROCEDURES.closeDay, { project_id: PROJECT, day: today() })], app.tokens.owner);
  assert.equal((await rows(TABLES.dayClosures)).filter((c: any) => c.day === today()).length, 1);
  // El cliente no escribe el cierre a mano.
  const c = (await rows(TABLES.dayClosures))[0];
  assert.equal((await commit([{ op: 'update', table: TABLES.dayClosures, id: c.id, expectedRevision: c.revision, fields: { food_status: 'sent' } }], app.tokens.owner)).data.error.code, 'PROCEDURE_ONLY');
});

test('flow · enviar a Food y a Finance con la sesión; requestId estable; modo pruebas; sin acceso, «Pide acceso»', async () => {
  const c = (await rows(TABLES.dayClosures)).find((x: any) => x.day === today());
  const project = await row(TABLES.projects, PROJECT);
  calls.length = 0;
  const food = await app.call(`/api/v1/closures/${c.id}/send/food`, { body: {} });
  assert.equal(food.status, 200, JSON.stringify(food.data));
  assert.match(calls[0]!.url, /\/functions\/v1\/food-api\/api\/v1\/commands$/);
  assert.equal(calls[0]!.worker, null); // a Food no se le manda la clave: no la pide
  assert.equal(calls[0]!.auth, 'Bearer ' + app.tokens.owner);
  const fop = calls[0]!.body.operations[0];
  assert.equal(fop.procedure, 'food.record_carta_sales');
  assert.equal(fop.args.menu_id, project.food_menu_id); assert.equal(fop.args.day, today());
  assert.ok(fop.args.lines.length >= 1 && fop.args.lines.every((l: any) => l.line_id && Number.isInteger(l.quantity)));
  const finance = await app.call(`/api/v1/closures/${c.id}/send/finance`, { body: {} });
  assert.equal(finance.status, 200, JSON.stringify(finance.data));
  const fin = calls[1]!.body.operations[0];
  assert.equal(fin.procedure, 'invoices.record_app_entry');
  assert.equal(fin.args.source_ref, `flow:project:${PROJECT}:${today()}`);
  assert.equal(fin.args.kind, 'income'); assert.equal(fin.args.tax_rate, 10); assert.equal(fin.args.nature, 'process');
  assert.equal(fin.args.methods.cash + fin.args.methods.bizum, fin.args.amount_cents);
  assert.equal(fin.args.detail.reduce((s: number, d: any) => s + d.amount_cents, 0) + fin.args.pending_refunds_cents, fin.args.amount_cents);
  // El mismo payload, el mismo requestId (idempotente en el núcleo de Finance).
  await app.call(`/api/v1/closures/${c.id}/send/finance`, { body: {} });
  assert.equal(calls[2]!.body.requestId, calls[1]!.body.requestId);
  // El resultado lo anotó flow-api (FL9): enviado a Food y a Finance; el navegador no puede marcarlo.
  const marked = await row(TABLES.dayClosures, c.id);
  assert.equal(marked.finance_status, 'sent'); assert.equal(marked.food_status, 'sent');
  assert.notEqual((await commit([call('flow.mark_closure_sent', { closure_id: c.id, target: 'finance', status: 'sent' })], app.tokens.owner)).status, 200);
  assert.notEqual((await commit([{ op: 'update', table: TABLES.dayClosures, id: c.id, expectedRevision: marked.revision, fields: { finance_status: 'error' } }], app.tokens.owner)).status, 200);
  // Sin acceso a la otra app: el aviso lo dice.
  reply = () => Response.json({ error: { code: 'NO_MEMBERSHIP', message: 'x', details: null } }, { status: 403 });
  const denied = await app.call(`/api/v1/closures/${c.id}/send/food`, { body: {} });
  assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'NEEDS_ACCESS'); assert.match(denied.data.error.message, /Pide acceso a Food/);
  assert.equal((await row(TABLES.dayClosures, c.id)).food_status, 'error'); // el fallo también queda anotado
  reply = () => Response.json({ results: [{ result: { status: 'created' } }] });
  // El modo pruebas ya no decide nada sobre Finance (VG 27-10): el resumen va siempre, como proceso.
  const p = await row(TABLES.projects, PROJECT);
  await ok([{ op: 'update', table: TABLES.projects, id: PROJECT, expectedRevision: p.revision, fields: { test_mode: true } }], app.tokens.owner);
  const before = calls.length;
  const sent = await app.call(`/api/v1/closures/${c.id}/send/finance`, { body: {} });
  assert.equal(sent.data.status, 'sent'); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)!.body.operations[0].args.nature, 'process');
  // Solo el owner envía.
  assert.equal((await app.call(`/api/v1/closures/${c.id}/send/food`, { token: app.tokens.editor, body: {} })).status, 403);
});

test('flow · Booking lee el resumen del servicio por su proyección cuando el flujo tiene evento', async () => {
  const event = uuid();
  const p = await row(TABLES.projects, PROJECT);
  await ok([{ op: 'update', table: TABLES.projects, id: PROJECT, expectedRevision: p.revision, fields: { booking_event_id: event } }], app.tokens.owner);
  const view = await app.t.db.query<{ event_id: string; day: string; data: any }>(`select * from flow.booking_service_projection where event_id = $1`, [event]);
  assert.equal(view.rows.length, 1);
  assert.ok(view.rows[0]!.data.sales_cents !== undefined);
  const reads = await app.t.db.query(`select 1 from core.allowed_reads where app = 'booking' and name = 'flow.booking_service_projection'`);
  assert.equal(reads.rows.length, 1);
});

test('Booking · qué flujos vivos tiene cada evento (tarjeta «Listo para Flow»), con lectura abierta a Booking', async () => {
  const event = (await row(TABLES.projects, PROJECT)).booking_event_id as string;
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'reader') on conflict do nothing`, [app.users.editor]);
  const out = (await app.t.db.query<{ out: any }>(`select core.read('booking', $1, 'flow.booking_event_flows_projection', $2::jsonb) as out`,
    [app.users.editor, JSON.stringify({ where: { event_id: event }, limit: 50 })])).rows[0]!.out;
  assert.deepEqual(out.rows.map((r: any) => r.project_id), [PROJECT]);
  assert.equal(out.rows[0].event_id, event);
});

test('enlaces · Booking: sus eventos se leen con la sesión de Flow (proyección abierta por Booking)', async () => {
  const res = await app.call('/api/v1/read/booking.event_projection?limit=5');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(Array.isArray(res.data.rows));
});

test('enlaces · «Pedir a Tasks»: proyecto elegido una vez, tarea o compra con la sesión, una vez por tarea; el enlace queda en la tarea', async () => {
  const unitId = uuid();
  await ok([{ op: 'insert', table: TABLES.units, id: unitId, fields: { project_id: PROJECT, column_key: 'logistics', kind: 'task', label: 'Reponer vasos', priority: true } }]);
  // Sin proyecto de Tasks, lo dice.
  assert.equal((await app.call(`/api/v1/units/${unitId}/tasks`, { body: { type: 'task' } })).data.error.code, 'NO_TASKS_PROJECT');
  // Lista de proyectos de Tasks: solo abiertos.
  reply = (url) => url.endsWith('/read/tasks.targets')
    ? Response.json({ tabs: [{ id: 'a1', name: 'Barra', projects: [{ id: 'p-open', title: 'Montaje', status: 'active' }, { id: 'p-arch', title: 'Viejo', status: 'archived' }, { id: 'p-sys', title: 'Entrada', status: 'active', system: true }] }] })
    : url.endsWith('/requests/task') ? Response.json({ created: true, task: { kind: 'task', id: 't-1', done: false } })
    : Response.json({ created: true, purchase: { kind: 'purchase_request', id: 'c-1', status: 'requested' } });
  const projects = await app.call('/api/v1/tasks/projects', { body: {} });
  assert.deepEqual(projects.data.items.map((p: any) => p.id), ['p-open']);
  const tasksProject = '00000000-0000-4000-8000-0000000000aa';
  const p2 = await row(TABLES.projects, PROJECT);
  await ok([{ op: 'update', table: TABLES.projects, id: PROJECT, expectedRevision: p2.revision, fields: { tasks_project_id: tasksProject } }], app.tokens.owner);
  calls.length = 0;
  const asked = await app.call(`/api/v1/units/${unitId}/tasks`, { token: app.tokens.editor, body: { type: 'task' } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.equal(calls[0]!.url, 'https://tasks.example.invalid/api/v1/requests/task');
  assert.equal(calls[0]!.auth, 'Bearer ' + app.tokens.editor);
  // FL2: identidad de servicio de Flow ante Tasks, además del token de la persona.
  assert.equal(calls[0]!.worker, 'clave-worker-de-prueba'); assert.equal(calls[0]!.caller, 'flow');
  assert.equal(calls[0]!.body.external_ref, unitId); assert.equal(calls[0]!.body.project_id, tasksProject);
  assert.equal(calls[0]!.body.priority, 'high'); assert.equal(calls[0]!.body.source, 'flow');
  // El enlace lo anotó flow-api (FL6); el cliente ya no puede escribirlo.
  assert.notEqual((await commit([call('flow.unit_link_external', { unit_id: unitId, link: { app: 'tasks', kind: 'task', id: 'otro' } })])).status, 200);
  assert.deepEqual((await row(TABLES.units, unitId)).payload.external.id, 't-1');
  // Compra con cantidad.
  const bought = await app.call(`/api/v1/units/${unitId}/tasks`, { body: { type: 'purchase', quantity: 3, unit: 'kg' } });
  assert.equal(bought.data.link.kind, 'purchase_request');
  assert.equal(calls[1]!.body.quantity, 3); assert.equal(calls[1]!.body.unit, 'kg');
  assert.equal(calls[1]!.body.external_url, `https://flow.ikisai.com/equipo#/p/${PROJECT}/logistica`);
  // El lector no pide; sin acceso a Tasks, «Pide acceso a Tasks»; proyecto que ya no vale, elegir otro.
  assert.equal((await app.call(`/api/v1/units/${unitId}/tasks`, { token: app.tokens.reader, body: { type: 'task' } })).status, 403);
  reply = () => Response.json({ error: { code: 'FORBIDDEN', message: 'x', details: null } }, { status: 403 });
  assert.equal((await app.call(`/api/v1/units/${unitId}/tasks`, { body: { type: 'task' } })).data.error.code, 'NEEDS_ACCESS');
  reply = () => Response.json({ error: { code: 'NOT_FOUND', message: 'x', details: null } }, { status: 404 });
  assert.equal((await app.call(`/api/v1/units/${unitId}/tasks`, { body: { type: 'task' } })).data.error.code, 'TASKS_PROJECT_GONE');
  reply = () => Response.json({ results: [{ result: { status: 'created' } }] });
  // Una tarea de producto no se pide; ni se falsea el enlace a mano.
  const manual = uuid();
  await ok([{ op: 'insert', table: TABLES.units, id: manual, fields: { project_id: PROJECT, column_key: 'logistics', kind: 'task', label: 'x', payload: { external: { app: 'tasks', id: 'fake' } } } }]);
  assert.equal((await row(TABLES.units, manual)).payload.external, undefined);
});
