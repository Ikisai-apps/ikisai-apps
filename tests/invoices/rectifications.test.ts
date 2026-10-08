/**
 * Invoices · facturas rectificativas RECIBIDAS (migración 0227, API.md §2.1) contra PGlite a través de `invoices-api`:
 * enlace con la original en los dos sentidos, líneas devueltas, signo, validación, asignaciones y otro trimestre.
 * Año 2025 para no cruzarse con los totales de las otras pruebas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { buildImportArgs, detectRectification, importDocumentSha256, invoicesCsv, negateDocument, proposeRectificationAllocations, type ImportDocument } from '../../packages/domain-invoices/src/index.ts';

let app: TestApp;
let counter = 0;
const uuid = () => crypto.randomUUID();
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `rect-${++counter}`, operations } });
async function ok(operations: unknown[]) { const r = await commit(operations); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function rejected(operations: unknown[], code: string) { const r = await commit(operations); assert.equal(r.status, 422, JSON.stringify(r.data)); assert.equal(r.data.error.code, code, JSON.stringify(r.data)); return r.data.error; }
async function rows(table: string, where: (r: Record<string, any>) => boolean = () => true) {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1`);
  return (snap.data.tables[0].rows as Array<Record<string, any>>).filter(where);
}
const row = async (table: string, id: string) => (await rows(table, (r) => r.id === id))[0]!;
async function uploadFile(content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'abono.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
  app.supabase.storage.set(ticket.data.path, bytes);
  await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
  return { file_id: ticket.data.id as string, mime_type: 'application/pdf', size_bytes: bytes.byteLength, sha256: sha };
}

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
});

/** Documento ikisai.invoice.v1 con líneas al 21 % (importes con su signo). */
function doc(supplier: { name: string; tax_id: string }, number: string, date: string, lines: Array<[string, number]>, notes: string | null = null): ImportDocument {
  const base = Math.round(lines.reduce((n, [, v]) => n + v, 0) * 100) / 100;
  const vat = Math.round(base * 21) / 100;
  return {
    schema_version: 'ikisai.invoice.v1',
    invoice: { invoice_date: date, supplier_name: supplier.name, supplier_tax_id: supplier.tax_id, invoice_number: number, object: 'material obra', currency: 'EUR', deductibility_suggestion: null, notes: null },
    lines: lines.map(([description, net]) => ({ description, quantity: null, unit: null, unit_price: null, discount_amount: null, net_amount: net, vat_rate: 21, vat_amount: Math.round(net * 21) / 100, gross_amount: null, suggested_item_type: null, suggested_match_name: null, confidence: 0.9, notes: null })),
    taxes: [{ tax_type: 'iva', rate: 21, taxable_base: base, amount: vat, notes: null }],
    document_totals: { base, vat, withholding: 0, total: Math.round((base + vat) * 100) / 100 },
    overall_confidence: 0.9, extraction_notes: notes,
  } as unknown as ImportDocument;
}

/** Importa un documento como factura (con su PDF) y, si se pide, la valida. */
async function importDoc(document: ImportDocument, overrides: Record<string, unknown>, supplierId: string | null, opts: { validate?: boolean } = {}) {
  const invoiceId = uuid(); let n = 0;
  const file = await uploadFile(`%PDF ${invoiceId}`);
  const args = buildImportArgs({ document, documentSha256: await importDocumentSha256(document), invoiceId,
    supplier: supplierId ? { mode: 'existing', id: supplierId } : { mode: 'create', id: uuid() },
    overrides: { expense_category: 'compras', ...overrides } as never,
    files: [{ file_id: file.file_id, original_filename: 'doc.pdf', page_order: 1 }], uuid: () => `${invoiceId.slice(0, 24)}${(++n).toString(16).padStart(12, '0')}` });
  await ok([call('invoices.import_v1', args as unknown as Record<string, unknown>)]);
  if (opts.validate) await ok([call('invoices.validate', { invoice_id: invoiceId })]);
  return invoiceId;
}

const OBRAMAT = { name: 'Obramat Ejemplo SL', tax_id: 'B11111119' };

