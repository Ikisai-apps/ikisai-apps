/**
 * Preparación de una importación `ikisai.invoice.v1` (API.md §3.1 y §6.1): emparejar proveedor, proponer
 * categoría e inversión, recalcular y construir los `args` del `call invoices.import_v1`.
 * Lo usan el cliente (vista previa y envío) y la Edge (`imports/preview`).
 */
import { slugify } from './filename.ts';
import type { ImportDocument } from './import-v1.schema.ts';
import { recalculate, type RecalcLine, type RecalcTax, type Recalculation } from './recalculate.ts';
import { EXPENSE_CATEGORIES, REVIEW_REASONS, type Deductibility, type ExpenseCategory, type InvoiceRow, type SupplierRow } from './types.ts';

export interface SupplierMatch {
  supplier: SupplierRow;
  by: 'tax_id' | 'alias' | 'name';
  score: number;
}

/** Normaliza un NIF para comparar: mayúsculas, sin espacios ni guiones ni prefijo ES. */
export function normalizeTaxId(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.toUpperCase().replace(/[\s.\-]/g, '').replace(/^ES/, '');
  return t || null;
}

export function normalizeName(value: string): string {
  return slugify(value, 200).replace(/_(sl|sa|slu|sll|scoop|sc|sau|s_l|s_a|s_l_u)$/g, '');
}

/** Candidatos ordenados: NIF exacto > alias exacto > nombre normalizado igual > nombre que contiene. */
export function matchSupplier(document: ImportDocument, suppliers: SupplierRow[]): SupplierMatch[] {
  const live = suppliers.filter((s) => !s.deleted_at);
  const taxId = normalizeTaxId(document.invoice.supplier_tax_id);
  const name = normalizeName(document.invoice.supplier_name);
  const out: SupplierMatch[] = [];
  for (const s of live) {
    if (taxId && normalizeTaxId(s.tax_id) === taxId) { out.push({ supplier: s, by: 'tax_id', score: 1 }); continue; }
    if (s.aliases.some((a) => normalizeName(a) === name)) { out.push({ supplier: s, by: 'alias', score: 0.9 }); continue; }
    const own = normalizeName(s.name);
    if (own === name) out.push({ supplier: s, by: 'name', score: 0.8 });
    else if (name.length >= 4 && (own.includes(name) || name.includes(own))) out.push({ supplier: s, by: 'name', score: 0.5 });
  }
  return out.sort((a, b) => b.score - a.score || a.supplier.name.localeCompare(b.supplier.name));
}

/** Factura viva no anulada del mismo proveedor y número (duplicado funcional). */
export function findDuplicateInvoice(document: ImportDocument, supplierId: string | null, invoices: InvoiceRow[]): InvoiceRow | null {
  const number = document.invoice.invoice_number?.trim().toLowerCase();
  if (!number || !supplierId) return null;
  return invoices.find((i) => !i.deleted_at && i.status !== 'anulada' && i.supplier_id === supplierId && (i.invoice_number ?? '').trim().toLowerCase() === number) ?? null;
}

export function findDuplicateImport(sha256: string, invoices: InvoiceRow[]): InvoiceRow | null {
  return invoices.find((i) => !i.deleted_at && i.status !== 'anulada' && i.import_sha256 === sha256) ?? null;
}

export interface ImportOverrides {
  object?: string | null;
  invoice_date?: string | null;
  expense_category?: ExpenseCategory | null;
  is_investment?: boolean | null;
  deductibility?: Deductibility | null;
  notes?: string | null;
}

export interface ImportProposal {
  object: string;
  invoice_date: string;
  expense_category: ExpenseCategory | null;
  is_investment: boolean;
  deductibility: Deductibility;
  notes: string | null;
  status: 'pendiente_revision';
  review_reason: string;
  recalculation: Recalculation;
}

export function linesForRecalc(document: ImportDocument): RecalcLine[] {
  return document.lines.map((l) => ({ quantity: l.quantity ?? null, unit_price: l.unit_price ?? null, discount_amount: l.discount_amount ?? 0, net_amount: l.net_amount, vat_rate: l.vat_rate ?? null, vat_amount: l.vat_amount ?? null }));
}

export function taxesForRecalc(document: ImportDocument): RecalcTax[] {
  return document.taxes.map((t) => ({ tax_type: t.tax_type, rate: t.rate ?? null, taxable_base: t.taxable_base ?? null, amount: t.amount }));
}

/** Valores propuestos para la factura: lo que diga el usuario → el documento → el proveedor → el defecto. */
export function proposeImport(document: ImportDocument, supplier: SupplierRow | null, overrides: ImportOverrides = {}): ImportProposal {
  const recalculation = recalculate(linesForRecalc(document), taxesForRecalc(document), document.document_totals);
  const suggestedCategory = overrides.expense_category ?? supplier?.default_category ?? null;
  const category = suggestedCategory && (EXPENSE_CATEGORIES as readonly string[]).includes(suggestedCategory) ? suggestedCategory : null;
  const deductibility = overrides.deductibility ?? document.invoice.deductibility_suggestion ?? 'pendiente_revision';
  return {
    object: (overrides.object ?? document.invoice.object).trim(),
    invoice_date: overrides.invoice_date ?? document.invoice.invoice_date,
    expense_category: category,
    is_investment: overrides.is_investment ?? supplier?.default_is_investment ?? false,
    deductibility,
    notes: overrides.notes ?? document.invoice.notes ?? null,
    status: 'pendiente_revision',
    review_reason: recalculation.within_tolerance === false ? REVIEW_REASONS.totals : REVIEW_REASONS.imported,
    recalculation,
  };
}

export interface ImportFileArg {
  /** `file_id` real o marcador `{ "$blob": sha256 }` que el sync-client sustituye. */
  file_id: string | { $blob: string };
  original_filename: string;
  page_order: number;
}

export interface ImportArgs {
  document: ImportDocument;
  document_sha256: string;
  invoice_id: string;
  ids: { lines: string[]; tax_lines: string[]; supplier: string | null; files: string[] };
  supplier: { mode: 'existing' | 'create'; id: string | null; slug: string | null };
  invoice: ImportOverrides;
  files: ImportFileArg[];
}

export interface BuildImportArgsOptions {
  document: ImportDocument;
  documentSha256: string;
  /** Factura nueva o existente en `pendiente_datos`. */
  invoiceId: string;
  supplier: { mode: 'existing'; id: string } | { mode: 'create'; id: string; slug?: string | null };
  overrides?: ImportOverrides;
  files?: ImportFileArg[];
  uuid?: () => string;
}

export function buildImportArgs(options: BuildImportArgsOptions): ImportArgs {
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const supplier = options.supplier.mode === 'create'
    ? { mode: 'create' as const, id: options.supplier.id, slug: options.supplier.slug ?? slugify(options.document.invoice.supplier_name) }
    : { mode: 'existing' as const, id: options.supplier.id, slug: null };
  return {
    document: options.document,
    document_sha256: options.documentSha256,
    invoice_id: options.invoiceId,
    ids: {
      lines: options.document.lines.map(() => uuid()),
      tax_lines: options.document.taxes.map(() => uuid()),
      supplier: options.supplier.mode === 'create' ? options.supplier.id : null,
      files: (options.files ?? []).map(() => uuid()),
    },
    supplier,
    invoice: options.overrides ?? {},
    files: options.files ?? [],
  };
}
