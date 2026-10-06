/**
 * Invoices · Edge `invoices-api`: beforeCommit (campos, documentos desde core.files, destinos tipados con el token
 * del usuario, importación), rutas propias (dashboard, imports/preview, targets, entregas: manifest, CSV y ZIP).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { collectStream, zipEntryNames, zipStream } from '../../supabase/functions/invoices-api/zip.ts';
import { CSV_BOM, type ImportDocument } from '../../packages/domain-invoices/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE: ImportDocument = JSON.parse(fs.readFileSync(path.join(here, '../core/fixtures/invoice-import-v1.example.json'), 'utf8'));

const uuid = () => crypto.randomUUID();
const TAB = uuid(); const PROJECT = uuid(); const TASK = uuid(); const ARCHIVED_PROJECT = uuid(); const DELETED_TASK = uuid(); const FORBIDDEN_PROJECT = uuid();
let app: TestApp;
let counter = 0;
let tasksDown = false;
const tasksCalls: Array<{ auth: string | null; body: any }> = [];

/** API de Tareas simulada: `POST /api/v1/read/tasks.targets` con el bearer del usuario. */
const tasksFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (tasksDown) throw new TypeError('tasks offline');
  const headers = new Headers(init?.headers as HeadersInit);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  tasksCalls.push({ auth: headers.get('authorization'), body });
  if (!url.endsWith('/api/v1/read/tasks.targets')) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  if (!headers.get('authorization')?.startsWith('Bearer ')) return Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
  const tree = {
    tabs: [{ id: TAB, name: 'Cocina', revision: 2, deleted: false, projects: [
      { id: PROJECT, title: 'Huerto', status: 'active', revision: 5, deleted: false, tasks: [{ id: TASK, title: 'Comprar semillas', done: false, revision: 1, deleted: false }] },
      { id: ARCHIVED_PROJECT, title: 'Antiguo', status: 'archived', revision: 1, deleted: false, tasks: [] },
    ] }],
  };
  if (body.kind) {
    if (body.id === FORBIDDEN_PROJECT) return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
    if (body.kind === 'tab' && body.id === TAB) return Response.json({ kind: 'tab', id: TAB, tabId: TAB, projectId: null, title: 'Cocina', revision: 2, deleted: false, archived: false });
    if (body.kind === 'project' && body.id === PROJECT) return Response.json({ kind: 'project', id: PROJECT, tabId: TAB, projectId: PROJECT, title: 'Huerto', revision: 5, deleted: false, archived: false });
    if (body.kind === 'task' && body.id === TASK) return Response.json({ kind: 'task', id: TASK, tabId: TAB, projectId: PROJECT, title: 'Comprar semillas', revision: 1, deleted: false, archived: false, done: false });
    if (body.kind === 'task' && body.id === DELETED_TASK) return Response.json({ kind: 'task', id: DELETED_TASK, tabId: TAB, projectId: PROJECT, title: 'Borrada', revision: 3, deleted: true, archived: false });
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
  return Response.json(tree);
};

