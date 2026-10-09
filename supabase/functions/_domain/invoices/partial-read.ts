/**
 * Lectura parcial aplicada a un borrador (fase 0 de REVISION_LECTOR, 9-10-2026; fase 1: un solo núcleo y precedencia por
 * nivel). Lo que el lector encontró se escribe en la factura en «Pendiente de datos» aunque falten campos, y el resumen de
 * la lectura va a `import_meta.reading`.
 *
 * Precedencia: manual confirmado > IA revisada (importación) > plantilla fiable > regla genérica > inferencia débil. Una
 * lectura automática escribe un campo si está vacío o si lo rellenó otra lectura automática con un nivel **menor** y nadie
 * lo ha cambiado desde entonces (`reading.filled[campo] = { value, level }`). Lo demás lo escribió una persona: manda.
 */
import { extractWithTemplates, type TemplateExtraction, type TemplateLike } from './supplier-templates.ts';
import { foundLabels, missingLabels, validSpanishTaxId, type FieldProvenance, type PartialInvoice, type PdfTextItem, type ReadLevel, type ReadStats } from './pdf-extract.ts';
import type { ImportDocument } from './import-v1.schema.ts';

/** Nivel de autoridad de un dato rellenado por la lectura automática (mayor manda). */
export type FillLevel = 'inferencia' | 'regla' | 'plantilla';
const RANK: Record<FillLevel, number> = { inferencia: 1, regla: 2, plantilla: 3 };
export interface FilledField { value: string | number; level: FillLevel }

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
  /** Campos que rellenó la lectura automática, con su valor y su nivel. */
  filled?: Record<string, FilledField>;
}

export function readingSummary(x: { read: ReadLevel; found: PartialInvoice; stats: ReadStats; template?: { id: string | null; version: number } | null }, readerVersion: number, at: string): ReadingSummary {
  return {
    read: x.read, found: foundLabels(x.found), missing: x.read === 'no_text' ? ['texto'] : missingLabels(x.found), stats: x.stats,
    extractor: 'pdf_text', template: x.template ? { id: x.template.id, version: x.template.version } : null, reader_version: readerVersion, at,
  };
}

/** Nivel de un dato según su procedencia: plantilla fiable, regla con etiqueta o inferencia débil. */
export function levelOf(p: FieldProvenance | undefined): FillLevel {
  if (!p) return 'regla';
  if (p.method === 'supplier_template' && p.confidence >= 0.8) return 'plantilla';
  return p.confidence >= 0.6 ? 'regla' : 'inferencia';
}

/** Lo rellenado antes, también en el formato de la fase 0 (`{campo: valor}`, sin nivel: cuenta como inferencia). */
function previousFilled(importMeta: unknown): Record<string, FilledField> {
  const raw = (importMeta as { reading?: { filled?: Record<string, unknown> } } | null)?.reading?.filled ?? {};
  const out: Record<string, FilledField> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && 'value' in v) out[k] = v as FilledField;
    else if (typeof v === 'string' || typeof v === 'number') out[k] = { value: v, level: 'inferencia' };
  }
  return out;
}

const PROVENANCE_KEY: Record<string, string> = {
  supplier_id: 'invoice.supplier_tax_id', invoice_number: 'invoice.invoice_number', invoice_date: 'invoice.invoice_date',
  source_total: 'document_totals.total', base: 'document_totals.base',
};

export interface PartialFillInput {
  invoice: { id: string; supplier_id: string; invoice_number: string | null; invoice_date: string | null; source_total: number | string | null; revision?: number; import_meta?: unknown };
  /** El proveedor «Sin identificar» de Drive: se sustituye si el documento trae un NIF válido. */
  placeholderSupplierId: string | null;
  suppliers: Array<{ id: string; tax_id: string | null; deleted_at?: string | null; slug?: string | null }>;
  /** La factura ya tiene líneas o impuestos: entonces no se tocan los importes. */
  hasContent: boolean;
  found: PartialInvoice;
  /** Procedencia de cada dato (para su nivel). Sin ella, todo cuenta como regla. */
  provenance?: Record<string, FieldProvenance>;
  reading: ReadingSummary;
  /** Ids nuevos (estables en el servidor, para reintentos idempotentes). */
  newId: (kind: string) => string;
  /** Las demás facturas: con el mismo proveedor y número, el número no se escribe (sería un duplicado). */
  invoices?: Array<{ id: string; code?: string | null; supplier_id: string; invoice_number: string | null; status: string; deleted_at: string | null }>;
}

const normTaxId = (raw: string) => validSpanishTaxId(raw) ?? raw.replace(/[\s.-]/g, '').toUpperCase();

