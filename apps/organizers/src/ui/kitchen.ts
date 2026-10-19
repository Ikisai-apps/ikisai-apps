/**
 * Pestaña Cocina de la ficha del retiro (API.md §9.7; pasada única, zona 3), de arriba abajo:
 * - el tipo de menú y la pensión, con «Confirmado» o «Por confirmar»;
 * - el aviso: cuántos platos del menú compartido declaran un alérgeno del grupo;
 * - lo que no se puede comprobar (lo que no es de la lista europea): siempre «no se puede comprobar: lo revisa cocina»;
 * - el menú plato a plato con los aciertos (y, solo como pista, lo que el nombre del plato menciona);
 * - lo de todo el grupo y lo que va con nombre, como siempre.
 * Nunca «apto» ni ✓ por plato. La gravedad solo va junto a un nombre compartido; en los recuentos, nunca.
 */
import { el, icon, renderMedal, replace, type Child } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import { kitchenStateOf, sharedAllergens, type DishCheck, type PortalMenu, type Watched } from '../app/kitchen-state.ts';
import type { Loaded } from '../app/api.ts';
import { mealPlanLabel, menuStyleLabel, restrictionText, timeLabel } from '../app/labels.ts';
import { failure, fbIgnore, fbMark, loading, section } from './common.ts';
import { allergenName, allergensLine, dayTitle, dishPhoto, SERVICES } from './menu.ts';
import type { RetreatData } from './retreat.ts';
import type { ViewContext } from './shell.ts';

const SVG = 'http://www.w3.org/2000/svg';
/** Iconos propios de cada tipo de menú (trazo como los del kit). */
const STYLE_ICON: Record<string, string> = {
  vegetariano: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19 13 11"/>',
  vegano: '<path d="M12 20v-8"/><path d="M12 12c0-4-3-6-7-6 0 4 3 6 7 6z"/><path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6z"/>',
  mixto: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3.5"/><path d="M3 4v6M5 4v6M3 7h2M4 10v10M21 4c-1.5 1-2 3-2 6h2v10"/>',
};
function styleIcon(style: string | null): Node {
  const path = style ? STYLE_ICON[style] : undefined;
  if (!path) return icon('chef', 22);
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.innerHTML = path;
  return svg;
}
const SERVICE_ICON: Record<string, 'sun' | 'chef' | 'moon' | 'menu'> = { desayuno: 'sun', comida: 'chef', merienda: 'sun', cena: 'moon', picnic: 'sun', otro: 'menu' };
const capital = (text: string) => (text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text);
/** «Alergia a pistacho», sin la gravedad: para lo que no lleva nombre. */
const anonymousText = (w: Watched) => restrictionText({ restriction_type: w.r.restriction_type, subject: w.r.subject, severity: null });

type MenuRead = { menu: PortalMenu; stale: string | null } | { error: unknown } | null;

