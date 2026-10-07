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
import { issuedCsv, issuedSummary, recalculate, slugify, normalizedFilename, taxesCsv, vfAltaHash, vfAnulacionHash, type ImportDocument } from '../../packages/domain-invoices/src/index.ts';

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

test('bootstrap registra las veinte tablas (extracciones, emitidas, plantillas, texto de documentos y registro VERI*FACTU); proveedores con slug derivado y alias', async () => {
  const boot = await app.call('/api/v1/bootstrap');
  assert.deepEqual(boot.data.tables.map((t: any) => t.table).sort(), ['invoices.allocations', 'invoices.customers', 'invoices.document_texts', 'invoices.export_items', 'invoices.exports', 'invoices.extractions', 'invoices.invoice_files', 'invoices.invoice_lines', 'invoices.invoices', 'invoices.issued_allocations', 'invoices.issued_invoice_files', 'invoices.issued_invoice_lines', 'invoices.issued_invoices', 'invoices.issued_series', 'invoices.issued_tax_lines', 'invoices.supplier_templates', 'invoices.suppliers', 'invoices.tax_lines', 'invoices.vf_events', 'invoices.vf_records', 'invoices.vf_state']);
  // Las tablas VERI*FACTU están registradas pero nadie las lee ni las escribe por sincronización
  for (const t of boot.data.tables.filter((x: any) => x.table.startsWith('invoices.vf_'))) assert.deepEqual([t.readable, t.writable], [false, false]);
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

test('emitidas: registro manual con totales recalculados, reglas de tipo y destinatario, número único, sin papelera, anular', async () => {
  const issued = uuid(); const l1 = uuid(); const l2 = uuid();
  await ok([
    insert('invoices.issued_series', uuid(), { code: 'A', description: 'Ordinarias' }),
    insert('invoices.issued_invoices', issued, { series_code: 'A', number: '2026-0001', issue_date: '2026-10-06', invoice_type: 'F1', recipient_name: 'Cliente Uno SL', recipient_tax_id: 'B22222222', recipient_id_type: 'NIF', description: 'Estancia retiro', source_total: 121, income_category: 'alojamiento' }),
    insert('invoices.issued_invoice_lines', l1, { issued_invoice_id: issued, position: 0, description: 'Alojamiento', net_amount: 80, vat_rate: 10 }),
    insert('invoices.issued_invoice_lines', l2, { issued_invoice_id: issued, position: 1, description: 'Actividad', net_amount: 20, vat_rate: 21 }),
  ]);
  let inv = await row('invoices.issued_invoices', issued);
  assert.equal(inv.full_number, 'A-2026-0001'); assert.equal(inv.fiscal_quarter, 4); assert.equal(inv.status, 'registrada'); assert.equal(inv.origin, 'manual');
  assert.equal(Number(inv.base_total), 100); assert.equal(Number(inv.quota_total), 12.2); assert.equal(Number(inv.total), 112.2);
  assert.equal(inv.review_reason, 'REVISAR IMPORTES'); assert.equal(Number(inv.totals_delta), 8.8);
  // Con IRPF en el desglose y el total del documento correcto, cuadra
  await ok([
    insert('invoices.issued_tax_lines', uuid(), { issued_invoice_id: issued, position: 0, tax: 'iva', rate: 10, taxable_base: 80, quota: 8, qualification: 'S1' }),
    insert('invoices.issued_tax_lines', uuid(), { issued_invoice_id: issued, position: 1, tax: 'iva', rate: 21, taxable_base: 20, quota: 4.2, qualification: 'S1' }),
    insert('invoices.issued_tax_lines', uuid(), { issued_invoice_id: issued, position: 2, tax: 'irpf', rate: 15, taxable_base: 20, quota: 3 }),
    update('invoices.issued_invoices', issued, inv.revision, { source_total: 109.2 }),
  ]);
  inv = await row('invoices.issued_invoices', issued);
  assert.equal(Number(inv.withholding_total), 3); assert.equal(Number(inv.total), 109.2); assert.equal(inv.review_reason, null);
  // Reglas: completa sin destinatario, rectificativa sin referencia, número repetido, origen app, campos Verifactu no escribibles
  const bad = await commit([insert('invoices.issued_invoices', uuid(), { series_code: 'A', number: '2026-0002', issue_date: '2026-10-06', invoice_type: 'F1', description: 'Sin cliente' })]);
  assert.equal(bad.status, 422);
  const rect = await commit([insert('invoices.issued_invoices', uuid(), { series_code: 'R', number: '2026-0001', issue_date: '2026-10-06', invoice_type: 'R1', recipient_name: 'Cliente Uno SL', recipient_tax_id: 'B22222222', description: 'Rectifica' })]);
  assert.equal(rect.status, 422);
  await ok([insert('invoices.issued_invoices', uuid(), { series_code: 'R', number: '2026-0001', issue_date: '2026-10-06', invoice_type: 'R1', rectification_kind: 'I', rectified: [{ series: 'A', number: '2026-0001', issue_date: '2026-10-06' }], rectification_reason: 'Error en el precio', recipient_name: 'Cliente Uno SL', recipient_tax_id: 'B22222222', description: 'Rectifica' })]);
  await rejected([insert('invoices.issued_invoices', uuid(), { series_code: 'a', number: '2026-0001', issue_date: '2026-10-07', invoice_type: 'F2', description: 'Repetida' })], 'CONSTRAINT_VIOLATION');
  await rejected([insert('invoices.issued_invoices', uuid(), { series_code: 'A', number: '2026-0099', issue_date: '2026-10-07', invoice_type: 'F2', description: 'Desde la app', origin: 'app' })], 'UNSUPPORTED_IN_V1');
  await rejected([update('invoices.issued_invoices', issued, inv.revision, { vf_hash: 'x' })], 'INVALID_FIELDS');
  // Sin papelera: ni la factura ni sus líneas
  await rejected([remove('invoices.issued_invoices', issued, inv.revision)], 'ISSUED_NOT_DELETABLE');
  await rejected([remove('invoices.issued_invoice_lines', l1, (await row('invoices.issued_invoice_lines', l1)).revision)], 'ISSUED_NOT_DELETABLE');
  // Destino de ingreso general y proyección de ingresos para Booking (el destino de Booking se resuelve en la Edge; aquí, en SQL)
  const alloc = uuid();
  await ok([insert('invoices.issued_allocations', alloc, { issued_invoice_id: issued, target_app: 'general', target_kind: 'general', target_label: 'General', allocated_amount: 100 })]);
  await rejected([insert('invoices.issued_allocations', uuid(), { issued_invoice_id: issued, target_app: 'general', target_kind: 'general', target_label: 'Otra', allocated_amount: 5 })], 'ALLOCATIONS_EXCEED_INVOICE');
  const reservation = uuid();
  await app.t.db.query(`update invoices.issued_allocations set target_app = 'booking', target_kind = 'reservation', target_id = $2 where id = $1`, [alloc, reservation]);
  const proj = await app.t.db.query<Record<string, any>>('select * from invoices.booking_income_projection where target_id = $1', [reservation]);
  assert.equal(proj.rows.length, 1); assert.equal(proj.rows[0]!.full_number, 'A-2026-0001'); assert.equal(Number(proj.rows[0]!.allocated_amount), 100);
  assert.equal('recipient_name' in proj.rows[0]!, false);
  // Anular: motivo obligatorio, retira asignaciones, el número sigue ocupado y la anulada no se edita
  inv = await row('invoices.issued_invoices', issued);
  await rejected([call('invoices.annul_issued', { issued_invoice_id: issued })], 'ANNUL_REASON_REQUIRED');
  await ok([call('invoices.annul_issued', { issued_invoice_id: issued, expectedRevision: inv.revision, reason: 'Emitida por error' })]);
  inv = await row('invoices.issued_invoices', issued);
  assert.equal(inv.status, 'anulada'); assert.ok((await row('invoices.issued_allocations', alloc)).deleted_at);
  assert.equal((await app.t.db.query('select * from invoices.booking_income_projection where target_id = $1', [reservation])).rows.length, 0);
  await rejected([update('invoices.issued_invoices', issued, inv.revision, { notes: 'x' })], 'ISSUED_ANNULLED', 409);
  await rejected([insert('invoices.issued_invoices', uuid(), { series_code: 'A', number: '2026-0001', issue_date: '2026-10-08', invoice_type: 'F2', description: 'Reutiliza número' })], 'CONSTRAINT_VIOLATION');
  // Documento: nombre canónico con cliente y número
  const doc = await uploadFile('%PDF emitida');
  const issued2 = uuid(); const fileRow = uuid();
  await ok([
    insert('invoices.issued_invoices', issued2, { series_code: 'A', number: '2026-0003', issue_date: '2026-10-09', invoice_type: 'F1', recipient_name: 'Cliente Dos', recipient_tax_id: 'B33333333', description: 'Cena' }),
    insert('invoices.issued_invoice_files', fileRow, { issued_invoice_id: issued2, file_id: doc.file_id, original_filename: 'factura.pdf', page_order: 1 }),
  ]);
  assert.equal((await row('invoices.issued_invoice_files', fileRow)).normalized_filename, '2026_10_09_(cliente_dos)_A-2026-0003.pdf');
});

test('emitidas en el resumen fiscal y en la entrega: IVA repercutido igual en SQL y en el dominio; entrega solo con emitidas; carpeta emitidas/', async () => {
  const a = uuid(); const b = uuid(); const doc = await uploadFile('%PDF emitida 2027');
  await ok([
    insert('invoices.issued_invoices', a, { series_code: 'Q', number: '2027-0001', issue_date: '2027-02-10', invoice_type: 'F1', recipient_name: 'Cliente Tres', recipient_tax_id: 'B55555555', description: 'Estancia', income_category: 'alojamiento' }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: a, position: 0, description: 'Habitación', net_amount: 200, vat_rate: 10 }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: a, position: 1, description: 'Masaje', net_amount: 40, vat_rate: 21 }),
    insert('invoices.issued_invoice_files', uuid(), { issued_invoice_id: a, file_id: doc.file_id, original_filename: 'q1.pdf', page_order: 1 }),
    insert('invoices.issued_invoices', b, { series_code: 'Q', number: '2027-0002', issue_date: '2027-03-01', invoice_type: 'F2', description: 'Ticket comida', income_category: 'restauracion' }),
    insert('invoices.issued_tax_lines', uuid(), { issued_invoice_id: b, position: 0, tax: 'iva', rate: 10, taxable_base: 30, quota: 3, qualification: 'S1' }),
    insert('invoices.issued_tax_lines', uuid(), { issued_invoice_id: b, position: 1, tax: 'irpf', rate: 15, taxable_base: 30, quota: 4.5 }),
  ]);
  const sql = await read('invoices.issued_summary', { year: 2027, quarter: 1 });
  assert.equal(sql.status, 200, JSON.stringify(sql.data));
  const s = sql.data;
  assert.deepEqual(s.invoices, { registrada: 2, anulada: 0 });
  assert.equal(Number(s.base), 270); assert.equal(Number(s.quota), 31.4); assert.equal(Number(s.withholding), 4.5); assert.equal(Number(s.total), 296.9);
  assert.deepEqual(s.quota_by_rate.map((g: any) => `${g.tax}:${Number(g.rate)}:${Number(g.base)}:${Number(g.quota)}`), ['iva:10:230:23', 'iva:21:40:8.4']);
  assert.equal(s.alerts.unpaid, 2); assert.equal(s.alerts.missing_file, 1);
  // El dominio da lo mismo con las filas del espejo
  const [inv, lines, taxes] = await Promise.all([rows('invoices.issued_invoices'), rows('invoices.issued_invoice_lines'), rows('invoices.issued_tax_lines')]);
  const files = await rows('invoices.issued_invoice_files');
  const ts = issuedSummary({ invoices: inv as any, lines: lines as any, taxLines: taxes as any, withFile: new Set(files.map((f) => f.issued_invoice_id)) }, { from: '2027-01-01', to: '2027-03-31' });
  assert.deepEqual({ ...ts, by_category: ts.by_category.map((c) => ({ ...c })) }, {
    invoices: s.invoices, base: Number(s.base), quota: Number(s.quota), surcharge: Number(s.surcharge), withholding: Number(s.withholding), total: Number(s.total),
    quota_by_rate: s.quota_by_rate.map((g: any) => ({ tax: g.tax, rate: g.rate === null ? null : Number(g.rate), base: Number(g.base), quota: Number(g.quota), surcharge: Number(g.surcharge) })),
    by_category: s.by_category.map((c: any) => ({ income_category: c.income_category, base: Number(c.base), total: Number(c.total), count: Number(c.count) })),
    alerts: { unpaid: s.alerts.unpaid, discrepancies: s.alerts.discrepancies, missing_file: s.alerts.missing_file },
  });
  // Entrega del T1 2027: sin recibidas validadas, pero con emitidas → se crea; manifest con emitidas y documentos en emitidas/
  const exportId = uuid();
  const created = await ok([call('invoices.create_export', { export_id: exportId, period_kind: 'quarter', fiscal_year: 2027, fiscal_quarter: 1 })]);
  assert.equal(created.results[0].result.invoice_count, 0); assert.equal(created.results[0].result.issued_count, 2);
  const bundle = await read('invoices.export_bundle', { export_id: exportId });
  assert.equal(bundle.status, 200);
  assert.deepEqual(bundle.data.manifest.issued.map((i: any) => i.full_number), ['Q-2027-0001', 'Q-2027-0002']);
  assert.equal(Number(bundle.data.manifest.issued_totals.quota), 31.4);
  assert.deepEqual(bundle.data.files.map((f: any) => `${f.folder}/${f.normalized_filename}`), ['emitidas/2027_02_10_(cliente_tres)_Q-2027-0001.pdf']);
  assert.equal(bundle.data.stale, false);
  assert.match(issuedCsv(bundle.data.manifest), /Q-2027-0002;Q;2027-03-01;;F2;/);
  assert.match(taxesCsv(bundle.data.manifest), /iva_repercutido_total;;;31,40/);
  // Una emitida nueva del periodo deja la entrega desfasada
  await ok([insert('invoices.issued_invoices', uuid(), { series_code: 'Q', number: '2027-0003', issue_date: '2027-03-15', invoice_type: 'F2', description: 'Otro ticket' })]);
  assert.equal((await read('invoices.export_bundle', { export_id: exportId })).data.stale, true);
});

