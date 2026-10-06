/**
 * Importación `ikisai.invoice.v1` expresada como operaciones de fila, para que el cliente pueda importar sin red con
 * espejo optimista (API.md §10). Produce el mismo resultado que el procedimiento `invoices.import_v1`: el hook
 * `check_invariants` del servidor recalcula y fija el estado; los duplicados los paran los índices únicos.
 * `import_meta` solo lo escribe el procedimiento, así que aquí no viaja.
 */
import { slugify } from './filename.ts';
import type { ImportDocument } from './import-v1.schema.ts';
import { normalizeName, proposeImport, type ImportFileArg, type ImportOverrides, type ImportProposal } from './import-v1.ts';
import type { SupplierRow } from './types.ts';

export interface ImportRowOperation {
  op: 'insert' | 'update';
  table: string;
  id: string;
  expectedRevision?: number;
  fields: Record<string, unknown>;
}

export interface ImportOperationsInput {
  document: ImportDocument;
  documentSha256: string;
  invoiceId: string;
  /** Factura existente en `pendiente_datos` sobre la que se importa (se actualiza en vez de insertarse). */
  existing?: { revision: number } | null;
  supplier: { mode: 'existing'; row: SupplierRow } | { mode: 'create'; id: string; slug?: string | null };
  overrides?: ImportOverrides;
  files?: ImportFileArg[];
  uuid?: () => string;
}

export function importOperations(input: ImportOperationsInput): { operations: ImportRowOperation[]; proposal: ImportProposal; supplierId: string } {
  const uuid = input.uuid ?? (() => crypto.randomUUID());
  const doc = input.document;
  const ops: ImportRowOperation[] = [];
  let supplierId: string;
  let supplierRow: SupplierRow | null = null;
  if (input.supplier.mode === 'create') {
    supplierId = input.supplier.id;
    ops.push({ op: 'insert', table: 'invoices.suppliers', id: supplierId, fields: {
      name: doc.invoice.supplier_name,
      tax_id: doc.invoice.supplier_tax_id ?? null,
      slug: input.supplier.slug ?? (slugify(doc.invoice.supplier_name) || 'proveedor'),
      aliases: [],
    } });
  } else {
    supplierRow = input.supplier.row;
    supplierId = supplierRow.id;
    const name = normalizeName(doc.invoice.supplier_name);
    if (name !== normalizeName(supplierRow.name) && !supplierRow.aliases.some((a) => normalizeName(a) === name) && supplierRow.aliases.length < 20) {
      ops.push({ op: 'update', table: 'invoices.suppliers', id: supplierRow.id, expectedRevision: supplierRow.revision, fields: { aliases: [...supplierRow.aliases, doc.invoice.supplier_name] } });
    }
  }
  const proposal = proposeImport(doc, supplierRow, input.overrides ?? {});
  const r = proposal.recalculation;
  const invoiceFields: Record<string, unknown> = {
    supplier_id: supplierId,
    invoice_date: proposal.invoice_date,
    object: proposal.object,
    invoice_number: doc.invoice.invoice_number?.trim() || null,
    currency: 'EUR',
    expense_category: proposal.expense_category,
    is_investment: proposal.is_investment,
    deductibility: proposal.deductibility,
    status: 'pendiente_revision',
    review_reason: proposal.review_reason,
    source_total: doc.document_totals.total,
    source: 'import_v1',
    import_sha256: input.documentSha256,
    notes: proposal.notes,
    calculated_base: r.calculated_base,
    calculated_vat: r.calculated_vat,
    calculated_other: r.calculated_other,
    calculated_withholding: r.calculated_withholding,
    calculated_total: r.calculated_total,
    totals_delta: r.totals_delta,
  };
  if (input.existing) ops.push({ op: 'update', table: 'invoices.invoices', id: input.invoiceId, expectedRevision: input.existing.revision, fields: invoiceFields });
  else ops.push({ op: 'insert', table: 'invoices.invoices', id: input.invoiceId, fields: invoiceFields });
  doc.lines.forEach((l, i) => ops.push({ op: 'insert', table: 'invoices.invoice_lines', id: uuid(), fields: {
    invoice_id: input.invoiceId, position: i, description: l.description, quantity: l.quantity ?? null, unit: l.unit ?? null, unit_price: l.unit_price ?? null,
    discount_amount: l.discount_amount ?? 0, net_amount: l.net_amount, vat_rate: l.vat_rate ?? null, vat_amount: l.vat_amount ?? null, gross_amount: l.gross_amount ?? null,
    item_type: l.suggested_item_type ?? null, match_name: l.suggested_match_name ?? null, confidence: l.confidence ?? null, notes: l.notes ?? null,
  } }));
  r.taxes.forEach((t, i) => ops.push({ op: 'insert', table: 'invoices.tax_lines', id: uuid(), fields: {
    invoice_id: input.invoiceId, position: i, tax_type: t.tax_type, rate: t.rate ?? null, taxable_base: t.taxable_base ?? null, amount: t.amount,
  } }));
  (input.files ?? []).forEach((f, i) => ops.push({ op: 'insert', table: 'invoices.invoice_files', id: uuid(), fields: {
    invoice_id: input.invoiceId, file_id: f.file_id, original_filename: f.original_filename, page_order: f.page_order ?? i + 1, kind: 'original',
    ...(f.mime_type ? { mime_type: f.mime_type } : {}), ...(f.size_bytes !== undefined ? { size_bytes: f.size_bytes } : {}), ...(f.sha256 ? { sha256: f.sha256 } : {}),
  } }));
  return { operations: ops, proposal, supplierId };
}
