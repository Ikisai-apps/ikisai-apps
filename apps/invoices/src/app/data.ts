/** Lectura del espejo local de Invoices y utilidades de presentación compartidas por las vistas. */
import type { SyncClient } from '@ikisai/sync-client';
import { formatEur, type InvoiceStatus, INVOICE_STATUS_LABELS, type DateRange, quarterRange, monthRange, yearRange } from '@ikisai/domain-invoices';
import {
  ALL_TABLES, ALLOCATIONS, EXPORTS, EXPORT_ITEMS, INVOICES, INVOICE_FILES, INVOICE_LINES, SUPPLIERS, SUPPLIER_TEMPLATES, TAX_LINES, type LocalSupplierTemplate,
  type LocalAllocation, type LocalExport, type LocalExportItem, type LocalInvoice, type LocalInvoiceFile, type LocalInvoiceLine, type LocalSupplier, type LocalTaxLine,
} from './client.ts';

export interface Mirror {
  suppliers: LocalSupplier[];
  invoices: LocalInvoice[];
  lines: LocalInvoiceLine[];
  taxes: LocalTaxLine[];
  files: LocalInvoiceFile[];
  allocations: LocalAllocation[];
  exports: LocalExport[];
  exportItems: LocalExportItem[];
  /** Plantillas por proveedor vivas (fase 3). */
  templates: LocalSupplierTemplate[];
  supplierById: Map<string, LocalSupplier>;
  linesByInvoice: Map<string, LocalInvoiceLine[]>;
  taxesByInvoice: Map<string, LocalTaxLine[]>;
  filesByInvoice: Map<string, LocalInvoiceFile[]>;
  allocationsByLine: Map<string, LocalAllocation[]>;
  itemsByExport: Map<string, LocalExportItem[]>;
}

function group<T extends { deleted_at: string | null }>(rows: T[], key: (row: T) => string, includeDeleted = false): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!includeDeleted && row.deleted_at) continue;
    const k = key(row);
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  return map;
}

/** Carga todas las tablas del espejo (con borradas) y las indexa. */
export async function loadMirror(client: SyncClient): Promise<Mirror> {
  const started = performance.now();
  try {
    return await readMirror(client);
  } finally {
    // Medida de rendimiento (tests/invoices/perf.ts): cuánto tarda recargar el espejo completo.
    try { performance.measure('invoices:loadMirror', { start: started, end: performance.now() }); } catch { /* navegadores sin measure con opciones */ }
  }
}

async function readMirror(client: SyncClient): Promise<Mirror> {
  const [suppliers, invoices, lines, taxes, files, allocations, exports, exportItems, templates] = await Promise.all([
    client.list(SUPPLIERS, { includeDeleted: true }) as Promise<LocalSupplier[]>,
    client.list(INVOICES, { includeDeleted: true }) as Promise<LocalInvoice[]>,
    client.list(INVOICE_LINES, { includeDeleted: true }) as Promise<LocalInvoiceLine[]>,
    client.list(TAX_LINES, { includeDeleted: true }) as Promise<LocalTaxLine[]>,
    client.list(INVOICE_FILES, { includeDeleted: true }) as Promise<LocalInvoiceFile[]>,
    client.list(ALLOCATIONS, { includeDeleted: true }) as Promise<LocalAllocation[]>,
    client.list(EXPORTS, { includeDeleted: true }) as Promise<LocalExport[]>,
    client.list(EXPORT_ITEMS, { includeDeleted: true }) as Promise<LocalExportItem[]>,
    client.list(SUPPLIER_TEMPLATES) as Promise<LocalSupplierTemplate[]>,
  ]);
  const sortPos = <T extends { position: number }>(m: Map<string, T[]>) => { for (const list of m.values()) list.sort((a, b) => a.position - b.position); return m; };
  return {
    suppliers, invoices, lines, taxes, files, allocations, exports, exportItems, templates: templates.filter((t) => !t.deleted_at),
    supplierById: new Map(suppliers.map((s) => [s.id, s])),
    linesByInvoice: sortPos(group(lines, (l) => l.invoice_id)),
    taxesByInvoice: sortPos(group(taxes, (t) => t.invoice_id)),
    filesByInvoice: group(files, (f) => f.invoice_id),
    allocationsByLine: group(allocations, (a) => a.invoice_line_id),
    itemsByExport: group(exportItems, (i) => i.export_id),
  };
}

/** Todas las tablas que la app copia al dispositivo (recibidas y emitidas): cualquier cambio repinta la vista. */
export const ALL_INVOICE_TABLES = ALL_TABLES;

