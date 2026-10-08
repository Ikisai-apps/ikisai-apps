/** Tarifario y propuestas: textos de importes y cálculo de la propuesta vigente (docs/booking/API.md §15.2). */
import type { SyncedRow } from '@ikisai/sync-client';
import { lineAmount, proposalTotals, round2, type ProposalTotals } from '@ikisai/domain-booking';
import { RATE_LABELS } from './labels.ts';

export type Row = SyncedRow & Record<string, any>;

const num = (value: unknown): number => { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; };

/** «2790,00 €» (dos decimales, coma decimal). */
export function eur(value: unknown): string {
  return `${num(value).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/** «10 %», «2,5 %»: número sin ceros sobrantes. */
export function pct(value: unknown): string {
  return `${num(value).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;
}

/** «−10 %» o «+5 %» (con el signo menos tipográfico). */
export function signedPct(value: unknown): string {
  const n = num(value);
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}${pct(Math.abs(n))}`;
}

/** Importe y unidad de una tarifa o de una línea: «40,00 € / persona y noche» o «−10 %». */
export function amountText(unit: unknown, amount: unknown): string {
  return unit === 'porcentaje' ? signedPct(amount) : `${eur(amount)} / ${RATE_LABELS.per[String(unit)] ?? String(unit)}`;
}

/** Cantidad sin ceros sobrantes: 40, 2,5. */
export function qty(value: unknown): string {
  return num(value).toLocaleString('es-ES', { maximumFractionDigits: 2 });
}

/** Importe de una línea: fijo = cantidad × unitario; los porcentajes se calculan sobre el subtotal de la propuesta. */
export function lineAmounts(lines: readonly Row[]): Map<string, number> {
  const live = lines.filter((l) => l.deleted_at === null);
  const subtotal = round2(live.filter((l) => l.unit !== 'porcentaje').reduce((sum, l) => sum + (lineAmount(l as any) ?? 0), 0));
  return new Map(live.map((l) => [l.id, l.unit === 'porcentaje' ? round2(subtotal * num(l.unit_amount) * num(l.quantity) / 100) : (lineAmount(l as any) ?? 0)]));
}

export interface ProposalFigures extends ProposalTotals {
  /** `true` si se calculó en vivo (borrador); `false` si son los importes que fijó el servidor al enviar. */
  live: boolean;
  includesVat: boolean;
  vatRate: number;
}

/** Totales de una propuesta: en borrador, en vivo con `proposalTotals`; enviada o posterior, los guardados. */
export function figures(proposal: Row, lines: readonly Row[], conditions: Row | null): ProposalFigures {
  const includesVat = conditions ? conditions.prices_include_vat !== false : true;
  const vatRate = num(conditions?.vat_rate);
  if (proposal.status === 'borrador' || proposal.total === null || proposal.total === undefined) {
    return { ...proposalTotals(lines.filter((l) => l.deleted_at === null) as any, conditions as any), live: true, includesVat, vatRate };
  }
  return {
    subtotal: num(proposal.subtotal), adjustments: num(proposal.adjustments), vat_amount: num(proposal.vat_amount), total: num(proposal.total),
    deposit_amount: num(proposal.deposit_amount), live: false, includesVat, vatRate,
  };
}

/** Propuesta vigente: la aceptada; si no, la última enviada; si no, el último borrador; si no, la de versión más alta. */
export function currentProposal(proposals: readonly Row[]): Row | null {
  const live = proposals.filter((p) => p.deleted_at === null).sort((a, b) => num(b.version) - num(a.version));
  for (const status of ['aceptada', 'enviada', 'borrador']) {
    const found = live.find((p) => p.status === status);
    if (found) return found;
  }
  return live[0] ?? null;
}

export const byPosition = (a: Row, b: Row) => num(a.position) - num(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);

/** Tramos de cancelación de unas condiciones, de más a menos antelación. */
export function tiersOf(tiers: readonly Row[], conditionsId: string | null): Row[] {
  return tiers.filter((t) => t.deleted_at === null && t.conditions_id === conditionsId).sort((a, b) => num(b.min_days_before) - num(a.min_days_before));
}

/** «Con 60 días o más de antelación: se devuelve toda la señal.» */
export function tierText(tier: Row): string {
  const days = num(tier.min_days_before);
  const when = days === 0 ? 'Cualquier día antes de la entrada' : `Con ${days === 1 ? '1 día' : `${days} días`} o más de antelación`;
  const percent = num(tier.deposit_refund_pct);
  const back = percent === 0 ? 'no se devuelve la señal' : percent === 100 ? 'se devuelve toda la señal' : `se devuelve el ${pct(percent)} de la señal`;
  return `${when}: ${back}${tier.extra_costs ? '; además se cobran costes extra' : ''}.`;
}

/** ¿Ya pasó esa fecha civil (AAAA-MM-DD) respecto a `today`? */
export function isPast(date: unknown, today: string): boolean {
  return typeof date === 'string' && date.slice(0, 10) < today;
}

/** Plazo máximo interno para exigir el saldo (horas tras el final del evento). Solo para el personal: nunca en el portal. */
export function balanceDeadlineHours(conditions: Record<string, unknown> | null | undefined): number {
  const hours = Number(conditions?.balance_deadline_hours_after_end ?? 24);
  return Number.isFinite(hours) && hours >= 0 ? hours : 24;
}

/** Momento del plazo máximo del saldo: hora de salida (o final del día de salida) más las horas internas. */
export function balanceDeadline(endDate: string | null | undefined, departureTime: string | null | undefined, hours: number): Date | null {
  if (!endDate) return null;
  const base = new Date(`${endDate}T${departureTime && /^\d{2}:\d{2}/.test(departureTime) ? departureTime.slice(0, 5) : '23:59'}:00`);
  return Number.isNaN(base.getTime()) ? null : new Date(base.getTime() + hours * 3_600_000);
}
