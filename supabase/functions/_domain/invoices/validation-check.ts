/**
 * Lo que falta para validar una factura recibida (incidencia del usuario, 9-10-2026): la misma comprobación que
 * `invoices.validate` (0227), para avisar antes de enviar y para traducir un rechazo del servidor. La autoridad sigue
 * siendo el servidor; esto solo evita mandar un «Validar» que se va a rechazar.
 */
import { recalculate, type RecalcLine, type RecalcTax } from './recalculate.ts';

export type MissingKey = 'invoice_date' | 'expense_category' | 'original_file' | 'lines_or_taxes' | 'rectified_invoice' | 'rectification_sign' | 'totals';

/** Lo que falta, en palabras («Falta: la categoría de gasto»). */
export const MISSING_LABELS: Record<MissingKey, string> = {
  invoice_date: 'la fecha de la factura',
  expense_category: 'la categoría de gasto',
  original_file: 'el documento original (PDF o foto)',
  lines_or_taxes: 'los importes (artículos o IVA)',
  rectified_invoice: 'la factura que rectifica (o marcar que no la tienes)',
  rectification_sign: 'el signo: una rectificativa resta (total negativo o cero)',
  totals: 'que los importes cuadren con el total del documento',
};

export interface ValidationInput {
  invoice: { invoice_date: string | null; expense_category: string | null; source_total: number | string | null; invoice_kind?: string | null; rectifies_invoice_id?: string | null; rectification_without_original?: boolean | null };
  lines: RecalcLine[];
  taxes: RecalcTax[];
  hasOriginal: boolean;
}

/** Lo que falta para validar, en el orden en que conviene arreglarlo. Vacío: lista para validar. */
export function validationMissing(x: ValidationInput): MissingKey[] {
  const out: MissingKey[] = [];
  const sourceTotal = x.invoice.source_total === null || x.invoice.source_total === undefined ? null : Number(x.invoice.source_total);
  const r = recalculate(x.lines, x.taxes, null, sourceTotal);
  if (!x.invoice.invoice_date) out.push('invoice_date');
  if (!x.invoice.expense_category) out.push('expense_category');
  if (!x.hasOriginal) out.push('original_file');
  if (!x.lines.length && !x.taxes.length) out.push('lines_or_taxes');
  if (x.invoice.invoice_kind === 'rectificativa') {
    if (!x.invoice.rectifies_invoice_id && !x.invoice.rectification_without_original) out.push('rectified_invoice');
    if (r.calculated_total > 0) out.push('rectification_sign');
  }
  if (r.within_tolerance === false) out.push('totals');
  return out;
}

/** El motivo de un rechazo del servidor al validar, en español; `null` si el error no es de validación. */
export function validationRejectionText(error: { code?: string; details?: unknown } | null | undefined): string | null {
  if (!error) return null;
  if (error.code === 'INVOICE_TOTALS_MISMATCH') return `falta ${MISSING_LABELS.totals}`;
  if (error.code === 'INVOICE_INCOMPLETE') {
    const missing = ((error.details as { missing?: unknown } | null)?.missing ?? []) as string[];
    const labels = missing.map((m) => MISSING_LABELS[m as MissingKey] ?? m);
    return labels.length ? `falta ${labels.join(', ')}` : 'faltan datos';
  }
  if (error.code === 'INVALID_TRANSITION') return 'ya no está pendiente (alguien la validó o la anuló)';
  if (error.code === 'VERSION_CONFLICT') return 'cambió mientras tanto; vuelve a abrirla';
  return null;
}
