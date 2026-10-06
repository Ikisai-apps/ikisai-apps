/**
 * Invoices · modelo, triggers, hook de invariantes, procedimientos y lecturas contra PGlite a través de `invoices-api`
 * (migraciones 0200 y 0201; docs/invoices/API.md §2–§4, §6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { recalculate, slugify, normalizedFilename, type ImportDocument } from '../../packages/domain-invoices/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE: ImportDocument = JSON.parse(fs.readFileSync(path.join(here, '../core/fixtures/invoice-import-v1.example.json'), 'utf8'));
const SHA_A = 'a'.repeat(64);

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const remove = (table: string, id: string, expectedRevision: number) => ({ op: 'delete', table, id, expectedRevision });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { body: { requestId: `inv-${++counter}`, operations }, ...(token ? { token } : {}) });
}
async function ok(operations: unknown[], token?: string) {
  const res = await commit(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rejected(operations: unknown[], code: string, status = 422, token?: string) {
  const res = await commit(operations, token);
  assert.equal(res.status, status, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}
async function row(table: string, id: string): Promise<Record<string, any>> {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  const found = (snap.data.tables[0].rows as Array<Record<string, any>>).find((r) => r.id === id);
  assert.ok(found, `fila ${id} en ${table}`);
  return found;
}
async function rows(table: string, where: (r: Record<string, any>) => boolean = () => true): Promise<Array<Record<string, any>>> {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1`);
  return (snap.data.tables[0].rows as Array<Record<string, any>>).filter(where);
}
async function read(name: string, args: Record<string, unknown> = {}, token?: string) {
  return app.call(`/api/v1/read/${name}`, { body: args, ...(token ? { token } : {}) });
}

/** Sube y verifica un archivo sintético; devuelve el id de core.files y sus datos. */
async function uploadFile(content: string, filename = 'scan.pdf', mime = 'application/pdf') {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename, mime, size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  const verified = await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return { file_id: ticket.data.id as string, mime_type: mime, size_bytes: bytes.byteLength, sha256: sha };
}

async function newSupplier(name: string, extra: Record<string, unknown> = {}) {
  const id = uuid();
  await ok([insert('invoices.suppliers', id, { name, ...extra })]);
  return id;
}

/** Factura manual lista para validar: proveedor, fecha, objeto, documento, una línea y su IVA. */
async function manualInvoice(opts: { supplier: string; date?: string; object?: string; net?: number; rate?: number; sourceTotal?: number | null; category?: string | null; withFile?: boolean } ) {
  const id = uuid(); const line = uuid(); const tax = uuid();
  const net = opts.net ?? 100; const rate = opts.rate ?? 21; const vat = Math.round(net * rate) / 100;
  const ops: unknown[] = [
    insert('invoices.invoices', id, { supplier_id: opts.supplier, invoice_date: opts.date ?? '2026-10-05', object: opts.object ?? 'alimentos retiro yoga', invoice_number: `N-${id.slice(0, 8)}`,
      expense_category: opts.category === undefined ? 'compras' : opts.category, source_total: opts.sourceTotal === undefined ? Math.round((net + vat) * 100) / 100 : opts.sourceTotal }),
    insert('invoices.invoice_lines', line, { invoice_id: id, position: 0, description: 'Artículo', quantity: 1, unit_price: net, net_amount: net, vat_rate: rate, vat_amount: vat }),
    insert('invoices.tax_lines', tax, { invoice_id: id, position: 0, tax_type: 'iva', rate, taxable_base: net, amount: vat }),
  ];
  if (opts.withFile !== false) {
    const file = await uploadFile(`%PDF ${id}`);
    ops.push(insert('invoices.invoice_files', uuid(), { invoice_id: id, original_filename: 'scan.pdf', ...file }));
  }
  await ok(ops);
  return { id, line, tax };
}

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('bootstrap registra las nueve tablas (extracciones incluida); proveedores con slug derivado y alias', async () => {
  const boot = await app.call('/api/v1/bootstrap');
  assert.deepEqual(boot.data.tables.map((t: any) => t.table).sort(), ['invoices.allocations', 'invoices.export_items', 'invoices.exports', 'invoices.extractions', 'invoices.invoice_files', 'invoices.invoice_lines', 'invoices.invoices', 'invoices.suppliers', 'invoices.tax_lines']);
  const id = await newSupplier('Makro España S.A.', { tax_id: 'A28647451', aliases: ['MAKRO'] });
  const s = await row('invoices.suppliers', id);
  assert.equal(s.slug, 'makro_espana_s_a'); assert.deepEqual(s.aliases, ['MAKRO']); assert.equal(s.default_is_investment, false);
  assert.equal(s.slug, slugify('Makro España S.A.'));
  const dup = uuid();
  const res = await commit([insert('invoices.suppliers', dup, { name: 'Otro', tax_id: 'a28647451' })]);
  assert.equal(res.status, 422); assert.equal(res.data.error.code, 'CONSTRAINT_VIOLATION');
});