test('rectificativa parcial por líneas: se enlaza con la original, empareja la línea devuelta, se valida y resta en el resumen', async () => {
  const original = await importDoc(doc(OBRAMAT, 'OBR-100', '2025-02-10', [['Taladro percutor', 100], ['Caja de brocas', 50]]), {}, null, { validate: true });
  const supplierId = (await row('invoices.invoices', original)).supplier_id;
  // El abono solo trae la línea devuelta, en negativo, y «rectifica a la factura OBR 100» (otro formato del número)
  const rect = await importDoc(doc(OBRAMAT, 'ABO-7', '2025-02-20', [['Caja de brocas', -50]], 'Factura rectificativa. Rectifica a la factura OBR 100'),
    { invoice_kind: 'rectificativa', rectifies_number: 'OBR 100' }, supplierId);
  const r = await row('invoices.invoices', rect);
  assert.equal(r.invoice_kind, 'rectificativa');
  assert.equal(r.rectifies_invoice_id, original, 'enlazada al importar');
  assert.equal(Number(r.calculated_total), -60.5);
  const returned = (await rows('invoices.invoice_lines', (l) => l.invoice_id === rect))[0]!;
  const brocas = (await rows('invoices.invoice_lines', (l) => l.invoice_id === original && l.description === 'Caja de brocas'))[0]!;
  assert.equal(returned.rectifies_line_id, brocas.id, 'línea devuelta emparejada');
  await ok([call('invoices.validate', { invoice_id: rect })]);
  const summary = (await app.call('/api/v1/read/invoices.fiscal_summary', { body: { year: 2025, quarter: 1 } })).data;
  assert.equal(Number(summary.base), 100); assert.equal(Number(summary.vat), 21); assert.equal(Number(summary.total), 121);
});

test('rectificativa que llega antes que la original: no se valida hasta enlazarla; al llegar la original se enlaza sola; «no tengo la original» también vale', async () => {
  const s = { name: 'Ferretería Ejemplo SL', tax_id: 'B22222228' };
  const rect = await importDoc(doc(s, 'R-1', '2025-03-05', [['Escalera', -80]], 'Abono'), { invoice_kind: 'rectificativa', rectifies_number: 'F-900' }, null);
  const r = await row('invoices.invoices', rect);
  assert.equal(r.rectifies_invoice_id, null, 'pendiente de enlazar');
  const e = await rejected([call('invoices.validate', { invoice_id: rect })], 'INVOICE_INCOMPLETE');
  assert.deepEqual(e.details.missing, ['rectified_invoice']);
  const original = await importDoc(doc(s, 'F-900', '2025-03-01', [['Escalera', 80], ['Cinta', 20]]), {}, r.supplier_id);
  assert.equal((await row('invoices.invoices', rect)).rectifies_invoice_id, original, 'enlazada al llegar la original');
  await ok([call('invoices.validate', { invoice_id: rect })]);

  // Otra sin original: con «no tengo la original» se valida
  const lonely = await importDoc(doc(s, 'R-2', '2025-03-06', [['Pintura', -10]], 'Abono'), { invoice_kind: 'rectificativa', rectifies_number: 'NO-EXISTE' }, r.supplier_id);
  await rejected([call('invoices.validate', { invoice_id: lonely })], 'INVOICE_INCOMPLETE');
  const lr = await row('invoices.invoices', lonely);
  await ok([update('invoices.invoices', lonely, lr.revision, { rectification_without_original: true })]);
  await ok([call('invoices.validate', { invoice_id: lonely })]);
  // Una rectificativa con total positivo no se valida
  const wrong = await importDoc(doc(s, 'R-3', '2025-03-07', [['Pintura', 10]], 'Abono'), { invoice_kind: 'rectificativa', rectifies_number: 'F-900' }, r.supplier_id);
  const w = await rejected([call('invoices.validate', { invoice_id: wrong })], 'INVOICE_INCOMPLETE');
  assert.ok(w.details.missing.includes('rectification_sign'));
});

test('signo: una ordinaria no lleva impuestos negativos; las asignaciones de una rectificativa son negativas y no pasan de su línea', async () => {
  const s = { name: 'Signo Ejemplo SL', tax_id: 'B33333337' };
  const original = await importDoc(doc(s, 'S-1', '2025-04-02', [['Cemento', 200]]), {}, null, { validate: true });
  const ordLine = (await rows('invoices.invoice_lines', (l) => l.invoice_id === original))[0]!;
  const ordTax = (await rows('invoices.tax_lines', (t) => t.invoice_id === original))[0]!;
  await rejected([update('invoices.tax_lines', ordTax.id, ordTax.revision, { amount: -1 })], 'NEGATIVE_TAX_IN_ORDINARY');
  await ok([insert('invoices.allocations', uuid(), { invoice_line_id: ordLine.id, target_app: 'general', target_kind: 'operating_expense', target_label: 'Gasto de explotación', allocated_amount: 200 })]);
  const rect = await importDoc(doc(s, 'SR-1', '2025-04-09', [['Cemento', -50]], 'Rectificativa'), { invoice_kind: 'rectificativa', rectifies_number: 'S-1' }, (await row('invoices.invoices', original)).supplier_id);
  const rectLine = (await rows('invoices.invoice_lines', (l) => l.invoice_id === rect))[0]!;
  const alloc = (amount: number) => insert('invoices.allocations', uuid(), { invoice_line_id: rectLine.id, target_app: 'general', target_kind: 'operating_expense', target_label: 'Gasto de explotación', allocated_amount: amount });
  await rejected([alloc(30)], 'ALLOCATIONS_EXCEED_LINE');
  await rejected([alloc(-60)], 'ALLOCATIONS_EXCEED_LINE');
  await ok([alloc(-50)]);
});