export function renderKitchen(ctx: ViewContext, reservationId: string, data: RetreatData): HTMLElement & { destroy: () => void } {
  const k = data.kitchen.value;
  const d = data.detail.value;
  const host = el('div', { id: 'kitchen', 'data-feedback-id': 'organizers.cocina.resumen', 'data-feedback-label': 'Cocina' }) as unknown as HTMLElement & { destroy: () => void };
  let alive = true;
  let menuRead: MenuRead = null;

  async function loadMenu(): Promise<void> {
    menuRead = null;
    paint();
    try {
      const out: Loaded<PortalMenu> = await ctx.api.readAny<PortalMenu>('food.portal_menu', { reservation_id: reservationId });
      menuRead = { menu: out.value, stale: out.stale ? out.at : null };
    } catch (error) {
      menuRead = { error };
    }
    if (alive) paint();
  }

  function menuStyleBlock(): HTMLElement {
    const style = d.menu_style;
    const plan = d.meal_plan;
    const known = !!style || !!plan;
    const confirmed = !!style && d.menu_style_confirmed && (!plan || d.meal_plan_confirmed);
    return fbMark(el('section', { class: 'card orgcard orgkmenu', id: 'kitchenMenuStyle' },
      el('span', { class: 'orgkmenu-icon', 'aria-hidden': 'true' }, styleIcon(style)),
      el('div', { class: 'orgkmenu-text' },
        el('strong', null, style ? capital(menuStyleLabel(style)) : t('Tipo de menú aún sin concretar')),
        plan ? el('span', { class: 'small' }, mealPlanLabel(plan)) : null),
      known ? el('span', { class: `chip ${confirmed ? 'ok' : 'warn'}` }, confirmed ? t('Confirmado') : t('Por confirmar')) : null),
    'organizers.cocina.tipo_menu', 'Tipo de menú');
  }

  /** Quién lleva un requisito que el plato declara: con nombre (y su gravedad, si la compartió) y, aparte, lo anónimo. */
  function hitLines(w: Watched, dish: DishCheck): HTMLElement[] {
    const which = sharedAllergens(w, dish).map(allergenName).join(', ');
    const out: HTMLElement[] = [];
    if (w.named.length) {
      const who = w.named.map((n) => `${n.guest} (${restrictionText(n)})`).join(', ');
      out.push(fbIgnore(el('p', { class: 'orgkdish-hit small' }, icon('warn', 16), ' ', t('Declara {alergeno}: {quien}', { alergeno: which, quien: who }))));
    }
    if (w.anonymous > 0) {
      out.push(el('p', { class: 'orgkdish-hit small' }, icon('warn', 16), ' ', t('Declara {alergeno}: {n} sin nombre ({que})', { alergeno: which, n: w.anonymous, que: anonymousText(w) })));
    }
    return out;
  }

  function dishBlock(dish: DishCheck): HTMLElement {
    const medalHost = el('span', { class: 'orgkdish-medal' });
    const paintMedal = (image: string | null) => replace(medalHost,
      fbMark(renderMedal({ image, name: dish.dish.name, size: 44 }), 'organizers.cocina.plato.medallon', 'Medallón del plato'),
      dish.hits.length ? el('span', { class: 'orgkdish-flag' }, el('span', { 'aria-hidden': 'true' }, '⚠'), el('span', { class: 'vh' }, t('Declara un alérgeno de tu grupo'))) : null);
    paintMedal(null);
    if (dish.dish.photo_thumb_file_id) void dishPhoto(ctx, dish.dish.photo_thumb_file_id).then((url) => { if (url && alive) paintMedal(url); });
    return el('div', { class: `orgkdish${dish.hits.length ? ' hit' : ''}`, 'data-dish': dish.dish.menu_item_id },
      medalHost,
      el('div', { class: 'orgkdish-main' },
        el('strong', null, dish.dish.name),
        dish.dish.description ? el('span', { class: 'muted small' }, dish.dish.description) : null,
        allergensLine(dish.dish),
        ...dish.hits.flatMap((w) => hitLines(w, dish)),
        ...dish.hints.map((w) => el('p', { class: 'orgkdish-hint small' }, icon('info', 16), ' ',
          t('Pista: el plato menciona «{que}» · no se puede comprobar: lo revisa cocina.', { que: w.r.subject ?? anonymousText(w) })))));
  }

  function paint(): void {
    if (!alive) return;
    const menu = menuRead && 'menu' in menuRead ? menuRead.menu : null;
    const s = kitchenStateOf(k, menu);
    const watchedAllergy = s.watched.some((w) => w.r.restriction_type === 'alergia' || w.r.restriction_type === 'intolerancia' || w.verifiable);
    const out: Child[] = [menuStyleBlock()];

    // 2 · Aviso del menú (o la carga, o el error con «Reintentar» en su sitio).
    if (menuRead === null) out.push(loading());
    else if ('error' in menuRead) out.push(el('div', { id: 'kitchenMenuError' }, failure(menuRead.error, () => void loadMenu())));
    else {
      if (menuRead.stale) out.push(el('p', { class: 'banner warn', id: 'kitchenMenuStale' }, t('Menú: datos de las {hora}.', { hora: timeLabel(menuRead.stale) })));
      const flagged = s.dishes.filter((x) => x.hits.length).length;
      const unchecked = s.dishes.filter((x) => x.unchecked).length;
      out.push(fbMark(el('section', { class: 'card orgcard orgkcheck', id: 'kitchenCheck', role: 'status' },
        !menu?.available
          ? [el('strong', null, t('La cocina aún no ha compartido el menú')), el('p', { class: 'small' }, t('Cuando lo comparta, lo verás aquí plato a plato.'))]
          : el('strong', null, flagged === 0 ? t('Ningún plato declara un alérgeno de tu grupo')
            : flagged === 1 ? t('1 plato del menú declara un alérgeno de tu grupo') : t('{n} platos del menú declaran un alérgeno de tu grupo', { n: flagged })),
        el('p', { class: 'small' }, t('La cocina lo revisa con las recetas; esto es solo un aviso con lo que declara el menú.')),
        menu?.available && watchedAllergy && unchecked
          ? el('p', { class: 'small orgkcheck-unchecked' }, unchecked === 1 ? t('1 plato aún sin revisar por cocina.') : t('{n} platos aún sin revisar por cocina.', { n: unchecked }))
          : null), 'organizers.cocina.aviso', 'Aviso del menú'));
    }

    // 3 · Lo que no se puede comprobar: nunca se calla.
    const unverifiable = s.watched.filter((w) => !w.verifiable);
    if (unverifiable.length) {
      out.push(el('div', { class: 'orgkunverifiable', id: 'kitchenUnverifiable' },
        ...unverifiable.map((w) => el('p', { class: 'small' }, icon('info', 16), ' ', t('{que}: no se puede comprobar: lo revisa cocina.', { que: anonymousText(w) })))));
    }

    // 4 · Resumen, sin gravedad.
    out.push(el('p', { id: 'kitchenSummary', class: 'orgksummary' }, s.allergyCount === 0 ? t('Nadie con alergias por ahora')
      : s.allergyCount === 1 ? t('1 alergia o intolerancia en el grupo') : t('{n} alergias o intolerancias en el grupo', { n: s.allergyCount })));

    // 5 · El menú plato a plato.
    if (menu?.available) {
      const days = [...new Set(menu.services.map((x) => x.date))].sort();
      out.push(fbMark(el('section', { class: 'card orgcard orgkmenu-list', id: 'kitchenMenu' },
        el('h3', null, t('El menú, plato a plato'), ' ', el('span', { class: `chip ${menu.status === 'confirmado' ? 'ok' : 'warn'}` }, menu.status === 'confirmado' ? t('Confirmado') : t('Provisional'))),
        ...days.map((day) => el('div', { class: 'orgday', 'data-day': day },
          el('h4', null, dayTitle(day)),
          ...menu.services.filter((x) => x.date === day).map((service) => el('div', { class: 'orgservice', 'data-service': service.service_id },
            el('h5', null, icon(SERVICE_ICON[service.type] ?? 'menu', 16), ' ', t(SERVICES[service.type] ?? service.type), service.time ? el('span', { class: 'muted small' }, ` · ${service.time.slice(0, 5)}`) : null),
            ...s.dishes.filter((x) => x.service.service_id === service.service_id).map(dishBlock)))))),
      'organizers.cocina.menu', 'Menú plato a plato'));
    }

    // 6-8 · Lo de siempre: todo el grupo, con nombre y la nota final.
    out.push(
      section(t('Para todo el grupo'), { id: 'kitchenTotals' },
        k.totals.length
          ? el('ul', { class: 'plainlist' }, ...k.totals.map((x) => el('li', null, el('strong', null, String(x.servings)), ' · ', restrictionText(x))))
          : el('p', { class: 'muted' }, t('Sin requisitos especiales por ahora.'))),
      section(t('Con nombre'), { id: 'kitchenNamed' },
        k.named.length
          ? el('ul', { class: 'plainlist', 'data-feedback-ignore': '' }, ...k.named.map((x) => el('li', null, el('strong', null, x.guest), ' · ', restrictionText(x))))
          : el('p', { class: 'muted' }, t('Aquí verás lo que tú indiques de cada asistente y lo que ellos decidan compartir contigo.')),
        s.anonymousTotal > 0
          ? el('p', { class: 'muted small', id: 'kitchenPrivacy' }, t('{n} de estos requisitos no llevan nombre: son de asistentes que no han compartido sus alergias contigo. La cocina los tiene igual.', { n: s.anonymousTotal }))
          : null),
      el('p', { class: 'muted small' }, t('Si alguien tiene una alergia, añádela en su ficha o pídele que la indique en su enlace personal.')));
    replace(host, ...out);
  }

  host.destroy = () => { alive = false; };
  void loadMenu();
  return host;
}