test('factura manual: código FVR, periodo derivado, nombre canónico, pendiente_datos → pendiente_revision al tener contenido', async () => {
  const supplier = await newSupplier('Makro', { slug: 'makro' });
  const id = uuid();
  await ok([insert('invoices.invoices', id, { supplier_id: supplier, invoice_date: '2026-10-05', object: 'Alimentos Retiro Yoga' })]);
  let inv = await row('invoices.invoices', id);
  assert.match(inv.code, /^FVR_2026_\d{3}$/); assert.equal(inv.fiscal_period, '2026T4'); assert.equal(inv.fiscal_quarter, 4);
  assert.equal(inv.status, 'pendiente_datos'); assert.equal(inv.deductibility, 'pendiente_revision');

  const file = await uploadFile('%PDF manual-1');
  const fileRow = uuid();
  await ok([insert('invoices.invoice_files', fileRow, { invoice_id: id, original_filename: 'IMG_0001.pdf', ...file })]);
  const f = await row('invoices.invoice_files', fileRow);
  assert.equal(f.normalized_filename, '2026_10_05_(makro)_alimentos_retiro_yoga.pdf');
  assert.equal(f.normalized_filename, normalizedFilename({ invoiceDate: '2026-10-05', supplierSlug: 'makro', object: 'Alimentos Retiro Yoga', mime: 'application/pdf' }));

  const line = uuid(); const tax = uuid();
  const result = await ok([
    insert('invoices.invoice_lines', line, { invoice_id: id, position: 0, description: 'Tomate', quantity: 20, unit: 'kg', unit_price: 2, net_amount: 40, vat_rate: 10, vat_amount: 4 }),
    insert('invoices.tax_lines', tax, { invoice_id: id, position: 0, tax_type: 'iva', rate: 10, taxable_base: 40, amount: 4 }),
  ]);
  // El hook recalcula y cambia el estado dentro del mismo lote: los cambios llegan en la respuesta.
  assert.ok(result.changes.some((c: any) => c.table === 'invoices.invoices' && c.op === 'update' && c.after.status === 'pendiente_revision'));
  inv = await row('invoices.invoices', id);
  assert.equal(inv.status, 'pendiente_revision'); assert.equal(inv.review_reason, 'DATOS_INTRODUCIDOS');
  assert.equal(Number(inv.calculated_base), 40); assert.equal(Number(inv.calculated_vat), 4); assert.equal(Number(inv.calculated_total), 44); assert.equal(inv.totals_delta, null);

  // Total documental que no cuadra → REVISAR IMPORTES; corregido → IMPORTES_CORREGIDOS
  await ok([update('invoices.invoices', id, inv.revision, { source_total: 45 })]);
  inv = await row('invoices.invoices', id);
  assert.equal(inv.review_reason, 'REVISAR IMPORTES'); assert.equal(Number(inv.totals_delta), 1);
  await ok([update('invoices.invoices', id, inv.revision, { source_total: 44.02 })]);
  inv = await row('invoices.invoices', id);
  assert.equal(inv.review_reason, 'IMPORTES_CORREGIDOS'); assert.equal(Number(inv.totals_delta), 0.02);

  // Cambiar el objeto renombra el documento mientras no esté validada
  await ok([update('invoices.invoices', id, inv.revision, { object: 'Verduras' })]);
  assert.equal((await row('invoices.invoice_files', fileRow)).normalized_filename, '2026_10_05_(makro)_verduras.pdf');

  // Las facturas no se borran
  inv = await row('invoices.invoices', id);
  await rejected([remove('invoices.invoices', id, inv.revision)], 'INVOICE_NOT_DELETABLE');
  // validada solo por procedimiento
  await rejected([update('invoices.invoices', id, inv.revision, { status: 'validada' })], 'INVALID_TRANSITION');
});

