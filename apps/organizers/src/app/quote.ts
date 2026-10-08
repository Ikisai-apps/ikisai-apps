/**
 * Calculadora del precio con Ikisai (fase 2, API.md §13.2; Booking B9). Puro: usa el mismo dominio que el personal de
 * Booking (`suggestLines`, `proposalTotals`, `applyMinimum`) sobre las tarifas visibles en el portal, así que el precio
 * orientativo sale igual que el de una propuesta. Precios con el IVA incluido (canon de Booking): no se suma IVA encima.
 *
 * Además, la calculadora privada de margen del organizador (`marginOf`): solo en su dispositivo.
 */
// Ruta directa al dominio (no el alias de Vite) para que las pruebas de Node puedan importarlo tal cual.
import { applyMinimum, proposalTotals, quantityFor, round2, stayLength, suggestLines, type LineLike, type ReservationForRates } from '../../../../supabase/functions/_domain/booking/rates.ts';
import type { Contract, ExtraRequest, PortalConditions, PortalRate } from './api.ts';

export interface QuoteInput {
  reservation: ReservationForRates;
  persons: number;
  rates: PortalRate[];
  conditions: PortalConditions | null;
  extras: ExtraRequest[];
}

export interface QuoteLine { description: string; unit: string; quantity: number; unit_amount: number; amount: number | null }

export type Quote =
  | { available: false; reason: 'no_rates' | 'no_dates' | 'no_persons' }
  | {
    available: true;
    nights: number;
    /** Comidas incluidas por persona: dos por noche (regla comercial), si el retiro lleva comidas. */
    mealsIncluded: number;
    lines: QuoteLine[];
    /** Total de las líneas (con IVA incluido) y su desglose. */
    total: number;
    vatAmount: number;
    vatRate: number;
    /** Total que se aplica: el de las líneas o el mínimo comercial si no llega. */
    payable: number;
    minimumApplied: boolean;
    minimum: number | null;
    deposit: number;
  };

const num = (v: number | string | null | undefined) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

export function quote(input: QuoteInput): Quote {
  if (!input.rates.length) return { available: false, reason: 'no_rates' };
  const stay = stayLength(input.reservation);
  if (!stay || stay.nights < 0 || !input.reservation.start_date) return { available: false, reason: 'no_dates' };
  if (!(input.persons > 0)) return { available: false, reason: 'no_persons' };

  const base = suggestLines(input.reservation, input.rates, { persons: input.persons })
    .map((l) => ({ description: l.description, unit: l.unit, quantity: l.quantity, unit_amount: l.unit_amount }));
  // Los extras no los sugiere el dominio: van aparte, con su cantidad pedida por la unidad de la tarifa.
  const byId = new Map(input.rates.map((r) => [r.id, r]));
  const extras = input.extras.flatMap((e) => {
    const rate = byId.get(e.rate_id);
    if (!rate) return [];
    return [{ description: rate.name, unit: rate.unit, quantity: round2(quantityFor(rate.unit, input.persons, stay) * num(e.quantity || 1)), unit_amount: num(rate.amount) }];
  });
  const lines: LineLike[] = [...base, ...extras];
  const totals = proposalTotals(lines, input.conditions);
  const minimum = applyMinimum(totals.total, input.conditions?.minimum_total ?? null);
  // La señal se calcula sobre lo que se paga (con el mínimo, si se aplica), con la misma regla de las condiciones.
  const deposit = minimum.minimumApplied
    ? Math.min(minimum.total, Math.max(round2(minimum.total * num(input.conditions?.deposit_percent) / 100), num(input.conditions?.deposit_minimum)))
    : totals.deposit_amount;
  const payableVat = minimum.minimumApplied
    ? round2(minimum.total - minimum.total / (1 + num(input.conditions?.vat_rate) / 100))
    : totals.vat_amount;
  return {
    available: true,
    nights: stay.nights,
    mealsIncluded: input.reservation.requires_meals ? stay.nights * 2 : 0,
    lines: [...base, ...extras].map((l) => ({ ...l, amount: l.unit === 'porcentaje' ? null : round2(l.quantity * l.unit_amount) })),
    total: totals.total,
    vatAmount: payableVat,
    vatRate: num(input.conditions?.vat_rate),
    payable: minimum.total,
    minimumApplied: minimum.minimumApplied,
    minimum: minimum.minimum,
    deposit,
  };
}

/** Calculadora privada: con el precio de venta por asistente, cuántos asistentes y otros gastos, cuánto gana el organizador. */
export interface Margin { revenue: number; cost: number; margin: number; breakEven: number | null }

export function marginOf(input: { price: number; attendees: number; ikisai: number; otherCosts: number }): Margin {
  const revenue = round2(Math.max(0, input.price) * Math.max(0, input.attendees));
  const cost = round2(Math.max(0, input.ikisai) + Math.max(0, input.otherCosts));
  return { revenue, cost, margin: round2(revenue - cost), breakEven: input.price > 0 ? Math.ceil(cost / input.price) : null };
}

/**
 * Saldo = contratado (Booking) − cobrado (Finance). Cada vencimiento queda cubierto si lo cobrado llega a lo acumulado
 * hasta él (primero la señal y luego el saldo).
 */
export function balanceOf(contract: Contract, collected: number): { contracted: number; collected: number; balance: number; due: Array<{ kind: string; date: string | null; amount: number; paid: boolean }> } {
  const contracted = Number(contract.total) || 0;
  let accumulated = 0;
  const due = contract.due.map((d) => {
    accumulated += Number(d.amount) || 0;
    return { kind: d.kind, date: d.date, amount: Number(d.amount) || 0, paid: collected + 0.005 >= accumulated };
  });
  return { contracted, collected, balance: Math.max(0, Math.round((contracted - collected) * 100) / 100), due };
}
