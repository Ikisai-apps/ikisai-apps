/**
 * Recálculo y cuadre de una factura (API.md §3.1 paso 5; handoff §24A «Importación desde ChatGPT»).
 * La misma regla vive en SQL (`invoices.recalculate`) y se comprueba su paridad en las pruebas.
 *
 *   calculated_base        = Σ taxable_base de impuestos iva (si alguno trae base) · si no, la de `otro` · si no, Σ net_amount de las líneas
 *   calculated_vat         = Σ amount de impuestos iva
 *   calculated_other       = Σ amount de impuestos otro
 *   calculated_withholding = Σ amount de impuestos irpf|otra_retencion
 *   calculated_total       = base + vat + other − withholding
 *   totals_delta           = source_total − calculated_total   (null si no hay total documental)
 */
import { fromCents, round2, sumCents, toCents, withinTolerance } from './money.ts';
import { TOLERANCE_EUR, type TaxType } from './types.ts';

export interface RecalcLine {
  quantity?: number | null;
  unit_price?: number | null;
  discount_amount?: number | null;
  net_amount: number;
  vat_rate?: number | null;
  vat_amount?: number | null;
}

export interface RecalcTax {
  tax_type: TaxType;
  rate?: number | null;
  taxable_base?: number | null;
  amount: number;
}

export interface DocumentTotals {
  base: number;
  vat: number;
  withholding: number;
  total: number;
}

export type RecalcWarningCode =
  | 'LINE_NET_MISMATCH'
  | 'LINE_VAT_MISMATCH'
  | 'LINE_VAT_RATE_MISSING'
  | 'TAXES_DERIVED_FROM_LINES'
  | 'LINES_VS_BASE'
  | 'BASE_MISMATCH'
  | 'VAT_MISMATCH'
  | 'WITHHOLDING_MISMATCH'
  | 'TOTALS_MISMATCH';

export interface RecalcWarning {
  code: RecalcWarningCode;
  message: string;
  /** Índice de línea cuando aplica. */
  line?: number;
  expected?: number;
  actual?: number;
}

export interface VatByRate {
  rate: number;
  base: number;
  amount: number;
}

export interface Recalculation {
  calculated_base: number;
  calculated_vat: number;
  calculated_other: number;
  calculated_withholding: number;
  calculated_total: number;
  /** Σ net_amount de las líneas. */
  lines_total: number;
  source_total: number | null;
  totals_delta: number | null;
  /** `true` si cuadra, `false` si no, `null` si no hay total documental con el que comparar. */
  within_tolerance: boolean | null;
  vat_by_rate: VatByRate[];
  /** Impuestos que se usarán: los dados o, si no había, los derivados de las líneas. */
  taxes: RecalcTax[];
  taxes_derived: boolean;
  warnings: RecalcWarning[];
}

const TOLERANCE_CENTS = toCents(TOLERANCE_EUR);

/** Importe neto esperado de una línea a partir de cantidad, precio y descuento, o `null` si faltan datos. */
export function expectedLineNet(line: RecalcLine): number | null {
  if (line.quantity == null || line.unit_price == null) return null;
  return round2(round2(line.quantity * line.unit_price) - (line.discount_amount ?? 0));
}

/** Impuestos derivados de las líneas agrupando por `vat_rate`. */
export function derivedTaxes(lines: RecalcLine[]): { taxes: RecalcTax[]; warnings: RecalcWarning[] } {
  const groups = new Map<number, { base: number; amount: number; allAmounts: boolean }>();
  const warnings: RecalcWarning[] = [];
  lines.forEach((line, index) => {
    if (line.vat_rate == null) {
      warnings.push({ code: 'LINE_VAT_RATE_MISSING', message: `La línea ${index + 1} no indica tipo de IVA; no entra en el desglose derivado.`, line: index });
      return;
    }
    const group = groups.get(line.vat_rate) ?? { base: 0, amount: 0, allAmounts: true };
    group.base += toCents(line.net_amount);
    if (line.vat_amount == null) group.allAmounts = false;
    else group.amount += toCents(line.vat_amount);
    groups.set(line.vat_rate, group);
  });
  const taxes: RecalcTax[] = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([rate, g]) => ({
    tax_type: 'iva',
    rate,
    taxable_base: fromCents(g.base),
    amount: g.allAmounts ? fromCents(g.amount) : round2((g.base / 100) * rate / 100),
  }));
  return { taxes, warnings };
}