test('nombre canónico: páginas _pNN al añadir imágenes y colisión _NN entre facturas iguales', async () => {
  const supplier = await newSupplier('Iberdrola', { slug: 'iberdrola' });
  const a = uuid();
  await ok([insert('invoices.invoices', a, { supplier_id: supplier, invoice_date: '2026-10-07', object: 'luz octubre' })]);
  const p1 = await uploadFile('img-1', 'p1.jpg', 'image/jpeg'); const p2 = await uploadFile('img-2', 'p2.jpg', 'image/jpeg');
  const f1 = uuid(); const f2 = uuid();
  await ok([insert('invoices.invoice_files', f1, { invoice_id: a, original_filename: 'p1.jpg', page_order: 1, ...p1 })]);
  assert.equal((await row('invoices.invoice_files', f1)).normalized_filename, '2026_10_07_(iberdrola)_luz_octubre.jpg');
  await ok([insert('invoices.invoice_files', f2, { invoice_id: a, original_filename: 'p2.jpg', page_order: 2, ...p2 })]);
  assert.equal((await row('invoices.invoice_files', f1)).normalized_filename, '2026_10_07_(iberdrola)_luz_octubre_p01.jpg');
  assert.equal((await row('invoices.invoice_files', f2)).normalized_filename, '2026_10_07_(iberdrola)_luz_octubre_p02.jpg');

  const b = uuid();
  await ok([insert('invoices.invoices', b, { supplier_id: supplier, invoice_date: '2026-10-07', object: 'Luz Octubre' })]);
  const pdf = await uploadFile('%PDF segunda'); const fb = uuid();
  await ok([insert('invoices.invoice_files', fb, { invoice_id: b, original_filename: 'x.pdf', ...pdf })]);
  assert.equal((await row('invoices.invoice_files', fb)).normalized_filename, '2026_10_07_(iberdrola)_luz_octubre_02.pdf');

  const att = await uploadFile('%PDF albaran'); const fa = uuid();
  await ok([insert('invoices.invoice_files', fa, { invoice_id: b, original_filename: 'albaran.pdf', kind: 'attachment', ...att })]);
  assert.equal((await row('invoices.invoice_files', fa)).normalized_filename, '2026_10_07_(iberdrola)_luz_octubre_02_a01.pdf');
  // normalized_filename no se escribe desde fuera (la Edge lo rechaza antes de llegar al trigger IMMUTABLE_FIELD)
  const fr = await row('invoices.invoice_files', fa);
  await rejected([update('invoices.invoice_files', fa, fr.revision, { normalized_filename: 'otro.pdf' })], 'INVALID_FIELDS');
});

