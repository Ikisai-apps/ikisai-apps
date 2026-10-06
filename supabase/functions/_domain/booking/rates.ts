/**
 * Ikisai Booking · tarifas, propuestas y cancelación (docs/booking/API.md §15.2). Cálculo puro, compartido por la Edge y la interfaz.
 * `proposalTotals` debe coincidir céntimo a céntimo con `booking.proposal_totals` (migración 0420), que es quien fija los
 * importes al enviar la propuesta.
 */
import { dayNumber } from './rules.ts';

export interface RateLike {
  id: string;
  name: string;
  layer: string;
  unit: string;
  amount: number | string;
  service: string | null;
  min_persons: number | null;
  max_persons: number | null;
  event_types: string[] | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  position?: number | string;
  deleted_at?: string | null;
}
export interface LineLike { unit: string; quantity: number | string; unit_amount: number | string; discount_pct?: number | string | null; deleted_at?: string | null }
export interface ConditionsLike {
  deposit_percent: number | string;
  deposit_minimum: number | string;
  prices_include_vat: boolean;
  vat_rate: number | string;
}
export interface TierLike { min_days_before: number; deposit_refund_pct: number | string; extra_costs: boolean; deleted_at?: string | null }
export interface ReservationForRates {
  event_type: string | null;
  start_date: string | null;
  end_date: string | null;
  expected_guests: number | null;
  uses_accommodation?: boolean;
  requires_meals?: boolean;
  uses_interpretation_center?: boolean;
  uses_outdoors?: boolean;
  uses_pool?: boolean;
  special_setup?: boolean;
  technical_support?: boolean;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** Redondeo a céntimos como `round(x, 2)` de Postgres: mitades lejos de cero. */
export function round2(x: number): number {
  const sign = x < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(x) * 100 + 1e-7)) / 100;
}

/** Importe de una línea: cantidad × unitario menos su descuento, a céntimos; null en las de porcentaje (dependen del subtotal). */
export function lineAmount(line: LineLike): number | null {
  return line.unit === 'porcentaje' ? null : round2(num(line.quantity) * num(line.unit_amount) * (100 - num(line.discount_pct)) / 100);
}

export interface ProposalTotals { subtotal: number; adjustments: number; vat_amount: number; total: number; deposit_amount: number }

export function proposalTotals(lines: readonly LineLike[], conditions: ConditionsLike | null): ProposalTotals {
  const live = lines.filter((l) => !l.deleted_at);
  const subtotal = round2(live.filter((l) => l.unit !== 'porcentaje').reduce((sum, l) => sum + (lineAmount(l) ?? 0), 0));
  const adjustments = round2(live.filter((l) => l.unit === 'porcentaje').reduce((sum, l) => sum + round2(subtotal * num(l.unit_amount) * num(l.quantity) / 100), 0));
  const net = round2(subtotal + adjustments);
  const rate = num(conditions?.vat_rate);
  const included = conditions?.prices_include_vat ?? true;
  const vat_amount = included ? round2(net - net / (1 + rate / 100)) : round2(net * rate / 100);
  const total = included ? net : round2(net + vat_amount);
  const deposit_amount = total <= 0 ? 0
    : Math.min(total, Math.max(round2(total * num(conditions?.deposit_percent) / 100), num(conditions?.deposit_minimum)));
  return { subtotal, adjustments, vat_amount, total, deposit_amount };
}

const SERVICE_FLAG: Record<string, keyof ReservationForRates> = {
  alojamiento: 'uses_accommodation',
  comidas: 'requires_meals',
  centro_interpretacion: 'uses_interpretation_center',
  exterior: 'uses_outdoors',
  piscina: 'uses_pool',
  montaje: 'special_setup',
  tecnico: 'technical_support',
};