test('plantillas: solo se escriben al validar una factura de ese proveedor; el owner puede retirarlas; versión única; texto de documentos solo por la Edge', async () => {
  const supplierA = await newSupplier('Plantillas A SL'); const supplierB = await newSupplier('Plantillas B SL');
  const tpl = (supplier: string, version: number) => ({ supplier_id: supplier, version, layout_tokens: ['factura', 'base'], layout_hash: 'c'.repeat(64), fields: { total: { anchor: { text: 'total', variants: [] }, relation: 'same_line_right', kind: 'money', hits: 1, misses: 0 } }, confirmations: 1 });
  // Suelta: rechazada
  await rejected([insert('invoices.supplier_templates', uuid(), tpl(supplierA, 1))], 'TEMPLATE_REQUIRES_CONFIRMATION');
  // Con la validación de una factura de otro proveedor: rechazada
  const invB = await manualInvoice({ supplier: supplierB });
  await rejected([call('invoices.validate', { invoice_id: invB.id }), insert('invoices.supplier_templates', uuid(), tpl(supplierA, 1))], 'TEMPLATE_REQUIRES_CONFIRMATION');
  // Con la validación de una factura del mismo proveedor: aceptada
  const invA = await manualInvoice({ supplier: supplierA });
  const t1 = uuid();
  await ok([call('invoices.validate', { invoice_id: invA.id }), insert('invoices.supplier_templates', t1, { ...tpl(supplierA, 1), last_confirmed_invoice_id: invA.id })]);
  let row1 = await row('invoices.supplier_templates', t1);
  assert.equal(row1.status, 'aprendiendo'); assert.equal(row1.confirmations, 1);
  // Actualizar sin validar: rechazada; misma versión otra vez: rechazada
  await rejected([update('invoices.supplier_templates', t1, row1.revision, { confirmations: 2, status: 'activa' })], 'TEMPLATE_REQUIRES_CONFIRMATION');
  const invA2 = await manualInvoice({ supplier: supplierA });
  await rejected([call('invoices.validate', { invoice_id: invA2.id }), insert('invoices.supplier_templates', uuid(), tpl(supplierA, 1))], 'CONSTRAINT_VIOLATION');
  // Retirar: el editor no, el owner sí, sin validar nada
  row1 = await row('invoices.supplier_templates', t1);
  await rejected([update('invoices.supplier_templates', t1, row1.revision, { status: 'retirada' })], 'FORBIDDEN', 403, app.tokens.editor);
  await ok([update('invoices.supplier_templates', t1, row1.revision, { status: 'retirada' })]);
  assert.equal((await row('invoices.supplier_templates', t1)).status, 'retirada');
  // Texto de documentos: el cliente no lo escribe; la Edge sí (ruta), se lee bajo demanda y se borra con su documento
  await rejected([insert('invoices.document_texts', uuid(), { file_id: uuid(), source: 'pdf_text', items: [] })], 'DOCUMENT_TEXT_EDGE_ONLY');
  const doc = await uploadFile('%PDF texto');
  const invC = await manualInvoice({ supplier: supplierA, withFile: false });
  const fileRow = uuid();
  await ok([insert('invoices.invoice_files', fileRow, { invoice_id: invC.id, original_filename: 'scan.pdf', ...doc })]);
  const posted = await app.call(`/api/v1/documents/${doc.file_id}/text`, { body: { source: 'pdf_text', items: [{ str: 'TOTAL FACTURA', page: 1, x: 40, y: 620, w: 70, h: 10 }, { str: '159,00 €', page: 1, x: 450, y: 620, w: 40, h: 10 }] } });
  assert.equal(posted.status, 200, JSON.stringify(posted.data)); assert.equal(posted.data.char_count, 19);
  const again = await app.call(`/api/v1/documents/${doc.file_id}/text`, { body: { items: [{ str: 'Otra lectura', page: 1, x: 1, y: 1 }] } });
  assert.equal(again.status, 200);
  let text = await read('invoices.document_text', { file_id: doc.file_id });
  assert.equal(text.status, 200); assert.equal(text.data.items[0].str, 'Otra lectura'); assert.equal(text.data.sha256, doc.sha256);
  assert.equal((await read('invoices.document_text', { file_id: doc.file_id }, app.tokens.reader)).status, 403);
  assert.equal((await app.call(`/api/v1/documents/${doc.file_id}/text`, { token: app.tokens.reader, body: { items: [] } })).status, 403);
  assert.equal((await app.call(`/api/v1/documents/${uuid()}/text`, { body: { items: [] } })).status, 422);
  const fr = await row('invoices.invoice_files', fileRow);
  await ok([remove('invoices.invoice_files', fileRow, fr.revision)]);
  text = await read('invoices.document_text', { file_id: doc.file_id });
  assert.equal(text.data, null);
});

