/**
 * Programa (API.md §13.2, dueño Booking) y menú (§13.3, dueño Food): días en pestañas, actividades por hora y servicios
 * con sus platos. «Hoy» junta las dos fuentes: lo que está pasando, lo siguiente y la próxima comida. Guardados en la
 * caché para verlos sin cobertura. Sin promesas clínicas en el menú.
 */
import { createDayTabs, el, icon, replace } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { formatDate, t } from '../app/i18n.ts';
import { hhmm, restrictionLabel } from '../app/labels.ts';
import type { Dish, Menu, ProgramItem } from '../app/portal.ts';
import { failure, fbIgnore, loading, staleNote } from './common.ts';
import { todayMadrid } from './home.ts';

/** Hora actual en Madrid (HH:MM). */
export function nowMadrid(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

const range = (from: string | null, to: string | null) => (from ? (to ? `${hhmm(from)}–${hhmm(to)}` : hhmm(from)!) : t('program.allDay'));

/** Lo que está pasando y lo siguiente de hoy. */
export function nowAndNext(items: ProgramItem[], day = todayMadrid(), now = nowMadrid()): { current: ProgramItem | null; next: ProgramItem | null } {
  const today = items.filter((i) => i.day === day && i.starts_at).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!));
  const current = today.find((i) => hhmm(i.starts_at)! <= now && (i.ends_at ? hhmm(i.ends_at)! > now : false)) ?? null;
  const next = today.find((i) => hhmm(i.starts_at)! > now) ?? null;
  return { current, next };
}

/** Próxima comida de hoy según el menú. */
export function nextMeal(menu: Menu, day = todayMadrid(), now = nowMadrid()): Menu['services'][number] | null {
  return menu.services.filter((s) => s.date === day && (!s.time || hhmm(s.time)! >= now)).sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'))[0] ?? null;
}

/**
 * Un plato: nombre y descripción públicos, etiquetas de dieta y, solo si cocina los revisó, sus alérgenos declarados.
 * Nunca «apto para ti»: la frase sobre lo que tiene registrado cocina va aparte y no califica platos (API.md §13.3).
 */
function dish(d: Dish, ctx: GuestContext): HTMLElement {
  // Foto del plato (Food #332): solo la miniatura, por `portal-files`, cuando llega (URL de 5 minutos).
  const photo = d.photo_thumb_file_id ? el('img', { class: 'gdish-photo', alt: '', loading: 'lazy', hidden: true }) as HTMLImageElement : null;
  if (photo && d.photo_thumb_file_id) {
    void ctx.reads.fileUrl(d.photo_thumb_file_id).then(({ url }) => { photo.src = url; photo.hidden = false; }).catch(() => undefined);
  }
  const tags = (d.diet_tags ?? []).map((tag) => (t(`diet.${tag}`) === `diet.${tag}` ? tag : t(`diet.${tag}`)));
  return el('li', { class: 'gdish' },
    photo,
    el('strong', null, d.name),
    d.description ? el('span', { class: 'muted small' }, d.description) : null,
    tags.length ? el('span', { class: 'gtags' }, ...tags.map((tag) => el('span', { class: 'chip small' }, tag))) : null,
    d.allergens_checked && d.allergens?.length ? el('span', { class: 'small gallergens' }, t('menu.allergens', { list: d.allergens.map((code) => t(`allergen.${code}`)).join(', ') })) : null);
}

function daysOf<T>(list: T[], key: (x: T) => string): string[] {
  return [...new Set(list.map(key))].sort();
}

/** Pestañas de días del kit 0.21 (`createDayTabs`, U5), con «hoy» en hora de Madrid. */
function dayTabs(days: string[], selected: string, onPick: (day: string) => void, id: string, panelId: string, count?: (day: string) => number): HTMLElement {
  const tabs = createDayTabs({ days, selected, today: todayMadrid(), onSelect: onPick, panelId, ...(count ? { count } : {}) });
  tabs.element.id = id;
  tabs.element.setAttribute('data-feedback-id', 'guests.programa.dias.elegir');
  tabs.element.setAttribute('data-feedback-label', 'Elegir día');
  return tabs.element;
}