export function recalculate(lines: RecalcLine[], taxes: RecalcTax[], documentTotals?: DocumentTotals | null, sourceTotal?: number | null): Recalculation {
  const warnings: RecalcWarning[] = [];

  lines.forEach((line, index) => {
    const expected = expectedLineNet(line);
    if (expected !== null && !withinTolerance(expected, line.net_amount)) {
      warnings.push({ code: 'LINE_NET_MISMATCH', message: `Línea ${index + 1}: cantidad × precio − descuento no coincide con el neto.`, line: index, expected, actual: line.net_amount });
    }
    if (line.vat_rate != null && line.vat_amount != null) {
      const expectedVat = round2(line.net_amount * line.vat_rate / 100);
      if (!withinTolerance(expectedVat, line.vat_amount)) {
        warnings.push({ code: 'LINE_VAT_MISMATCH', message: `Línea ${index + 1}: el IVA no coincide con neto × tipo.`, line: index, expected: expectedVat, actual: line.vat_amount });
      }
    }
  });

  let usedTaxes = taxes;
  let derived = false;
  if (taxes.length === 0 && lines.length > 0) {
    const d = derivedTaxes(lines);
    usedTaxes = d.taxes;
    derived = true;
    warnings.push(...d.warnings);
    warnings.push({ code: 'TAXES_DERIVED_FROM_LINES', message: 'El documento no traía desglose de impuestos; se ha derivado de las líneas.' });
  }

  const linesTotalCents = sumCents(lines.map((l) => l.net_amount));
  // Base: la de los impuestos `iva` si la traen; si no, la de `otro`; si no, la suma de las líneas.
  const ivaTaxes = usedTaxes.filter((t) => t.tax_type === 'iva' && t.taxable_base != null);
  const otherTaxes = usedTaxes.filter((t) => t.tax_type === 'otro' && t.taxable_base != null);
  const baseCents = ivaTaxes.length ? sumCents(ivaTaxes.map((t) => t.taxable_base ?? 0)) : otherTaxes.length ? sumCents(otherTaxes.map((t) => t.taxable_base ?? 0)) : linesTotalCents;
  const vatCents = sumCents(usedTaxes.filter((t) => t.tax_type === 'iva').map((t) => t.amount));
  const otherCents = sumCents(usedTaxes.filter((t) => t.tax_type === 'otro').map((t) => t.amount));
  const withholdingCents = sumCents(usedTaxes.filter((t) => t.tax_type === 'irpf' || t.tax_type === 'otra_retencion').map((t) => t.amount));
  const totalCents = baseCents + vatCents + otherCents - withholdingCents;

  const vatByRate = new Map<number, { base: number; amount: number }>();
  for (const tax of usedTaxes) {
    if (tax.tax_type !== 'iva') continue;
    const rate = tax.rate ?? 0;
    const g = vatByRate.get(rate) ?? { base: 0, amount: 0 };
    g.base += toCents(tax.taxable_base ?? 0);
    g.amount += toCents(tax.amount);
    vatByRate.set(rate, g);
  }

  if (documentTotals) {
    if (lines.length && Math.abs(linesTotalCents - toCents(documentTotals.base)) > TOLERANCE_CENTS) {
      warnings.push({ code: 'LINES_VS_BASE', message: 'La suma de las líneas no coincide con la base del documento.', expected: documentTotals.base, actual: fromCents(linesTotalCents) });
    }
    if (Math.abs(baseCents - toCents(documentTotals.base)) > TOLERANCE_CENTS) warnings.push({ code: 'BASE_MISMATCH', message: 'La base calculada no coincide con la base del documento.', expected: documentTotals.base, actual: fromCents(baseCents) });
    if (Math.abs(vatCents + otherCents - toCents(documentTotals.vat)) > TOLERANCE_CENTS) warnings.push({ code: 'VAT_MISMATCH', message: 'El IVA calculado no coincide con el del documento.', expected: documentTotals.vat, actual: fromCents(vatCents + otherCents) });
    if (Math.abs(withholdingCents - toCents(documentTotals.withholding)) > TOLERANCE_CENTS) warnings.push({ code: 'WITHHOLDING_MISMATCH', message: 'Las retenciones calculadas no coinciden con las del documento.', expected: documentTotals.withholding, actual: fromCents(withholdingCents) });
  }

  const source = sourceTotal ?? documentTotals?.total ?? null;
  const deltaCents = source === null ? null : toCents(source) - totalCents;
  const within = deltaCents === null ? null : Math.abs(deltaCents) <= TOLERANCE_CENTS;
  if (within === false) {
    warnings.push({ code: 'TOTALS_MISMATCH', message: 'REVISAR IMPORTES: el total calculado no coincide con el total del documento.', expected: source ?? undefined, actual: fromCents(totalCents) });
  }

  return {
    calculated_base: fromCents(baseCents),
    calculated_vat: fromCents(vatCents),
    calculated_other: fromCents(otherCents),
    calculated_withholding: fromCents(withholdingCents),
    calculated_total: fromCents(totalCents),
    lines_total: fromCents(linesTotalCents),
    source_total: source,
    totals_delta: deltaCents === null ? null : fromCents(deltaCents),
    within_tolerance: within,
    vat_by_rate: [...vatByRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, g]) => ({ rate, base: fromCents(g.base), amount: fromCents(g.amount) })),
    taxes: usedTaxes,
    taxes_derived: derived,
    warnings,
  };
}