test('emisor de las emitidas: sin datos en Central queda vacío; con la entidad, se copia al registrar; GET entity; el cliente no lo escribe', async () => {
  // Sin entidad
  const noEntity = await app.call('/api/v1/entity');
  assert.equal(noEntity.status, 200); assert.equal(noEntity.data.entity, null);
  const a = uuid();
  await ok([insert('invoices.issued_invoices', a, { series_code: 'E', number: '2026-0001', issue_date: '2026-10-07', invoice_type: 'F2', description: 'Sin emisor' })]);
  assert.equal((await row('invoices.issued_invoices', a)).issuer_tax_id, null);
  // Con la entidad de Central
  await app.t.db.query(`insert into central.entity (legal_name, trade_name, tax_id, address_line, postal_code, city, province, country, email)
    values ('Ikisai Retiros SL', 'Ikisai', 'B12345674', 'Calle Prueba 1', '28001', 'Madrid', 'Madrid', 'ES', 'hola@example.invalid')`);
  const withEntity = await app.call('/api/v1/entity', { token: app.tokens.reader });
  assert.equal(withEntity.status, 200, JSON.stringify(withEntity.data));
  assert.equal(withEntity.data.entity.legal_name, 'Ikisai Retiros SL'); assert.equal(withEntity.data.logo_url, null);
  assert.equal('logo_path' in withEntity.data.entity, false);
  const b = uuid();
  await ok([insert('invoices.issued_invoices', b, { series_code: 'E', number: '2026-0002', issue_date: '2026-10-07', invoice_type: 'F2', description: 'Con emisor' })]);
  const rb = await row('invoices.issued_invoices', b);
  assert.equal(rb.issuer_tax_id, 'B12345674'); assert.equal(rb.issuer_name, 'Ikisai Retiros SL');
  assert.equal(rb.issuer.trade_name, 'Ikisai'); assert.equal(rb.issuer.city, 'Madrid'); assert.ok(rb.issuer.entity_revision >= 1);
  // Copia del momento: si la entidad cambia, la emitida ya registrada no cambia
  await app.t.db.query(`update central.entity set legal_name = 'Otro nombre SL', revision = revision + 1`);
  assert.equal((await row('invoices.issued_invoices', b)).issuer_name, 'Ikisai Retiros SL');
  // El cliente no puede escribir el emisor
  await rejected([update('invoices.issued_invoices', b, rb.revision, { issuer_name: 'Falso' })], 'INVALID_FIELDS');
});

