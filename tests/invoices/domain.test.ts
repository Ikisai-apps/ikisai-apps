/** Invoices · pruebas del dominio compartido (`supabase/functions/_domain/invoices`). Se ejecutan con `tsx --test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DomainError, EXPENSE_CATEGORIES, TABLES, WRITABLE, buildImportArgs, derivedTaxes, exportFolderName, findDuplicateInvoice, fiscalSummary, formatEur,
  importDocumentSha256, matchSupplier, normalizedFilename, parseImportDocument, proposeImport, purchaseItems, quarterRange, recalculate, round2, slugify,
  stableStringify, toCents, validateImportDocument, validateRowFields, withinTolerance,
  type AllocationRow, type ImportDocument, type InvoiceLineRow, type InvoiceRow, type SupplierRow, type TaxLineRow,
} from '../../packages/domain-invoices/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE: ImportDocument = JSON.parse(fs.readFileSync(path.join(here, '../core/fixtures/invoice-import-v1.example.json'), 'utf8'));

const NOW = '2026-10-06T10:00:00.000Z';
const common = (id: string) => ({ id, revision: 1, created_at: NOW, updated_at: NOW, updated_by: null, deleted_at: null });
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function supplier(n: number, extra: Partial<SupplierRow> = {}): SupplierRow {
  return { ...common(uid(n)), name: `Proveedor ${n}`, tax_id: null, default_category: null, default_is_investment: false, aliases: [], slug: `proveedor_${n}`, notes: null, ...extra };
}

function invoice(n: number, extra: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    ...common(uid(100 + n)), code: `FVR_2026_${String(n).padStart(3, '0')}`, supplier_id: uid(1), invoice_date: '2026-10-05', object: 'alimentos', invoice_number: `F-${n}`,
    currency: 'EUR', due_date: null, expense_category: 'compras', is_investment: false, deductibility: 'si', status: 'validada', review_reason: null, annulled_reason: null,
    payment_status: 'pendiente', payment_method: null, paid_at: null, source_total: 110, calculated_base: 100, calculated_vat: 10, calculated_other: 0, calculated_withholding: 0,
    calculated_total: 110, totals_delta: 0, source: 'manual', import_sha256: null, import_meta: null, fiscal_year: 2026, fiscal_quarter: 4, fiscal_period: '2026T4', notes: null, ...extra,
  };
}

function line(n: number, invoiceId: string, extra: Partial<InvoiceLineRow> = {}): InvoiceLineRow {
  return {
    ...common(uid(200 + n)), invoice_id: invoiceId, position: n, description: `Artículo ${n}`, quantity: 10, unit: 'kg', unit_price: 5, discount_amount: 0, net_amount: 50,
    vat_rate: 10, vat_amount: 5, gross_amount: 55, item_type: 'food_ingredient', match_name: null, expense_category: null, is_investment: null, confidence: null, notes: null, ...extra,
  };
}

function tax(n: number, invoiceId: string, extra: Partial<TaxLineRow> = {}): TaxLineRow {
  return { ...common(uid(300 + n)), invoice_id: invoiceId, position: n, tax_type: 'iva', rate: 10, taxable_base: 100, amount: 10, notes: null, ...extra };
}

function allocation(n: number, lineId: string, invoiceId: string, extra: Partial<AllocationRow> = {}): AllocationRow {
  return { ...common(uid(400 + n)), invoice_line_id: lineId, invoice_id: invoiceId, target_app: 'general', target_kind: 'operating_expense', target_id: null, target_code: null, target_label: 'Gasto de explotación', target_revision: null, allocated_quantity: null, allocated_amount: 20, notes: null, ...extra };
}

function failsWith(fn: () => void): string {
  try { fn(); } catch (error) { assert.ok(error instanceof DomainError, String(error)); return error.code; }
  return 'OK';
}

// ---------------------------------------------------------------------------

test('dinero: redondeo a céntimos como PostgreSQL y tolerancia de 0,02 €', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.ok(withinTolerance(100, 100.02));
  assert.equal(withinTolerance(100, 100.03), false);
  assert.equal(formatEur(1234.5), '1.234,50');
  assert.equal(formatEur(-0.07, true), '-0,07 €');
});

test('schema ikisai.invoice.v1: el ejemplo del handoff valida; errores con ruta', () => {
  const ok = validateImportDocument(EXAMPLE);
  assert.ok(ok.ok, JSON.stringify(ok));
  const unknownKey = validateImportDocument({ ...EXAMPLE, invoice: { ...EXAMPLE.invoice, foo: 1 } });
  assert.ok(!unknownKey.ok && unknownKey.errors.some((e) => e.path === '$.invoice.foo'));
  const noTotals = validateImportDocument({ ...EXAMPLE, document_totals: undefined });
  assert.ok(!noTotals.ok && noTotals.errors.some((e) => e.path === '$.document_totals' && e.reason === 'obligatorio'));
  const badVersion = validateImportDocument({ ...EXAMPLE, schema_version: 'ikisai.invoice.v2' });
  assert.ok(!badVersion.ok && badVersion.errors[0]!.path === '$.schema_version');
  const emptyLines = validateImportDocument({ ...EXAMPLE, lines: [] });
  assert.ok(!emptyLines.ok && emptyLines.errors.some((e) => e.path === '$.lines'));
  const badTax = validateImportDocument({ ...EXAMPLE, taxes: [{ tax_type: 'igic', amount: 1 }] });
  assert.ok(!badTax.ok && badTax.errors.some((e) => e.path === '$.taxes[0].tax_type'));
  const badDate = validateImportDocument({ ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_date: '05/10/2026' } });
  assert.ok(!badDate.ok && badDate.errors.some((e) => e.path === '$.invoice.invoice_date'));
  const badConfidence = validateImportDocument({ ...EXAMPLE, overall_confidence: 1.2 });
  assert.ok(!badConfidence.ok);
  const nullOk = validateImportDocument({ ...EXAMPLE, lines: [{ description: 'x', net_amount: 1, quantity: null, vat_rate: null }] });
  assert.ok(nullOk.ok);
  const parsed = parseImportDocument('{ no es json');
  assert.ok(!parsed.ok && parsed.errors[0]!.path === '$');
});

test('sha256 canónico del documento no depende del orden de las claves', async () => {
  const a = await importDocumentSha256(EXAMPLE);
  const reordered = JSON.parse(stableStringify({ lines: EXAMPLE.lines, taxes: EXAMPLE.taxes, invoice: EXAMPLE.invoice, document_totals: EXAMPLE.document_totals, schema_version: EXAMPLE.schema_version, extraction_notes: null, overall_confidence: 0.98 }));
  assert.equal(await importDocumentSha256(reordered), a);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('recálculo: el ejemplo cuadra; desglose por tipos; retenciones restan; derivación desde líneas', () => {
  const r = recalculate(
    EXAMPLE.lines.map((l) => ({ ...l })),
    EXAMPLE.taxes.map((t) => ({ ...t })),
    EXAMPLE.document_totals,
  );
  assert.equal(r.calculated_base, 40); assert.equal(r.calculated_vat, 4); assert.equal(r.calculated_total, 44);
  assert.equal(r.totals_delta, 0); assert.equal(r.within_tolerance, true); assert.deepEqual(r.warnings, []);

  const mixed = recalculate(
    [{ net_amount: 100, vat_rate: 21, vat_amount: 21 }, { net_amount: 50, vat_rate: 10, vat_amount: 5 }],
    [{ tax_type: 'iva', rate: 21, taxable_base: 100, amount: 21 }, { tax_type: 'iva', rate: 10, taxable_base: 50, amount: 5 }, { tax_type: 'irpf', rate: 15, taxable_base: 150, amount: 22.5 }],
    { base: 150, vat: 26, withholding: 22.5, total: 153.5 },
  );
  assert.equal(mixed.calculated_base, 150); assert.equal(mixed.calculated_vat, 26); assert.equal(mixed.calculated_withholding, 22.5); assert.equal(mixed.calculated_total, 153.5);
  assert.deepEqual(mixed.vat_by_rate, [{ rate: 10, base: 50, amount: 5 }, { rate: 21, base: 100, amount: 21 }]);

  const derived = derivedTaxes([{ net_amount: 33.33, vat_rate: 21 }, { net_amount: 10, vat_rate: 21 }, { net_amount: 7, vat_rate: 4, vat_amount: 0.28 }]);
  assert.deepEqual(derived.taxes, [{ tax_type: 'iva', rate: 4, taxable_base: 7, amount: 0.28 }, { tax_type: 'iva', rate: 21, taxable_base: 43.33, amount: 9.1 }]);
  const noTaxes = recalculate([{ net_amount: 100, vat_rate: 21 }], [], { base: 100, vat: 21, withholding: 0, total: 121 });
  assert.equal(noTaxes.taxes_derived, true); assert.equal(noTaxes.calculated_total, 121); assert.ok(noTaxes.warnings.some((w) => w.code === 'TAXES_DERIVED_FROM_LINES'));
});

test('recálculo: tolerancia 0,02 € y avisos por línea', () => {
  const within = recalculate([{ net_amount: 100, vat_rate: 21, vat_amount: 21 }], [{ tax_type: 'iva', rate: 21, taxable_base: 100, amount: 21 }], { base: 100, vat: 21, withholding: 0, total: 121.02 });
  assert.equal(within.within_tolerance, true); assert.equal(within.totals_delta, 0.02);
  const outside = recalculate([{ net_amount: 100, vat_rate: 21, vat_amount: 21 }], [{ tax_type: 'iva', rate: 21, taxable_base: 100, amount: 21 }], { base: 100, vat: 21, withholding: 0, total: 121.5 });
  assert.equal(outside.within_tolerance, false); assert.equal(outside.totals_delta, 0.5);
  assert.ok(outside.warnings.some((w) => w.code === 'TOTALS_MISMATCH' && w.message.startsWith('REVISAR IMPORTES')));
  const lines = recalculate([{ quantity: 3, unit_price: 2.5, discount_amount: 0, net_amount: 8, vat_rate: 21, vat_amount: 1.5 }], [], null);
  assert.ok(lines.warnings.some((w) => w.code === 'LINE_NET_MISMATCH' && w.expected === 7.5));
  assert.ok(lines.warnings.some((w) => w.code === 'LINE_VAT_MISMATCH' && w.expected === 1.68));
  assert.equal(lines.within_tolerance, null);
  const other = recalculate([], [{ tax_type: 'iva', rate: 21, taxable_base: 100, amount: 21 }, { tax_type: 'otro', rate: 5.2, taxable_base: 100, amount: 5.2 }], { base: 100, vat: 26.2, withholding: 0, total: 126.2 });
  assert.equal(other.calculated_other, 5.2); assert.equal(other.calculated_total, 126.2); assert.equal(other.within_tolerance, true);
});

test('nombre canónico: AAAA_MM_DD_(empresa)_objeto, páginas, colisiones, extensión por MIME y slug sin acentos', () => {
  assert.equal(slugify('Alimentos Retiro Yoga'), 'alimentos_retiro_yoga');
  assert.equal(slugify('  Jamón & Quesos — Ñoño ß  '), 'jamon_quesos_nono_ss');
  assert.equal(slugify('a'.repeat(50)).length, 40);
  assert.equal(slugify('abc_'.repeat(12)), 'abc_abc_abc_abc_abc_abc_abc_abc_abc_abc');
  assert.equal(normalizedFilename({ invoiceDate: '2026-10-05', supplierSlug: 'makro', object: 'alimentos retiro yoga', mime: 'application/pdf' }), '2026_10_05_(makro)_alimentos_retiro_yoga.pdf');
  assert.equal(normalizedFilename({ invoiceDate: '2026-10-05', supplierSlug: 'makro', object: 'alimentos', mime: 'image/jpeg', pageOrder: 2, pageCount: 3 }), '2026_10_05_(makro)_alimentos_p02.jpg');
  assert.equal(normalizedFilename({ invoiceDate: '2026-10-05', supplierSlug: 'makro', object: 'alimentos', mime: 'image/webp', collision: 2 }), '2026_10_05_(makro)_alimentos_02.webp');
  assert.equal(normalizedFilename({ invoiceDate: '2026-10-05', supplierSlug: 'makro', object: 'alimentos', mime: 'image/png', collision: 3, pageOrder: 1, pageCount: 2 }), '2026_10_05_(makro)_alimentos_03_p01.png');
  assert.equal(normalizedFilename({ invoiceDate: '2026-10-05', supplierSlug: '', object: '', mime: 'text/plain' }), '2026_10_05_(sin_proveedor)_sin_objeto.bin');
  assert.equal(exportFolderName('quarter', 2026, 4, '2026-10-01', '2026-12-31'), 'IKISAI_COMPRAS_2026_T4');
  assert.equal(exportFolderName('year', 2026, null, '2026-01-01', '2026-12-31'), 'IKISAI_COMPRAS_2026');
  assert.equal(exportFolderName('custom', 2026, null, '2026-01-01', '2026-02-15'), 'IKISAI_COMPRAS_2026_01_01_2026_02_15');
});

test('importación: emparejado de proveedor, duplicados, propuesta y args', async () => {
  const makro = supplier(1, { name: 'Makro', tax_id: 'A-28647451', aliases: ['MAKRO ESPAÑA S.A.'], default_category: 'compras' });
  const other = supplier(2, { name: 'Proveedor Ejemplo S.L.', tax_id: 'B00000000', default_category: 'suministros', default_is_investment: true });
  const byTax = matchSupplier(EXAMPLE, [makro, other]);
  assert.equal(byTax[0]!.supplier.id, other.id); assert.equal(byTax[0]!.by, 'tax_id');
  const byAlias = matchSupplier({ ...EXAMPLE, invoice: { ...EXAMPLE.invoice, supplier_tax_id: null, supplier_name: 'Makro España, S.A.' } }, [makro, other]);
  assert.equal(byAlias[0]!.by, 'alias');
  const byName = matchSupplier({ ...EXAMPLE, invoice: { ...EXAMPLE.invoice, supplier_tax_id: null, supplier_name: 'MAKRO' } }, [makro]);
  assert.equal(byName[0]!.by, 'name'); assert.equal(byName[0]!.score, 0.8);
  assert.deepEqual(matchSupplier({ ...EXAMPLE, invoice: { ...EXAMPLE.invoice, supplier_tax_id: null, supplier_name: 'Nadie' } }, [makro, other]), []);

  const existing = invoice(1, { supplier_id: other.id, invoice_number: 'f-2026-123' });
  assert.equal(findDuplicateInvoice(EXAMPLE, other.id, [existing])?.id, existing.id);
  assert.equal(findDuplicateInvoice(EXAMPLE, makro.id, [existing]), null);
  assert.equal(findDuplicateInvoice({ ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: null } }, other.id, [existing]), null);

  const proposal = proposeImport(EXAMPLE, other);
  assert.equal(proposal.expense_category, 'suministros'); assert.equal(proposal.is_investment, true);
  assert.equal(proposal.deductibility, 'pendiente_revision'); assert.equal(proposal.object, 'alimentos_retiro_ejemplo');
  assert.equal(proposal.review_reason, 'IMPORTADA'); assert.equal(proposal.status, 'pendiente_revision');
  const overridden = proposeImport({ ...EXAMPLE, document_totals: { ...EXAMPLE.document_totals, total: 45 } }, null, { expense_category: 'compras', object: ' Tomates ' });
  assert.equal(overridden.review_reason, 'REVISAR IMPORTES'); assert.equal(overridden.object, 'Tomates'); assert.equal(overridden.expense_category, 'compras'); assert.equal(overridden.is_investment, false);

  let n = 0;
  const args = buildImportArgs({ document: EXAMPLE, documentSha256: await importDocumentSha256(EXAMPLE), invoiceId: uid(999), supplier: { mode: 'create', id: uid(50) }, files: [{ file_id: { $blob: 'a'.repeat(64) }, original_filename: 'scan.pdf', page_order: 1 }], uuid: () => uid(600 + n++) });
  assert.equal(args.ids.lines.length, 1); assert.equal(args.ids.tax_lines.length, 1); assert.equal(args.ids.files.length, 1); assert.equal(args.ids.supplier, uid(50));
  assert.equal(args.supplier.slug, 'proveedor_ejemplo_s_l'); assert.deepEqual(args.files[0]!.file_id, { $blob: 'a'.repeat(64) });
});

test('validación de campos por tabla: columnas escribibles, listas cerradas, pares de destino', () => {
  assert.equal(failsWith(() => validateRowFields(TABLES.suppliers, 'insert', { name: 'Makro', aliases: ['MAKRO ESPAÑA'] })), 'OK');
  assert.equal(failsWith(() => validateRowFields(TABLES.suppliers, 'insert', { name: '' })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.suppliers, 'update', { slug: 'Makro' })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.suppliers, 'update', { revision: 3 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'insert', { supplier_id: uid(1), invoice_date: '2026-10-05', object: 'alimentos' })), 'OK');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'insert', { supplier_id: uid(1), invoice_date: '2026-10-05' })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'update', { currency: 'USD' })), 'UNSUPPORTED_IN_V1');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'update', { import_meta: {} })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'update', { import_meta: {} }, { allowImportMeta: true })), 'OK');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'update', { payment_status: 'pagada', paid_at: null })), 'PAID_AT_REQUIRED');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'update', { status: 'anulada', annulled_reason: null })), 'ANNUL_REASON_REQUIRED');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoices, 'update', { calculated_base: 1.005 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoiceFiles, 'insert', { invoice_id: uid(1), file_id: { $blob: 'a'.repeat(64) }, original_filename: 'scan.pdf' })), 'OK');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoiceFiles, 'insert', { invoice_id: uid(1), file_id: 'nope', original_filename: 'scan.pdf' })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoiceLines, 'insert', { invoice_id: uid(1), position: 0, description: 'Tomate', net_amount: 40, quantity: 20.123, unit_price: 2.0001 })), 'OK');
  assert.equal(failsWith(() => validateRowFields(TABLES.invoiceLines, 'insert', { invoice_id: uid(1), position: 0, description: 'Tomate', net_amount: 40, vat_rate: 120 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.taxLines, 'insert', { invoice_id: uid(1), position: 0, tax_type: 'iva', amount: -1 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.allocations, 'insert', { invoice_line_id: uid(1), target_app: 'tasks', target_kind: 'project', target_id: 'p1', target_label: 'Huerto', allocated_amount: 10 })), 'OK');
  assert.equal(failsWith(() => validateRowFields(TABLES.allocations, 'insert', { invoice_line_id: uid(1), target_app: 'tasks', target_kind: 'event', target_id: 'p1', target_label: 'x', allocated_amount: 10 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.allocations, 'insert', { invoice_line_id: uid(1), target_app: 'general', target_kind: 'unassigned', target_id: 'x', target_label: 'x', allocated_amount: 10 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.allocations, 'insert', { invoice_line_id: uid(1), target_app: 'tasks', target_kind: 'task', target_label: 'x', allocated_amount: 10 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.allocations, 'insert', { invoice_line_id: uid(1), target_app: 'general', target_kind: 'investment', target_label: 'x', allocated_amount: 0 })), 'INVALID_FIELDS');
  assert.equal(failsWith(() => validateRowFields(TABLES.exports, 'insert', { status: 'generada' })), 'INVALID_OPERATION');
  assert.equal(failsWith(() => validateRowFields(TABLES.exports, 'update', { status: 'entregada', delivered_to: 'correo' })), 'OK');
  assert.equal(failsWith(() => validateRowFields(TABLES.exportItems, 'insert', {})), 'INVALID_OPERATION');
  for (const table of Object.values(TABLES)) assert.ok(Array.isArray(WRITABLE[table]));
  assert.equal(EXPENSE_CATEGORIES.length, 9);
});

test('resumen fiscal: solo validadas y archivadas suman; IVA por tasa; alertas', () => {
  const inv1 = invoice(1);
  const inv2 = invoice(2, { calculated_base: 200, calculated_vat: 42, calculated_total: 242, source_total: 242, is_investment: true, expense_category: 'inversiones', deductibility: 'pendiente_revision', status: 'archivada', due_date: '2026-10-01' });
  const inv3 = invoice(3, { status: 'pendiente_revision', review_reason: 'REVISAR IMPORTES', totals_delta: 0.5 });
  const inv4 = invoice(4, { status: 'anulada', annulled_reason: 'duplicada' });
  const inv5 = invoice(5, { invoice_date: '2026-09-30' });
  const taxes = [tax(1, inv1.id), tax(2, inv2.id, { rate: 21, taxable_base: 200, amount: 42 }), tax(3, inv3.id), tax(4, inv2.id, { tax_type: 'irpf', rate: 15, taxable_base: 200, amount: 30 })];
  const s = fiscalSummary({ invoices: [inv1, inv2, inv3, inv4, inv5], taxLines: taxes, invoicesWithFile: new Set([inv1.id]), today: '2026-10-06' }, quarterRange(2026, 4));
  assert.deepEqual(s.invoices, { pendiente_datos: 0, pendiente_revision: 1, validada: 1, archivada: 1, anulada: 1 });
  assert.equal(s.base, 300); assert.equal(s.vat, 52); assert.equal(s.total, 352);
  assert.deepEqual(s.vat_by_rate, [{ rate: 10, base: 100, amount: 10 }, { rate: 21, base: 200, amount: 42 }]);
  assert.deepEqual(s.withholdings_by_type, [{ tax_type: 'irpf', rate: 15, base: 200, amount: 30 }]);
  assert.deepEqual(s.investment, { base: 200, total: 242, count: 1 }); assert.deepEqual(s.operating, { base: 100, total: 110, count: 1 });
  assert.equal(s.deductibility.pendiente_revision, 200);
  assert.equal(s.alerts.pending_invoices.length, 1); assert.equal(s.alerts.discrepancies[0]!.totals_delta, 0.5);
  assert.equal(s.alerts.deductibility_unreviewed, 1); assert.equal(s.alerts.missing_file, 2); assert.equal(s.alerts.unpaid_overdue, 1);
  assert.equal(s.range.from, '2026-10-01'); assert.equal(s.range.to, '2026-12-31');
});

test('compras: líneas con asignado y sin asignar, filtros y agrupaciones', () => {
  const makro = supplier(1, { name: 'Makro' });
  const inv1 = invoice(1);
  const inv2 = invoice(2, { status: 'pendiente_revision' });
  const l1 = line(1, inv1.id);
  const l2 = line(2, inv1.id, { net_amount: 30, expense_category: 'mantenimiento', is_investment: true, item_type: 'equipment' });
  const l3 = line(3, inv2.id);
  const a1 = allocation(1, l1.id, inv1.id, { target_app: 'tasks', target_kind: 'project', target_id: 'p1', target_label: 'Huerto', allocated_amount: 30, allocated_quantity: 6 });
  const a2 = allocation(2, l1.id, inv1.id, { allocated_amount: 10 });
  const r = purchaseItems({ invoices: [inv1, inv2], lines: [l1, l2, l3], suppliers: [makro], allocations: [a1, a2] });
  assert.equal(r.items.length, 2);
  const item1 = r.items.find((i) => i.line.id === l1.id)!;
  assert.equal(item1.allocated_amount, 40); assert.equal(item1.unallocated_amount, 10); assert.equal(item1.allocated_quantity, 6);
  assert.equal(r.total_base, 80); assert.equal(r.total_allocated, 40); assert.equal(r.total_unallocated, 40);
  assert.equal(r.by_target[0]!.key, 'unassigned'); assert.equal(r.by_target[0]!.base, 40);
  assert.ok(r.by_category.some((g) => g.key === 'mantenimiento:inv' && g.base === 30));
  assert.equal(r.by_supplier[0]!.label, 'Makro');
  const all = purchaseItems({ invoices: [inv1, inv2], lines: [l1, l2, l3], suppliers: [makro], allocations: [a1, a2] }, { validatedOnly: false });
  assert.equal(all.items.length, 3);
  const unassigned = purchaseItems({ invoices: [inv1], lines: [l1, l2], suppliers: [makro], allocations: [a1, a2] }, { unassignedOnly: true });
  assert.equal(unassigned.items.length, 2);
  const byTarget = purchaseItems({ invoices: [inv1], lines: [l1, l2], suppliers: [makro], allocations: [a1, a2] }, { targetApp: 'tasks', targetId: 'p1' });
  assert.equal(byTarget.items.length, 1);
  const search = purchaseItems({ invoices: [inv1], lines: [l1, l2], suppliers: [makro], allocations: [] }, { query: 'artículo 2' });
  assert.equal(search.items.length, 1); assert.equal(search.items[0]!.line.id, l2.id);
});
