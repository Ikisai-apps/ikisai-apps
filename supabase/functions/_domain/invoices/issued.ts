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

export const ISSUED_STATUSES = ['registrada', 'anulada', 'borrador', 'emitida', 'rectificada'] as const;
export type IssuedStatus = (typeof ISSUED_STATUSES)[number];
/** Estados que cuentan en resúmenes y entregas: registradas de otra herramienta, emitidas y rectificadas (§14.3). */
export const ISSUED_COUNTED_STATUSES: readonly IssuedStatus[] = ['registrada', 'emitida', 'rectificada'];
export const SERIES_MODES = ['registro', 'emision'] as const;
export const RECIPIENT_KINDS = ['empresa', 'profesional', 'particular'] as const;
export const ISSUED_ORIGINS = ['manual', 'importada', 'app'] as const;
export type IssuedOrigin = (typeof ISSUED_ORIGINS)[number];
export const ISSUED_ORIGIN_LABELS: Record<IssuedOrigin, string> = { manual: 'Registrada a mano', importada: 'Importada de otra herramienta', app: 'Emitida desde la app' };

/** Categorías de ingreso (confirmadas por el usuario en la ronda 26). */
export const INCOME_CATEGORIES = ['alojamiento', 'restauracion', 'actividades', 'eventos', 'tienda', 'artesania', 'consultoria', 'otros'] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
export const INCOME_CATEGORY_LABELS: Record<IncomeCategory, string> = {
  alojamiento: 'Alojamiento', restauracion: 'Restauración', actividades: 'Actividades', eventos: 'Eventos',
  tienda: 'Tienda (productos alimentarios)', artesania: 'Artesanía', consultoria: 'Consultoría tecnológica', otros: 'Otros',
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
  /** `registro` (otra herramienta) o `emision` (Finance asigna el número al emitir, §14.2). */
  mode: (typeof SERIES_MODES)[number];
  closed_at: string | null;
  closed_last_number: string | null;
  counter_year: number | null;
  counter_last: number;
  counter_last_date: string | null;
}

export interface IssuedInvoiceRow extends SyncedColumns {
  series_code: string;
  /** `null` solo en borrador: el número lo asigna el servidor al emitir. */
  number: string | null;
  full_number: string | null;
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
  /** Emisor (la entidad de Central) copiado al registrar: NIF y nombre para Verifactu, y el resto en `issuer`. */
  issuer_tax_id: string | null;
  issuer_name: string | null;
  issuer: IssuerSnapshot | null;
}

/** Datos de la entidad (Central) tal como se copian en una emitida al registrarla. */
export interface IssuerSnapshot {
  entity_id: string;
  entity_revision: number;
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  address_line: string;
  postal_code: string;
  city: string;
  province: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  logo_file_id: string | null;
}

