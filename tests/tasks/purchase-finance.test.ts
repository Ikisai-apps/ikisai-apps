/**
 * Tasks · la compra recibida se registra en Finance (`POST purchases/:id/finance`, migración 0346, docs/tasks/API.md §44),
 * con las dos Edges reales sobre la misma base, como hace Finance en sus pruebas: la de Tasks invoca la capacidad
 * `invoices.register_purchase_quick` con el token de la persona y sube la foto del justificante a Finance de servidor a
 * servidor. Sin acceso a Finance queda «pendiente» y no se bloquea nada; con acceso, se registra una vez. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createInvoicesApp } from '../../supabase/functions/invoices-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const FINANCE = 'https://invoices.test';
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid(), BARRA = uuid(), HIELO = uuid(), VASOS = uuid();
let app: TestApp;
let invoices: ((request: Request) => Promise<Response>) | null = null;
let lastPath = '';
let seq = 0;

const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `seed-${++seq}`, operations } });
const register = (id: string, token?: string) => app.call(`/api/v1/purchases/${id}/finance`, { token, body: {} });
const purchase = async (id: string) => (await app.t.db.query<any>(`select * from tasks.purchase_requests where id = $1`, [id])).rows[0];
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Hacia Finance (su Edge real) o, la subida firmada, al almacenamiento del arnés. */
async function transport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(FINANCE)) {
    const res = await invoices!(new Request('https://x/invoices-api' + url.slice(FINANCE.length), { method: init?.method, headers: init?.headers, body: init?.body }));
    if (url.endsWith('/api/v1/uploads')) { const out = await res.clone().json() as any; lastPath = out.path ?? ''; }
    return res;
  }
  if ((init?.method ?? 'GET') === 'PUT') { app.supabase.storage.set(lastPath, new Uint8Array(init!.body as Uint8Array)); return new Response(null, { status: 200 }); }
  return app.supabase.fetch(input as any, init);
}

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin], capabilities: { apiBaseOf: () => FINANCE, fetch: transport as typeof fetch } }) });
  invoices = createInvoicesApp({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch, drive: { api: null } } as any) as any;
  await commit(createTabOps({ id: TAB, name: 'Eventos', position: 1024, inboxId: INBOX }));
  await commit([{ op: 'insert', table: 'tasks.projects', id: BARRA, fields: { tab_id: TAB, title: 'Barra de prueba', position: 2048 } }]);
  // Dos compras ya recibidas (el camino de estados lo prueban las de compras); una con foto de la factura.
  for (const [id, title] of [[HIELO, 'Hielo para la barra'], [VASOS, 'Vasos de prueba']] as const) {
    await app.t.db.query(`insert into tasks.purchase_requests (id, tab_id, project_id, title, status, position, supplier_name) values ($1, $2, $3, $4, 'requested', 1024, 'Hielos de prueba')`, [id, TAB, BARRA, title]);
    await app.t.db.query(`update tasks.purchase_requests set status = 'received' where id = $1`, [id]);
  }
  const bytes = new TextEncoder().encode('%PDF-1.4 factura del hielo de prueba');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'factura.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: await sha256(bytes) } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} })).data.verified, true);
  await app.t.db.query(`update tasks.purchase_requests set paid_total = 36.30, receipt_kind = 'invoice', invoice_number = 'F-0042', receipt_file_id = $2 where id = $1`, [HIELO, ticket.data.id]);
});
test.after(async () => { await app.close(); });

test('sin acceso a Finance: queda pendiente de registrar, sin bloquear nada', async () => {
  const res = await register(HIELO);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'needs_access');
  assert.equal((await purchase(HIELO)).finance_status, 'needs_access');
  assert.equal((await purchase(HIELO)).status, 'received', 'la compra sigue recibida');
});

test('con acceso: se registra una vez, con su foto subida a Finance, y la compra guarda la factura y su código', async () => {
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'editor') on conflict (app, user_id) do update set role = 'editor'`, [app.users.owner]);
  const res = await register(HIELO);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'registered', JSON.stringify(res.data));
  assert.equal(res.data.nature, 'fiscal', 'factura con su documento');
  assert.equal(res.data.url, `https://finance.ikisai.com/#/facturas/${res.data.invoiceId}`);
  const row = await purchase(HIELO);
  assert.deepEqual([row.finance_status, row.finance_invoice_id, row.finance_code], ['registered', res.data.invoiceId, res.data.code]);
  const invoice = (await app.t.db.query<any>(`select * from invoices.invoices where id = $1`, [res.data.invoiceId])).rows[0];
  assert.equal(invoice.object, 'Hielo para la barra');
  assert.equal(Number(invoice.source_total), 36.3);
  assert.ok(String(invoice.notes ?? '').includes(HIELO), 'las notas llevan el id de la solicitud');
  const files = (await app.t.db.query<{ n: number }>(`select count(*)::int n from core.files where app = 'invoices' and status = 'verified'`)).rows[0]!.n;
  assert.ok(files >= 1, 'la foto está en Finance');

  // Repetir no duplica.
  const again = await register(HIELO);
  assert.deepEqual([again.data.status, again.data.invoiceId], ['registered', res.data.invoiceId]);
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from invoices.invoices where object = 'Hielo para la barra'`)).rows[0]!.n, 1);
});

test('sin lo pagado no se registra; quien solo lee no puede; una ajena no existe', async () => {
  const bare = await register(VASOS);
  assert.equal(bare.status, 422, JSON.stringify(bare.data));
  assert.equal(bare.data.error.code, 'NOT_READY');
  assert.equal((await register(HIELO, app.tokens.reader)).status, 403);
  assert.equal((await register(uuid())).status, 404);
  // Sin foto y como ticket: se registra igual (de proceso).
  await app.t.db.query(`update tasks.purchase_requests set paid_total = 12.5, receipt_kind = 'ticket' where id = $1`, [VASOS]);
  const ticket = await register(VASOS);
  assert.equal(ticket.data.status, 'registered', JSON.stringify(ticket.data));
  assert.equal(ticket.data.nature, 'process');
});

test('el resultado de Finance no lo fija la app, y el justificante tiene que ser un archivo propio', async () => {
  const row = await purchase(VASOS);
  const spoof = await commit([{ op: 'update', table: 'tasks.purchase_requests', id: VASOS, expectedRevision: Number(row.revision), fields: { finance_status: 'registered' } }]);
  assert.equal(spoof.status, 422, JSON.stringify(spoof.data));
  // Un archivo que subió otra persona no se puede poner como justificante (no se manda a Finance lo ajeno).
  const bytes = new TextEncoder().encode('%PDF-1.4 documento de otra persona');
  const ticket = await app.call('/api/v1/uploads', { token: app.tokens.editor, body: { filename: 'otro.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: await sha256(bytes) } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { token: app.tokens.editor, body: {} });
  const now = await purchase(VASOS);
  const foreign = await commit([{ op: 'update', table: 'tasks.purchase_requests', id: VASOS, expectedRevision: Number(now.revision), fields: { receipt_file_id: ticket.data.id } }]);
  assert.equal(foreign.status, 422, JSON.stringify(foreign.data));
});