test('tomar el emisor actual: solo las emitidas sin emisor, nunca sobrescribe ni toca anuladas; lo pone el servidor; queda en el historial', async () => {
  // Sin entidad viva: se registran sin emisor y la acción falla con ENTITY_MISSING
  await app.t.db.query(`update central.entity set deleted_at = now()`);
  const c = uuid(); const d = uuid();
  await ok([
    insert('invoices.issued_invoices', c, { series_code: 'E', number: '2026-0101', issue_date: '2026-10-07', invoice_type: 'F2', description: 'Sin emisor 1' }),
    insert('invoices.issued_invoices', d, { series_code: 'E', number: '2026-0102', issue_date: '2026-10-07', invoice_type: 'F2', description: 'Sin emisor 2' }),
  ]);
  await rejected([call('invoices.take_issuer', { ids: [c] })], 'ENTITY_MISSING');
  const rd = await row('invoices.issued_invoices', d);
  await ok([call('invoices.annul_issued', { issued_invoice_id: d, expectedRevision: rd.revision, reason: 'Prueba' })]);
  await app.t.db.query(`update central.entity set deleted_at = null, legal_name = 'Ikisai Retiros SL'`);
  // Una con emisor ya copiado (no se sobrescribe)
  const e = uuid();
  await ok([insert('invoices.issued_invoices', e, { series_code: 'E', number: '2026-0103', issue_date: '2026-10-07', invoice_type: 'F2', description: 'Con emisor' })]);
  await app.t.db.query(`update central.entity set legal_name = 'Nombre nuevo SL'`);
  // El lector no puede
  await rejected([call('invoices.take_issuer', { ids: [c] })], 'FORBIDDEN', 403, app.tokens.reader);
  // El cliente intenta poner su propio emisor: se descarta y se usa el de Central
  const out = await ok([call('invoices.take_issuer', { ids: [c, d, e], issuer: { tax_id: 'X0000000T', legal_name: 'Falso' } })]);
  assert.deepEqual(out.results[0].result.filled, [c], JSON.stringify(out));
  assert.deepEqual(out.results[0].result.skipped.map((s: { reason: string }) => s.reason).sort(), ['annulled', 'has_issuer']);
  const rc = await row('invoices.issued_invoices', c);
  assert.equal(rc.issuer_name, 'Nombre nuevo SL'); assert.equal(rc.issuer_tax_id, 'B12345674'); assert.equal(rc.issuer.city, 'Madrid');
  assert.equal((await row('invoices.issued_invoices', e)).issuer_name, 'Ikisai Retiros SL');
  assert.equal((await row('invoices.issued_invoices', d)).issuer_tax_id, null);
  const hist = await app.t.db.query<{ actor_id: string | null }>(`select actor_id from core.changes where row_id = $1 and op = 'update' order by cursor desc limit 1`, [c]);
  assert.ok(hist.rows[0]?.actor_id, 'el historial guarda quién lo hizo');
});


test('indicadores para Central (§7.5): columnas del contrato, 29 filas, solo agregados y valores que cuadran', async () => {
  const q = await app.t.db.query<Record<string, any>>(`select * from invoices.central_kpi_projection order by kpi, period`);
  const rowsKpi = q.rows;
  assert.equal(rowsKpi.length, 29);
  assert.deepEqual(Object.keys(rowsKpi[0]!).sort(), ['computed_at', 'direction', 'kpi', 'label', 'link', 'period', 'period_end', 'period_start', 'unit', 'value'].sort());
  const keys = [...new Set(rowsKpi.map((r) => r.kpi))].sort();
  assert.deepEqual(keys, ['invoices.expenses_month', 'invoices.income_issued_month', 'invoices.pending_review', 'invoices.unpaid', 'invoices.unpaid_amount']);
  for (const r of rowsKpi) {
    assert.ok(r.label.length <= 60 && ['count', 'eur'].includes(r.unit) && ['up', 'down'].includes(r.direction) && r.link.startsWith('https://finance.ikisai.com/#/'));
  }
  const months = rowsKpi.filter((r) => r.kpi === 'invoices.income_issued_month').map((r) => r.period);
  assert.equal(months.length, 13); assert.match(months[0], /^\d{4}-\d{2}$/);
  const madrid = await app.t.db.query<{ m: string }>(`select to_char((now() at time zone 'Europe/Madrid')::date, 'YYYY-MM') as m`);
  assert.equal(months[12], madrid.rows[0]!.m);
  // Los valores cuadran con los cálculos directos
  const direct = await app.t.db.query<Record<string, string>>(`select
    (select count(*) from invoices.invoices where deleted_at is null and status in ('pendiente_datos','pendiente_revision')) as pending,
    (select count(*) from invoices.invoices where deleted_at is null and status <> 'anulada' and payment_status = 'pendiente') as unpaid,
    (select coalesce(sum(base_total), 0) from invoices.issued_invoices where deleted_at is null and status <> 'anulada'
      and issue_date between (date_trunc('month', (now() at time zone 'Europe/Madrid')::date) - interval '12 months')::date
      and (date_trunc('month', (now() at time zone 'Europe/Madrid')::date) + interval '1 month' - interval '1 day')::date) as income_window`);
  const val = (k: string) => Number(rowsKpi.find((r) => r.kpi === k)!.value);
  assert.equal(val('invoices.pending_review'), Number(direct.rows[0]!.pending));
  assert.equal(val('invoices.unpaid'), Number(direct.rows[0]!.unpaid));
  // La suma de los 13 meses es la base de las emitidas no anuladas de esa ventana
  const incomeWindow = rowsKpi.filter((r) => r.kpi === 'invoices.income_issued_month').reduce((n, r) => n + Number(r.value), 0);
  assert.equal(Math.round(incomeWindow * 100), Math.round(Number(direct.rows[0]!.income_window) * 100));
  // Registrada para Central
  const reg = await app.t.db.query(`select kind from core.allowed_reads where app = 'central' and name = 'invoices.central_kpi_projection'`);
  assert.deepEqual(reg.rows, [{ kind: 'view' }]);
});

