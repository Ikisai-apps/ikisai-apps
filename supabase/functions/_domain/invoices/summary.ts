/**
 * Lecturas compuestas calculadas sobre filas (espejo local en el cliente, snapshot en la Edge):
 * resumen fiscal (API.md §6.4) y Compras por línea (§6.3). La función SQL `invoices.fiscal_summary`
 * e `invoices.items` devuelven la misma forma.
 */
import { fromCents, sumCents, toCents } from './money.ts';
import type { AllocationRow, ExpenseCategory, InvoiceLineRow, InvoiceRow, InvoiceStatus, SupplierRow, TaxLineRow } from './types.ts';

export interface DateRange {
  kind: 'quarter' | 'month' | 'year' | 'custom';
  year: number;
  quarter: number | null;
  month: number | null;
  from: string;
  to: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function quarterRange(year: number, quarter: number): DateRange {
  const firstMonth = (quarter - 1) * 3 + 1;
  const lastMonth = firstMonth + 2;
  return { kind: 'quarter', year, quarter, month: null, from: `${year}-${pad(firstMonth)}-01`, to: `${year}-${pad(lastMonth)}-${pad(daysInMonth(year, lastMonth))}` };
}

export function monthRange(year: number, month: number): DateRange {
  return { kind: 'month', year, quarter: Math.ceil(month / 3), month, from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}` };
}

export function yearRange(year: number): DateRange {
  return { kind: 'year', year, quarter: null, month: null, from: `${year}-01-01`, to: `${year}-12-31` };
}

export function customRange(from: string, to: string): DateRange {
  return { kind: 'custom', year: Number(from.slice(0, 4)), quarter: null, month: null, from, to };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function inRange(date: string, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

const SUMMED_STATUSES: readonly InvoiceStatus[] = ['validada', 'archivada'];

export interface FiscalSummary {
  range: DateRange;
  invoices: Record<InvoiceStatus, number>;
  base: number;
  vat: number;
  other: number;
  withholding: number;
  total: number;
  vat_by_rate: Array<{ rate: number; base: number; amount: number }>;
  withholdings_by_type: Array<{ tax_type: string; rate: number | null; base: number; amount: number }>;
  by_category: Array<{ expense_category: ExpenseCategory | null; is_investment: boolean; base: number; vat: number; total: number; count: number }>;
  investment: { base: number; total: number; count: number };
  operating: { base: number; total: number; count: number };
  deductibility: Record<string, number>;
  alerts: {
    pending_invoices: Array<{ id: string; code: string | null; status: InvoiceStatus; review_reason: string | null }>;
    discrepancies: Array<{ id: string; code: string | null; totals_delta: number }>;
    deductibility_unreviewed: number;
    missing_file: number;
    unpaid_overdue: number;
  };
}

export interface FiscalSummaryInput {
  invoices: InvoiceRow[];
  taxLines: TaxLineRow[];
  /** Ids de factura que tienen al menos un documento `original` vivo (para la alerta `missing_file`). */
  invoicesWithFile?: Set<string>;
  /** Fecha de referencia `AAAA-MM-DD` para «vencidas»; por defecto hoy en UTC. */
  today?: string;
}

export function fiscalSummary(input: FiscalSummaryInput, range: DateRange): FiscalSummary {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const live = input.invoices.filter((i) => !i.deleted_at && inRange(i.invoice_date, range));
  const counts: Record<InvoiceStatus, number> = { pendiente_datos: 0, pendiente_revision: 0, validada: 0, archivada: 0, anulada: 0 };
  for (const inv of live) counts[inv.status] += 1;
  const summed = live.filter((i) => SUMMED_STATUSES.includes(i.status));
  const summedIds = new Set(summed.map((i) => i.id));

  const vatByRate = new Map<number, { base: number; amount: number }>();
  const withholdingByType = new Map<string, { tax_type: string; rate: number | null; base: number; amount: number }>();
  for (const tax of input.taxLines) {
    if (tax.deleted_at || !summedIds.has(tax.invoice_id)) continue;
    if (tax.tax_type === 'iva') {
      const rate = tax.rate ?? 0;
      const g = vatByRate.get(rate) ?? { base: 0, amount: 0 };
      g.base += toCents(tax.taxable_base ?? 0);
      g.amount += toCents(tax.amount);
      vatByRate.set(rate, g);
    } else if (tax.tax_type === 'irpf' || tax.tax_type === 'otra_retencion') {
      const key = `${tax.tax_type}:${tax.rate ?? ''}`;
      const g = withholdingByType.get(key) ?? { tax_type: tax.tax_type, rate: tax.rate ?? null, base: 0, amount: 0 };
      g.base += toCents(tax.taxable_base ?? 0);
      g.amount += toCents(tax.amount);
      withholdingByType.set(key, g);
    }
  }

  const byCategory = new Map<string, { expense_category: ExpenseCategory | null; is_investment: boolean; base: number; vat: number; total: number; count: number }>();
  const investment = { base: 0, total: 0, count: 0 };
  const operating = { base: 0, total: 0, count: 0 };
  const deductibility: Record<string, number> = { si: 0, no: 0, parcial: 0, pendiente_revision: 0 };
  for (const inv of summed) {
    const key = `${inv.expense_category ?? ''}:${inv.is_investment}`;
    const g = byCategory.get(key) ?? { expense_category: inv.expense_category, is_investment: inv.is_investment, base: 0, vat: 0, total: 0, count: 0 };
    g.base += toCents(inv.calculated_base);
    g.vat += toCents(inv.calculated_vat);
    g.total += toCents(inv.calculated_total);
    g.count += 1;
    byCategory.set(key, g);
    const bucket = inv.is_investment ? investment : operating;
    bucket.base += toCents(inv.calculated_base);
    bucket.total += toCents(inv.calculated_total);
    bucket.count += 1;
    deductibility[inv.deductibility] = (deductibility[inv.deductibility] ?? 0) + toCents(inv.calculated_base);
  }

  const pending = live.filter((i) => i.status === 'pendiente_datos' || i.status === 'pendiente_revision');
  return {
    range,
    invoices: counts,
    base: fromCents(sumCents(summed.map((i) => i.calculated_base))),
    vat: fromCents(sumCents(summed.map((i) => i.calculated_vat))),
    other: fromCents(sumCents(summed.map((i) => i.calculated_other))),
    withholding: fromCents(sumCents(summed.map((i) => i.calculated_withholding))),
    total: fromCents(sumCents(summed.map((i) => i.calculated_total))),
    vat_by_rate: [...vatByRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, g]) => ({ rate, base: fromCents(g.base), amount: fromCents(g.amount) })),
    withholdings_by_type: [...withholdingByType.values()].sort((a, b) => a.tax_type.localeCompare(b.tax_type) || (a.rate ?? 0) - (b.rate ?? 0)).map((g) => ({ ...g, base: fromCents(g.base), amount: fromCents(g.amount) })),
    by_category: [...byCategory.values()].sort((a, b) => b.base - a.base).map((g) => ({ ...g, base: fromCents(g.base), vat: fromCents(g.vat), total: fromCents(g.total) })),
    investment: { base: fromCents(investment.base), total: fromCents(investment.total), count: investment.count },
    operating: { base: fromCents(operating.base), total: fromCents(operating.total), count: operating.count },
    deductibility: Object.fromEntries(Object.entries(deductibility).map(([k, v]) => [k, fromCents(v)])),
    alerts: {
      pending_invoices: pending.map((i) => ({ id: i.id, code: i.code, status: i.status, review_reason: i.review_reason })),
      discrepancies: live.filter((i) => i.status !== 'anulada' && i.totals_delta !== null && Math.abs(toCents(i.totals_delta)) > 2).map((i) => ({ id: i.id, code: i.code, totals_delta: i.totals_delta as number })),
      deductibility_unreviewed: summed.filter((i) => i.deductibility === 'pendiente_revision').length,
      missing_file: input.invoicesWithFile ? live.filter((i) => i.status !== 'anulada' && !input.invoicesWithFile!.has(i.id)).length : 0,
      unpaid_overdue: live.filter((i) => i.status !== 'anulada' && i.payment_status === 'pendiente' && i.due_date !== null && i.due_date < today).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Compras (líneas como artículos comprados)
// ---------------------------------------------------------------------------

export interface PurchaseFilters {
  range?: DateRange;
  supplierId?: string;
  expenseCategory?: ExpenseCategory;
  isInvestment?: boolean;
  itemType?: string;
  targetApp?: string;
  targetKind?: string;
  targetId?: string;
  unassignedOnly?: boolean;
  /** Solo facturas `validada|archivada` (por defecto `true`, como pide el handoff). */
  validatedOnly?: boolean;
  /** Búsqueda libre en descripción, proveedor, código y objeto. */
  query?: string;
}

export interface PurchaseItem {
  line: InvoiceLineRow;
  invoice: InvoiceRow;
  supplier: SupplierRow | null;
  allocations: AllocationRow[];
  effective_category: ExpenseCategory | null;
  effective_investment: boolean;
  allocated_amount: number;
  unallocated_amount: number;
  allocated_quantity: number | null;
}

export interface PurchaseGroup {
  key: string;
  label: string;
  base: number;
  count: number;
}

export interface PurchaseItemsResult {
  items: PurchaseItem[];
  total_base: number;
  total_allocated: number;
  total_unallocated: number;
  by_category: PurchaseGroup[];
  by_target: PurchaseGroup[];
  by_supplier: PurchaseGroup[];
  by_item_type: PurchaseGroup[];
}

export interface PurchaseItemsInput {
  invoices: InvoiceRow[];
  lines: InvoiceLineRow[];
  suppliers: SupplierRow[];
  allocations: AllocationRow[];
}

export function purchaseItems(input: PurchaseItemsInput, filters: PurchaseFilters = {}): PurchaseItemsResult {
  const validatedOnly = filters.validatedOnly ?? true;
  const invoices = new Map(input.invoices.map((i) => [i.id, i]));
  const suppliers = new Map(input.suppliers.map((s) => [s.id, s]));
  const allocationsByLine = new Map<string, AllocationRow[]>();
  for (const a of input.allocations) {
    if (a.deleted_at) continue;
    const list = allocationsByLine.get(a.invoice_line_id) ?? [];
    list.push(a);
    allocationsByLine.set(a.invoice_line_id, list);
  }
  const q = filters.query?.trim().toLowerCase();
  const items: PurchaseItem[] = [];
  for (const line of input.lines) {
    if (line.deleted_at) continue;
    const invoice = invoices.get(line.invoice_id);
    if (!invoice || invoice.deleted_at || invoice.status === 'anulada') continue;
    if (validatedOnly && !SUMMED_STATUSES.includes(invoice.status)) continue;
    if (filters.range && !inRange(invoice.invoice_date, filters.range)) continue;
    if (filters.supplierId && invoice.supplier_id !== filters.supplierId) continue;
    const supplier = suppliers.get(invoice.supplier_id) ?? null;
    const category = line.expense_category ?? invoice.expense_category;
    const investment = line.is_investment ?? invoice.is_investment;
    if (filters.expenseCategory && category !== filters.expenseCategory) continue;
    if (filters.isInvestment !== undefined && investment !== filters.isInvestment) continue;
    if (filters.itemType && line.item_type !== filters.itemType) continue;
    const allocations = allocationsByLine.get(line.id) ?? [];
    const allocatedCents = sumCents(allocations.map((a) => a.allocated_amount));
    const unallocatedCents = Math.max(0, toCents(line.net_amount) - allocatedCents);
    if (filters.unassignedOnly && unallocatedCents === 0) continue;
    if (filters.targetApp && !allocations.some((a) => a.target_app === filters.targetApp && (!filters.targetKind || a.target_kind === filters.targetKind) && (!filters.targetId || a.target_id === filters.targetId))) continue;
    if (q) {
      const haystack = [line.description, line.match_name ?? '', supplier?.name ?? '', invoice.code ?? '', invoice.object].join(' ').toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    const quantities = allocations.map((a) => a.allocated_quantity).filter((x): x is number => x !== null);
    items.push({
      line, invoice, supplier, allocations,
      effective_category: category,
      effective_investment: investment,
      allocated_amount: fromCents(allocatedCents),
      unallocated_amount: fromCents(unallocatedCents),
      allocated_quantity: quantities.length ? quantities.reduce((a, b) => a + b, 0) : null,
    });
  }
  items.sort((a, b) => b.invoice.invoice_date.localeCompare(a.invoice.invoice_date) || (a.invoice.code ?? '').localeCompare(b.invoice.code ?? '') || a.line.position - b.line.position);

  const group = (keyOf: (item: PurchaseItem) => Array<[string, string, number]>): PurchaseGroup[] => {
    const map = new Map<string, PurchaseGroup>();
    for (const item of items) {
      for (const [key, label, cents] of keyOf(item)) {
        const g = map.get(key) ?? { key, label, base: 0, count: 0 };
        g.base += cents;
        g.count += 1;
        map.set(key, g);
      }
    }
    return [...map.values()].sort((a, b) => (a.key === 'unassigned' ? -1 : b.key === 'unassigned' ? 1 : b.base - a.base)).map((g) => ({ ...g, base: fromCents(g.base) }));
  };

  return {
    items,
    total_base: fromCents(sumCents(items.map((i) => i.line.net_amount))),
    total_allocated: fromCents(sumCents(items.map((i) => i.allocated_amount))),
    total_unallocated: fromCents(sumCents(items.map((i) => i.unallocated_amount))),
    by_category: group((i) => [[`${i.effective_category ?? 'sin_categoria'}${i.effective_investment ? ':inv' : ''}`, `${i.effective_category ?? 'Sin categoría'}${i.effective_investment ? ' (inversión)' : ''}`, toCents(i.line.net_amount)]]),
    by_target: group((i) => {
      const out: Array<[string, string, number]> = i.allocations.map((a) => [`${a.target_app}:${a.target_kind}:${a.target_id ?? ''}`, a.target_label, toCents(a.allocated_amount)]);
      if (toCents(i.unallocated_amount) > 0) out.push(['unassigned', 'Sin asignar', toCents(i.unallocated_amount)]);
      return out;
    }),
    by_supplier: group((i) => [[i.invoice.supplier_id, i.supplier?.name ?? 'Proveedor desconocido', toCents(i.line.net_amount)]]),
    by_item_type: group((i) => [[i.line.item_type ?? 'other', i.line.item_type ?? 'other', toCents(i.line.net_amount)]]),
  };
}