export function mountProgram(main: HTMLElement, ctx: GuestContext): () => void {
  let alive = true;
  replace(main, loading());
  void ctx.reads.program(ctx.grant.reservation_id).then((loaded) => {
    if (!alive) return;
    const items = loaded?.value.items ?? [];
    const days = daysOf(items, (i) => i.day);
    if (!days.length) { replace(main, el('div', { class: 'pagehead' }, el('h2', null, t('program.title'))), el('p', { class: 'card gcard muted', id: 'programEmpty' }, t('program.empty'))); return; }
    let selected = days.includes(todayMadrid()) ? todayMadrid() : days[0]!;
    const list = el('ol', { class: 'gprogram', id: 'programList', role: 'tabpanel' });
    const tabs = dayTabs(days, selected, (d) => { selected = d; paint(); }, 'programDays', 'programList', (d) => items.filter((i) => i.day === d).length);
    const paint = () => {
      replace(list, ...items.filter((i) => i.day === selected).sort((a, b) => (a.starts_at ?? '').localeCompare(b.starts_at ?? '')).map((i) =>
        el('li', { class: `gslot kind-${i.kind}` },
          el('span', { class: 'gslot-time' }, range(i.starts_at, i.ends_at)),
          el('span', { class: 'gslot-body' }, el('strong', null, i.title),
            i.place ? el('span', { class: 'muted small' }, icon('pin', 14), ' ', i.place) : null,
            i.public_note ? el('span', { class: 'small' }, i.public_note) : null))));
    };
    replace(main,
      loaded?.stale ? staleNote(loaded.at) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('program.title'))),
      tabs, list);
    paint();
  }).catch((error) => { if (alive) replace(main, failure(error)); });
  return () => { alive = false; };
}

export function mountMenu(main: HTMLElement, ctx: GuestContext, notice: HTMLElement | null): () => void {
  let alive = true;
  replace(main, loading());
  void ctx.reads.menu(ctx.grant.reservation_id, ctx.grant.guest_id).then((loaded) => {
    if (!alive) return;
    const menu = loaded?.value ?? { status: null, services: [] };
    const restrictions = ctx.guest().restrictions;
    const head = el('div', { class: 'pagehead' }, el('h2', null, t('menu.title')),
      menu.status === 'provisional' ? el('p', { class: 'chip small', id: 'menuProvisional' }, t('menu.provisional')) : null);
    // Sin promesas clínicas (API.md §13.3): solo que cocina tiene registrado lo que indicó el huésped.
    const kitchen = restrictions.length ? fbIgnore(el('p', { class: 'banner', id: 'menuKitchen' }, icon('chef', 18), ' ',
      t('menu.kitchenHas', { list: restrictions.map((r) => r.subject ?? restrictionLabel(r.restriction_type).toLowerCase()).join(', ') }))) : null;
    const days = daysOf(menu.services, (s) => s.date);
    if (!days.length) { replace(main, head, el('p', { class: 'card gcard muted', id: 'menuEmpty' }, t('menu.empty')), notice); return; }
    let selected = days.includes(todayMadrid()) ? todayMadrid() : days[0]!;
    const list = el('div', { id: 'menuList', role: 'tabpanel' });
    const tabs = dayTabs(days, selected, (d) => { selected = d; paint(); }, 'menuDays', 'menuList');
    const paint = () => {
      replace(list, ...menu.services.filter((s) => s.date === selected).sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '')).map((s) =>
        el('section', { class: 'card gcard gservice' },
          el('h3', null, t(`menu.${s.type}`), s.time ? el('span', { class: 'muted small' }, ` · ${hhmm(s.time)}`) : null),
          el('ul', { class: 'gdishes' }, ...s.dishes.map((d) => dish(d, ctx))))));
    };
    replace(main, loaded?.stale ? staleNote(loaded.at) : null, head, kitchen, tabs, list, notice);
    paint();
  }).catch((error) => { if (alive) replace(main, failure(error)); });
  return () => { alive = false; };
}

/** Tarjeta «Hoy en Ikisai» de Inicio durante el retiro: ahora, lo siguiente y la próxima comida. */
export async function todayCard(ctx: GuestContext, program: boolean, menu: boolean): Promise<HTMLElement[]> {
  const rows: HTMLElement[] = [];
  if (program) {
    const items = (await ctx.reads.program(ctx.grant.reservation_id).catch(() => null))?.value.items ?? [];
    const { current, next } = nowAndNext(items);
    if (current) rows.push(el('p', { id: 'todayNow' }, el('strong', null, t('today.now')), ` ${current.title}${current.place ? ` · ${current.place}` : ''}`));
    if (next) rows.push(el('p', { id: 'todayNext' }, el('strong', null, t('today.next', { time: hhmm(next.starts_at) ?? '' })), ` ${next.title}${next.place ? ` · ${next.place}` : ''}`));
  }
  if (menu) {
    const loaded = await ctx.reads.menu(ctx.grant.reservation_id, ctx.grant.guest_id).catch(() => null);
    const meal = loaded ? nextMeal(loaded.value) : null;
    if (meal) rows.push(el('p', { id: 'todayMeal' }, el('strong', null, `${t(`menu.${meal.type}`)}${meal.time ? ` · ${hhmm(meal.time)}` : ''}:`), ` ${meal.dishes.map((d) => d.name).join(', ')}`));
  }
  return rows;
}