test('huella VERI*FACTU en SQL: los tres ejemplos oficiales de la AEAT (v0.1.2)', async () => {
  const q = await app.t.db.query<{ a: string; b: string; c: string }>(`select
    invoices.vf_hash(invoices.vf_alta_input('89890001K', '12345678/G33', '01-01-2024', 'F1', 12.35, 123.45, null, '2024-01-01T19:20:30+01:00')) a,
    invoices.vf_hash(invoices.vf_alta_input('89890001K', '12345679/G34', '01-01-2024', 'F1', 12.35, 123.45, '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60', '2024-01-01T19:20:35+01:00')) b,
    invoices.vf_hash(invoices.vf_anulacion_input('89890001K', '12345679/G34', '01-01-2024', 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97', '2024-01-01T19:20:40+01:00')) c`);
  assert.equal(q.rows[0]!.a, '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60');
  assert.equal(q.rows[0]!.b, 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97');
  assert.equal(q.rows[0]!.c, '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68');
  const qr = await app.t.db.query<{ u: string; t: string }>(`select invoices.vf_qr_url('pruebas', '89890001K', '12345678&G33', '01-01-2024', 241.4) u,
    invoices.vf_time_text('2026-07-01T10:00:00Z'::timestamptz) || ' ' || invoices.vf_time_text('2026-12-01T10:00:00Z'::timestamptz) t`);
  assert.equal(qr.rows[0]!.u, 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40');
  assert.equal(qr.rows[0]!.t, '2026-07-01T12:00:00+02:00 2026-12-01T11:00:00+01:00');
});

test('emisión (§14): borrador sin número, datos obligatorios, número correlativo en el servidor, cadena de huellas, congelada, anulación del owner', async () => {
  const today = (await app.t.db.query<{ d: string; y: number }>(`select to_char((now() at time zone 'Europe/Madrid')::date, 'YYYY-MM-DD') d, extract(year from (now() at time zone 'Europe/Madrid'))::int y`)).rows[0]!;
  const fmt = (d: string) => d.split('-').reverse().join('-');
  // Series de emisión
  const sf = uuid(); const sr = uuid();
  await rejected([insert('invoices.issued_series', uuid(), { code: 'X', kind: 'ordinaria', mode: 'emision', format: '{serie}{año}' })], 'INVALID_FIELDS');
  await ok([
    insert('invoices.issued_series', sf, { code: 'F', kind: 'ordinaria', mode: 'emision', format: '{serie}{año}-{n:4}', yearly: true }),
    insert('invoices.issued_series', sr, { code: 'R', kind: 'rectificativa', mode: 'emision', format: '{serie}{año}-{n:4}', yearly: true }),
  ]);
  // Borrador: sin número; con número o como registrada se rechaza
  await rejected([insert('invoices.issued_invoices', uuid(), { series_code: 'F', status: 'borrador', number: '1', issue_date: today.d, description: 'x' })], 'INVALID_FIELDS');
  await rejected([insert('invoices.issued_invoices', uuid(), { series_code: 'F', number: '1', issue_date: today.d, description: 'x' })], 'ISSUE_REQUIRES_PROCEDURE');
  const d1 = uuid(); const l1 = uuid();
  await ok([
    insert('invoices.issued_invoices', d1, { series_code: 'F', status: 'borrador', issue_date: today.d, description: 'Estancia de grupo', recipient_name: 'Cliente Emisión SL', recipient_tax_id: 'B55555555', recipient_kind: 'empresa', income_category: 'alojamiento' }),
    insert('invoices.issued_invoice_lines', l1, { issued_invoice_id: d1, description: 'Alojamiento 2 noches', quantity: 2, unit_price: 50, net_amount: 100, vat_rate: 10 }),
  ]);
  let draft = await row('invoices.issued_invoices', d1);
  assert.equal(draft.status, 'borrador'); assert.equal(draft.number, null); assert.equal(draft.origin, 'app');
  // Faltan datos: el domicilio del destinatario (empresa)
  const missing = await rejected([call('invoices.issue', { id: d1, expectedRevision: draft.revision })], 'ISSUE_MISSING_DATA');
  assert.deepEqual(missing.details.missing, ['recipient_address']);
  // El lector no emite
  await rejected([call('invoices.issue', { id: d1 })], 'FORBIDDEN', 403, app.tokens.reader);
  await ok([update('invoices.issued_invoices', d1, draft.revision, { recipient_address: { line: 'Calle Cliente 2', postal_code: '28002', city: 'Madrid', country: 'ES' } })]);
  draft = await row('invoices.issued_invoices', d1);
  const out1 = await ok([call('invoices.issue', { id: d1, expectedRevision: draft.revision, issuer: { tax_id: 'X0000000T', legal_name: 'Falso' } })], app.tokens.editor);
  const r1 = out1.results[0].result;
  assert.equal(r1.full_number, `F${today.y}-0001`);
  const e1 = await row('invoices.issued_invoices', d1);
  assert.equal(e1.status, 'emitida'); assert.equal(e1.number, `F${today.y}-0001`); assert.equal(e1.full_number, `F${today.y}-0001`); assert.equal(e1.issue_date, today.d);
  assert.equal(e1.issuer_tax_id, 'B12345674', 'el emisor lo pone el servidor desde Central');
  assert.equal(e1.base_total, 100); assert.equal(e1.quota_total, 10); assert.equal(e1.total, 110);
  assert.equal(e1.vf_status, 'no_enviar'); assert.match(e1.vf_hash, /^[0-9A-F]{64}$/);
  assert.equal(e1.vf_qr_url, `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674&numserie=F${today.y}-0001&fecha=${fmt(today.d)}&importe=110.00`);
  assert.equal(e1.document.recipient.address.city, 'Madrid'); assert.equal(e1.document.lines.length, 1); assert.equal(e1.document.totals.total, 110);
  assert.equal(e1.issued_by !== null, true);
  // La huella se puede recalcular con el dominio TypeScript
  const rec1 = (await app.t.db.query<Record<string, any>>(`select * from invoices.vf_records where issued_invoice_id = $1`, [d1])).rows[0]!;
  assert.equal(rec1.hash, e1.vf_hash);
  assert.equal(rec1.hash, await vfAltaHash({ issuerTaxId: 'B12345674', numSerie: `F${today.y}-0001`, issueDate: fmt(today.d), invoiceType: 'F1', quotaTotal: 10, amountTotal: 110, previousHash: rec1.previous_hash, generatedAt: rec1.generated_at_text }));
  assert.equal(rec1.payload.IDFactura.NumSerieFactura, `F${today.y}-0001`); assert.equal(rec1.payload.Desglose[0].CuotaRepercutida, '10.00');
  assert.equal(rec1.payload.Destinatarios[0].NIF, 'B55555555'); assert.equal(rec1.payload.SistemaInformatico.NombreSistemaInformatico, 'Ikisai Finance');
  // Emitir otra vez: no
  await rejected([call('invoices.issue', { id: d1 })], 'ISSUED_NOT_DRAFT', 409);
  // Segunda: número siguiente y encadenada a la primera
  const d2 = uuid();
  await ok([
    insert('invoices.issued_invoices', d2, { series_code: 'F', status: 'borrador', issue_date: today.d, description: 'Cena', recipient_name: 'Particular', recipient_tax_id: '00000000T', recipient_kind: 'particular' }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: d2, description: 'Cena', net_amount: 20, vat_rate: 10 }),
  ]);
  const out2 = await ok([call('invoices.issue', { id: d2 })]);
  assert.equal(out2.results[0].result.full_number, `F${today.y}-0002`);
  const rec2 = (await app.t.db.query<Record<string, any>>(`select * from invoices.vf_records where issued_invoice_id = $1`, [d2])).rows[0]!;
  assert.equal(rec2.previous_hash, rec1.hash); assert.equal(rec2.seq, Number(rec1.seq) + 1); assert.equal(rec2.payload.Encadenamiento.RegistroAnterior.Huella, rec1.hash);
  // Congelada: ni datos ni líneas; cobro sí; no se borra
  await rejected([update('invoices.issued_invoices', d1, e1.revision, { description: 'Otra cosa' })], 'ISSUED_FROZEN', 409);
  await rejected([insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: d1, description: 'Extra', net_amount: 5 })], 'ISSUED_FROZEN', 409);
  await rejected([remove('invoices.issued_invoices', d1, e1.revision)], 'ISSUED_NOT_DELETABLE');
  await ok([update('invoices.issued_invoices', d1, e1.revision, { payment_status: 'cobrada', paid_at: today.d })]);
  // La serie ya no cambia de formato
  const series = await row('invoices.issued_series', sf);
  assert.equal(series.counter_last, 2); assert.equal(series.counter_year, today.y);
  await rejected([update('invoices.issued_series', sf, series.revision, { format: '{serie}-{n}' })], 'SERIES_IN_USE', 409);
  // Un borrador se borra
  const d3 = uuid();
  await ok([insert('invoices.issued_invoices', d3, { series_code: 'F', status: 'borrador', issue_date: today.d, description: 'Se borra' })]);
  await ok([remove('invoices.issued_invoices', d3, (await row('invoices.issued_invoices', d3)).revision)]);
  // El registro no lo escribe el cliente ni se altera
  await rejected([insert('invoices.vf_records', uuid(), { hash: 'x' })], 'VF_SERVER_ONLY');
  await assert.rejects(app.t.db.query(`update invoices.vf_records set hash = 'AA' where id = $1`, [rec1.id]), /VF_IMMUTABLE/);
  await assert.rejects(app.t.db.query(`delete from invoices.vf_records where id = $1`, [rec1.id]), /VF_IMMUTABLE/);
  // Lectura para la ficha
  const vr = await read('invoices.vf_records_of', { issued_invoice_id: d1 }, app.tokens.reader);
  assert.equal(vr.status, 200, JSON.stringify(vr.data));
  assert.equal(vr.data.records.length, 1); assert.equal(vr.data.settings.sending, 'apagado');
  // Anular una emitida: solo el owner, con registro de anulación encadenado
  const e2 = await row('invoices.issued_invoices', d2);
  await rejected([call('invoices.annul_issued', { issued_invoice_id: d2, expectedRevision: e2.revision, reason: 'No llegó al cliente' })], 'FORBIDDEN', 403, app.tokens.editor);
  await ok([call('invoices.annul_issued', { issued_invoice_id: d2, expectedRevision: e2.revision, reason: 'No llegó al cliente' })]);
  assert.equal((await row('invoices.issued_invoices', d2)).status, 'anulada');
  const an = (await app.t.db.query<Record<string, any>>(`select * from invoices.vf_records where issued_invoice_id = $1 and record_kind = 'anulacion'`, [d2])).rows[0]!;
  assert.equal(an.previous_hash, rec2.hash);
  assert.equal(an.hash, await vfAnulacionHash({ issuerTaxId: 'B12345674', numSerie: `F${today.y}-0002`, issueDate: fmt(today.d), previousHash: rec2.hash, generatedAt: an.generated_at_text }));
  // Resumen: la emitida cuenta, el borrador no
  const d4 = uuid();
  await ok([insert('invoices.issued_invoices', d4, { series_code: 'F', status: 'borrador', issue_date: today.d, description: 'Borrador vivo' }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: d4, description: 'x', net_amount: 1000, vat_rate: 21 })]);
  const sum = await read('invoices.issued_summary', { from: today.d, to: today.d });
  assert.equal(sum.status, 200, JSON.stringify(sum.data));
  const counted = await app.t.db.query<{ n: string; b: string }>(`select count(*) n, coalesce(sum(base_total), 0) b from invoices.issued_invoices
    where deleted_at is null and status in ('registrada', 'emitida', 'rectificada') and issue_date = $1`, [today.d]);
  assert.equal(sum.data.invoices.registrada, Number(counted.rows[0]!.n));
  assert.equal(sum.data.base, Number(counted.rows[0]!.b));
  // Cerrar una serie de registro (la de la hoja, owner): ya no admite más
  await ok([insert('invoices.issued_series', uuid(), { code: 'H', kind: 'ordinaria' })]);
  await rejected([call('invoices.close_series', { code: 'H', last_number: '2026-0103' })], 'FORBIDDEN', 403, app.tokens.editor);
  await ok([call('invoices.close_series', { code: 'H', last_number: '2026-0103' })]);
  await rejected([insert('invoices.issued_invoices', uuid(), { series_code: 'H', number: '2026-0999', issue_date: today.d, invoice_type: 'F2', description: 'Tarde' })], 'SERIES_CLOSED', 409);
});


