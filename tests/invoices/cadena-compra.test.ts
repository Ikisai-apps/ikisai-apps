/**
 * QA de integración para el evento del 31-10 (encargo de Core): la cadena de compra de la barra de extremo a extremo,
 * con las Edges reales de Flow, Tasks y Finance sobre la misma base PGlite y la sesión de la misma persona.
 *
 * 1. Flow: una tarea de logística «Comprar hielo» → «Pedir a Tasks» (`POST units/:id/tasks`, `type: purchase`).
 * 2. Tasks: la solicitud de compra nace «pedida» (`requests/purchase`, procedencia `flow` + id de la unidad); se aprueba,
 *    se compra y se recibe.
 * 3. Tasks → Finance (#820): recibida con lo pagado, la tienda y «ticket», `POST purchases/:id/finance` de Tasks invoca
 *    `invoices.register_purchase_quick` por el catálogo con el token de la persona. Finance la registra con ticket, al
 *    destino general sin asignar, y la oficina la asigna al evento de Booking.
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
  // La clave de worker: Flow pide a Tasks desde su servidor (X-Ikisai-Worker-Key y X-Ikisai-Caller: flow; Tasks §45, #998).
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch, workerKey: 'clave-de-worker-de-prueba' };
  // Tasks llega a Finance por el catálogo (#820): aquí, directo a la Edge de Finance de la misma base.
  tasksHandler = createTasksApp({ ...base, origins: [TASKS_ORIGINS[0]!], capabilities: {
    apiBaseOf: () => 'https://invoices.test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://invoices.test')) return app.handler(new Request(url.replace('https://invoices.test', `${app.supabase.url}/functions/v1/invoices-api`), init));
      return app.supabase.fetch(input as never, init);
    }) as typeof fetch,
  } } as never) as unknown as Handler;
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

test('cadena de compra de la barra: Flow → Tasks → Finance → «Evento» y Gestoría', async () => {
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
  for (const status of ['approved', 'purchased']) {
    await okCommit(tasks, [{ op: 'update', table: 'tasks.purchase_requests', id: purchaseId, expectedRevision: request.revision, fields: { status } }]);
    request = (await snapshot(tasks, 'tasks.purchase_requests')).find((r) => r.id === purchaseId);
  }
  // Recibida con lo pagado (con IVA), la tienda y el ticket (sin foto: el número basta)
  await okCommit(tasks, [{ op: 'update', table: 'tasks.purchase_requests', id: purchaseId, expectedRevision: request.revision,
    fields: { status: 'received', paid_total: 24.2, supplier_name: 'Hielos del Sur', receipt_kind: 'ticket', invoice_number: 'T-881' } }]);

  // 3. Tasks → Finance (#820): con el token de la persona, por el catálogo
  const sent = await tasks(`purchases/${purchaseId}/finance`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.status, 'registered', JSON.stringify(sent.data));
  const invoiceId = sent.data.invoiceId as string;
  assert.equal(sent.data.url, `https://finance.ikisai.com/#/facturas/${invoiceId}`);
  request = (await snapshot(tasks, 'tasks.purchase_requests')).find((r) => r.id === purchaseId);
  assert.deepEqual([request.finance_status, request.finance_invoice_id], ['registered', invoiceId], 'Tasks guarda el enlace');
  // Repetir no duplica (idempotente por requestId)
  assert.equal((await tasks(`purchases/${purchaseId}/finance`, {})).data.invoiceId, invoiceId);
  let invoice = (await snapshot(finance, 'invoices.invoices')).find((i) => i.id === invoiceId);
  assert.ok(invoice.notes.includes(purchaseId), 'en las notas, el id de la solicitud de Tasks');
  assert.deepEqual([invoice.receipt_kind, invoice.invoice_number, Number(invoice.source_total)], ['ticket', 'T-881', 24.2]);
  assert.equal((await snapshot(finance, 'invoices.invoices')).filter((i) => !i.deleted_at).length, 1);
  // La oficina la asigna al evento de Booking (llega «sin asignar»)
  const line = (await snapshot(finance, 'invoices.invoice_lines')).find((l) => l.invoice_id === invoiceId);
  const allocation = (await snapshot(finance, 'invoices.allocations')).find((x) => x.invoice_line_id === line.id);
  assert.deepEqual([allocation.target_app, allocation.target_kind], ['general', 'unassigned']);
  const assigned = await app.call('/api/v1/commands', { body: { requestId: `cadena-${++seq}`, operations: [
    { op: 'update', table: 'invoices.allocations', id: allocation.id, expectedRevision: allocation.revision, fields: { target_app: 'booking', target_kind: 'event', target_id: EVENT, target_label: 'Evento' } },
  ] } });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));

  // 4. «Evento»: gasto de proceso, marcado; Gestoría: fuera (un ticket no es deducible)
  const sources = async () => ({
    entries: [], allocations: await snapshot(finance, 'invoices.allocations'), lines: await snapshot(finance, 'invoices.invoice_lines'),
    invoices: await snapshot(finance, 'invoices.invoices'), issuedAllocations: [], issued: [],
  });
  let [event] = eventResults(await sources());
  assert.equal(event!.eventId, EVENT);
  // Tasks no manda el tipo de IVA: con ticket, la línea va por el total
  assert.deepEqual(event!.moves.map((m) => [m.kind, m.cents, !!m.process]), [['invoice', 2420, true]]);
  assert.equal(event!.resultCents, -2420);
  const fiscal = async () => (await app.t.db.query<{ s: any }>(`select invoices.fiscal_summary_for('2026-10-01', '2026-12-31') s`)).rows[0]!.s;
  assert.equal(Number((await fiscal()).base), 0, 'el ticket no entra en Gestoría');

  // Llega la factura: pasa a factura (con el documento y la categoría), se valida y entra en Gestoría con su IVA
  const bytes = new TextEncoder().encode('%PDF factura del hielo');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await finance('uploads', { filename: 'factura-hielo.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha });
  app.supabase.storage.set(ticket.data.path, bytes);
  await finance(`uploads/${ticket.data.id}/verify`, {});
  invoice = (await snapshot(finance, 'invoices.invoices')).find((i) => i.id === invoiceId);
  const lineNow = (await snapshot(finance, 'invoices.invoice_lines')).find((l) => l.id === line.id);
  const allocationNow = (await snapshot(finance, 'invoices.allocations')).find((x) => x.id === allocation.id);
  const res = await app.call('/api/v1/commands', { body: { requestId: `cadena-${++seq}`, operations: [
    { op: 'update', table: 'invoices.invoices', id: invoiceId, expectedRevision: invoice.revision, fields: { receipt_kind: 'invoice', invoice_number: 'F-2026-0412', expense_category: 'compras' } },
    { op: 'insert', table: 'invoices.invoice_files', id: uuid(), fields: { invoice_id: invoiceId, file_id: ticket.data.id, original_filename: 'factura-hielo.pdf' } },
    // La factura desglosa el IVA del 10 %: base 22, cuota 2,20; lo asignado al evento, la base
    { op: 'update', table: 'invoices.invoice_lines', id: lineNow.id, expectedRevision: lineNow.revision, fields: { net_amount: 22, vat_rate: 10, vat_amount: 2.2 } },
    { op: 'insert', table: 'invoices.tax_lines', id: uuid(), fields: { invoice_id: invoiceId, position: 0, tax_type: 'iva', rate: 10, taxable_base: 22, amount: 2.2 } },
    { op: 'update', table: 'invoices.allocations', id: allocationNow.id, expectedRevision: allocationNow.revision, fields: { allocated_amount: 22 } },
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