/** Noches y días de la reserva (la salida no es noche; sí día). */
export function stayLength(reservation: Pick<ReservationForRates, 'start_date' | 'end_date'>): { nights: number; days: number } | null {
  const from = dayNumber(reservation.start_date);
  const to = dayNumber(reservation.end_date);
  if (from === null || to === null || to < from) return null;
  return { nights: to - from, days: to - from + 1 };
}

/** Cantidad que corresponde a una unidad de tarifa para esa reserva. */
export function quantityFor(unit: string, persons: number, stay: { nights: number; days: number }): number {
  switch (unit) {
    case 'persona_noche': return persons * stay.nights;
    case 'persona_dia': return persons * stay.days;
    case 'dia': return stay.days;
    case 'noche': return stay.nights;
    default: return 1; // estancia (por evento), unidad, porcentaje
  }
}

export interface SuggestedLine { rate_id: string; description: string; unit: string; quantity: number; unit_amount: number; position: number }

/** Lo que la reserva usa además de sus datos: personas presupuestadas y supletorias activadas en el alojamiento. */
export interface SuggestContext { persons?: number; extraBeds?: number }

/**
 * Líneas sugeridas desde el tarifario: tarifas activas del tipo de reserva, vigentes en la fecha de entrada, del tramo de
 * personas y con su servicio marcado en la reserva. Los extras no se sugieren (se añaden a mano), salvo el de cama
 * supletoria cuando el alojamiento tiene supletorias activadas. La persona las acepta o corrige línea a línea.
 */
export function suggestLines(reservation: ReservationForRates, rates: readonly RateLike[], context: SuggestContext = {}): SuggestedLine[] {
  const stay = stayLength(reservation);
  if (!stay) return [];
  const persons = context.persons ?? reservation.expected_guests ?? 0;
  const extraBeds = context.extraBeds ?? 0;
  const start = dayNumber(reservation.start_date)!;
  const order = ['recinto', 'por_persona', 'servicio', 'extra', 'ajuste'];
  return rates
    .filter((r) => !r.deleted_at && r.active)
    .filter((r) => !r.event_types || r.event_types.length === 0 || (reservation.event_type !== null && r.event_types.includes(reservation.event_type)))
    .filter((r) => (dayNumber(r.valid_from) ?? -Infinity) <= start && start <= (dayNumber(r.valid_to) ?? Infinity))
    .filter((r) => (r.min_persons ?? 0) <= persons && persons <= (r.max_persons ?? Infinity))
    .filter((r) => r.service === 'cama_supletoria' ? extraBeds > 0
      : r.layer !== 'extra' && (!r.service || reservation[SERVICE_FLAG[r.service] ?? 'uses_accommodation'] === true))
    .sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer) || num(a.position) - num(b.position))
    .map((r, i) => ({
      rate_id: r.id, description: r.name, unit: r.unit, unit_amount: num(r.amount), position: i + 1,
      // la supletoria se cobra por cama activada
      quantity: r.service === 'cama_supletoria' ? extraBeds * quantityFor(r.unit, 1, stay) : quantityFor(r.unit, persons, stay),
    }));
}

export interface Refund { daysBefore: number; percent: number; amount: number; extraCosts: boolean }

/**
 * Cuánto de la señal se devuelve si se cancela en `cancelledOn`: el tramo con más días de antelación que se cumpla.
 * Sin tramo aplicable, no se devuelve nada.
 */
export function refundFor(depositAmount: number, startDate: string, cancelledOn: string, tiers: readonly TierLike[]): Refund | null {
  const start = dayNumber(startDate);
  const on = dayNumber(cancelledOn);
  if (start === null || on === null) return null;
  const daysBefore = start - on;
  const tier = tiers.filter((t) => !t.deleted_at && t.min_days_before <= daysBefore).sort((a, b) => b.min_days_before - a.min_days_before)[0];
  const percent = tier ? num(tier.deposit_refund_pct) : 0;
  return { daysBefore, percent, amount: round2(depositAmount * percent / 100), extraCosts: tier?.extra_costs ?? false };
}