test('rectificativa de otro trimestre: cuenta en el de su fecha; el de la original no cambia', async () => {
  const s = { name: 'Trimestre Ejemplo SL', tax_id: 'B44444446' };
  const original = await importDoc(doc(s, 'T-1', '2025-08-10', [['Bombilla', 40]]), {}, null, { validate: true });
  const q3 = (await app.call('/api/v1/read/invoices.fiscal_summary', { body: { year: 2025, quarter: 3 } })).data;
  const rect = await importDoc(doc(s, 'TR-1', '2025-10-02', [['Bombilla', -40]], 'Abono'), { invoice_kind: 'rectificativa', rectifies_number: 'T-1' }, (await row('invoices.invoices', original)).supplier_id, { validate: true });
  assert.equal((await row('invoices.invoices', rect)).rectifies_invoice_id, original);
  const q3After = (await app.call('/api/v1/read/invoices.fiscal_summary', { body: { year: 2025, quarter: 3 } })).data;
  const q4 = (await app.call('/api/v1/read/invoices.fiscal_summary', { body: { year: 2025, quarter: 4 } })).data;
  assert.equal(Number(q3After.base), Number(q3.base));
  assert.equal(Number(q4.base), -40); assert.equal(Number(q4.vat), -8.4);
  // Entrega del 4T: va como rectificativa con la referencia a la original (de otro periodo) en el manifest y en el CSV
  const manifest = (await app.t.db.query<{ m: any }>(`select invoices.export_manifest('2025-10-01', '2025-12-31', 'quarter', 2025, 4, 'prueba') m`)).rows[0]!.m;
  const item = manifest.invoices.find((i: any) => i.id === rect);
  assert.equal(item.kind, 'rectificativa');
  assert.deepEqual({ number: item.rectifies.invoice_number, date: item.rectifies.invoice_date, other: item.rectifies.other_period }, { number: 'T-1', date: '2025-08-10', other: true });
  const csv = invoicesCsv(manifest);
  assert.ok(csv.split(String.fromCharCode(13, 10))[0]!.endsWith(';tipo;rectifica;fecha_original;original_otro_periodo'));
  assert.ok(csv.includes(';R;T-1;2025-08-10;si'), csv);
});

test('dominio: detección, documento en negativo y reparto proporcional como la original', () => {
  const d = doc(OBRAMAT, 'ABO-1', '2025-02-20', [['Brocas', 50]], null);
  assert.deepEqual(detectRectification({ text: 'FACTURA RECTIFICATIVA\nRectifica a la factura nº: OBR-100\nTotal 60,50', document: d }), { isRectification: true, number: 'OBR-100', evidence: 'FACTURA RECTIFICATIVA' });
  assert.equal(detectRectification({ text: 'Factura nº 12\nTotal 30', document: d }).isRectification, false);
  assert.equal(detectRectification({ document: negateDocument(d) }).isRectification, true, 'total negativo');
  const neg = negateDocument(d);
  assert.deepEqual([neg.lines[0]!.net_amount, neg.taxes[0]!.amount, neg.document_totals.total], [-50, -10.5, -60.5]);
  const alloc = (line: string, label: string, amount: number) => ({ invoice_line_id: line, target_app: 'tasks', target_kind: 'project', target_id: label, target_code: null, target_label: label, target_revision: 1, allocated_amount: amount });
  const proposed = proposeRectificationAllocations({
    rectLines: [{ id: 'r1', net_amount: -50, rectifies_line_id: 'o2' }, { id: 'r2', net_amount: -10 }],
    originalLines: [{ id: 'o1', net_amount: 100 }, { id: 'o2', net_amount: 50 }],
    originalAllocations: [alloc('o1', 'Obra A', 100), alloc('o2', 'Obra A', 30), alloc('o2', 'Obra B', 20)],
  });
  assert.deepEqual(proposed.map((p) => [p.invoice_line_id, p.target_label, p.allocated_amount]),
    [['r1', 'Obra A', -30], ['r1', 'Obra B', -20], ['r2', 'Obra A', -6.67], ['r2', 'Obra A', -2], ['r2', 'Obra B', -1.33]]);
});
