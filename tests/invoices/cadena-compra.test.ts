/**
 * QA de integración para el evento del 31-10 (encargo de Core): la cadena de compra de la barra de extremo a extremo,
 * con las Edges reales de Flow, Tasks y Finance sobre la misma base PGlite y la sesión de la misma persona.
 *
 * 1. Flow: una tarea de logística «Comprar hielo» → «Pedir a Tasks» (`POST units/:id/tasks`, `type: purchase`).
 * 2. Tasks: la solicitud de compra nace «pedida» (`requests/purchase`, procedencia `flow` + id de la unidad); se aprueba,
 *    se compra y se recibe.
 * 3. Finance: al recibirla con total y ticket, Tasks invoca `invoices.register_purchase_quick` por el catálogo con el
 *    token de la persona (decisión de Core, 27-10; PETICIONES.md). Mientras Tasks no lo haga, la prueba la registra a mano
 *    con «Registrar compra rápida» (`POST purchases/quick`) y el paso automático queda como `todo` (no en rojo).
 * 4. «Evento»: cuenta como gasto de proceso; Gestoría (`fiscal_summary_for`): fuera. Llega la factura: pasa a factura,
 *    se valida, y entonces cuenta como gasto en «Evento» y entra en Gestoría con su IVA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { requestPurchaseId } from '../../supabase/functions/tasks-api/requests.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';
import { eventResults } from '../../apps/invoices/src/app/app-entries-state.ts';

const uuid = () => crypto.randomUUID();
const FLOW_PROJECT = '0f10a000-0000-4000-8000-000000000001'; // la semilla de la 0900
const TAB = uuid(), TASKS_PROJECT = uuid(), EVENT = uuid(), RESERVATION = uuid();
let app: TestApp; // Finance (la app de esta prueba)
type Handler = (request: Request) => Promise<Response>;
let tasksHandler: Handler; let flowHandler: Handler;
let seq = 0;

/** Llamada a otra Edge sobre la misma base, con el token de la persona (como `app.call`, pero a su slug). */
async function edge(handler: Handler, slug: string, origin: string, path: string, body?: unknown, token = app.tokens.owner): Promise<{ status: number; data: any }> {
  const res = await handler(new Request(`${app.supabase.url}/functions/v1/${slug}/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const tasks = (path: string, body?: unknown) => edge(tasksHandler, 'tasks-api', TASKS_ORIGINS[0]!, path, body);
const flow = (path: string, body?: unknown) => edge(flowHandler, 'flow-api', FLOW_ORIGINS[0]!, path, body);
async function okCommit(call: (path: string, body?: unknown) => Promise<{ status: number; data: any }>, operations: unknown[]) {
  const res = await call('commands', { requestId: `cadena-${++seq}`, operations });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const snapshot = async (call: (path: string) => Promise<{ data: any }>, table: string) => (await call(`snapshot?tables=${table}&includeDeleted=1`)).data.tables[0].rows as any[];
const finance = (path: string, body?: unknown) => app.call(`/api/v1/${path}`, body === undefined ? {} : { body });

test.before(async () => {
  app = await createTestApp({ app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }) });
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch };
  tasksHandler = createTasksApp({ ...base, origins: [TASKS_ORIGINS[0]!] }) as unknown as Handler;
  // Flow habla con Tasks por HTTP con el token de la persona: aquí, directo a la Edge de Tasks de la misma base.
  flowHandler = createFlowApp({ ...base, origins: [FLOW_ORIGINS[0]!] } as never, {
    tasksApiBase: 'https://tasks.test',
    appsFetch: async (input, init) => tasksHandler(new Request(String(input).replace('https://tasks.test', `${app.supabase.url}/functions/v1/tasks-api`), {
      method: init?.method, body: init?.body, headers: { ...(init?.headers as Record<string, string>), Origin: TASKS_ORIGINS[0]! },
    })),
  }) as unknown as Handler;
  // La misma persona es owner en Flow y en Tasks (en Finance ya lo es)
  for (const a of ['flow', 'tasks']) await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'owner') on conflict (app, user_id) do update set role = 'owner'`, [a, app.users.owner]);
  // Tasks: el área y el proyecto de la barra
  await okCommit(tasks, createTabOps({ id: TAB, name: 'Eventos', position: 1024 }));
  await okCommit(tasks, [{ op: 'insert', table: 'tasks.projects', id: TASKS_PROJECT, fields: { tab_id: TAB, title: 'Montaje de la barra', position: 2048 } }]);
  // Booking: el evento del 31-10 (lo escribe su app; aquí, directo en la base)
  await app.t.db.query(`insert into booking.reservations (id, title, status, start_date, end_date, expected_guests, requires_meals, meal_plan_requested, menu_style_requested)
    values ($1, 'Evento de octubre', 'confirmada', '2026-10-30', '2026-11-01', 80, true, 'pension_completa', 'vegetariano')`, [RESERVATION]);
  await app.t.db.query(`insert into booking.events (id, reservation_id) values ($1, $2)`, [EVENT, RESERVATION]);
});
test.after(async () => { await app.close(); });

