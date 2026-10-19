/**
 * Calendario de precios (tanda 27, MUELA-067 §5 y §7): fines de semana con su disponibilidad y su precio, para «Probar un
 * caso» en Tarifas y #freeWeekends en el Calendario. Puro, para calcular también sin red con lo sincronizado.
 * - Disponibilidad: la misma regla que `booking.range_availability` (migración 0452), la que ve el organizador. No hay otra.
 * - Precio: el mismo cálculo del caso (`suggestLines` → `proposalTotals` → `applyMinimum`); solo cambia la fecha.
 * - «Temporada alta» no es un dato propio: es un fin de semana en que el tarifario aplica un ajuste que sube el precio.
 */
import { applyMinimum, proposalTotals, round2, suggestLines, type ConditionsLike, type RateLike, type ReservationForRates } from './rates.ts';

export type Availability = 'libre' | 'en_opcion' | 'ocupado';

export interface AvailabilityInput {
  blocks: ReadonlyArray<{ start_date: string; end_date: string; deleted_at?: string | null }>;
  reservations: ReadonlyArray<{ id: string; status: string; start_date: string | null; end_date: string | null; dates_definitive?: boolean | null; archived_at?: string | null; deleted_at?: string | null }>;
  /** Opciones de fecha de las reservas (`reservation_date_options`). */
  options: ReadonlyArray<{ reservation_id: string; start_date: string; end_date: string; proposed_by: string; deleted_at?: string | null }>;
}

const OCCUPIED = new Set(['confirmada', 'en_ejecucion', 'cerrada']);
const OPEN = new Set(['en_estudio', 'negociacion', 'pre_reservada']);
const day = (v: string | null | undefined) => (v ?? '').slice(0, 10);
/** Se solapan [a, b) y [c, d), con la salida como día libre (como en SQL). */
const overlaps = (a: string, b: string, c: string | null | undefined, d: string | null | undefined) => !!c && !!d && day(c) < b && a < day(d);

/** `booking.range_availability` en el dispositivo: ocupado, en opción o libre, sin contar la reserva `ownId`. */
export function rangeAvailability(start: string, end: string, input: AvailabilityInput, ownId: string | null = null): Availability {
  const s = day(start); const e = day(end);
  const live = input.reservations.filter((r) => !r.deleted_at && !r.archived_at && r.id !== ownId);
  if (input.blocks.some((b) => !b.deleted_at && overlaps(s, e, b.start_date, b.end_date))
    || live.some((r) => overlaps(s, e, r.start_date, r.end_date) && (OCCUPIED.has(r.status) || (r.status === 'pre_reservada' && !!r.dates_definitive)))) return 'ocupado';
  const open = new Map(live.filter((r) => OPEN.has(r.status)).map((r) => [r.id, r]));
  if ([...open.values()].some((r) => !!r.dates_definitive && overlaps(s, e, r.start_date, r.end_date))
    || input.options.some((o) => !o.deleted_at && o.proposed_by === 'ikisai' && open.has(o.reservation_id) && overlaps(s, e, o.start_date, o.end_date))) return 'en_opcion';
  return 'libre';
}

const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => toIso(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000);

/** Viernes desde `from` (incluido) durante `months` meses naturales, empezando por el mes de `from`. */
export function fridays(from: string, months: number): string[] {
  const first = Date.parse(`${day(from)}T00:00:00Z`);
  const start = new Date(first);
  const limit = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + Math.max(1, months), 1);
  const offset = (5 - start.getUTCDay() + 7) % 7;
  const out: string[] = [];
  for (let t = first + offset * 86_400_000; t < limit; t += 7 * 86_400_000) out.push(toIso(t));
  return out;
}

export interface PriceCase {
  /** El caso: tipo, servicios y personas, como en «Probar un caso» o una reserva. Sus fechas se ignoran. */
  reservation: ReservationForRates;
  persons: number;
  nights: number;
  rates: readonly RateLike[];
  conditions: (ConditionsLike & { minimum_total?: number | string | null }) | null;
}

export interface WeekendPrice {
  start: string;
  end: string;
  availability: Availability;
  /** Lo que se paga (con el mínimo si se aplica) y por persona; `null` sin tarifas que apliquen. */
  total: number | null;
  perPerson: number | null;
  minimumApplied: boolean;
  /** Temporada alta: el tarifario aplica ese día un ajuste que sube el precio. */
  high: boolean;
  /** El más barato de los libres de todo el calendario. */
  cheapest: boolean;
}

export interface PriceMonth { month: string; free: number; weekends: WeekendPrice[] }

/** Precio del caso para una llegada, con el mismo cálculo que la propuesta. */
export function priceFor(input: PriceCase, start: string): Omit<WeekendPrice, 'availability' | 'cheapest'> {
  const end = addDays(day(start), input.nights);
  const reservation = { ...input.reservation, start_date: day(start), end_date: end };
  const lines = suggestLines(reservation, input.rates, { persons: input.persons });
  const high = lines.some((l) => input.rates.find((r) => r.id === l.rate_id)?.layer === 'ajuste' && l.unit_amount > 0);
  if (!lines.length) return { start: day(start), end, total: null, perPerson: null, minimumApplied: false, high };
  const totals = proposalTotals(lines, input.conditions);
  const payable = applyMinimum(totals.total, input.conditions?.minimum_total ?? null);
  return { start: day(start), end, total: payable.total, perPerson: input.persons > 0 ? round2(payable.total / input.persons) : null, minimumApplied: payable.minimumApplied, high };
}

/** La hoja «Elige la llegada viendo su precio» o «Fines de semana libres»: llegada en viernes, por meses. */
export function priceCalendar(input: PriceCase & { from: string; months: number; availability: AvailabilityInput; ownId?: string | null }): PriceMonth[] {
  const weekends: WeekendPrice[] = fridays(input.from, input.months).map((start) => {
    const price = priceFor(input, start);
    return { ...price, availability: rangeAvailability(price.start, price.end, input.availability, input.ownId ?? null), cheapest: false };
  });
  const free = weekends.filter((w) => w.availability === 'libre' && w.total !== null);
  const min = free.length ? Math.min(...free.map((w) => w.total!)) : null;
  for (const w of free) if (w.total === min) w.cheapest = true;
  const months = new Map<string, WeekendPrice[]>();
  for (const w of weekends) months.set(w.start.slice(0, 7), [...(months.get(w.start.slice(0, 7)) ?? []), w]);
  return [...months].map(([month, list]) => ({ month, free: list.filter((w) => w.availability === 'libre').length, weekends: list }));
}
