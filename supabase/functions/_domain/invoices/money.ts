/** Aritmética de importes en céntimos para que cliente y servidor redondeen igual. */
import { TOLERANCE_EUR } from './types.ts';

/** Euros → céntimos enteros (redondeo al más cercano, mitad hacia arriba en valor absoluto). */
export function toCents(amount: number): number {
  const sign = amount < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(amount) * 100 + 1e-9);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Redondeo a dos decimales con la misma regla que `round(x, 2)` de PostgreSQL (mitad alejándose de cero). */
export function round2(amount: number): number {
  return fromCents(toCents(amount));
}

export function sumCents(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += toCents(value);
  return total;
}

export function sum2(values: Iterable<number>): number {
  return fromCents(sumCents(values));
}

/** `|a − b| ≤ tolerancia`, comparando en céntimos. */
export function withinTolerance(a: number, b: number, toleranceEur: number = TOLERANCE_EUR): boolean {
  return Math.abs(toCents(a) - toCents(b)) <= toCents(toleranceEur);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Número de decimales de un valor (hasta 6), para comprobar escalas. */
export function decimalsOf(value: number): number {
  const text = String(value);
  if (text.includes('e-')) return 7;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Formato español `1.234,56` sin dependencias de Intl en el servidor. */
export function formatEur(amount: number, withSymbol = false): string {
  const cents = toCents(amount);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const text = `${negative ? '-' : ''}${whole},${String(abs % 100).padStart(2, '0')}`;
  return withSymbol ? `${text} €` : text;
}