test('cadena de compra de la barra: Flow → Tasks → Finance → «Evento» y Gestoría', async (t) => {
  // 1. Flow: el proyecto de la barra apunta al de Tasks; la tarea «Comprar hielo» se pide a Tasks como compra
  const project = (await snapshot(flow, 'flow.projects')).find((p) => p.id === FLOW_PROJECT);
  assert.ok(project, 'el proyecto de la semilla de Flow');
  await okCommit(flow, [{ op: 'update', table: 'flow.projects', id: FLOW_PROJECT, expectedRevision: project.revision, fields: { tasks_project_id: TASKS_PROJECT } }]);
  const unit = uuid();
  await okCommit(flow, [{ op: 'insert', table: 'flow.units', id: unit, fields: { project_id: FLOW_PROJECT, column_key: 'logistics', kind: 'task', label: 'Comprar hielo', priority: true } }]);
  const asked = await flow(`units/${unit}/tasks`, { type: 'purchase', quantity: 10, unit: 'kg' });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.equal(asked.data.link.kind, 'purchase_request');
  const purchaseId = asked.data.link.id as string;
  assert.equal(purchaseId, await requestPurchaseId(`flow:${unit}`), 'idempotente por la unidad de Flow');

  // 2. Tasks: nace pedida, con la procedencia; se aprueba, se compra y se recibe
  let request = (await snapshot(tasks, 'tasks.purchase_requests')).find((r) => r.id === purchaseId);
  assert.deepEqual([request.status, request.title, request.source_app, request.source_ref, Number(request.quantity), request.unit, request.needs_invoice],
    ['requested', 'Comprar hielo', 'flow', unit, 10, 'kg', true]);
  for (const status of ['approved', 'purchased', 'received']) {
    await okCommit(tasks, [{ op: 'update', table: 'tasks.purchase_requests', id: purchaseId, expectedRevision: request.revision, fields: { status } }]);
    request = (await snapshot(tasks, 'tasks.purchase_requests')).find((r) => r.id === purchaseId);
  }
  assert.equal(request.status, 'received');

  // 3. Tasks → Finance al recibirla (pendiente en Tasks): si ya llegó, se usa; si no, la registra quien compró
  const arrived = (await snapshot(finance, 'invoices.invoices')).find((i) => !i.deleted_at);
  if (!arrived) t.diagnostic('PENDIENTE (Tasks): al recibir la compra no llega a Finance; se registra a mano con «Registrar compra rápida».');
  const quick = arrived ? { status: 200, data: { invoice_id: arrived.id, nature: 'process', base: 22, vat: 2.2 } } : await finance('purchases/quick', {
    requestId: `tasks-purchase-${purchaseId}`, supplier: { name: 'Hielos del Sur' }, date: '2026-10-31', total: 24.2, vat_rate: 10,
    description: 'Hielo para la barra (10 kg)', invoice_number: 'T-881', receipt_kind: 'ticket', target: { app: 'booking', kind: 'event', id: EVENT },
    notes: `Compra de Tasks ${purchaseId} pedida desde Flow`,
  });
  assert.equal(quick.status, 200, JSON.stringify(quick.data));
  assert.deepEqual([quick.data.nature, quick.data.base, quick.data.vat], ['process', 22, 2.2]);
  const invoiceId = quick.data.invoice_id as string;

  // 4. «Evento»: gasto de proceso, marcado; Gestoría: fuera (un ticket no es deducible)
  const sources = async () => ({
    entries: [], allocations: await snapshot(finance, 'invoices.allocations'), lines: await snapshot(finance, 'invoices.invoice_lines'),
    invoices: await snapshot(finance, 'invoices.invoices'), issuedAllocations: [], issued: [],
  });
  let [event] = eventResults(await sources());
  assert.equal(event!.eventId, EVENT);
  assert.deepEqual(event!.moves.map((m) => [m.kind, m.cents, !!m.process]), [['invoice', 2200, true]]);
  assert.equal(event!.resultCents, -2200);
  const fiscal = async () => (await app.t.db.query<{ s: any }>(`select invoices.fiscal_summary_for('2026-10-01', '2026-12-31') s`)).rows[0]!.s;
  assert.equal(Number((await fiscal()).base), 0, 'el ticket no entra en Gestoría');

  // Llega la factura: pasa a factura (con el documento y la categoría), se valida y entra en Gestoría con su IVA
  const bytes = new TextEncoder().encode('%PDF factura del hielo');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await finance('uploads', { filename: 'factura-hielo.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha });
  app.supabase.storage.set(ticket.data.path, bytes);
  await finance(`uploads/${ticket.data.id}/verify`, {});
  let invoice = (await snapshot(finance, 'invoices.invoices')).find((i) => i.id === invoiceId);
  const res = await app.call('/api/v1/commands', { body: { requestId: `cadena-${++seq}`, operations: [
    { op: 'update', table: 'invoices.invoices', id: invoiceId, expectedRevision: invoice.revision, fields: { receipt_kind: 'invoice', invoice_number: 'F-2026-0412', expense_category: 'compras' } },
    { op: 'insert', table: 'invoices.invoice_files', id: uuid(), fields: { invoice_id: invoiceId, file_id: ticket.data.id, original_filename: 'factura-hielo.pdf' } },
  ] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  invoice = (await snapshot(finance, 'invoices.invoices')).find((i) => i.id === invoiceId);
  const validated = await app.call('/api/v1/commands', { body: { requestId: `cadena-${++seq}`, operations: [{ op: 'call', procedure: 'invoices.validate', args: { invoice_id: invoiceId, expectedRevision: invoice.revision } }] } });
  assert.equal(validated.status, 200, JSON.stringify(validated.data));

  [event] = eventResults(await sources());
  assert.deepEqual(event!.moves.map((m) => [m.kind, m.cents, !!m.process]), [['invoice', 2200, false]], 'ya es gasto del evento, no de proceso');
  const after = await fiscal();
  assert.deepEqual([Number(after.base), Number(after.vat), Number(after.invoices.validada)], [22, 2.2, 1], 'en Gestoría, con su IVA soportado');
  // Una factura validada no vuelve a ser ticket
  invoice = (await snapshot(finance, 'invoices.invoices')).find((i) => i.id === invoiceId);
  const back = await app.call('/api/v1/commands', { body: { requestId: `cadena-${++seq}`, operations: [{ op: 'update', table: 'invoices.invoices', id: invoiceId, expectedRevision: invoice.revision, fields: { receipt_kind: 'ticket' } }] } });
  assert.equal(back.status, 409, JSON.stringify(back.data));
});

// Lo que hará Tasks (decisión de Core, 27-10): al pasar la compra a «recibida» con su total y su ticket, invoca la capacidad
// `invoices.register_purchase_quick` con el token de la persona. Cuando exista, esta prueba deja de ser `todo`.
test('Tasks → Finance: al recibir la compra, Finance la tiene registrada (pendiente en Tasks)', { todo: 'Tasks invoca invoices.register_purchase_quick al marcar «recibida» (PETICIONES.md, 27-10)' }, async () => {
  const unit = uuid();
  const project = (await snapshot(flow, 'flow.projects')).find((p) => p.id === FLOW_PROJECT);
  if (project.tasks_project_id !== TASKS_PROJECT) await okCommit(flow, [{ op: 'update', table: 'flow.projects', id: FLOW_PROJECT, expectedRevision: project.revision, fields: { tasks_project_id: TASKS_PROJECT } }]);
  await okCommit(flow, [{ op: 'insert', table: 'flow.units', id: unit, fields: { project_id: FLOW_PROJECT, column_key: 'logistics', kind: 'task', label: 'Comprar limones' } }]);
  const asked = await flow(`units/${unit}/tasks`, { type: 'purchase' });
  let request = (await snapshot(tasks, 'tasks.purchase_requests')).find((r) => r.id === asked.data.link.id);
  for (const status of ['approved', 'purchased', 'received']) {
    await okCommit(tasks, [{ op: 'update', table: 'tasks.purchase_requests', id: request.id, expectedRevision: request.revision, fields: { status } }]);
    request = (await snapshot(tasks, 'tasks.purchase_requests')).find((r) => r.id === request.id);
  }
  const registered = (await snapshot(finance, 'invoices.invoices')).filter((i) => (i.notes ?? '').includes(request.id) || (i.object ?? '').includes('limones'));
  assert.equal(registered.length, 1, 'Finance registra la compra recibida en Tasks');
});

