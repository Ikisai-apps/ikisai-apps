/**
 * «Tus ofertas de hoy» en el Menú (API.md §9.18): para el día elegido, lo que le toca a cada persona en cada servicio (lo
 * incluido, con sus opciones) y las cartas del día con su modo: «Incluido», «De pago» o «A cuenta». La carta «a cuenta»
 * abre la carta pública de Flow con el número de cliente de la persona (`flow.portal_customer`; su enlace es de un solo
 * uso y se pide en cada toque). Cada plato y cada línea se cruzan con lo que indicó cada persona (G13), como el Menú.
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import { localeTag, t } from '../app/i18n.ts';
import { hhmm } from '../app/labels.ts';
import { FLOW_CARTA, priceText, safeUrl, type Carta, type CartaMode, type GuestOffers, type Included } from '../app/offers.ts';
import type { Dish } from '../app/portal.ts';
import { fbIgnore } from './common.ts';
import { allergens, crossings, hitsOf, type Eater } from './program.ts';

export interface OffersPerson { eater: Eater; offers: GuestOffers }

const MODE_LABEL: Record<CartaMode, string> = { incluido: 'offers.included', de_pago: 'offers.paid', a_cuenta: 'offers.account' };

function asDish(x: { name: string; description?: string | null; diet_tags: string[]; allergens: string[]; allergens_checked: boolean }): Dish {
  return { name: x.name, description: x.description ?? null, diet_tags: x.diet_tags, allergens: x.allergens, allergens_checked: x.allergens_checked };
}

/** Días con alguna oferta para alguna de las personas. */
export function offerDays(people: OffersPerson[]): string[] {
  return [...new Set(people.flatMap((p) => p.offers.days.map((d) => d.date)))].sort();
}

/**
 * El bloque del día, o null si ese día no hay nada para nadie. `customer` pide el número de cliente y el enlace de un solo
 * uso a Flow; sin respuesta, la carta pública sin número.
 */
