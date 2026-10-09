/**
 * Lectura parcial aplicada a un borrador (fase 0 de REVISION_LECTOR, 9-10-2026): lo que el lector encontró se escribe en
 * la factura en «Pendiente de datos» aunque falten campos, y el resumen de la lectura va a `import_meta.reading`.
 *
 * Precedencia mínima: una lectura automática solo rellena campos **vacíos** (o el proveedor provisional); nunca pisa lo que
 * ya tiene la factura. Lo que rellenó queda en `reading.filled`, para distinguirlo después de lo que escribió una persona.
 */
import { foundLabels, missingLabels, validSpanishTaxId, type PartialInvoice, type ReadLevel, type ReadStats } from './pdf-extract.ts';
import type { ImportDocument } from './import-v1.schema.ts';

/** Resumen de la lectura que se guarda en `import_meta.reading` (sin texto del documento: solo números y etiquetas). */
export interface ReadingSummary {
  read: ReadLevel;
  found: string[];
  missing: string[];
  stats: ReadStats;
  extractor: 'pdf_text';
  template: { id: string | null; version: number } | null;
  reader_version: number;
  at: string;
  /** Campos que rellenó la lectura automática, con su valor. */
  filled?: Record<string, string | number>;
}

export function readingSummary(x: { read: ReadLevel; found: PartialInvoice; stats: ReadStats; template?: { id: string | null; version: number } | null }, readerVersion: number, at: string): ReadingSummary {
  return {
    read: x.read, found: foundLabels(x.found), missing: x.read === 'no_text' ? ['texto'] : missingLabels(x.found), stats: x.stats,
    extractor: 'pdf_text', template: x.template ? { id: x.template.id, version: x.template.version } : null, reader_version: readerVersion, at,
  };
}

export interface PartialFillInput {
  invoice: { id: string; supplier_id: string; invoice_number: string | null; invoice_date: string | null; source_total: number | string | null; revision?: number; import_meta?: unknown };
  /** El proveedor «Sin identificar» de Drive: se sustituye si el documento trae un NIF válido. */
  placeholderSupplierId: string | null;
  suppliers: Array<{ id: string; tax_id: string | null; deleted_at?: string | null; slug?: string | null }>;
  /** La factura ya tiene líneas o impuestos: entonces no se tocan los importes. */
  hasContent: boolean;
  found: PartialInvoice;
  reading: ReadingSummary;
  /** Ids nuevos (estables en el servidor, para reintentos idempotentes). */
  newId: (kind: string) => string;
}

const normTaxId = (raw: string) => validSpanishTaxId(raw) ?? raw.replace(/[\s.-]/g, '').toUpperCase();

/** Operaciones para rellenar lo vacío con lo encontrado. Siempre guarda el resumen de la lectura. */
export function partialFillOperations(x: PartialFillInput): { ops: Array<Record<string, unknown>>; filled: Record<string, string | number> } {
  const { invoice, found } = x;
  const ops: Array<Record<string, unknown>> = [];
  const fields: Record<string, unknown> = {};
  const filled: Record<string, string | number> = {};
  // Proveedor: solo si sigue el provisional y hay un NIF válido (con nombre, si es nuevo).
  if (x.placeholderSupplierId && invoice.supplier_id === x.placeholderSupplierId && found.supplier_tax_id) {
    const id = normTaxId(found.supplier_tax_id);
    const known = x.suppliers.find((s) => !s.deleted_at && s.slug !== 'sin_identificar' && s.tax_id && normTaxId(s.tax_id) === id);
    if (known) { fields.supplier_id = known.id; filled.supplier_id = known.id; }
    else if (found.supplier_name) {
      const supplierId = x.newId('supplier');
      ops.push({ op: 'insert', table: 'invoices.suppliers', id: supplierId, fields: { name: found.supplier_name.slice(0, 160), tax_id: id } });
      fields.supplier_id = supplierId; filled.supplier_id = supplierId;
    }
  }
  if (!invoice.invoice_number && found.invoice_number) { fields.invoice_number = found.invoice_number; filled.invoice_number = found.invoice_number; }
  if (!invoice.invoice_date && found.invoice_date) { fields.invoice_date = found.invoice_date; filled.invoice_date = found.invoice_date; }
  if ((invoice.source_total === null || invoice.source_total === undefined) && found.total !== null) { fields.source_total = found.total; filled.source_total = found.total; }
  // Importes: solo en una factura sin líneas ni impuestos, y con la base identificada.
  const amountOps: Array<Record<string, unknown>> = [];
  if (!x.hasContent && found.base !== null) {
    const rates = found.vat;
    const lines = rates.length && rates.every((v) => v.base !== null)
      ? rates.map((v) => ({ description: `Base al ${v.rate} % según documento`, net_amount: v.base!, vat_rate: v.rate, vat_amount: v.quota }))
      : [{ description: 'Importe según documento', net_amount: found.base, vat_rate: rates.length === 1 ? rates[0]!.rate : null, vat_amount: rates.length === 1 ? rates[0]!.quota : null }];
    lines.forEach((l, i) => amountOps.push({ op: 'insert', table: 'invoices.invoice_lines', id: x.newId(`line:${i}`), fields: { invoice_id: invoice.id, position: i, ...l } }));
    rates.forEach((v, i) => amountOps.push({ op: 'insert', table: 'invoices.tax_lines', id: x.newId(`tax:${i}`), fields: { invoice_id: invoice.id, position: i, tax_type: 'iva', rate: v.rate, taxable_base: v.base, amount: v.quota } }));
    if (found.withholding) amountOps.push({ op: 'insert', table: 'invoices.tax_lines', id: x.newId('tax:irpf'), fields: { invoice_id: invoice.id, position: rates.length, tax_type: 'irpf', rate: found.withholding.rate, taxable_base: null, amount: found.withholding.amount } });
    if (amountOps.length) filled.base = found.base;
  }
  const meta = invoice.import_meta && typeof invoice.import_meta === 'object' && !Array.isArray(invoice.import_meta) ? invoice.import_meta as Record<string, unknown> : {};
  fields.import_meta = { ...meta, reading: { ...x.reading, filled } };
  ops.push({ op: 'update', table: 'invoices.invoices', id: invoice.id, ...(invoice.revision !== undefined ? { expectedRevision: invoice.revision } : {}), fields });
  ops.push(...amountOps);
  return { ops, filled };
}

/**
 * Antes de importar una lectura completa sobre un borrador: lo que ya escribió una persona (número o fecha distintos de
 * los que rellenó la lectura automática) manda sobre lo leído.
 */
export function keepHumanFields(document: ImportDocument, invoice: { invoice_number: string | null; invoice_date: string | null; import_meta?: unknown }): ImportDocument {
  const reading = (invoice.import_meta as { reading?: ReadingSummary } | null)?.reading;
  const filled = reading?.filled ?? {};
  const human = (field: 'invoice_number' | 'invoice_date') => invoice[field] && invoice[field] !== filled[field] ? invoice[field] : null;
  const number = human('invoice_number');
  const date = human('invoice_date');
  if (!number && !date) return document;
  return { ...document, invoice: { ...document.invoice, ...(number ? { invoice_number: number } : {}), ...(date ? { invoice_date: date } : {}) } };
}