const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { body: { requestId: `api-${++counter}`, operations }, ...(token ? { token } : {}) });
}
async function ok(operations: unknown[], token?: string) {
  const res = await commit(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rejected(operations: unknown[], code: string, status = 422) {
  const res = await commit(operations);
  assert.equal(res.status, status, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}
async function row(table: string, id: string): Promise<Record<string, any>> {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1`);
  const found = (snap.data.tables[0].rows as Array<Record<string, any>>).find((r) => r.id === id);
  assert.ok(found, `fila ${id} en ${table}`);
  return found;
}
async function uploadFile(content: string, filename = 'scan.pdf', mime = 'application/pdf') {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename, mime, size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  const verified = await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return { id: ticket.data.id as string, sha, size: bytes.byteLength, path: ticket.data.path as string };
}

let supplier: string;
let invoice: { id: string; line: string };

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], tasksApiBase: 'https://tasks.test', tasksFetch }),
  });
  supplier = uuid();
  await ok([insert('invoices.suppliers', supplier, { name: 'Makro', tax_id: 'A28647451', default_category: 'compras' })]);
  const id = uuid(); const line = uuid(); const tax = uuid();
  await ok([
    insert('invoices.invoices', id, { supplier_id: supplier, invoice_date: '2026-10-05', object: 'alimentos retiro yoga', invoice_number: 'A-1', expense_category: 'compras', source_total: 44 }),
    insert('invoices.invoice_lines', line, { invoice_id: id, position: 0, description: 'Tomate', quantity: 20, unit: 'kg', unit_price: 2, net_amount: 40, vat_rate: 10, vat_amount: 4 }),
    insert('invoices.tax_lines', tax, { invoice_id: id, position: 0, tax_type: 'iva', rate: 10, taxable_base: 40, amount: 4 }),
  ]);
  invoice = { id, line };
});
test.after(async () => { await app.close(); });

test('beforeCommit: campos desconocidos, listas cerradas, import_meta reservado y borrado de facturas', async () => {
  assert.equal((await rejected([insert('invoices.invoices', uuid(), { supplier_id: supplier, invoice_date: '2026-10-05', object: 'x', foo: 1 })], 'INVALID_FIELDS')).details.field, 'foo');
  await rejected([insert('invoices.invoices', uuid(), { supplier_id: supplier, invoice_date: '05/10/2026', object: 'x' })], 'INVALID_FIELDS');
  await rejected([insert('invoices.invoices', uuid(), { supplier_id: supplier, invoice_date: '2026-10-05', object: 'x', expense_category: 'viajes' })], 'INVALID_FIELDS');
  await rejected([insert('invoices.invoices', uuid(), { supplier_id: supplier, invoice_date: '2026-10-05', object: 'x', currency: 'USD' })], 'UNSUPPORTED_IN_V1');
  const inv = await row('invoices.invoices', invoice.id);
  await rejected([update('invoices.invoices', invoice.id, inv.revision, { import_meta: { a: 1 } })], 'INVALID_FIELDS');
  await rejected([update('invoices.invoices', invoice.id, inv.revision, { status: 'validada' })], 'INVALID_TRANSITION');
  await rejected([update('invoices.invoices', invoice.id, inv.revision, { payment_status: 'pagada', paid_at: null })], 'PAID_AT_REQUIRED');
  await rejected([{ op: 'delete', table: 'invoices.invoices', id: invoice.id, expectedRevision: inv.revision }], 'INVOICE_NOT_DELETABLE');
  await rejected([insert('invoices.exports', uuid(), { status: 'generada' })], 'INVALID_OPERATION');
  await rejected([insert('invoices.export_items', uuid(), {})], 'INVALID_OPERATION');
});

test('beforeCommit: documentos se comprueban en core.files y el servidor fija mime, tamaño y hash', async () => {
  const file = await uploadFile('%PDF prueba edge');
  const rowId = uuid();
  const res = await ok([insert('invoices.invoice_files', rowId, { invoice_id: invoice.id, file_id: file.id, original_filename: 'scan.pdf', mime_type: 'image/png', size_bytes: 1, sha256: 'f'.repeat(64) })]);
  const after = res.changes.find((c: any) => c.table === 'invoices.invoice_files' && c.id === rowId).after;
  assert.equal(after.mime_type, 'application/pdf'); assert.equal(Number(after.size_bytes), file.size); assert.equal(after.sha256, file.sha);
  assert.equal(after.normalized_filename, '2026_10_05_(makro)_alimentos_retiro_yoga.pdf');
  await rejected([insert('invoices.invoice_files', uuid(), { invoice_id: invoice.id, file_id: uuid(), original_filename: 'x.pdf' })], 'INVALID_FILE');
  await rejected([insert('invoices.invoice_files', uuid(), { invoice_id: invoice.id, file_id: { $blob: 'a'.repeat(64) }, original_filename: 'x.pdf' })], 'INVALID_FIELDS');
  const pending = await app.call('/api/v1/uploads', { body: { filename: 'p.pdf', mime: 'application/pdf', size: 3, sha256: 'b'.repeat(64) } });
  await rejected([insert('invoices.invoice_files', uuid(), { invoice_id: invoice.id, file_id: pending.data.id, original_filename: 'p.pdf' })], 'INVALID_FILE');
});

test('beforeCommit: destinos de Tareas con el token del usuario (etiqueta, revisión, 404, 403, caída) y pares inválidos', async () => {
  tasksCalls.length = 0;
  const a = uuid();
  const res = await ok([insert('invoices.allocations', a, { invoice_line_id: invoice.line, target_app: 'tasks', target_kind: 'project', target_id: PROJECT, target_label: 'lo que diga el cliente', allocated_amount: 10 })]);
  const after = res.changes.find((c: any) => c.id === a).after;
  assert.equal(after.target_label, 'Huerto'); assert.equal(after.target_revision, 5); assert.equal(after.target_id, PROJECT);
  assert.ok(tasksCalls[0]!.auth === 'Bearer ' + app.tokens.owner, 'la Edge reenvía el bearer del usuario');
  assert.deepEqual(tasksCalls[0]!.body, { kind: 'project', id: PROJECT });
  const t = uuid();
  const res2 = await ok([insert('invoices.allocations', t, { invoice_line_id: invoice.line, target_app: 'tasks', target_kind: 'task', target_id: TASK, target_label: 'x', allocated_amount: 5 })]);
  assert.equal(res2.changes.find((c: any) => c.id === t).after.target_label, 'Comprar semillas');
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'tasks', target_kind: 'task', target_id: DELETED_TASK, target_label: 'x', allocated_amount: 1 })], 'TARGET_NOT_FOUND');
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'tasks', target_kind: 'project', target_id: uuid(), target_label: 'x', allocated_amount: 1 })], 'TARGET_NOT_FOUND');
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'tasks', target_kind: 'project', target_id: FORBIDDEN_PROJECT, target_label: 'x', allocated_amount: 1 })], 'TARGET_FORBIDDEN');
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'tasks', target_kind: 'event', target_id: PROJECT, target_label: 'x', allocated_amount: 1 })], 'INVALID_FIELDS');
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'general', target_kind: 'unassigned', target_id: 'x', target_label: 'x', allocated_amount: 1 })], 'INVALID_FIELDS');
  tasksDown = true;
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'tasks', target_kind: 'project', target_id: PROJECT, target_label: 'x', allocated_amount: 1 })], 'TARGET_UNAVAILABLE', 503);
  tasksDown = false;
  // general no consulta a nadie
  const before = tasksCalls.length;
  await ok([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'general', target_kind: 'investment', target_label: 'Inversión', allocated_amount: 5 })]);
  assert.equal(tasksCalls.length, before);
  // sobreasignación la para el hook SQL (10 + 5 + 5 = 20 de 40; 25 más excede)
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'general', target_kind: 'unassigned', target_label: 'Sin asignar', allocated_amount: 25 })], 'ALLOCATIONS_EXCEED_LINE');
});

test('beforeCommit: destinos de Food y Booking por proyección registrada (ids desconocidos → TARGET_NOT_FOUND)', async () => {
  const ingredient = uuid(); const equipment = uuid();
  await app.t.db.query(`insert into food.ingredients (id, name, preferred_unit) values ($1, 'Tomate pera', 'kg')`, [ingredient]);
  await app.t.db.query(`insert into food.equipment (id, name, quantity) values ($1, 'Horno 1', 1)`, [equipment]);
  const a = uuid();
  const res = await ok([insert('invoices.allocations', a, { invoice_line_id: invoice.line, target_app: 'food', target_kind: 'ingredient', target_id: ingredient, target_label: 'x', allocated_amount: 2, allocated_quantity: 1 })]);
  assert.equal(res.changes.find((c: any) => c.id === a).after.target_label, 'Ingredientes › Tomate pera');
  const e = uuid();
  const res2 = await ok([insert('invoices.allocations', e, { invoice_line_id: invoice.line, target_app: 'food', target_kind: 'equipment', target_id: equipment, target_label: 'x', allocated_amount: 1 })]);
  assert.equal(res2.changes.find((c: any) => c.id === e).after.target_label, 'Maquinaria › Horno 1');
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'food', target_kind: 'ingredient', target_id: uuid(), target_label: 'x', allocated_amount: 1 })], 'TARGET_NOT_FOUND');
  // Booking publica booking.food_event_projection para invoices (migración 0402): la proyección existe y el id no.
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: invoice.line, target_app: 'booking', target_kind: 'event', target_id: uuid(), target_label: 'x', allocated_amount: 1 })], 'TARGET_NOT_FOUND');
  const list = await app.call('/api/v1/targets/food?q=tom');
  assert.equal(list.status, 200); assert.equal(list.data.items.length, 1); assert.equal(list.data.items[0].kind, 'ingredient');
  const one = await app.call(`/api/v1/targets/food/equipment/${equipment}`);
  assert.equal(one.data.label, 'Horno 1');
  const bookingTargets = await app.call('/api/v1/targets/booking?q=');
  assert.equal(bookingTargets.status, 200, JSON.stringify(bookingTargets.data)); assert.deepEqual(bookingTargets.data.items, []);
});

test('rutas: targets/tasks busca Área → Proyecto → Tarea; reader no busca; dashboard', async () => {
  const all = await app.call('/api/v1/targets/tasks?q=');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.items.map((i: any) => `${i.kind}:${i.label}`), ['area:Cocina', 'task:Comprar semillas', 'project:Huerto']);
  const archived = await app.call('/api/v1/targets/tasks?q=antiguo');
  assert.equal(archived.data.items.length, 1); assert.equal(archived.data.items[0].archived, true);
  const tasksOnly = await app.call('/api/v1/targets/tasks?q=&kind=task');
  assert.deepEqual(tasksOnly.data.items[0].path, ['Cocina', 'Huerto']);
  assert.equal((await app.call('/api/v1/targets/tasks?q=&kind=foo')).status, 422);
  assert.equal((await app.call('/api/v1/targets/tasks?q=', { token: app.tokens.reader })).status, 403);
  const one = await app.call(`/api/v1/targets/tasks/project/${PROJECT}`, { token: app.tokens.reader });
  assert.equal(one.status, 200); assert.equal(one.data.label, 'Huerto');
  const dash = await app.call('/api/v1/dashboard');
  assert.equal(dash.status, 200, JSON.stringify(dash.data));
  assert.equal(dash.data.counts.pendiente_revision, 1); assert.ok(dash.data.current_period.range);
});

test('rutas: imports/preview valida, empareja proveedor, detecta duplicados y recalcula sin escribir', async () => {
  const bad = await app.call('/api/v1/imports/preview', { body: { document: { schema_version: 'v1' } } });
  assert.equal(bad.status, 200); assert.equal(bad.data.valid, false); assert.ok(bad.data.errors.length);
  const preview = await app.call('/api/v1/imports/preview', { body: { document: { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, supplier_name: 'MAKRO ESPAÑA', supplier_tax_id: 'A-28647451' } } } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.valid, true); assert.equal(preview.data.supplier_matches[0].id, supplier); assert.equal(preview.data.supplier_matches[0].by, 'tax_id');
  assert.equal(preview.data.proposed.expense_category, 'compras'); assert.equal(preview.data.recalculation.within_tolerance, true); assert.equal(preview.data.duplicate, null);
  assert.equal(preview.data.normalized_filename_preview, '2026_10_05_(makro)_alimentos_retiro_ejemplo.pdf');
  const dup = await app.call('/api/v1/imports/preview', { body: { document: { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, supplier_tax_id: 'A28647451', invoice_number: 'a-1' } } } });
  assert.equal(dup.data.duplicate.invoice_id, invoice.id); assert.equal(dup.data.duplicate.kind, 'invoice');
  assert.equal((await app.call('/api/v1/imports/preview', { token: app.tokens.reader, body: { document: EXAMPLE } })).status, 403);
  // imports/extract sin helper → 503 EXTRACTION_UNAVAILABLE (el cliente ofrece pegar el JSON); con ids inválidos → 422
  const noHelper = await app.call('/api/v1/imports/extract', { body: { file_ids: [uuid()] } });
  assert.equal(noHelper.status, 503); assert.equal(noHelper.data.error.code, 'EXTRACTION_UNAVAILABLE');
  assert.equal((await app.call('/api/v1/imports/extract', { body: { file_ids: [] } })).status, 422);
  assert.equal((await app.call('/api/v1/imports/extract', { token: app.tokens.reader, body: { file_ids: [uuid()] } })).status, 403);
  // call import_v1 con documento inválido o archivo sin verificar → antes de SQL
  const e = await rejected([call('invoices.import_v1', { document: { ...EXAMPLE, lines: [] }, document_sha256: 'a'.repeat(64), invoice_id: uuid(), ids: {}, supplier: { mode: 'existing', id: supplier } })], 'IMPORT_INVALID');
  assert.ok(e.details.errors.some((x: any) => x.path === '$.lines'));
  await rejected([call('invoices.import_v1', { document: EXAMPLE, document_sha256: 'a'.repeat(64), invoice_id: uuid(), ids: {}, supplier: { mode: 'existing', id: supplier }, files: [{ file_id: uuid(), original_filename: 'x.pdf', page_order: 1 }] })], 'INVALID_FILE');
});

test('entregas: vista previa, ZIP en streaming con manifest, CSV y documentos; CSV sueltos; manifest byte a byte', async () => {
  // Validar la factura (tiene documento) y crear la entrega del T4
  const inv = await row('invoices.invoices', invoice.id);
  await ok([call('invoices.validate', { invoice_id: invoice.id, expectedRevision: inv.revision })]);
  const preview = await app.call('/api/v1/exports/accountant', { body: { period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 4 } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data)); assert.equal(preview.data.invoice_count, 1); assert.equal(preview.data.folder_name, 'IKISAI_COMPRAS_2026_T4');
  const exportId = uuid();
  const created = await ok([call('invoices.create_export', { export_id: exportId, period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 4 })]);
  const sha = created.results[0].result.manifest_sha256;

  const manifest = await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/manifest.json`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.reader } }));
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-disposition') ?? '', /IKISAI_COMPRAS_2026_T4_manifest\.json/);
  const text = await manifest.text();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(digest, sha, 'manifest.json se sirve exactamente como se hasheó');

  const csv = await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/facturas_recibidas.csv`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.owner } }));
  // Response.text() quita el BOM al decodificar; se comprueba sobre los bytes.
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 con BOM para Excel');
  const csvText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes);
  assert.ok(csvText.startsWith(CSV_BOM + 'codigo;fecha;proveedor'));
  assert.ok(csvText.includes(';Makro;A28647451;A-1;alimentos retiro yoga;compras;no;pendiente_revision;40,00;4,00;0,00;0,00;44,00;44,00;0,00;validada;pendiente;;;2026_10_05_(makro)_alimentos_retiro_yoga.pdf'), csvText);
  const lines = await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/lineas_compra.csv`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.owner } }));
  const linesText = await lines.text();
  assert.ok(linesText.includes('Tomate;;20;kg;2,00;0,00;40,00;10;4,00;;compras;no;tasks/project: Huerto (10,00) | tasks/task: Comprar semillas (5,00) | general/investment: Inversión (5,00) | food/ingredient: Ingredientes › Tomate pera (2,00) | food/equipment: Maquinaria › Horno 1 (1,00)'));
  assert.equal((await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/otro.csv`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.owner } }))).status, 404);

  const zip = await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/download`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.reader } }));
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.deepEqual(zipEntryNames(bytes), [
    'IKISAI_COMPRAS_2026_T4/manifest.json', 'IKISAI_COMPRAS_2026_T4/facturas_recibidas.csv', 'IKISAI_COMPRAS_2026_T4/lineas_compra.csv', 'IKISAI_COMPRAS_2026_T4/resumen_impuestos.csv',
    'IKISAI_COMPRAS_2026_T4/facturas/2026_10_05_(makro)_alimentos_retiro_yoga.pdf',
  ]);
  assert.ok(new TextDecoder().decode(bytes).includes('%PDF prueba edge'), 'el documento va dentro del ZIP');

  // Documento desaparecido del almacenamiento → 409 con el detalle
  const bundle = await app.call('/api/v1/read/invoices.export_bundle', { body: { export_id: exportId } });
  await app.t.db.query(`update core.files set status = 'missing' where id = $1`, [bundle.data.files[0].file_id]);
  const missing = await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/download`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.owner } }));
  assert.equal(missing.status, 409); assert.equal((await missing.json()).error.code, 'EXPORT_FILE_MISSING');
});

test('agentes: import_v1 seguro; facturas entregadas a gestoría o validadas exigen aprobación; asignar a una validada no', async () => {
  // Depende de «entregas»: `invoice` está validada y en la entrega GST del T4.
  const issued = await app.call('/api/v1/agents', { body: { name: 'Bot de facturas', role: 'editor' } });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  const agent = issued.data.token as string;
  const boot = await app.call('/api/v1/bootstrap', { token: agent });
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.data.agentPolicy.safeProcedures, ['invoices.import_v1']);

  // Factura pendiente: el agente la edita sin aprobación.
  const pending = uuid(); const pendingLine = uuid();
  await ok([
    insert('invoices.invoices', pending, { supplier_id: supplier, invoice_date: '2026-10-06', object: 'material limpieza', expense_category: 'compras' }),
    insert('invoices.invoice_lines', pendingLine, { invoice_id: pending, position: 0, description: 'Lejía', net_amount: 5, vat_rate: 21, vat_amount: 1.05 }),
  ]);
  const p = await row('invoices.invoices', pending);
  await ok([update('invoices.invoices', pending, p.revision, { notes: 'Pedido por correo' })], agent);

  // Validar sigue pidiendo aprobación (procedimiento no seguro).
  const p2 = await row('invoices.invoices', pending);
  const validate = await commit([call('invoices.validate', { invoice_id: pending, expectedRevision: p2.revision })], agent);
  assert.equal(validate.status, 428, JSON.stringify(validate.data)); assert.ok(validate.data.error.details.risk.reasons.includes('call:invoices.validate'));

  // Factura validada y entregada: tocarla (o una de sus filas) exige aprobación, con el código en el motivo.
  const inv = await row('invoices.invoices', invoice.id);
  const touched = await commit([update('invoices.invoices', invoice.id, inv.revision, { notes: 'Cambio de agente' })], agent);
  assert.equal(touched.status, 428, JSON.stringify(touched.data));
  assert.deepEqual(touched.data.error.details.risk.reasons, [`invoice:exported:${inv.code}`]);
  const line = await row('invoices.invoice_lines', invoice.line);
  const lineTouched = await commit([update('invoices.invoice_lines', invoice.line, line.revision, { description: 'Tomate rama' })], agent);
  assert.equal(lineTouched.status, 428); assert.deepEqual(lineTouched.data.error.details.risk.reasons, [`invoice:exported:${inv.code}`]);
  assert.equal((await row('invoices.invoices', invoice.id)).notes ?? null, inv.notes ?? null);

  // Con propuesta aprobada por un owner humano, el mismo lote pasa.
  const ops = [update('invoices.invoices', invoice.id, inv.revision, { notes: 'Cambio de agente' })];
  const proposal = await app.call('/api/v1/proposals', { token: agent, body: { requestId: 'inv-agent-1', operations: ops } });
  assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
  const approved = await app.call(`/api/v1/proposals/${proposal.data.id}/approve`, { body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const applied = await app.call('/api/v1/commands', { token: agent, body: { requestId: 'inv-agent-1', operations: ops, confirmationId: proposal.data.id } });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal((await row('invoices.invoices', invoice.id)).notes, 'Cambio de agente');

  // Validada sin entregar: cambiar datos exige aprobación; asignar un destino no.
  const v = uuid(); const vLine = uuid();
  const doc = await uploadFile('%PDF agente');
  await ok([
    insert('invoices.invoices', v, { supplier_id: supplier, invoice_date: '2026-11-02', object: 'fruta', expense_category: 'compras', source_total: 11 }),
    insert('invoices.invoice_lines', vLine, { invoice_id: v, position: 0, description: 'Manzana', net_amount: 10, vat_rate: 10, vat_amount: 1 }),
    insert('invoices.tax_lines', uuid(), { invoice_id: v, position: 0, tax_type: 'iva', rate: 10, taxable_base: 10, amount: 1 }),
    insert('invoices.invoice_files', uuid(), { invoice_id: v, file_id: doc.id, original_filename: 'fruta.pdf', page_order: 1, kind: 'original' }),
  ]);
  await ok([call('invoices.validate', { invoice_id: v, expectedRevision: (await row('invoices.invoices', v)).revision })]);
  const vr = await row('invoices.invoices', v);
  assert.equal(vr.status, 'validada');
  const edit = await commit([update('invoices.invoices', v, vr.revision, { object: 'fruta variada' })], agent);
  assert.equal(edit.status, 428); assert.deepEqual(edit.data.error.details.risk.reasons, [`invoice:validada:${vr.code}`]);
  await ok([insert('invoices.allocations', uuid(), { invoice_line_id: vLine, target_app: 'general', target_kind: 'operating_expense', target_label: 'Gasto de explotación', allocated_amount: 10 })], agent);

  // Emitidas (registro fiscal): cualquier cambio de un agente pide aprobación.
  const issuedByAgent = await commit([insert('invoices.issued_series', uuid(), { code: 'B' })], agent);
  assert.equal(issuedByAgent.status, 428); assert.deepEqual(issuedByAgent.data.error.details.risk.reasons, ['issued:insert:issued_series']);

  // Diez filas en un lote: umbral del usuario (10 elementos).
  const bulk = await commit(Array.from({ length: 10 }, (_, i) => insert('invoices.suppliers', uuid(), { name: `Proveedor ${i}` })), agent);
  assert.equal(bulk.status, 428); assert.equal(bulk.data.error.details.risk.bulk, true);
});

test('MCP: importar desde JSON (idempotente, duplicados, JSON inválido), compras y resumen fiscal; el lector no importa', async () => {
  let seq = 0;
  const rpc = (method: string, params: unknown, token?: string) => app.call('/api/v1/mcp', { ...(token ? { token } : {}), body: { jsonrpc: '2.0', id: ++seq, method, params } });
  const tool = async (name: string, args: Record<string, unknown>, token?: string) => (await rpc('tools/call', { name, arguments: args }, token)).data.result;
  const agent = (await app.call('/api/v1/agents', { body: { name: 'Bot MCP facturas', role: 'editor' } })).data.token as string;
  const names = async (token: string) => ((await rpc('tools/list', {}, token)).data.result.tools as Array<{ name: string }>).map((t) => t.name);
  const readerTools = await names(app.tokens.reader);
  assert.ok(readerTools.includes('invoices_purchases') && readerTools.includes('invoices_fiscal_summary')); assert.ok(!readerTools.includes('invoices_import_json'));
  assert.ok((await names(agent)).includes('invoices_import_json'));

  const doc = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'MCP-1', supplier_tax_id: 'B12345678', supplier_name: 'Huerta MCP SL' } };
  const first = await tool('invoices_import_json', { document: doc }, agent);
  assert.equal(first.isError, undefined, JSON.stringify(first));
  const out = first.structuredContent;
  assert.equal(out.status, 'pendiente_revision'); assert.match(out.code, /^FVR_2026_\d{3}$/); assert.equal(out.supplier.mode, 'create'); assert.equal(out.recalculation.within_tolerance, true);
  const created = await row('invoices.invoices', out.invoice_id);
  assert.equal(created.source, 'import_v1'); assert.equal(created.review_reason, 'IMPORTADA');
  assert.equal((await row('invoices.suppliers', out.supplier.id)).tax_id, 'B12345678');
  // Reintento: misma factura, sin duplicar
  const again = await tool('invoices_import_json', { document: doc }, agent);
  assert.equal(again.structuredContent.replayed, true); assert.equal(again.structuredContent.invoice_id, out.invoice_id);
  // Mismo proveedor y número con otro JSON → duplicado; JSON roto → IMPORT_INVALID
  const dup = await tool('invoices_import_json', { document: { ...doc, extraction_notes: 'otra lectura' } }, agent);
  assert.equal(dup.isError, true); assert.equal(dup.structuredContent.error.code, 'DUPLICATE_INVOICE');
  const bad = await tool('invoices_import_json', { document: { schema_version: 'v0' } }, agent);
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.error.code, 'IMPORT_INVALID');
  // Proveedor existente por NIF: la segunda factura de la huerta se empareja
  const second = await tool('invoices_import_json', { document: { ...doc, invoice: { ...doc.invoice, invoice_number: 'MCP-2' } } }, agent);
  assert.equal(second.structuredContent.supplier.mode, 'existing'); assert.equal(second.structuredContent.supplier.id, out.supplier.id);

  const purchases = await tool('invoices_purchases', { year: 2026, quarter: 4, validated_only: false }, app.tokens.reader);
  assert.equal(purchases.isError, undefined, JSON.stringify(purchases));
  assert.ok(purchases.structuredContent.rows.some((r: any) => r.invoice_id === out.invoice_id || r.invoice?.id === out.invoice_id || r.code === out.code || JSON.stringify(r).includes(out.invoice_id)));
  const noPeriod = await tool('invoices_purchases', {}, app.tokens.reader);
  assert.equal(noPeriod.isError, true);
  const fiscal = await tool('invoices_fiscal_summary', { year: 2026, quarter: 4 }, app.tokens.reader);
  assert.equal(fiscal.isError, undefined, JSON.stringify(fiscal));
});

test('zip: escritor en streaming produce entradas legibles y CRC correcto', async () => {
  const bytes = await collectStream(zipStream([
    { name: 'a/hola.txt', data: new TextEncoder().encode('123456789'), modified: new Date('2026-10-06T10:00:00Z') },
    { name: 'a/vacio.txt', data: new Uint8Array(0) },
    { name: 'b.bin', data: new Blob([new Uint8Array([1, 2, 3, 4, 5])]).stream() },
  ]));
  assert.deepEqual(zipEntryNames(bytes), ['a/hola.txt', 'a/vacio.txt', 'b.bin']);
  // CRC32('123456789') = 0xcbf43926 (vector de referencia) en el descriptor de datos tras el contenido
  const view = new DataView(bytes.buffer);
  const descriptor = 30 + 'a/hola.txt'.length + 9;
  assert.equal(view.getUint32(descriptor, true), 0x08074b50);
  assert.equal(view.getUint32(descriptor + 4, true), 0xcbf43926);
  assert.equal(view.getUint32(descriptor + 8, true), 9);
});

test('imports/extract con helper: documento validado y hasheado; documento inválido → EXTRACTION_INVALID; archivo sin verificar → INVALID_FILE', async () => {
  let received: any = null;
  const extracting = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], tasksFetch, extractInvoice: async (args) => {
      received = { files: args.files.map((f) => ({ mime: f.mime, filename: f.filename })), promptStart: args.prompt.slice(0, 30), prose: args.prompt.includes('ANTES del JSON'), schemaType: (args.schema as { type?: string } | undefined)?.type, actor: args.ctx.user.id };
      if (args.files[0]!.filename === 'malo.pdf') return { document: { schema_version: 'v2' }, warnings: ['texto borroso'] };
      return { document: EXAMPLE, warnings: ['IVA deducido de la línea 1'], usage: { tokens: 1234 } };
    } }),
  });
  try {
    const bytes = new TextEncoder().encode('%PDF extraer');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ticket = await extracting.call('/api/v1/uploads', { body: { filename: 'factura.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
    extracting.supabase.storage.set(ticket.data.path, bytes);
    const pending = await extracting.call('/api/v1/imports/extract', { body: { file_ids: [ticket.data.id] } });
    assert.equal(pending.status, 422); assert.equal(pending.data.error.code, 'INVALID_FILE');
    await extracting.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
    const ok = await extracting.call('/api/v1/imports/extract', { body: { file_ids: [ticket.data.id] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.document.schema_version, 'ikisai.invoice.v1'); assert.match(ok.data.document_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(ok.data.warnings, ['IVA deducido de la línea 1']); assert.deepEqual(ok.data.usage, { tokens: 1234 });
    assert.deepEqual(received.files, [{ mime: 'application/pdf', filename: 'factura.pdf' }]); assert.ok(received.promptStart.startsWith('Lee la factura')); assert.equal(received.prose, false, 'la vía estructurada no pide prosa antes del JSON'); assert.equal(received.schemaType, 'object', 'el helper recibe el JSON Schema del handoff'); assert.equal(received.actor, extracting.users.owner);
    const bad = await extracting.call('/api/v1/uploads', { body: { filename: 'malo.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
    extracting.supabase.storage.set(bad.data.path, bytes);
    await extracting.call(`/api/v1/uploads/${bad.data.id}/verify`, { body: {} });
    const invalid = await extracting.call('/api/v1/imports/extract', { body: { file_ids: [bad.data.id] } });
    assert.equal(invalid.status, 422); assert.equal(invalid.data.error.code, 'EXTRACTION_INVALID'); assert.ok(invalid.data.error.details.errors.length); assert.equal(invalid.data.error.details.usage, null);

    // Registro: cada extracción deja su fila con el coste en la primera.
    const logged = await extracting.t.db.query<{ outcome: string; input_tokens: number | null }>(`select outcome, input_tokens from invoices.extractions where file_id = $1`, [ticket.data.id]);
    assert.deepEqual(logged.rows.map((r) => r.outcome), ['ok']);

    // Límite de los agentes: una extracción por documento; repetir exige propuesta aprobada. Las personas no tienen límite.
    const agent = (await extracting.call('/api/v1/agents', { body: { name: 'Bot extractor', role: 'editor' } })).data.token as string;
    const upload = async (name: string) => {
      const t = await extracting.call('/api/v1/uploads', { body: { filename: name, mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
      extracting.supabase.storage.set(t.data.path, bytes);
      await extracting.call(`/api/v1/uploads/${t.data.id}/verify`, { body: {} });
      return t.data.id as string;
    };
    const fresh = await upload('agente.pdf');
    assert.equal((await extracting.call('/api/v1/imports/extract', { token: agent, body: { file_ids: [fresh] } })).status, 200);
    const repeat = await extracting.call('/api/v1/imports/extract', { token: agent, body: { file_ids: [fresh] } });
    assert.equal(repeat.status, 428, JSON.stringify(repeat.data)); assert.equal(repeat.data.error.code, 'CONFIRMATION_REQUIRED');
    assert.deepEqual(repeat.data.error.details.risk.reasons, [`extract:repeat:${fresh}`]);
    // Un agente no escribe el registro directamente
    const direct = await extracting.call('/api/v1/commands', { token: agent, body: { requestId: 'x-direct', operations: [{ op: 'insert', table: 'invoices.extractions', id: uuid(), fields: { file_id: fresh, outcome: 'ok' } }] } });
    assert.equal(direct.status, 422);
    const ops = [{ op: 'insert', table: 'invoices.extractions', id: uuid(), fields: { file_id: fresh } }];
    const proposal = await extracting.call('/api/v1/proposals', { token: agent, body: { requestId: 'x-repeat', operations: ops } });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.data)); assert.deepEqual(proposal.data.risk.reasons, [`extract:repeat:${fresh}`]);
    const early = await extracting.call('/api/v1/imports/extract', { token: agent, body: { file_ids: [fresh], confirmationId: proposal.data.id } });
    assert.equal(early.status, 428, 'sin aprobar todavía');
    assert.equal((await extracting.call(`/api/v1/proposals/${proposal.data.id}/approve`, { body: {} })).status, 200);
    const allowed = await extracting.call('/api/v1/imports/extract', { token: agent, body: { file_ids: [fresh], confirmationId: proposal.data.id } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    const reused = await extracting.call('/api/v1/imports/extract', { token: agent, body: { file_ids: [fresh], confirmationId: proposal.data.id } });
    assert.equal(reused.status, 428, 'una propuesta se consume una vez');
    const rowsFresh = await extracting.t.db.query<{ outcome: string }>(`select outcome from invoices.extractions where file_id = $1 order by created_at`, [fresh]);
    assert.deepEqual(rowsFresh.rows.map((r) => r.outcome), ['ok', 'ok']);
    assert.equal((await extracting.call('/api/v1/imports/extract', { body: { file_ids: [fresh] } })).status, 200, 'una persona repite sin límite');

    // Documento de una factura que ya no está pendiente de datos → aprobación
    const other = await upload('revisada.pdf');
    const sup = uuid(); const inv = uuid();
    const made = await extracting.call('/api/v1/commands', { body: { requestId: 'x-inv', operations: [
      { op: 'insert', table: 'invoices.suppliers', id: sup, fields: { name: 'Revisada SL' } },
      { op: 'insert', table: 'invoices.invoices', id: inv, fields: { supplier_id: sup, invoice_date: '2026-10-06', object: 'revisada', expense_category: 'compras' } },
      { op: 'insert', table: 'invoices.invoice_files', id: uuid(), fields: { invoice_id: inv, file_id: other, original_filename: 'revisada.pdf', page_order: 1, kind: 'original' } },
      { op: 'insert', table: 'invoices.invoice_lines', id: uuid(), fields: { invoice_id: inv, position: 0, description: 'Algo', net_amount: 1 } },
    ] } });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const code = (await extracting.t.db.query<{ code: string; status: string }>(`select code, status from invoices.invoices where id = $1`, [inv])).rows[0]!;
    assert.equal(code.status, 'pendiente_revision');
    const notPending = await extracting.call('/api/v1/imports/extract', { token: agent, body: { file_ids: [other] } });
    assert.equal(notPending.status, 428); assert.deepEqual(notPending.data.error.details.risk.reasons, [`extract:not_pending:${code.code}`]);
  } finally {
    await extracting.close();
  }
});
