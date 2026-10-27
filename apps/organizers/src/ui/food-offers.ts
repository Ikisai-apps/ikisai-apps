/**
 * «Comida que se ofrece» en Experiencia › Menú (encargo de VG por Core, 27-10): las ofertas de comida del retiro tal como
 * las publica Food (`food.portal_offers`), con quién paga, cuándo y dónde. Una carta enseña sus líneas por ámbito, con
 * precio, alérgenos y dietas; un menú cerrado remite al menú día a día, que sale debajo. Solo lectura: lo interno no llega.
 *
 * Si la lectura no existe todavía (Food sin publicar) o falla sin copia guardada, el bloque no sale: el menú sigue igual.
 */
import { el, replace } from '@ikisai/ui-kit';
import { i18n, t } from '../app/i18n.ts';
import { linesByScope, payerText, priceText, visibleOffers, whenText, type FoodOffer, type PortalOffers } from '../app/food-offers.ts';
import { allergensLine, SERVICES } from './menu.ts';
import { staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

const SCOPE_TITLE = { clasico: () => t('Clásicos'), gourmet: () => t('Gourmet'), barra: () => t('Barra') } as const;

function offerCard(o: FoodOffer): HTMLElement {
  const groups = linesByScope(o.lines);
  return el('article', { class: 'card orgcard orgfoodoffer', dataset: { offer: o.offer_id } },
    el('div', { class: 'orgfoodoffer-head' },
      el('h4', null, o.name),
      el('span', { class: 'chips' },
        el('span', { class: 'chip' }, o.kind === 'carta' ? t('Carta') : t('Menú cerrado')),
        o.provisional ? el('span', { class: 'chip warn' }, t('Provisional')) : null)),
    el('p', { class: 'orgfoodoffer-payer' }, el('strong', null, payerText(o, t))),
    el('p', { class: 'muted small' }, whenText(o, t, i18n.tag(), (type) => t(SERVICES[type] ?? type)), o.place ? ` · ${o.place}` : ''),
    o.meal_groups.length ? el('p', { class: 'muted small' }, t('Para: {grupos}', { grupos: o.meal_groups.join(', ') })) : null,
    o.kind === 'cerrado'
      ? el('p', { class: 'small' }, t('Lo que se sirve cada día está en el menú, aquí debajo.'))
      : groups.length
        ? el('div', { class: 'orgfoodoffer-lines' }, ...groups.map((g) => el('section', null,
          el('h5', null, SCOPE_TITLE[g.scope]()),
          el('ul', { class: 'orgfoodoffer-list' }, ...g.lines.map((l) => el('li', { dataset: { line: l.line_id } },
            el('span', { class: 'orgfoodoffer-line' },
              el('span', { class: 'orgfoodoffer-code' }, l.code), ' ', el('strong', null, l.name),
              el('span', { class: 'orgfoodoffer-price' }, priceText(l.price_cents, i18n.tag()))),
            l.description ? el('span', { class: 'muted small' }, l.description) : null,
            l.diet_tags.length ? el('span', { class: 'small' }, l.diet_tags.map((d) => d.replace(/_/g, ' ')).join(' · ')) : null,
            allergensLine({ allergens: l.allergens, allergens_checked: l.allergens_checked })))))))
        : el('p', { class: 'muted small' }, t('Esta carta aún no tiene platos publicados.')));
}

export function renderFoodOffers(ctx: ViewContext, reservationId: string): HTMLElement {
  const host = el('section', { id: 'foodOffers', class: 'orgfoodoffers', 'data-feedback-id': 'organizers.menu.ofertas', 'data-feedback-label': 'Comida que se ofrece', hidden: '' });
  void ctx.api.readAny<PortalOffers>('food.portal_offers', { reservation_id: reservationId }).then((out) => {
    const offers = visibleOffers(out.value);
    host.hidden = false;
    replace(host,
      el('h3', null, t('Comida que se ofrece')),
      out.stale ? staleNote(out.at) : null,
      offers.length
        ? el('div', { class: 'orgcards' }, ...offers.map(offerCard))
        : el('p', { class: 'muted', id: 'foodOffersEmpty' }, t('Cocina aún no ha publicado la comida de tu retiro.')));
  }).catch(() => { host.hidden = true; });
  return host;
}