/** Operaciones para rellenar (o mejorar) con lo encontrado, respetando la precedencia. Siempre guarda el resumen. */
export function partialFillOperations(x: PartialFillInput): { ops: Array<Record<string, unknown>>; filled: Record<string, FilledField>; duplicateOf: { id: string; code: string | null } | null } {
  const { invoice, found } = x;
  const ops: Array<Record<string, unknown>> = [];
  const fields: Record<string, unknown> = {};
  const before = previousFilled(invoice.import_meta);
  const filled: Record<string, FilledField> = { ...before };
  const level = (field: string) => levelOf(x.provenance?.[PROVENANCE_KEY[field] ?? '']);
  /** Vacío, o rellenado antes por la lectura con menos nivel y sin tocar desde entonces. */
  const writable = (field: string, current: unknown) => {
    if (current === null || current === undefined || current === '') return true;
    const prev = before[field];
    return !!prev && String(prev.value) === String(current) && RANK[level(field)] > RANK[prev.level];
  };
  const set = (field: string, current: unknown, value: string | number) => {
    if (String(current ?? '') === String(value) || !writable(field, current)) return;
    fields[field] = value; filled[field] = { value, level: level(field) };
  };
  // Proveedor: el provisional se sustituye por un NIF válido (con nombre, si es nuevo).
  if (x.placeholderSupplierId && invoice.supplier_id === x.placeholderSupplierId && found.supplier_tax_id) {
    const id = normTaxId(found.supplier_tax_id);
    const known = x.suppliers.find((s) => !s.deleted_at && s.slug !== 'sin_identificar' && s.tax_id && normTaxId(s.tax_id) === id);
    if (known) { fields.supplier_id = known.id; filled.supplier_id = { value: known.id, level: level('supplier_id') }; }
    else if (found.supplier_name) {
      const supplierId = x.newId('supplier');
      ops.push({ op: 'insert', table: 'invoices.suppliers', id: supplierId, fields: { name: found.supplier_name.slice(0, 160), tax_id: id } });
      fields.supplier_id = supplierId; filled.supplier_id = { value: supplierId, level: level('supplier_id') };
    }
  }
  // Mismo proveedor y número que otra factura viva: es un duplicado; el número no se escribe (lo dice `duplicateOf`).
  const supplierAfter = String(fields.supplier_id ?? invoice.supplier_id);
  const duplicate = found.invoice_number ? (x.invoices ?? []).find((o) => o.id !== invoice.id && !o.deleted_at && o.status !== 'anulada' && o.supplier_id === supplierAfter
    && (o.invoice_number ?? '').trim().toLowerCase() === found.invoice_number!.trim().toLowerCase()) ?? null : null;
  if (found.invoice_number && !duplicate) set('invoice_number', invoice.invoice_number, found.invoice_number);
  if (found.invoice_date) set('invoice_date', invoice.invoice_date, found.invoice_date);
  const total = invoice.source_total === null || invoice.source_total === undefined ? null : Number(invoice.source_total);
  if (found.total !== null) set('source_total', total, found.total);
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
    if (amountOps.length) filled.base = { value: found.base, level: level('base') };
  }
  const meta = invoice.import_meta && typeof invoice.import_meta === 'object' && !Array.isArray(invoice.import_meta) ? invoice.import_meta as Record<string, unknown> : {};
  fields.import_meta = { ...meta, reading: { ...x.reading, filled } };
  ops.push({ op: 'update', table: 'invoices.invoices', id: invoice.id, ...(invoice.revision !== undefined ? { expectedRevision: invoice.revision } : {}), fields });
  ops.push(...amountOps);
  return { ops, filled, duplicateOf: duplicate ? { id: duplicate.id, code: duplicate.code ?? null } : null };
}

/**
 * El núcleo único de la lectura en el servidor (fase 1): Drive, la relectura y el texto que sube la app pasan por aquí.
 * Lee los fragmentos con las plantillas y las reglas y prepara el relleno del borrador. Si la lectura es suficiente, el
 * que llama decide si importa la factura completa (`extraction.document`) o solo rellena.
 */
export function readAndFill(input: {
  items: PdfTextItem[];
  invoice: PartialFillInput['invoice'];
  suppliers: Array<{ id: string; name: string; tax_id: string | null; deleted_at?: string | null; slug?: string | null }>;
  templates: TemplateLike[];
  placeholderSupplierId: string | null;
  hasContent: boolean;
  readerVersion: number;
  at: string;
  newId: (kind: string) => string;
  invoices?: PartialFillInput['invoices'];
}): { extraction: TemplateExtraction; summary: ReadingSummary; ops: Array<Record<string, unknown>>; filled: Record<string, FilledField>; duplicateOf: { id: string; code: string | null } | null } {
  const extraction = extractWithTemplates(input.items, { suppliers: input.suppliers.filter((s) => !s.deleted_at).map((s) => ({ id: s.id, name: s.name, tax_id: s.tax_id })), templates: input.templates });
  const summary = readingSummary(extraction, input.readerVersion, input.at);
  const fill = partialFillOperations({
    invoice: input.invoice, placeholderSupplierId: input.placeholderSupplierId, suppliers: input.suppliers, hasContent: input.hasContent,
    found: extraction.found, provenance: extraction.provenance, reading: summary, newId: input.newId, invoices: input.invoices,
  });
  return { extraction, summary, ...fill };
}

/**
 * Antes de importar una lectura completa sobre un borrador: lo que ya escribió una persona (número o fecha distintos de
 * los que rellenó la lectura automática) manda sobre lo leído.
 */
export function keepHumanFields(document: ImportDocument, invoice: { invoice_number: string | null; invoice_date: string | null; import_meta?: unknown }): ImportDocument {
  const filled = previousFilled(invoice.import_meta);
  const human = (field: 'invoice_number' | 'invoice_date') => invoice[field] && invoice[field] !== filled[field]?.value ? invoice[field] : null;
  const number = human('invoice_number');
  const date = human('invoice_date');
  if (!number && !date) return document;
  return { ...document, invoice: { ...document.invoice, ...(number ? { invoice_number: number } : {}), ...(date ? { invoice_date: date } : {}) } };
}
