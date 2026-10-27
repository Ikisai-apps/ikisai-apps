/**
 * Ofertas de comida del retiro tal como las publica Food (`food.portal_offers`, migración 1111 de Food; encargo de VG por
 * Core, 27-10): el menú cerrado incluido y las cartas, con quién paga. Lo interno (`audience = 'interna'`) nunca llega al
 * portal; aquí, además, se descarta por si acaso. Reglas puras: las pantallas pasan su `t`.
 */
type Tr = (text: string, vars?: Record<string, string | number>) => string;

export interface FoodOfferLine {
  line_id: string; code: string; scope: 'clasico' | 'gourmet' | 'barra'; name: string; description: string | null;
  price_cents: number; allergens: string[]; allergens_checked: boolean; diet_tags: string[];
}

export interface FoodOffer {
  offer_id: string; event_id: string; name: string; kind: 'cerrado' | 'carta'; audience: string;
  meal_groups: string[]; days: string[] | null; services: string[] | null; place: string | null;
  payer: 'organizador' | 'huesped'; charge_when: 'barra' | 'cuenta' | null; provisional: boolean;
  lines: FoodOfferLine[] | null;
}

export interface PortalOffers { reservation_id: string; offers: FoodOffer[] }

/** Lo que se enseña: sin lo interno, primero los menús cerrados y después las cartas, por nombre. */
export function visibleOffers(data: PortalOffers | null | undefined): FoodOffer[] {
  return (data?.offers ?? []).filter((o) => o.audience !== 'interna')
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'cerrado' ? -1 : 1));
}

/** Quién paga, en palabras de quien organiza (textos acordados con Food). */
export function payerText(o: Pick<FoodOffer, 'payer' | 'charge_when'>, t: Tr): string {
  if (o.payer === 'organizador') return t('Lo pagas tú (incluido en tu retiro)');
  if (o.charge_when === 'barra') return t('Lo paga cada asistente, en barra');
  if (o.charge_when === 'cuenta') return t('Lo paga cada asistente, al final, en su cuenta');
  return t('Lo paga cada asistente');
}

/** Precio de venta (céntimos, IVA incluido) en euros. */
export function priceText(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

/**
 * Cuándo: los días (o «Todos los días») y los servicios (o «todos los servicios»). `serviceName` traduce cada servicio
 * con los nombres de siempre del menú.
 */
export function whenText(o: Pick<FoodOffer, 'days' | 'services'>, t: Tr, locale: string, serviceName: (type: string) => string): string {
  const days = o.days?.length
    ? [...o.days].sort().map((d) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))).join(', ')
    : t('Todos los días');
  const services = o.services?.length ? o.services.map(serviceName).join(', ') : t('todos los servicios');
  return `${days} · ${services}`;
}

export const SCOPES = ['clasico', 'gourmet', 'barra'] as const;

/** Líneas de una carta por ámbito (clásicos, gourmet y barra), cada grupo por código. Sin líneas, ningún grupo. */
export function linesByScope(lines: readonly FoodOfferLine[] | null): Array<{ scope: FoodOfferLine['scope']; lines: FoodOfferLine[] }> {
  return SCOPES.map((scope) => ({ scope, lines: (lines ?? []).filter((l) => l.scope === scope).sort((a, b) => a.code.localeCompare(b.code)) }))
    .filter((g) => g.lines.length > 0);
}