/**
 * Vuelve a cargar cuando cambia cualquier tabla; devuelve la función de baja.
 * Un lote toca varias tablas (factura, líneas, impuestos…) y cada una avisa por separado: se agrupan los avisos en una
 * sola recarga por vuelta (medido con 500 facturas: de 9 recargas por cambio a 1–2; cada una ~120–150 ms con CPU ×4).
 */
export function onAnyTable(client: SyncClient, listener: () => void): () => void {
  let scheduled = false;
  const coalesced = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; listener(); }, 40);
  };
  const offs = ALL_INVOICE_TABLES.map((table) => client.onTable(table, coalesced));
  return () => offs.forEach((off) => off());
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------
export const STATUS_LABELS = INVOICE_STATUS_LABELS;

export const REVIEW_LABELS: Record<string, string> = {
  IMPORTADA: 'Importada, pendiente de revisar',
  DATOS_INTRODUCIDOS: 'Pendiente de revisar',
  'REVISAR IMPORTES': 'REVISAR IMPORTES',
  IMPORTES_CORREGIDOS: 'Importes corregidos, pendiente de validar',
  EDITADA_TRAS_VALIDAR: 'Editada tras validar',
};

export const DEDUCTIBILITY_LABELS: Record<string, string> = { si: 'Deducible', no: 'No deducible', parcial: 'Parcialmente deducible', pendiente_revision: 'Deducibilidad sin revisar' };
export const PAYMENT_METHOD_LABELS: Record<string, string> = { transferencia: 'Transferencia', tarjeta: 'Tarjeta', efectivo: 'Efectivo', bizum: 'Bizum', domiciliacion: 'Domiciliación', otro: 'Otro' };
export const TAX_TYPE_LABELS: Record<string, string> = { iva: 'IVA', irpf: 'IRPF', otra_retencion: 'Otra retención', otro: 'Otro tributo' };
export const ITEM_TYPE_LABELS: Record<string, string> = { food_ingredient: 'Ingrediente', equipment: 'Maquinaria', material: 'Material', service: 'Servicio', other: 'Otro' };
export const TARGET_APP_LABELS: Record<string, string> = { general: 'General', tasks: 'Tareas', booking: 'Reservas', food: 'Cocina' };
export const GENERAL_KIND_LABELS: Record<string, string> = { unassigned: 'Sin asignar', operating_expense: 'Gasto de explotación', investment: 'Inversión' };

export function statusChipClass(status: InvoiceStatus, reviewReason: string | null): string {
  if (status === 'validada' || status === 'archivada') return 'chip ok';
  if (status === 'anulada') return 'chip trash';
  if (reviewReason === 'REVISAR IMPORTES') return 'chip alert';
  return 'chip';
}

export function statusText(invoice: { status: InvoiceStatus; review_reason: string | null }): string {
  if (invoice.status === 'pendiente_revision' && invoice.review_reason) return REVIEW_LABELS[invoice.review_reason] ?? invoice.review_reason;
  return STATUS_LABELS[invoice.status];
}

export const eur = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : formatEur(Number(value), true));

/** Fecha corta `5 oct 2026` a partir de `AAAA-MM-DD`. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** `AAAA-MM`, o «Sin fecha» para una factura recibida que aún no la tiene (0223): `monthLabel` la deja tal cual. */
export function monthKey(iso: string | null): string {
  return iso ? iso.slice(0, 7) : 'Sin fecha';
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  const text = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Rango por defecto: el trimestre actual. */
export function currentQuarter(): DateRange {
  const now = new Date();
  return quarterRange(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) + 1);
}

export type RangeKind = 'quarter' | 'month' | 'year';

export function rangeFor(kind: RangeKind, year: number, part: number): DateRange {
  if (kind === 'quarter') return quarterRange(year, part);
  if (kind === 'month') return monthRange(year, part);
  return yearRange(year);
}

export function rangeLabel(range: DateRange): string {
  if (range.kind === 'quarter') return `${range.quarter}.º trimestre de ${range.year}`;
  if (range.kind === 'month') return monthLabel(`${range.year}-${String(range.month).padStart(2, '0')}`);
  if (range.kind === 'year') return `Año ${range.year}`;
  return `${shortDate(range.from)} – ${shortDate(range.to)}`;
}

export function parseNumber(value: string): number | null {
  const t = value.trim().replace(/\./g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Entrada numérica tolerante: acepta «1.234,56» y «1234.56». */
export function parseAmount(value: string): number | null {
  const t = value.trim();
  if (!t) return null;
  const normalized = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
