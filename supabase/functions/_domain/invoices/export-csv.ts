/**
 * CSV de la entrega a gestoría (API.md §6.5), generados desde el manifest congelado de `invoices.exports`.
 * Separador `;`, UTF-8 con BOM, decimales con coma (Excel en español), fechas AAAA-MM-DD.
 */

export const CSV_BOM = '﻿';

type Cell = string | number | boolean | null | undefined;

/** Importe con dos decimales y coma. */
export const money = (value: number | null | undefined): string => (value === null || value === undefined ? '' : value.toFixed(2).replace('.', ','));
/** Cantidad con hasta tres decimales y coma. */
export const qty = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(Math.round(value * 1000) / 1000).replace('.', ','));
/** Tipo o tasa tal cual, con coma. */
export const rate = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(value).replace('.', ','));

function cell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
  if (typeof value === 'boolean') return value ? 'si' : 'no';
  const text = String(value);
  return /[;"\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function csvRows(header: string[], rows: Cell[][]): string {
  return CSV_BOM + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

/** Forma mínima del manifest que necesitan los CSV (es la que produce `invoices.export_manifest`). */
export interface ManifestInvoice {
  code: string;
  invoice_date: string;
  supplier: { name: string; tax_id: string | null };
  invoice_number: string | null;
  object: string;
  expense_category: string | null;
  is_investment: boolean;
  deductibility: string;
  base: number;
  vat: number;
  other: number;
  withholding: number;
  total: number;
  source_total: number | null;
  totals_delta: number | null;
  status: string;
  payment: { status: string; method: string | null; paid_at: string | null };
  taxes: Array<{ tax_type: string; rate: number | null; taxable_base: number | null; amount: number }>;
  lines: Array<{
    position: number; description: string; item_type: string | null; quantity: number | null; unit: string | null; unit_price: number | null; discount_amount: number;
    net_amount: number; vat_rate: number | null; vat_amount: number | null; gross_amount: number | null; expense_category: string | null; is_investment: boolean;
    allocations: Array<{ target_app: string; target_kind: string; target_label: string; allocated_amount: number }>;
  }>;
  files: Array<{ name: string; sha256: string; size_bytes: number; mime_type: string; kind: string; page_order: number }>;
  missing_file: boolean;
  /** Rectificativa recibida (0227): tipo y referencia a la original. */
  kind?: 'ordinaria' | 'rectificativa';
  rectifies?: { code: string | null; invoice_number: string | null; invoice_date: string | null; other_period: boolean; without_original: boolean } | null;
  /** Periodo de declaración (0228) y si va atrasada (fecha de un trimestre anterior). */
  declared_period?: string | null;
  late?: boolean;
}

export interface ManifestTotals {
  base: number; vat: number; other: number; withholding: number; total: number;
  vat_by_rate: Array<{ rate: number; base: number; amount: number }>;
  withholdings_by_type: Array<{ tax_type: string; rate: number | null; base: number; amount: number }>;
}

export interface ExportManifest {
  schema: string;
  export: { folder: string; range: { kind: string; year: number; quarter: number | null; from: string; to: string }; created_at: string };
  invoice_count: number;
  file_count: number;
  totals: ManifestTotals;
  invoices: ManifestInvoice[];
  excluded: Array<{ code: string; status: string; reason: string | null }>;
  /** Emitidas del periodo (desde la migración 0206; las entregas anteriores no las traen). */
  issued_count?: number;
  issued_file_count?: number;
  issued_totals?: { base: number; quota: number; surcharge: number; withholding: number; total: number; quota_by_rate: Array<{ tax: string; rate: number | null; base: number; quota: number; surcharge: number }> };
  issued?: ManifestIssued[];
}

export interface ManifestIssued {
  id: string;
  full_number: string;
  revision: number;
  series: string;
  number: string;
  issue_date: string;
  operation_date: string | null;
  invoice_type: string;
  rectification: { kind: string | null; rectified: unknown[]; reason: string | null } | null;
  recipient: { name: string | null; tax_id: string | null; id_type: string | null; country: string | null };
  description: string;
  income_category: string | null;
  origin: string;
  external_tool: string | null;
  base: number; quota: number; surcharge: number; withholding: number; total: number;
  source_total: number | null; totals_delta: number | null;
  status: string;
  annulled_reason: string | null;
  payment: { status: string; paid_at: string | null };
  files: Array<{ name: string; file_id: string; sha256: string; size_bytes: number }>;
}

/** Libro de emitidas del periodo, con las anuladas para que se vea la numeración completa. */
export function issuedCsv(manifest: ExportManifest): string {
  return csvRows(
    ['numero', 'serie', 'fecha_expedicion', 'fecha_operacion', 'tipo', 'destinatario', 'nif', 'concepto', 'categoria', 'base', 'cuota', 'recargo', 'retenciones', 'total', 'total_documento', 'delta', 'estado', 'motivo_anulacion', 'cobro', 'rectifica', 'origen', 'documentos'],
    (manifest.issued ?? []).map((i) => [
      i.full_number, i.series, i.issue_date, i.operation_date, i.invoice_type, i.recipient.name, i.recipient.tax_id, i.description, i.income_category,
      money(i.base), money(i.quota), money(i.surcharge), money(i.withholding), money(i.total), money(i.source_total), money(i.totals_delta), i.status, i.annulled_reason,
      i.payment.status, i.rectification ? JSON.stringify(i.rectification.rectified) : null, i.external_tool ?? i.origin,
      i.files.map((f) => f.name.replace(/^emitidas\//, '')).join(' | '),
    ]),
  );
}

export function invoicesCsv(manifest: ExportManifest): string {
  return csvRows(
    ['codigo', 'fecha', 'proveedor', 'nif', 'numero', 'objeto', 'categoria', 'inversion', 'deducibilidad', 'base', 'iva', 'otros', 'retenciones', 'total', 'total_documento', 'delta', 'estado', 'pago', 'metodo_pago', 'fecha_pago', 'archivos', 'tipo', 'rectifica', 'fecha_original', 'original_otro_periodo', 'periodo_declaracion', 'atrasada'],
    manifest.invoices.map((i) => [
      i.code, i.invoice_date, i.supplier.name, i.supplier.tax_id, i.invoice_number, i.object, i.expense_category, i.is_investment, i.deductibility,
      money(i.base), money(i.vat), money(i.other), money(i.withholding), money(i.total), money(i.source_total), money(i.totals_delta), i.status, i.payment.status, i.payment.method, i.payment.paid_at,
      i.files.map((f) => f.name.replace(/^facturas\//, '')).join(' | '),
      // Libro de recibidas: F1 ordinaria, R rectificativa con la referencia a la original (que puede ser de otro periodo)
      i.kind === 'rectificativa' ? 'R' : 'F1',
      i.kind === 'rectificativa' ? (i.rectifies?.invoice_number ?? (i.rectifies?.without_original ? 'sin original' : null)) : null,
      i.kind === 'rectificativa' ? i.rectifies?.invoice_date ?? null : null,
      i.kind === 'rectificativa' ? !!i.rectifies?.other_period : null,
      i.declared_period ?? null,
      !!i.late,
    ]),
  );
}

export function linesCsv(manifest: ExportManifest): string {
  const rows: Cell[][] = [];
  for (const i of manifest.invoices) {
    for (const l of i.lines) {
      rows.push([
        i.code, i.invoice_date, i.supplier.name, l.position + 1, l.description, l.item_type, qty(l.quantity), l.unit, money(l.unit_price), money(l.discount_amount), money(l.net_amount), rate(l.vat_rate), money(l.vat_amount),
        money(l.gross_amount), l.expense_category, l.is_investment,
        l.allocations.map((a) => `${a.target_app}/${a.target_kind}: ${a.target_label} (${money(a.allocated_amount)})`).join(' | '),
      ]);
    }
  }
  return csvRows(
    ['codigo_factura', 'fecha', 'proveedor', 'posicion', 'descripcion', 'tipo_articulo', 'cantidad', 'unidad', 'precio_unitario', 'descuento', 'base', 'iva_tipo', 'iva_importe', 'total_linea', 'categoria', 'inversion', 'asignaciones'],
    rows,
  );
}

export function taxesCsv(manifest: ExportManifest): string {
  const t = manifest.totals;
  const rows: Cell[][] = [
    ...t.vat_by_rate.map((g) => ['iva', rate(g.rate), money(g.base), money(g.amount)]),
    ...t.withholdings_by_type.map((g) => [g.tax_type, rate(g.rate), money(g.base), money(g.amount)]),
    ['base_total', null, money(t.base), null],
    ['iva_total', null, null, money(t.vat)],
    ['otros_total', null, null, money(t.other)],
    ['retenciones_total', null, null, money(t.withholding)],
    ['total', null, null, money(t.total)],
  ];
  // IVA repercutido de las emitidas y diferencia con el soportado (orientativa: la deducibilidad la decide la gestoría).
  const it = manifest.issued_totals;
  if (it) {
    rows.push(
      ...it.quota_by_rate.map((g) => [`${g.tax}_repercutido`, rate(g.rate), money(g.base), money(g.quota)] as Cell[]),
      ['base_emitidas', null, money(it.base), null],
      ['iva_repercutido_total', null, null, money(it.quota)],
      ['recargo_equivalencia_total', null, null, money(it.surcharge)],
      ['retenciones_emitidas', null, null, money(it.withholding)],
      ['diferencia_repercutido_soportado', null, null, money(Math.round((it.quota - t.vat) * 100) / 100)],
    );
  }
  return csvRows(['tipo', 'tasa', 'base', 'importe'], rows);
}

export const EXPORT_CSV_FILES = {
  'facturas_recibidas.csv': invoicesCsv,
  'lineas_compra.csv': linesCsv,
  'resumen_impuestos.csv': taxesCsv,
  'facturas_emitidas.csv': issuedCsv,
} as const;
export type ExportCsvName = keyof typeof EXPORT_CSV_FILES;
