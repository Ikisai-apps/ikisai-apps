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

const max0 = (n: number) => Math.max(0, Number(n) || 0);

/**
 * «¿Cuánto ganas?» (pasada única, zona 2). El precio por asistente con el que se cubren costes, redondeado al euro hacia
 * arriba. `round2` antes de `ceil`, para que 148,0000001 no salga como 149.
 */
export function breakEvenPrice(input: { ikisai: number; otherCosts: number; attendees: number }): number | null {
  if (!(input.attendees > 0)) return null;
  return Math.ceil(round2((max0(input.ikisai) + max0(input.otherCosts)) / input.attendees));
}

/** Precio por asistente para ganar `pct` % por encima de los costes (el % es sobre los costes). */
export function priceForMargin(input: { ikisai: number; otherCosts: number; attendees: number; pct: number }): number | null {
  if (!(input.attendees > 0)) return null;
  const cost = round2(max0(input.ikisai) + max0(input.otherCosts));
  return Math.ceil(round2(cost * (1 + max0(input.pct) / 100) / input.attendees));
}

/** Lo que se gana sobre los costes, en %; sin costes, `null`. */
export function marginPct(m: Margin): number | null {
  return m.cost > 0 ? Math.round((m.margin / m.cost) * 100) : null;
}

/**
 * Punto de equilibrio en asistentes cuando lo de Ikisai **varía con las plazas** (asistentes más colaboradores): el primer
 * `a` (1…max) con `precio × a ≥ ikisaiFor(a + colaboradores) + otros gastos`. `null` si el precio es 0 o si no llega nunca.
 */
export function breakEvenAttendees(input: { price: number; collaborators: number; otherCosts: number; ikisaiFor: (seats: number) => number; max?: number }): number | null {
  const price = Number(input.price) || 0;
  if (price <= 0) return null;
  const collaborators = max0(Math.round(input.collaborators));
  const other = max0(input.otherCosts);
  const max = input.max ?? 500;
  for (let a = 1; a <= max; a++) {
    if (round2(price * a) + 0.005 >= round2(max0(input.ikisaiFor(a + collaborators)) + other)) return a;
  }
  return null;
}

/** Precio medio por persona (el total entre N personas); sin personas, `null`. Nunca se enseña un «por persona» suelto. */
export function averagePrice(total: number | string, persons: number | null | undefined): number | null {
  const n = Number(persons) || 0;
  return n > 0 ? round2((Number(total) || 0) / n) : null;
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

/**
 * Calculadora con las ofertas del organizador (API.md §16.2): ingresos = Σ precio × plazas que espera vender. Lo de Ikisai
 * es lo contratado (o el precio orientativo) y los otros gastos los pone él; nada de esto viaja al servidor.
 */
export function offersMargin(offers: Array<{ price: number | string; expected?: number | string | null }>, ikisai: number, otherCosts: number): Margin & { attendees: number } {
  const revenue = round2(offers.reduce((sum, o) => sum + Math.max(0, Number(o.price) || 0) * Math.max(0, Number(o.expected) || 0), 0));
  const attendees = offers.reduce((sum, o) => sum + Math.max(0, Number(o.expected) || 0), 0);
  const cost = round2(Math.max(0, ikisai) + Math.max(0, otherCosts));
  const average = attendees > 0 ? revenue / attendees : 0;
  return { revenue, cost, margin: round2(revenue - cost), breakEven: average > 0 ? Math.ceil(cost / average) : null, attendees };
}