/** Fila de `central.common_entity_projection` a copia del emisor (sin rutas de almacenamiento). */
export function issuerSnapshot(row: Record<string, unknown> | null | undefined): IssuerSnapshot | null {
  if (!row || !row.entity_id || !row.legal_name || !row.tax_id) return null;
  const s = (k: string) => (row[k] === null || row[k] === undefined ? null : String(row[k]));
  return {
    entity_id: String(row.entity_id), entity_revision: Number(row.entity_revision ?? 0), legal_name: String(row.legal_name), trade_name: s('trade_name'),
    tax_id: String(row.tax_id), address_line: s('address_line') ?? '', postal_code: s('postal_code') ?? '', city: s('city') ?? '', province: s('province'),
    country: s('country') ?? 'ES', email: s('email'), phone: s('phone'), website: s('website'), logo_file_id: s('logo_file_id'),
  };
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

/** Resumen de emitidas de un periodo: IVA repercutido (misma forma que `invoices.issued_summary_for` en SQL). */
export interface IssuedSummary {
  invoices: { registrada: number; anulada: number };
  base: number;
  quota: number;
  surcharge: number;
  withholding: number;
  total: number;
  quota_by_rate: Array<{ tax: string; rate: number | null; base: number; quota: number; surcharge: number }>;
  by_category: Array<{ income_category: IncomeCategory | null; base: number; total: number; count: number }>;
  alerts: { unpaid: number; discrepancies: Array<{ id: string; full_number: string; totals_delta: number | null }>; missing_file: number };
}

export interface IssuedSummaryInput {
  invoices: IssuedInvoiceRow[];
  lines: IssuedLineRow[];
  taxLines: IssuedTaxLineRow[];
  /** Ids de emitidas con al menos un documento vivo (alerta `missing_file`). */
  withFile?: Set<string>;
}

export function issuedSummary(input: IssuedSummaryInput, range: { from: string; to: string }): IssuedSummary {
  const live = input.invoices.filter((i) => !i.deleted_at && i.status !== 'borrador' && i.issue_date >= range.from && i.issue_date <= range.to);
  const summed = live.filter((i) => ISSUED_COUNTED_STATUSES.includes(i.status));
  const ids = new Set(summed.map((i) => i.id));
  const sum = (values: Array<number | null | undefined>) => fromCents(values.reduce<number>((acc, v) => acc + toCents(Number(v ?? 0)), 0));
  const breakdown = input.taxLines.filter((t) => !t.deleted_at && ids.has(t.issued_invoice_id) && !(WITHHOLDING_TAXES as readonly string[]).includes(t.tax));
  const withBreakdown = new Set(breakdown.map((t) => t.issued_invoice_id));
  const groups = new Map<string, { tax: string; rate: number | null; base: number; quota: number; surcharge: number }>();
  const add = (tax: string, rate: number | null, base: number, quota: number, surcharge: number) => {
    const key = `${tax}|${rate ?? ''}`;
    const g = groups.get(key) ?? { tax, rate, base: 0, quota: 0, surcharge: 0 };
    g.base += toCents(base); g.quota += toCents(quota); g.surcharge += toCents(surcharge);
    groups.set(key, g);
  };
  for (const t of breakdown) add(t.tax, t.rate === null ? null : Number(t.rate), Number(t.taxable_base ?? 0), Number(t.quota), Number(t.surcharge_quota ?? 0));
  for (const l of input.lines) {
    if (l.deleted_at || !ids.has(l.issued_invoice_id) || withBreakdown.has(l.issued_invoice_id)) continue;
    const quota = l.vat_amount ?? Math.round(Number(l.net_amount) * Number(l.vat_rate ?? 0)) / 100;
    add(l.tax, l.vat_rate === null ? null : Number(l.vat_rate), Number(l.net_amount), Number(quota), Number(l.surcharge_amount ?? 0));
  }
  const quota_by_rate = [...groups.values()]
    .sort((a, b) => a.tax.localeCompare(b.tax) || (a.rate ?? -1) - (b.rate ?? -1))
    .map((g) => ({ tax: g.tax, rate: g.rate, base: fromCents(g.base), quota: fromCents(g.quota), surcharge: fromCents(g.surcharge) }));
  const cats = new Map<string, { income_category: IncomeCategory | null; base: number[]; total: number[]; count: number }>();
  for (const i of summed) {
    const key = i.income_category ?? '';
    const c = cats.get(key) ?? { income_category: i.income_category ?? null, base: [], total: [], count: 0 };
    c.base.push(Number(i.base_total)); c.total.push(Number(i.total)); c.count += 1;
    cats.set(key, c);
  }
  return {
    invoices: { registrada: summed.length, anulada: live.filter((i) => i.status === 'anulada').length },
    base: sum(summed.map((i) => i.base_total)),
    quota: sum(summed.map((i) => i.quota_total)),
    surcharge: sum(summed.map((i) => i.surcharge_total)),
    withholding: sum(summed.map((i) => i.withholding_total)),
    total: sum(summed.map((i) => i.total)),
    quota_by_rate,
    by_category: [...cats.values()].sort((a, b) => (a.income_category ?? '￿').localeCompare(b.income_category ?? '￿'))
      .map((c) => ({ income_category: c.income_category, base: sum(c.base), total: sum(c.total), count: c.count })),
    alerts: {
      unpaid: summed.filter((i) => i.payment_status !== 'cobrada').length,
      discrepancies: summed.filter((i) => i.review_reason === 'REVISAR IMPORTES').sort((a, b) => a.issue_date.localeCompare(b.issue_date) || (a.full_number ?? '').localeCompare(b.full_number ?? ''))
        .map((i) => ({ id: i.id, full_number: i.full_number ?? '', totals_delta: i.totals_delta === null ? null : Number(i.totals_delta) })),
      missing_file: input.withFile ? summed.filter((i) => !input.withFile!.has(i.id)).length : 0,
    },
  };
}