test('rectificativas (§14.3): borrador desde una emitida, por diferencias en negativo o por sustitución; al emitir, la original queda rectificada', async () => {
  const today = (await app.t.db.query<{ d: string; y: number }>(`select to_char((now() at time zone 'Europe/Madrid')::date, 'YYYY-MM-DD') d, extract(year from (now() at time zone 'Europe/Madrid'))::int y`)).rows[0]!;
  // Una emitida en F (las series F y R y la entidad vienen de la prueba de emisión)
  const f = uuid();
  await ok([
    insert('invoices.issued_invoices', f, { series_code: 'F', status: 'borrador', issue_date: today.d, description: 'Retiro para rectificar', recipient_name: 'Cliente Rect SL', recipient_tax_id: 'B66666666',
      recipient_address: { line: 'Calle 3', postal_code: '28003', city: 'Madrid', country: 'ES' } }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: f, position: 0, description: 'Alojamiento', quantity: 3, unit_price: 100, net_amount: 300, vat_rate: 10 }),
  ]);
  const issued = (await ok([call('invoices.issue', { id: f })])).results[0].result;
  // No se rectifica un borrador ni una registrada de otra herramienta; el lector no rectifica
  const draftOnly = uuid();
  await ok([insert('invoices.issued_invoices', draftOnly, { series_code: 'F', status: 'borrador', issue_date: today.d, description: 'Borrador' })]);
  await rejected([call('invoices.rectify', { id: draftOnly, reason: 'x' })], 'RECTIFY_NOT_ISSUED');
  await rejected([call('invoices.rectify', { id: f, reason: 'x' })], 'FORBIDDEN', 403, app.tokens.reader);
  await rejected([call('invoices.rectify', { id: f, reason: '' })], 'INVALID_ARGS');
  // Por diferencias: líneas en negativo
  const outI = await ok([call('invoices.rectify', { id: f, kind: 'I', reason_code: 'R4', reason: 'Devolución de la estancia' })], app.tokens.editor);
  const rI = outI.results[0].result.id as string;
  const draftI = await row('invoices.issued_invoices', rI);
  assert.equal(draftI.status, 'borrador'); assert.equal(draftI.series_code, 'R'); assert.equal(draftI.invoice_type, 'R4'); assert.equal(draftI.rectification_kind, 'I');
  assert.equal(draftI.rectified[0].issued_invoice_id, f); assert.equal(draftI.rectified[0].full_number, issued.full_number);
  assert.equal(draftI.recipient_tax_id, 'B66666666'); assert.equal(draftI.base_total, -300); assert.equal(draftI.total, -330);
  const linesI = await rows('invoices.issued_invoice_lines', (l) => l.issued_invoice_id === rI);
  assert.deepEqual(linesI.map((l) => [l.net_amount, l.unit_price, l.vat_rate]), [[-300, -100, 10]]);
  // Emitirla: R{año}-000N, la original pasa a rectificada y anota la rectificativa
  const outIssue = (await ok([call('invoices.issue', { id: rI })])).results[0].result;
  assert.match(outIssue.full_number, new RegExp(`^R${today.y}-\\d{4}$`));
  const orig = await row('invoices.issued_invoices', f);
  assert.equal(orig.status, 'rectificada'); assert.deepEqual(orig.rectified_by.map((r: any) => r.full_number), [outIssue.full_number]);
  const recR = (await app.t.db.query<Record<string, any>>(`select * from invoices.vf_records where issued_invoice_id = $1`, [rI])).rows[0]!;
  assert.equal(recR.payload.TipoFactura, 'R4'); assert.equal(recR.payload.TipoRectificativa, 'I');
  assert.equal(recR.payload.FacturasRectificadas[0].full_number, issued.full_number);
  assert.equal(recR.payload.ImporteTotal, '-330.00'); assert.equal(recR.payload.CuotaTotal, '-30.00');
  assert.equal(recR.hash, await vfAltaHash({ issuerTaxId: 'B12345674', numSerie: outIssue.full_number, issueDate: today.d.split('-').reverse().join('-'), invoiceType: 'R4',
    quotaTotal: -30, amountTotal: -330, previousHash: recR.previous_hash, generatedAt: recR.generated_at_text }));
  // La original rectificada sigue congelada; se puede volver a rectificar (por sustitución, con base y cuota rectificadas)
  await rejected([update('invoices.issued_invoices', f, orig.revision, { description: 'Cambio' })], 'ISSUED_FROZEN', 409);
  const outS = await ok([call('invoices.rectify', { id: f, kind: 'S', reason_code: 'R1', reason: 'NIF del cliente erróneo' })]);
  const draftS = await row('invoices.issued_invoices', outS.results[0].result.id);
  assert.equal(draftS.rectification_kind, 'S'); assert.equal(draftS.rectified_base, 300); assert.equal(draftS.rectified_quota, 30); assert.equal(draftS.base_total, 300);
});


