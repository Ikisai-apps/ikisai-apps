/**
 * Invoices · facturas emitidas registradas (API.md §13). Listas cerradas, tipos de fila y recálculo de importes, con la
 * misma regla que `invoices.recalculate_issued` en SQL. Compartido por la Edge y el frontend.
 */
import { fromCents, toCents } from './money.ts';
import type { SyncedColumns } from './types.ts';

/** Tipos de factura de la AEAT (lista a confirmar contra la especificación vigente antes de emitir desde la app). */
export const ISSUED_TYPES = ['F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;
export type IssuedType = (typeof ISSUED_TYPES)[number];
export const ISSUED_TYPE_LABELS: Record<IssuedType, string> = {
  F1: 'Completa',
  F2: 'Simplificada (ticket)',
  F3: 'Sustitutiva de simplificadas',
  R1: 'Rectificativa (error fundado en derecho)',
  R2: 'Rectificativa (concurso de acreedores)',
  R3: 'Rectificativa (créditos incobrables)',
  R4: 'Rectificativa (resto de causas)',
  R5: 'Rectificativa de simplificada',
};
export const isRectificative = (type: string | null | undefined): boolean => !!type && type.startsWith('R');
/** Simplificadas: el destinatario puede faltar. */
export const recipientOptional = (type: string | null | undefined): boolean => type === 'F2' || type === 'R5';

export const RECTIFICATION_KINDS = ['S', 'I'] as const;
export const RECTIFICATION_KIND_LABELS: Record<string, string> = { S: 'Por sustitución', I: 'Por diferencias' };

export const RECIPIENT_ID_TYPES = ['NIF', '02', '03', '04', '05', '06'] as const;
export const RECIPIENT_ID_TYPE_LABELS: Record<string, string> = {
  NIF: 'NIF español', '02': 'NIF-IVA (UE)', '03': 'Pasaporte', '04': 'Documento oficial del país', '05': 'Certificado de residencia', '06': 'Otro',
};

export const ISSUED_STATUSES = ['registrada', 'anulada'] as const;
export type IssuedStatus = (typeof ISSUED_STATUSES)[number];
export const ISSUED_ORIGINS = ['manual', 'importada', 'app'] as const;
export type IssuedOrigin = (typeof ISSUED_ORIGINS)[number];
export const ISSUED_ORIGIN_LABELS: Record<IssuedOrigin, string> = { manual: 'Registrada a mano', importada: 'Importada de otra herramienta', app: 'Emitida desde la app' };

/** Categorías de ingreso (propuestas; a confirmar con el usuario). */
export const INCOME_CATEGORIES = ['alojamiento', 'restauracion', 'actividades', 'eventos', 'otros'] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
export const INCOME_CATEGORY_LABELS: Record<IncomeCategory, string> = {
  alojamiento: 'Alojamiento', restauracion: 'Restauración', actividades: 'Actividades', eventos: 'Eventos', otros: 'Otros',
};

export const ISSUED_TAXES = ['iva', 'igic', 'ipsi', 'otros'] as const;
export const ISSUED_TAX_LINE_TAXES = ['iva', 'igic', 'ipsi', 'otros', 'irpf', 'otra_retencion'] as const;
export const WITHHOLDING_TAXES = ['irpf', 'otra_retencion'] as const;
export const QUALIFICATIONS = ['S1', 'S2', 'N1', 'N2'] as const;
export const EXEMPTIONS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'] as const;
export const SERIES_KINDS = ['ordinaria', 'rectificativa', 'simplificada'] as const;
export const ISSUED_TARGET_KINDS: Record<string, readonly string[]> = { booking: ['reservation', 'event'], general: ['general'] };

export interface IssuedSeriesRow extends SyncedColumns {
  code: string;
  description: string | null;
  kind: (typeof SERIES_KINDS)[number];
  yearly: boolean;
  format: string;
  active: boolean;
}

export interface IssuedInvoiceRow extends SyncedColumns {
  series_code: string;
  number: string;
  full_number: string;
  issue_date: string;
  operation_date: string | null;
  fiscal_year: number;
  fiscal_quarter: number;
  invoice_type: IssuedType;
  rectification_kind: 'S' | 'I' | null;
  rectified: Array<{ series?: string; number: string; issue_date?: string; issued_invoice_id?: string }>;
  rectification_reason: string | null;
  rectified_base: number | null;
  rectified_quota: number | null;
  recipient_name: string | null;
  recipient_tax_id: string | null;
  recipient_id_type: string | null;
  recipient_country: string | null;
  extra_recipients: unknown[];
  description: string;
  notes: string | null;
  currency: string;
  base_total: number;
  quota_total: number;
  surcharge_total: number;
  withholding_total: number;
  total: number;
  source_total: number | null;
  totals_delta: number | null;
  status: IssuedStatus;
  review_reason: string | null;
  annulled_reason: string | null;
  origin: IssuedOrigin;
  external_tool: string | null;
  external_id: string | null;
  import_sha256: string | null;
  income_category: IncomeCategory | null;
  payment_status: 'pendiente' | 'cobrada';
  paid_at: string | null;
  external_qr_url: string | null;
  external_csv: string | null;
  vf_status: string | null;
}

export interface IssuedLineRow extends SyncedColumns {
  issued_invoice_id: string;
  position: number;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  discount_amount: number;
  net_amount: number;
  tax: (typeof ISSUED_TAXES)[number];
  vat_rate: number | null;
  vat_amount: number | null;
  surcharge_rate: number | null;
  surcharge_amount: number | null;
  gross_amount: number | null;
  notes: string | null;
}

export interface IssuedTaxLineRow extends SyncedColumns {
  issued_invoice_id: string;
  position: number;
  tax: (typeof ISSUED_TAX_LINE_TAXES)[number];
  regime_key: string;
  qualification: string | null;
  exemption: string | null;
  rate: number | null;
  taxable_base: number | null;
  quota: number;
  surcharge_rate: number | null;
  surcharge_quota: number | null;
}

export interface IssuedFileRow extends SyncedColumns {
  issued_invoice_id: string;
  file_id: string;
  original_filename: string;
  normalized_filename: string | null;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  page_order: number;
}

export interface IssuedAllocationRow extends SyncedColumns {
  issued_invoice_id: string;
  target_app: 'booking' | 'general';
  target_kind: string;
  target_id: string | null;
  target_code: string | null;
  target_label: string;
  target_revision: number | null;
  allocated_amount: number;
  notes: string | null;
}

export interface IssuedTotals { base: number; quota: number; surcharge: number; withholding: number; total: number }

type LineLike = Pick<IssuedLineRow, 'net_amount' | 'vat_rate' | 'vat_amount' | 'surcharge_rate' | 'surcharge_amount'> & { deleted_at?: string | null };
type TaxLike = Pick<IssuedTaxLineRow, 'tax' | 'taxable_base' | 'quota' | 'surcharge_quota'> & { deleted_at?: string | null };

/** Recálculo de una emitida (misma regla que SQL): con desglose manda el desglose; sin él, líneas agrupadas por tipo. */
export function recalculateIssued(lines: LineLike[], taxes: TaxLike[]): IssuedTotals {
  const live = <T extends { deleted_at?: string | null }>(rows: T[]) => rows.filter((r) => !r.deleted_at);
  const n = (v: unknown) => toCents(Number(v ?? 0));
  const breakdown = live(taxes).filter((t) => !(WITHHOLDING_TAXES as readonly string[]).includes(t.tax));
  let base = 0; let quota = 0; let surcharge = 0;
  if (breakdown.length) {
    for (const t of breakdown) { base += n(t.taxable_base); quota += n(t.quota); surcharge += n(t.surcharge_quota); }
  } else {
    const groups = new Map<string, { net: number; amounts: number; all: boolean; sAmounts: number; sAll: boolean; rate: number; sRate: number }>();
    for (const l of live(lines)) {
      base += n(l.net_amount);
      const key = `${l.vat_rate ?? ''}|${l.surcharge_rate ?? ''}`;
      const g = groups.get(key) ?? { net: 0, amounts: 0, all: true, sAmounts: 0, sAll: true, rate: Number(l.vat_rate ?? 0), sRate: Number(l.surcharge_rate ?? 0) };
      g.net += n(l.net_amount);
      if (l.vat_amount === null || l.vat_amount === undefined) g.all = false; else g.amounts += n(l.vat_amount);
      if (l.surcharge_amount === null || l.surcharge_amount === undefined) g.sAll = false; else g.sAmounts += n(l.surcharge_amount);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      quota += g.all ? g.amounts : Math.round((g.net * g.rate) / 100);
      surcharge += g.sAll ? g.sAmounts : Math.round((g.net * g.sRate) / 100);
    }
  }
  let withholding = 0;
  for (const t of live(taxes)) if ((WITHHOLDING_TAXES as readonly string[]).includes(t.tax)) withholding += n(t.quota);
  return { base: fromCents(base), quota: fromCents(quota), surcharge: fromCents(surcharge), withholding: fromCents(withholding), total: fromCents(base + quota + surcharge - withholding) };
}

/** Desglose por tipo a partir de las líneas (lo que la app propone al registrar a mano). */
export function breakdownFromLines(lines: LineLike[]): Array<{ rate: number | null; taxable_base: number; quota: number }> {
  const groups = new Map<string, { rate: number | null; net: number; amounts: number; all: boolean }>();
  for (const l of lines.filter((x) => !x.deleted_at)) {
    const key = String(l.vat_rate ?? '');
    const g = groups.get(key) ?? { rate: l.vat_rate ?? null, net: 0, amounts: 0, all: true };
    g.net += toCents(Number(l.net_amount));
    if (l.vat_amount === null || l.vat_amount === undefined) g.all = false; else g.amounts += toCents(Number(l.vat_amount));
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ rate: g.rate, taxable_base: fromCents(g.net), quota: fromCents(g.all ? g.amounts : Math.round((g.net * Number(g.rate ?? 0)) / 100)) }));
}

/** Número completo como lo guarda SQL (`full_number`). */
export function fullNumber(seriesCode: string, number: string): string {
  const s = seriesCode.trim(); const n = number.trim();
  return n.toUpperCase().startsWith(s.toUpperCase()) ? n : `${s}-${n}`;
}
