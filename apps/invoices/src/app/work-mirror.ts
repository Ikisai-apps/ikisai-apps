/**
 * El estado de trabajo (`work-state.ts`) con lo del dispositivo: documento, lo que falta para validar, si está en una
 * entrega y si se declara en un trimestre posterior. Lo usan la lista de Facturas e Inicio (tanda 27).
 */
import { MISSING_LABELS, periodOfDate } from '@ikisai/domain-invoices';
import type { LocalInvoice } from './client.ts';
import type { Mirror } from './data.ts';
import { missingOf } from './validate.ts';
import { invoiceLabels, workState, type WorkFacts, type WorkLabel, type WorkRow } from './work-state.ts';

export interface MirrorRow extends WorkRow<LocalInvoice> { facts: WorkFacts; labels: WorkLabel[] }

/** «3T 2026» si la factura se declara en un trimestre posterior al de su fecha (0228). */
function lateQuarter(invoice: LocalInvoice): string | null {
  const own = periodOfDate(invoice.invoice_date);
  if (!invoice.declared_period || !own || invoice.declared_period <= own) return null;
  return `${own.slice(5)}T ${own.slice(0, 4)}`;
}

export function hasOriginal(mirror: Mirror, invoiceId: string): boolean {
  return (mirror.filesByInvoice.get(invoiceId) ?? []).some((f) => f.kind === 'original' && !f.deleted_at);
}

/** Ids de las facturas que están en alguna entrega viva a la gestoría. */
export function exportedIds(mirror: Mirror): Set<string> {
  const live = new Set(mirror.exports.filter((e) => !e.deleted_at).map((e) => e.id));
  return new Set(mirror.exportItems.filter((x) => !x.deleted_at && live.has(x.export_id)).map((x) => x.invoice_id));
}

export function mirrorRows(mirror: Mirror, today: string, invoices: LocalInvoice[] = mirror.invoices.filter((i) => !i.deleted_at)): MirrorRow[] {
  const exported = exportedIds(mirror);
  return invoices.map((invoice) => {
    const pending = invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision';
    const facts: WorkFacts = {
      hasOriginal: hasOriginal(mirror, invoice.id),
      missing: pending ? missingOf(mirror, invoice).map((m) => MISSING_LABELS[m]) : [],
      inExport: exported.has(invoice.id),
      late: lateQuarter(invoice),
    };
    return { invoice, facts, state: workState(invoice, facts, today), labels: invoiceLabels(invoice, facts, today) };
  });
}