test('IVA incluido (§14.8): con la cuota exacta por línea, la emitida suma exactamente el importe de la reserva', async () => {
  const today = (await app.t.db.query<{ d: string }>(`select to_char((now() at time zone 'Europe/Madrid')::date, 'YYYY-MM-DD') d`)).rows[0]!;
  const id = uuid();
  await ok([
    insert('invoices.issued_invoices', id, { series_code: 'F', status: 'borrador', issue_date: today.d, description: 'Reserva con IVA incluido', recipient_name: 'Asociación Prueba',
      recipient_tax_id: 'G12345678', recipient_address: { line: 'Calle 9', postal_code: '48001', city: 'Bilbao' }, prices_include_vat: true }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: id, position: 0, description: 'Masaje', quantity: 3, unit_price: 27.5455, discount_amount: 4.13, net_amount: 78.5, vat_rate: 21, vat_amount: 16.49 }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: id, position: 1, description: 'Alojamiento', quantity: 20, unit_price: 50, net_amount: 1000, vat_rate: 10, vat_amount: 100 }),
  ]);
  await ok([call('invoices.issue', { id })]);
  const inv = await row('invoices.issued_invoices', id);
  assert.equal(inv.status, 'emitida'); assert.equal(inv.base_total, 1078.5); assert.equal(inv.quota_total, 116.49); assert.equal(inv.total, 1194.99);
  assert.equal(inv.document.totals.total, 1194.99);
  assert.deepEqual(inv.document.breakdown.map((b: any) => [b.rate, b.base, b.quota]), [[10, 1000, 100], [21, 78.5, 16.49]]);
});

