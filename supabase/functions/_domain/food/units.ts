/** Ikisai Food · unidades. Solo se convierte dentro de masa (g↔kg) y de volumen (ml↔l); nunca entre familias. */

export const UNITS = ['g', 'kg', 'ml', 'l', 'unidad', 'paquete', 'manojo', 'otro'] as const;
export type Unit = (typeof UNITS)[number];

/** Familia de una unidad: las de masa y volumen se suman entre sí; el resto solo consigo mismas. */
export type UnitFamily = 'masa' | 'volumen' | 'unidad' | 'paquete' | 'manojo' | 'otro';

const FAMILY: Record<Unit, UnitFamily> = {
  g: 'masa', kg: 'masa', ml: 'volumen', l: 'volumen', unidad: 'unidad', paquete: 'paquete', manojo: 'manojo', otro: 'otro',
};
const FACTOR: Record<Unit, number> = { g: 1, kg: 1000, ml: 1, l: 1000, unidad: 1, paquete: 1, manojo: 1, otro: 1 };

export function isUnit(value: unknown): value is Unit {
  return typeof value === 'string' && (UNITS as readonly string[]).includes(value);
}

export function unitFamily(unit: Unit): UnitFamily {
  return FAMILY[unit];
}

/** Cantidad en la unidad base de su familia: gramos, mililitros o la propia unidad. */
export function toBase(quantity: number, unit: Unit): number {
  return quantity * FACTOR[unit];
}

export function fromBase(quantity: number, unit: Unit): number {
  return quantity / FACTOR[unit];
}

/** Convierte entre unidades de la misma familia; `null` si no son compatibles. */
export function convert(quantity: number, from: Unit, to: Unit): number | null {
  if (FAMILY[from] !== FAMILY[to]) return null;
  return fromBase(toBase(quantity, from), to);
}

/**
 * Unidad en la que se presenta un total: la preferida del ingrediente si es de la familia;
 * si no, kg o l a partir de 1000 y g o ml por debajo. Las demás familias no cambian.
 */
export function outputUnit(family: UnitFamily, baseTotal: number, preferred: Unit | null): Unit {
  if (family !== 'masa' && family !== 'volumen') return family;
  if (preferred && FAMILY[preferred] === family) return preferred;
  if (family === 'masa') return baseTotal >= 1000 ? 'kg' : 'g';
  return baseTotal >= 1000 ? 'l' : 'ml';
}

/** Redondeo a tres decimales, como numeric(12,3). */
export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