export function offersBlock(day: string, today: string, people: OffersPerson[], named: boolean,
  customer: (guestId: string) => Promise<{ number: string | null; carta_url: string | null; account_open: boolean | null } | null>): HTMLElement | null {
  const eaters = people.map((p) => p.eater);
  const everyone = (ids: Set<string>) => !named || ids.size === people.length;
  const forWhom = (ids: Set<string>) => (everyone(ids) ? null
    : el('span', { class: 'chip small' }, t('offers.for', { names: new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(eaters.filter((e) => ids.has(e.guestId)).map((e) => e.name || t('menu.noName'))) })));

  // Lo incluido, por servicio (tipo y hora) y por oferta, con a quién toca.
  const services = new Map<string, { type: string; time: string | null; items: Map<string, { inc: Included; ids: Set<string> }> }>();
  const cartas = new Map<string, { carta: Carta; ids: Set<string> }>();
  for (const p of people) {
    const d = p.offers.days.find((x) => x.date === day);
    if (!d) continue;
    for (const s of d.services) {
      const key = `${s.time ?? '99:99'}|${s.type}`;
      const svc = services.get(key) ?? { type: s.type, time: s.time, items: new Map() };
      for (const inc of s.included) {
        const known = svc.items.get(inc.offer_id) ?? { inc, ids: new Set<string>() };
        known.ids.add(p.eater.guestId);
        svc.items.set(inc.offer_id, known);
      }
      services.set(key, svc);
    }
    for (const c of d.cartas) {
      const known = cartas.get(c.offer_id) ?? { carta: c, ids: new Set<string>() };
      known.ids.add(p.eater.guestId);
      cartas.set(c.offer_id, known);
    }
  }
  if (!services.size && !cartas.size) return null;

  const cross = (x: Parameters<typeof asDish>[0], i: number, ids: Set<string>) => crossings(hitsOf(asDish(x), i, eaters.filter((e) => ids.has(e.guestId))), named);

  const serviceBlocks = [...services.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => el('section', { class: 'goffer-service', dataset: { service: s.type } },
    el('h4', null, t(`menu.${s.type}`), s.time ? el('span', { class: 'small' }, ` · ${hhmm(s.time)}`) : null),
    ...[...s.items.values()].map(({ inc, ids }) => el('div', { class: 'goffer', dataset: { offer: inc.offer_id } },
      el('p', { class: 'goffer-head' }, el('strong', null, inc.name),
        el('span', { class: 'gtags' }, el('span', { class: 'chip small goffer-mode', dataset: { mode: 'incluido' } }, t('offers.included')),
          inc.internal ? el('span', { class: 'chip small' }, t('offers.internal')) : null, forWhom(ids))),
      inc.place ? el('p', { class: 'small' }, t('offers.at', { place: inc.place })) : null,
      inc.options.length > 1 ? el('p', { class: 'small' }, t('offers.choose')) : null,
      el('ul', { class: 'goffer-options' }, ...inc.options.map((o, i) => el('li', null, el('span', null, o.name),
        o.description ? el('span', { class: 'small' }, ` · ${o.description}`) : null, cross(o, i, ids), allergens(o))))))));

  const cartaBlocks = [...cartas.values()].map(({ carta, ids }) => {
    const mode = el('span', { class: 'chip small goffer-mode', dataset: { mode: carta.mode } }, t(MODE_LABEL[carta.mode]));
    let account: HTMLElement | null = null;
    if (carta.mode === 'a_cuenta') {
      const note = el('p', { class: 'small', id: `cartaNumber-${carta.offer_id.slice(0, 8)}`, role: 'status' }, t('offers.accountText'));
      const guestId = [...ids][0]!;
      const open = el('button', {
        type: 'button', class: 'primary goffer-open', 'data-feedback-id': 'guests.menu.carta.abrir', 'data-feedback-label': 'Abrir la carta a cuenta',
        onclick: async () => {
          // Se abre la ventana en el toque (si no, el navegador la bloquea) y se le pone el enlace al llegar.
          const win = window.open('about:blank', '_blank');
          const out = await customer(guestId).catch(() => null);
          const url = safeUrl(out?.carta_url) ?? FLOW_CARTA;
          // La cuenta la abre caja a petición de la persona (Core, 27-10): Guests solo dice si ya la tiene.
          replace(note, out?.number ? t('offers.customer', { number: String(out.number) }) : t('offers.noNumber'),
            out?.account_open === true ? ` ${t('offers.accountOpen')}` : out?.account_open === false ? ` ${t('offers.accountClosed')}` : '');
          if (win) { win.opener = null; win.location.href = url; } else window.location.href = url;
        },
      }, icon('menu', 16), ' ', t('offers.openCarta'));
      account = el('div', { class: 'goffer-account' }, note, open);
    }
    return el('section', { class: 'goffer goffer-carta', dataset: { offer: carta.offer_id, mode: carta.mode } },
      el('p', { class: 'goffer-head' }, el('strong', null, carta.name || t('offers.cartaTitle')),
        el('span', { class: 'gtags' }, mode, carta.internal ? el('span', { class: 'chip small' }, t('offers.internal')) : null, forWhom(ids))),
      carta.place ? el('p', { class: 'small' }, t('offers.at', { place: carta.place })) : null,
      el('ul', { class: 'goffer-lines' }, ...carta.lines.map((l, i) => el('li', { dataset: { line: l.id } },
        el('span', { class: 'goffer-line' }, l.code ? el('span', { class: 'goffer-code' }, l.code) : null, el('span', null, l.name),
          el('strong', { class: 'goffer-price' }, carta.mode === 'incluido' ? t('offers.included') : priceText(l.price_cents, localeTag()) ?? '')),
        cross(l, i, ids), allergens(l)))),
      account);
  });

  return fbIgnore(el('section', { class: 'card gcard goffers', id: 'menuOffers', 'aria-labelledby': 'menuOffersTitle' },
    el('h3', { id: 'menuOffersTitle' }, day === today ? t('offers.today') : named ? t('offers.titleFamily') : t('offers.title')),
    ...serviceBlocks,
    cartaBlocks.length ? el('h4', { class: 'goffer-cartas' }, t('offers.cartas')) : null,
    ...cartaBlocks));
}
