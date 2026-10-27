/**
 * «Tus ofertas de hoy» (API.md §9.18; encargo de VG por Core, 27-10-2026): lo que le toca a una ficha cada día y en cada
 * servicio, de la lectura de portal de Food `food.portal_offers` (FD3, la misma para Guests y Organizers):
 * - las **ofertas** del evento (menús cerrados y cartas), con los grupos de comida a los que van (`meal_groups`; vacío = todos);
 * - los **días**, con lo incluido en cada servicio y las cartas de ese día.
 * El cruce con la persona lo hace Guests: una ficha ve las ofertas de su `meal_group` (Booking, BG16) y las que no tienen
 * grupos. El modo sale de quién paga y cuándo se cobra: organizador → «Incluido»; huésped en barra → «De pago»; huésped a
 * cuenta → «A cuenta» (con la carta pública de Flow y su número de cliente, `flow.portal_customer`).
 * Ofertas internas (`audience: 'interna'`, decisión de VG por Core, 27-10): solo para fichas de equipo asignadas (`staff` y
 * `direccion`) de su grupo; nunca a un huésped ni al organizador.
 */
export type CartaMode = 'incluido' | 'de_pago' | 'a_cuenta';

export interface OfferDish { name: string; description: string | null; diet_tags: string[]; allergens: string[]; allergens_checked: boolean }
export interface CartaLine {
  id: string; code: string | null; scope: string | null; name: string; description: string | null; price_cents: number | null;
  diet_tags: string[]; allergens: string[]; allergens_checked: boolean;
}
export interface Carta { offer_id: string; name: string; place: string | null; mode: CartaMode; internal: boolean; services: string[] | null; lines: CartaLine[] }
export interface Included { offer_id: string; name: string; place: string | null; internal: boolean; options: OfferDish[] }
export interface OfferService { type: string; time: string | null; included: Included[] }
export interface OfferDay { date: string; services: OfferService[]; cartas: Carta[] }
export interface GuestOffers { days: OfferDay[] }

interface Offer {
  id: string; name: string; kind: 'cerrado' | 'carta'; meal_groups: string[]; place: string | null; mode: CartaMode; internal: boolean;
  services: string[] | null; lines: CartaLine[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => x !== null) : []);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** El modo de una oferta según quién paga y cuándo se cobra (Food, 27-10). */
export function modeOf(payer: unknown, chargeWhen: unknown): CartaMode {
  if (payer === 'organizador') return 'incluido';
  return chargeWhen === 'cuenta' ? 'a_cuenta' : 'de_pago';
}

function dish(d: Record<string, unknown>): OfferDish | null {
  const name = str(d.name);
  return name ? { name, description: str(d.description), diet_tags: strs(d.diet_tags), allergens: strs(d.allergens), allergens_checked: d.allergens_checked === true } : null;
}

function line(l: Record<string, unknown>, i: number): CartaLine | null {
  const name = str(l.name);
  if (!name) return null;
  const price = typeof l.price_cents === 'number' && Number.isFinite(l.price_cents) && l.price_cents >= 0 ? Math.round(l.price_cents) : null;
  return { id: str(l.line_id) ?? `l${i}`, code: str(l.code), scope: str(l.scope), name, description: str(l.description), price_cents: price,
    diet_tags: strs(l.diet_tags), allergens: strs(l.allergens), allergens_checked: l.allergens_checked === true };
}

/** ¿Le toca esta oferta a una ficha de ese grupo de comida? Sin grupos, a todas. */
export function offerFor(groups: string[], mealGroup: string | null): boolean {
  return !groups.length || (mealGroup !== null && groups.includes(mealGroup));
}

/**
 * Lo que le toca a una ficha, por día: en cada servicio, lo incluido (con sus opciones) y, aparte, las cartas del día con
 * su modo. Sin nada ese día, el día no sale; un servicio sin nada incluido, tampoco.
 */
export function offersForGuest(raw: unknown, mealGroup: string | null, role: string | null = null): GuestOffers {
  const assigned = role === 'staff' || role === 'direccion';
  const root = obj(raw);
  const offers = new Map<string, Offer>();
  for (const o of list(root?.offers)) {
    const id = str(o.offer_id);
    if (!id) continue;
    const meal = strs(o.meal_groups);
    if (!offerFor(meal, mealGroup)) continue;
    const internal = o.audience === 'interna';
    if (internal && !assigned) continue;
    offers.set(id, {
      id, name: str(o.name) ?? '', kind: o.kind === 'carta' ? 'carta' : 'cerrado', meal_groups: meal, place: str(o.place), internal,
      mode: internal ? 'incluido' : modeOf(o.payer, o.charge_when), services: Array.isArray(o.services) ? strs(o.services) : null,
      lines: list(o.lines).map(line).filter((x): x is CartaLine => x !== null),
    });
  }
  const days: OfferDay[] = [];
  for (const d of list(root?.days)) {
    const date = str(d.date);
    if (!date || !DAY.test(date)) continue;
    const services: OfferService[] = [];
    for (const s of list(d.services)) {
      const included: Included[] = [];
      for (const inc of list(s.included)) {
        const offer = offers.get(str(inc.offer_id) ?? '');
        const options = list(inc.options).map(dish).filter((x): x is OfferDish => x !== null);
        if (offer && options.length) included.push({ offer_id: offer.id, name: offer.name, place: offer.place, internal: offer.internal, options });
      }
      if (included.length) services.push({ type: str(s.type) ?? 'otro', time: str(s.time), included });
    }
    const cartas: Carta[] = strs(d.cartas).map((id) => offers.get(id)).filter((o): o is Offer => Boolean(o && o.kind === 'carta' && o.lines.length))
      .map((o) => ({ offer_id: o.id, name: o.name, place: o.place, mode: o.mode, internal: o.internal, services: o.services, lines: o.lines }));
    if (!services.length && !cartas.length) continue;
    services.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));
    days.push({ date, services, cartas });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days };
}

/** «3,50 €» en el idioma elegido; sin precio, null. */
export function priceText(cents: number | null, tag: string): string | null {
  return cents === null ? null : new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

/** La carta pública de Flow sin número (mientras no exista `flow.portal_customer` o no devuelva nada). */
// La carta pública de Flow (entradas de Flow, 27-10: la raíz es la entrada del equipo).
export const FLOW_CARTA = 'https://flow.ikisai.com/recorridos/carta';

/** Solo enlaces https: lo demás, ninguno. */
export function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try { return new URL(s).protocol === 'https:' ? s : null; } catch { return null; }
}