test('directorio de clientes (ronda 46): un NIF por país, NIF normalizado, solo editor y owner escriben', async () => {
  const c = uuid();
  await ok([insert('invoices.customers', c, { name: 'Asociación Yoga Norte', tax_id: 'G12345678', kind: 'empresa', address: { line: 'Calle del Norte 5', postal_code: '48001', city: 'Bilbao' } })]);
  const row1 = await row('invoices.customers', c);
  assert.equal(row1.country, 'ES'); assert.equal(row1.id_type, 'NIF');
  await rejected([insert('invoices.customers', uuid(), { name: 'Otra', tax_id: 'G12345678' })], 'CONSTRAINT_VIOLATION');
  await ok([insert('invoices.customers', uuid(), { name: 'Misma cifra en Francia', tax_id: 'G12345678', country: 'FR', id_type: '02' })]);
  await rejected([insert('invoices.customers', uuid(), { name: 'Minúsculas', tax_id: 'g 123' })], 'INVALID_FIELDS');
  await rejected([insert('invoices.customers', uuid(), { name: 'Con teléfono', tax_id: 'B10000001', phone: '600000000' })], 'INVALID_FIELDS');
  await rejected([insert('invoices.customers', uuid(), { name: 'Lector', tax_id: 'B10000002' })], 'FORBIDDEN', 403, app.tokens.reader);
  await ok([update('invoices.customers', c, row1.revision, { address: { line: 'Calle Nueva 1', postal_code: '48002', city: 'Bilbao' } })], app.tokens.editor);
  assert.equal((await row('invoices.customers', c)).address.line, 'Calle Nueva 1');
});

test('campos de archivo (§3.9): documentos de facturas legales, extracciones y texto operativos, ZIP temporal; recogida activada', async () => {
  const q = await app.t.db.query<{ t: string; retention: string }>(`select table_name || '.' || column_name t, retention from core.file_fields where schema_name = 'invoices' order by 1`);
  assert.deepEqual(q.rows.map((r) => `${r.t}:${r.retention}`), [
    'document_texts.file_id:operational', 'exports.zip_file_id:temporary', 'extractions.file_id:operational',
    'invoice_files.file_id:legal', 'issued_invoice_files.file_id:legal',
  ]);
  const gc = await app.t.db.query(`select 1 from core.file_gc_apps where app = 'invoices'`);
  assert.equal(gc.rows.length, 1);
});

test('numeración como dato de la serie (ronda 47): continuar F_02_26 con F_03_26, sin huecos; año de la serie; sin recortar', async () => {
  const today = (await app.t.db.query<{ d: string; y: number }>(`select to_char((now() at time zone 'Europe/Madrid')::date, 'YYYY-MM-DD') d, extract(year from (now() at time zone 'Europe/Madrid'))::int y`)).rows[0]!;
  const yy = String(today.y % 100).padStart(2, '0');
  const fmt = await app.t.db.query<{ a: string; b: string }>(`select invoices.format_issued_number('{serie}_{n:2}_{aa}', 'F', 2026, 3) a, invoices.format_issued_number('{serie}_{n:2}_{aa}', 'F', 2026, 100) b`);
  assert.deepEqual(fmt.rows[0], { a: 'F_03_26', b: 'F_100_26' });
  // Serie con el formato de la hoja y su año; el último emitido fuera de Finance fue el 2
  const g = uuid();
  await ok([insert('invoices.issued_series', g, { code: 'G', kind: 'ordinaria', mode: 'emision', format: '{serie}_{n:2}_{aa}', yearly: true, valid_year: today.y })]);
  await rejected([call('invoices.series_start', { code: 'G', last_number: 2 })], 'FORBIDDEN', 403, app.tokens.reader);
  const start = await ok([call('invoices.series_start', { code: 'G', last_number: 2, year: today.y })]);
  assert.equal(start.results[0].result.next, `G_03_${yy}`);
  const draft = async (description: string) => {
    const id = uuid();
    await ok([
      insert('invoices.issued_invoices', id, { series_code: 'G', status: 'borrador', issue_date: today.d, description, recipient_name: 'Cliente Hoja SL', recipient_tax_id: 'B77777777',
        recipient_address: { line: 'Calle 7', postal_code: '28007', city: 'Madrid' } }),
      insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: id, description: 'Servicio', net_amount: 10, vat_rate: 21 }),
    ]);
    return id;
  };
  const first = (await ok([call('invoices.issue', { id: await draft('Primera de la serie G') })])).results[0].result;
  const second = (await ok([call('invoices.issue', { id: await draft('Segunda de la serie G') })])).results[0].result;
  assert.deepEqual([first.full_number, second.full_number], [`G_03_${yy}`, `G_04_${yy}`]);
  // Con emitidas, el comienzo ya no se cambia
  await rejected([call('invoices.series_start', { code: 'G', last_number: 10 })], 'SERIES_IN_USE', 409);
  // Una serie de otro año no emite (la de 2027 será otra serie, creada en su año)
  await ok([insert('invoices.issued_series', uuid(), { code: 'GV', kind: 'ordinaria', mode: 'emision', format: '{serie}{año}-{n:4}', valid_year: today.y - 1 })]);
  const old = uuid();
  await ok([
    insert('invoices.issued_invoices', old, { series_code: 'GV', status: 'borrador', issue_date: today.d, description: 'Serie vieja', recipient_name: 'Cliente', recipient_tax_id: 'B77777777',
      recipient_address: { line: 'Calle 7', postal_code: '28007', city: 'Madrid' } }),
    insert('invoices.issued_invoice_lines', uuid(), { issued_invoice_id: old, description: 'x', net_amount: 1, vat_rate: 21 }),
  ]);
  await rejected([call('invoices.issue', { id: old })], 'SERIES_YEAR_MISMATCH');
  await rejected([insert('invoices.issued_series', uuid(), { code: 'GX', kind: 'ordinaria', mode: 'emision', format: '{serie}{año}-{n:4}', valid_year: 1999 })], 'INVALID_FIELDS');
});