test('import_v1: el ejemplo del handoff crea proveedor, factura, líneas, impuestos y documento; duplicados; REVISAR IMPORTES', async () => {
  const file = await uploadFile('%PDF ejemplo');
  const invoiceId = uuid(); const supplierId = uuid(); const lineId = uuid(); const taxId = uuid(); const fileRowId = uuid();
  const args = {
    document: EXAMPLE, document_sha256: SHA_A, invoice_id: invoiceId,
    ids: { lines: [lineId], tax_lines: [taxId], supplier: supplierId, files: [fileRowId] },
    supplier: { mode: 'create', id: supplierId, slug: null },
    invoice: { expense_category: 'compras' },
    files: [{ file_id: file.file_id, original_filename: 'ejemplo.pdf', page_order: 1 }],
  };
  const res = await ok([call('invoices.import_v1', args)]);
  const result = res.results[0].result;
  assert.equal(result.status, 'pendiente_revision'); assert.equal(result.review_reason, 'IMPORTADA'); assert.match(result.code, /^FVR_2026_/);
  assert.deepEqual(result.normalized_filenames, ['2026_10_05_(proveedor_ejemplo_s_l)_alimentos_retiro_ejemplo.pdf']);
  assert.equal(result.recalculation.within_tolerance, true); assert.equal(result.recalculation.calculated_total, 44);
  const inv = await row('invoices.invoices', invoiceId);
  assert.equal(inv.source, 'import_v1'); assert.equal(inv.import_sha256, SHA_A); assert.equal(inv.expense_category, 'compras'); assert.equal(inv.deductibility, 'pendiente_revision');
  assert.equal(Number(inv.source_total), 44); assert.equal(Number(inv.totals_delta), 0); assert.equal(inv.import_meta.overall_confidence, 0.98);
  const line = await row('invoices.invoice_lines', lineId);
  assert.equal(line.description, 'Tomate'); assert.equal(line.item_type, 'food_ingredient'); assert.equal(line.match_name, 'tomate'); assert.equal(Number(line.confidence), 0.99);
  assert.equal((await row('invoices.tax_lines', taxId)).tax_type, 'iva');
  const supplier = await row('invoices.suppliers', supplierId);
  assert.equal(supplier.name, 'Proveedor Ejemplo S.L.'); assert.equal(supplier.tax_id, 'B00000000');
  // Paridad del recálculo SQL con el dominio TS
  const ts = recalculate(EXAMPLE.lines, EXAMPLE.taxes, EXAMPLE.document_totals);
  assert.equal(Number(inv.calculated_base), ts.calculated_base); assert.equal(Number(inv.calculated_vat), ts.calculated_vat); assert.equal(Number(inv.calculated_total), ts.calculated_total);

  // Duplicados: mismo proveedor y número; mismo JSON
  await rejected([call('invoices.import_v1', { ...args, invoice_id: uuid(), document_sha256: 'b'.repeat(64), ids: { lines: [uuid()], tax_lines: [uuid()], supplier: null, files: [] }, supplier: { mode: 'existing', id: supplierId }, files: [] })], 'DUPLICATE_INVOICE', 409);
  await rejected([call('invoices.import_v1', { ...args, invoice_id: uuid(), ids: { lines: [uuid()], tax_lines: [uuid()], supplier: null, files: [] }, supplier: { mode: 'existing', id: supplierId }, files: [],
    document: { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-124' } } })], 'DUPLICATE_IMPORT', 409);
  // NIF ya existente al crear
  await rejected([call('invoices.import_v1', { ...args, invoice_id: uuid(), document_sha256: 'c'.repeat(64), ids: { lines: [uuid()], tax_lines: [uuid()], supplier: uuid(), files: [] }, supplier: { mode: 'create', id: uuid() }, files: [],
    document: { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-125' } } })], 'SUPPLIER_TAX_ID_EXISTS', 409);
  // Esquema inválido → nada escrito
  const bad = uuid();
  await rejected([call('invoices.import_v1', { ...args, invoice_id: bad, document_sha256: 'd'.repeat(64), supplier: { mode: 'existing', id: supplierId }, files: [], document: { ...EXAMPLE, schema_version: 'v2' } })], 'IMPORT_INVALID');
  assert.equal((await rows('invoices.invoices', (r) => r.id === bad)).length, 0);

  // Fuera de tolerancia → REVISAR IMPORTES; alias añadido al proveedor existente con otro nombre
  const second = uuid();
  const doc2 = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-200', supplier_name: 'PROVEEDOR EJEMPLO SL' }, document_totals: { ...EXAMPLE.document_totals, total: 44.5 } };
  const r2 = await ok([call('invoices.import_v1', { document: doc2, document_sha256: 'e'.repeat(64), invoice_id: second, ids: { lines: [uuid()], tax_lines: [], supplier: null, files: [] }, supplier: { mode: 'existing', id: supplierId }, invoice: {}, files: [] })]);
  assert.equal(r2.results[0].result.review_reason, 'REVISAR IMPORTES'); assert.equal(r2.results[0].result.recalculation.delta, 0.5);
  assert.ok(r2.results[0].result.warnings.includes('TOTALS_MISMATCH'));
  assert.deepEqual((await row('invoices.suppliers', supplierId)).aliases, ['PROVEEDOR EJEMPLO SL']);
  assert.equal((await row('invoices.invoices', second)).expense_category, null); // sin categoría por defecto en el proveedor

  // Sin desglose de impuestos → derivados de las líneas
  const third = uuid();
  const r3 = await ok([call('invoices.import_v1', { document: { ...EXAMPLE, taxes: [], invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-300' } }, document_sha256: 'f'.repeat(64), invoice_id: third, ids: { lines: [uuid()], tax_lines: [], supplier: null, files: [] }, supplier: { mode: 'existing', id: supplierId }, invoice: {}, files: [] })]);
  assert.ok(r3.results[0].result.warnings.includes('TAXES_DERIVED_FROM_LINES'));
  const derived = await rows('invoices.tax_lines', (t) => t.invoice_id === third);
  assert.equal(derived.length, 1); assert.equal(Number(derived[0]!.amount), 4);

  // Importar sobre una factura existente en pendiente_datos
  const fourth = uuid();
  await ok([insert('invoices.invoices', fourth, { supplier_id: supplierId, invoice_date: '2026-10-01', object: 'tecleado' })]);
  const r4 = await ok([call('invoices.import_v1', { document: { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-400' } }, document_sha256: '1'.repeat(64), invoice_id: fourth, ids: { lines: [uuid()], tax_lines: [uuid()], supplier: null, files: [] }, supplier: { mode: 'existing', id: supplierId }, invoice: { object: null }, files: [] })]);
  assert.equal(r4.results[0].result.status, 'pendiente_revision');
  assert.equal((await row('invoices.invoices', fourth)).object, 'alimentos_retiro_ejemplo');
  const again = await commit([call('invoices.import_v1', { document: { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-401' } }, document_sha256: '2'.repeat(64), invoice_id: fourth, ids: { lines: [uuid()], tax_lines: [], supplier: null, files: [] }, supplier: { mode: 'existing', id: supplierId }, invoice: {}, files: [] })]);
  assert.equal(again.status, 409); assert.equal(again.data.error.code, 'INVOICE_NOT_IMPORTABLE');
});

test('validate: incompleta, descuadrada, correcta; editar tras validar la devuelve a revisión; anular', async () => {
  const supplier = await newSupplier('Validar SL');
  const noFile = await manualInvoice({ supplier, withFile: false, category: null });
  const e = await rejected([call('invoices.validate', { invoice_id: noFile.id })], 'INVOICE_INCOMPLETE');
  assert.deepEqual(e.details.missing.sort(), ['expense_category', 'original_file']);

  const off = await manualInvoice({ supplier, sourceTotal: 130 });
  await rejected([call('invoices.validate', { invoice_id: off.id })], 'INVOICE_TOTALS_MISMATCH');

  const good = await manualInvoice({ supplier });
  let inv = await row('invoices.invoices', good.id);
  assert.equal(inv.status, 'pendiente_revision');
  const res = await ok([call('invoices.validate', { invoice_id: good.id, expectedRevision: inv.revision })]);
  assert.equal(res.results[0].result.status, 'validada');
  inv = await row('invoices.invoices', good.id);
  assert.equal(inv.status, 'validada'); assert.equal(inv.review_reason, null);
  await rejected([call('invoices.validate', { invoice_id: good.id, expectedRevision: 1 })], 'VERSION_CONFLICT', 409);

  // Pago y notas no la tocan; cambiar la fecha sí
  await ok([update('invoices.invoices', good.id, inv.revision, { payment_status: 'pagada', paid_at: '2026-10-20', payment_method: 'transferencia', notes: 'ok' })]);
  inv = await row('invoices.invoices', good.id);
  assert.equal(inv.status, 'validada');
  await ok([update('invoices.invoices', good.id, inv.revision, { invoice_date: '2026-10-06' })]);
  inv = await row('invoices.invoices', good.id);
  assert.equal(inv.status, 'pendiente_revision'); assert.equal(inv.review_reason, 'EDITADA_TRAS_VALIDAR');
  // Revalidar y editar una línea
  await ok([call('invoices.validate', { invoice_id: good.id })]);
  const line = await row('invoices.invoice_lines', good.line);
  await ok([update('invoices.invoice_lines', good.line, line.revision, { description: 'Artículo corregido' })]);
  inv = await row('invoices.invoices', good.id);
  assert.equal(inv.status, 'pendiente_revision'); assert.equal(inv.review_reason, 'EDITADA_TRAS_VALIDAR');
  await ok([call('invoices.validate', { invoice_id: good.id })]);
  // Validada: borrar una línea o un documento está bloqueado
  const line2 = await row('invoices.invoice_lines', good.line);
  await rejected([remove('invoices.invoice_lines', good.line, line2.revision)], 'INVOICE_LINE_LOCKED');
  const files = await rows('invoices.invoice_files', (f) => f.invoice_id === good.id);
  await rejected([remove('invoices.invoice_files', files[0]!.id, files[0]!.revision)], 'INVOICE_FILE_LOCKED');

  // Anular
  await rejected([call('invoices.annul', { invoice_id: good.id, reason: '  ' })], 'ANNUL_REASON_REQUIRED');
  const annulled = await ok([call('invoices.annul', { invoice_id: good.id, reason: 'duplicada' })]);
  assert.equal(annulled.results[0].result.invoice.status, 'anulada');
  inv = await row('invoices.invoices', good.id);
  await rejected([update('invoices.invoices', good.id, inv.revision, { object: 'otro' })], 'INVOICE_ANNULLED', 409);
  await ok([update('invoices.invoices', good.id, inv.revision, { notes: 'anulada por duplicado' })]);
  await rejected([call('invoices.annul', { invoice_id: good.id, reason: 'otra vez' })], 'INVOICE_ANNULLED', 409);
});

test('asignaciones: por línea, invoice_id derivado, sin sobreasignar por importe ni cantidad; anular retira asignaciones', async () => {
  const supplier = await newSupplier('Asignar SL');
  const inv = await manualInvoice({ supplier, net: 50 });
  const line = await row('invoices.invoice_lines', inv.line);
  await ok([update('invoices.invoice_lines', inv.line, line.revision, { quantity: 20, unit: 'kg', unit_price: 2.5 })]);
  const a1 = uuid(); const a2 = uuid();
  await ok([
    // Los destinos de Tareas se prueban en api.test.ts con una API de Tareas simulada; aquí destinos generales.
    insert('invoices.allocations', a1, { invoice_line_id: inv.line, target_app: 'general', target_kind: 'investment', target_label: 'Inversión', allocated_amount: 30, allocated_quantity: 12 }),
    insert('invoices.allocations', a2, { invoice_line_id: inv.line, target_app: 'general', target_kind: 'operating_expense', target_label: 'Gasto de explotación', allocated_amount: 20, allocated_quantity: 8 }),
  ]);
  assert.equal((await row('invoices.allocations', a1)).invoice_id, inv.id);
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: inv.line, target_app: 'general', target_kind: 'investment', target_label: 'Inversión', allocated_amount: 0.05 })], 'ALLOCATIONS_EXCEED_LINE');
  const a2row = await row('invoices.allocations', a2);
  await rejected([update('invoices.allocations', a2, a2row.revision, { allocated_amount: 19, allocated_quantity: 9 })], 'ALLOCATIONS_EXCEED_QUANTITY');
  // pares inválidos y destino general con id → check de la tabla
  const bad = await commit([insert('invoices.allocations', uuid(), { invoice_line_id: inv.line, target_app: 'tasks', target_kind: 'event', target_id: 'x', target_label: 'x', allocated_amount: 1 })]);
  assert.equal(bad.data.error.code, 'INVALID_FIELDS'); // la Edge lo para antes del check de la tabla
  // Compras ve la línea con asignado 50 y sin asignar 0 (solo validadas por defecto → vacío hasta validar)
  let items = await read('invoices.items', { year: 2026, quarter: 4 });
  assert.equal(items.status, 200); assert.ok(!items.data.rows.some((r: any) => r.id === inv.line));
  items = await read('invoices.items', { year: 2026, quarter: 4, validated_only: false, target_app: 'general', target_kind: 'investment' });
  const item = items.data.rows.find((r: any) => r.id === inv.line);
  assert.ok(item); assert.equal(Number(item.allocated_amount), 50); assert.equal(Number(item.unallocated_amount), 0); assert.equal(item.allocations.length, 2);
  // Anular retira las asignaciones
  await ok([call('invoices.annul', { invoice_id: inv.id, reason: 'prueba' })]);
  assert.ok((await row('invoices.allocations', a1)).deleted_at);
  const invRow = await row('invoices.invoices', inv.id);
  assert.equal(invRow.status, 'anulada');
  await rejected([insert('invoices.allocations', uuid(), { invoice_line_id: inv.line, target_app: 'general', target_kind: 'unassigned', target_label: 'x', allocated_amount: 1 })], 'INVOICE_ANNULLED', 409);
});

test('resumen fiscal, entrega a gestoría (manifest, hash, items), entregada, archivar periodo (owner) y bloqueo de archivada', async () => {
  const supplier = await newSupplier('Gestoría SL');
  const a = await manualInvoice({ supplier, date: '2026-07-10', net: 200, rate: 21, object: 'ferretería' });
  const b = await manualInvoice({ supplier, date: '2026-08-02', net: 100, rate: 10, object: 'verdura', category: 'compras' });
  const pending = await manualInvoice({ supplier, date: '2026-09-15', net: 10, rate: 21, sourceTotal: 99, object: 'pendiente' });
  await ok([call('invoices.validate', { invoice_id: a.id })]);
  await ok([call('invoices.validate', { invoice_id: b.id })]);

  const summary = await read('invoices.fiscal_summary', { year: 2026, quarter: 3 });
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  const s = summary.data;
  assert.equal(s.range.from, '2026-07-01'); assert.equal(s.range.to, '2026-09-30');
  assert.equal(s.invoices.validada, 2); assert.equal(s.invoices.pendiente_revision, 1);
  assert.equal(Number(s.base), 300); assert.equal(Number(s.vat), 52); assert.equal(Number(s.total), 352);
  assert.deepEqual(s.vat_by_rate.map((g: any) => [Number(g.rate), Number(g.base), Number(g.amount)]), [[10, 100, 10], [21, 200, 42]]);
  assert.equal(s.alerts.pending_invoices.length, 1); assert.equal(s.alerts.discrepancies.length, 1); assert.equal(s.alerts.deductibility_unreviewed, 2);
  const byMonth = await read('invoices.fiscal_summary', { year: 2026, month: 8 });
  assert.equal(Number(byMonth.data.base), 100);
  assert.equal((await read('invoices.fiscal_summary', {})).status, 422);

  // Vista previa y creación de la entrega
  const preview = await read('invoices.export_preview', { period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 3 });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.folder_name, 'IKISAI_COMPRAS_2026_T3'); assert.equal(preview.data.invoice_count, 2); assert.equal(preview.data.excluded.length, 1);
  assert.equal((await read('invoices.export_preview', { period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 3 }, app.tokens.reader)).status, 403);
  await rejected([call('invoices.create_export', { export_id: uuid(), period_kind: 'quarter', fiscal_year: 2025, fiscal_quarter: 1 })], 'EXPORT_EMPTY');
  const exportId = uuid();
  const created = await ok([call('invoices.create_export', { export_id: exportId, period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 3 })]);
  const result = created.results[0].result;
  assert.match(result.code, /^GST_2026_\d{3}$/); assert.equal(result.invoice_count, 2); assert.match(result.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.warnings.length, 1); assert.equal(result.warnings[0].reason, 'REVISAR IMPORTES');
  const exp = await row('invoices.exports', exportId);
  assert.equal(exp.status, 'generada'); assert.equal(exp.manifest.schema, 'ikisai.invoices.export.v1'); assert.equal(exp.manifest.invoices.length, 2);
  assert.equal(exp.manifest.invoices[0].files[0].name.startsWith('facturas/2026_07_10_(gestoria_sl)_ferreteria'), true);
  const items = await rows('invoices.export_items', (i) => i.export_id === exportId);
  assert.equal(items.length, 2); assert.equal(items[0]!.files.length, 1);
  // El estado de las facturas no cambia
  assert.equal((await row('invoices.invoices', a.id)).status, 'validada');
  // Inmutable; no se borra
  await rejected([update('invoices.exports', exportId, exp.revision, { invoice_count: 5 })], 'INVALID_FIELDS'); // la Edge solo deja status/delivered_*/notes
  await rejected([remove('invoices.exports', exportId, exp.revision)], 'EXPORT_NOT_DELETABLE');
  // El cliente no puede insertar entregas a mano (lo impone la Edge en la siguiente PR; en SQL falta el manifest)
  const direct = await commit([insert('invoices.exports', uuid(), { status: 'generada' })]);
  assert.equal(direct.status, 422);

  // Bundle para el ZIP
  const bundle = await read('invoices.export_bundle', { export_id: exportId });
  assert.equal(bundle.status, 200, JSON.stringify(bundle.data));
  assert.equal(bundle.data.files.length, 2); assert.ok(bundle.data.files[0].path); assert.equal(bundle.data.stale, false);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundle.data.manifest_text)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  assert.equal(sha, exp.manifest_sha256);
  // reader puede leer el bundle (descarga el ZIP)
  assert.equal((await read('invoices.export_bundle', { export_id: exportId }, app.tokens.reader)).status, 200);

  // Archivar antes de entregar → no; entregar → sí; archivar como editor → no; como owner → sí
  await rejected([call('invoices.archive_period', { export_id: exportId })], 'INVALID_OPERATION');
  const delivered = await ok([call('invoices.mark_delivered', { export_id: exportId, expectedRevision: exp.revision, delivered_to: 'correo a la gestoría' })]);
  assert.equal(delivered.results[0].result.status, 'entregada'); assert.ok(delivered.results[0].result.delivered_at);
  await rejected([call('invoices.archive_period', { export_id: exportId })], 'FORBIDDEN', 403, app.tokens.editor);
  const archived = await ok([call('invoices.archive_period', { export_id: exportId })]);
  assert.equal(archived.results[0].result.archived, 2);
  let ar = await row('invoices.invoices', a.id);
  assert.equal(ar.status, 'archivada');
  await rejected([update('invoices.invoices', a.id, ar.revision, { object: 'otro' })], 'INVOICE_ARCHIVED', 409);
  await ok([update('invoices.invoices', a.id, ar.revision, { payment_status: 'pagada', paid_at: '2026-10-01', payment_method: 'tarjeta' })]);
  ar = await row('invoices.invoices', a.id);
  const line = await row('invoices.invoice_lines', a.line);
  await rejected([update('invoices.invoice_lines', a.line, line.revision, { description: 'x' })], 'INVOICE_LOCKED', 409);
  // desarchivar: solo owner (la Edge no deja a un editor pedir «validada»; el trigger exige owner y archivada → validada)
  await rejected([update('invoices.invoices', a.id, ar.revision, { status: 'validada' })], 'INVALID_TRANSITION', 422, app.tokens.editor);
  await ok([update('invoices.invoices', a.id, ar.revision, { status: 'validada' })]);
  // La entrega queda desfasada al cambiar una factura incluida
  const stale = await read('invoices.export_bundle', { export_id: exportId });
  assert.equal(stale.data.stale, true);

  // Compras: solo validadas/archivadas; agrupación por destino en el cliente, aquí filas con asignaciones vacías
  const list = await read('invoices.items', { year: 2026, quarter: 3, unassigned: true });
  assert.equal(list.data.rows.length, 2); assert.equal(Number(list.data.rows[0].unallocated_amount), Number(list.data.rows[0].net_amount));
});

test('papelera y permisos: facturas, documentos, líneas y entregas no se purgan; reader no escribe', async () => {
  const supplier = await newSupplier('Papelera SL');
  const inv = await manualInvoice({ supplier, net: 10 });
  const alloc = uuid();
  await ok([insert('invoices.allocations', alloc, { invoice_line_id: inv.line, target_app: 'general', target_kind: 'unassigned', target_label: 'Sin asignar', allocated_amount: 5 })]);
  const al = await row('invoices.allocations', alloc);
  await ok([remove('invoices.allocations', alloc, al.revision)]);
  const purged = await app.call('/api/v1/trash/purge', { body: { requestId: `purge-${++counter}` } });
  assert.equal(purged.status, 200, JSON.stringify(purged.data)); assert.ok(purged.data.purged >= 1);
  assert.equal((await rows('invoices.allocations', (r) => r.id === alloc)).length, 0);
  assert.equal((await rows('invoices.invoices', (r) => r.status === 'anulada')).length > 0, true, 'las anuladas siguen existiendo');
  const forbidden = await commit([insert('invoices.invoices', uuid(), { supplier_id: supplier, invoice_date: '2026-10-05', object: 'x' })], app.tokens.reader);
  assert.equal(forbidden.status, 403);
  assert.equal((await read('invoices.fiscal_summary', { year: 2026 }, app.tokens.reader)).status, 200);
});

test('proyección para Food: unidad normalizada (kg, l, ud) y cantidad en esa unidad; unidades desconocidas en null', async () => {
  const cases: Array<[string | null, string | null, number | null]> = [
    ['Kg', 'kg', 1], ['kilos', 'kg', 1], ['gr.', 'kg', 0.001], ['Gramos', 'kg', 0.001], ['litros', 'l', 1], ['ML', 'l', 0.001], ['cl', 'l', 0.01],
    ['ud.', 'ud', 1], ['Unidades', 'ud', 1], ['caja', null, null], [null, null, null],
  ];
  for (const [input, unit, factor] of cases) {
    const r = await app.t.db.query<{ unit: string | null; factor: string | null }>('select * from invoices.normalize_unit($1)', [input]);
    assert.equal(r.rows[0]!.unit, unit, String(input));
    assert.equal(r.rows[0]!.factor === null ? null : Number(r.rows[0]!.factor), factor, String(input));
  }
  // Una asignación a Cocina de 2500 gr → 2,5 kg en la proyección (las columnas anteriores siguen igual).
  const supplier = await newSupplier('Unidades SL');
  const inv = await manualInvoice({ supplier, net: 10 });
  const line = await row('invoices.invoice_lines', inv.line);
  await ok([update('invoices.invoice_lines', inv.line, line.revision, { quantity: 2500, unit: 'gr', unit_price: 0.004 })]);
  const alloc = uuid();
  await ok([insert('invoices.allocations', alloc, { invoice_line_id: inv.line, target_app: 'general', target_kind: 'operating_expense', target_label: 'Gasto', allocated_amount: 10, allocated_quantity: 2500 })]);
  // Los destinos de Cocina se resuelven contra la proyección de Food en la Edge (api.test.ts); aquí se cambia el destino en SQL.
  await app.t.db.query(`update invoices.allocations set target_app = 'food', target_kind = 'ingredient', target_id = $2, target_label = 'Harina' where id = $1`, [alloc, uuid()]);
  const p = await app.t.db.query<Record<string, any>>('select * from invoices.food_stock_projection where allocation_id = $1', [alloc]);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0]!.unit, 'gr'); assert.equal(Number(p.rows[0]!.allocated_quantity), 2500);
  assert.equal(p.rows[0]!.unit_normalized, 'kg'); assert.equal(Number(p.rows[0]!.quantity_normalized), 2.5);
});
