/**
 * Cuentas de las ofertas (pasada única, zona 3): margen, caducadas, próximas, plazas ofrecidas y lo que sale en el cartel.
 * Puro y sin navegador (`tests/organizers/offers-state.test.ts`).
 * - Las caducadas **siguen sumando** en las cuentas (decisión del usuario): esas plazas pueden estar ya vendidas. Llevan su
 *   marca y un aviso, y nunca salen en el cartel.
 * - El margen solo cuenta lo contratado con Ikisai (nunca el precio orientativo).
 */
import { offersMargin } from './quote.ts';

export interface OfferLike {
  price?: unknown; expected?: unknown; capacity?: unknown; available_from?: unknown; available_until?: unknown; on_poster?: unknown;
  [column: string]: unknown;
}

const day = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 10) : null);
const count = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Math.max(0, Number(v) || 0));

/** Caducada: su «disponible hasta» ya pasó (`today` es el día de Madrid, `AAAA-MM-DD`). */
export const isExpired = (o: OfferLike, today: string): boolean => { const until = day(o.available_until); return !!until && until < today; };
/** Aún no a la venta: su «disponible desde» es posterior a hoy. */
export const isUpcoming = (o: OfferLike, today: string): boolean => { const from = day(o.available_from); return !!from && from > today; };

export function offersStateOf<T extends OfferLike>(offers: readonly T[], today: string, contracted: number | null, seats: number | null, other: number) {
  const m = offersMargin(offers.map((o) => ({ price: Number(o.price) || 0, expected: count(o.expected) })), contracted ?? 0, Math.max(0, other || 0));
  const expired = offers.filter((o) => isExpired(o, today));
  const upcoming = offers.filter((o) => isUpcoming(o, today));
  const offered = offers.filter((o) => !isExpired(o, today)).reduce((n, o) => n + (count(o.capacity) ?? 0), 0);
  const over = seats && offered > seats ? offered - seats : 0;
  const posterOffers = offers.filter((o) => o.on_poster === true && !isExpired(o, today));
  return { m, expired, upcoming, offered, over, posterOffers };
}
