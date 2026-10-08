/**
 * Módulos visibles y barra inferior (API.md §13.1): Inicio · Programa · Menú · Alojamiento · Más, solo con lo que el
 * organizador haya activado y en su ventana (antes, durante o después). Sin configuración no hay barra (fase 1).
 */
import { el, icon, replace, type IconName } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { inWindow } from '../app/portal.ts';
import { momentOf } from './home.ts';

export interface Modules { program: boolean; menu: boolean; lodging: boolean; materials: boolean; questions: boolean; map: boolean }

export function modulesOf(ctx: GuestContext): Modules {
  const m = ctx.experience()?.modules ?? {};
  const moment = momentOf(ctx.guest());
  return {
    program: Boolean(m.program?.visible && inWindow(m.program.window, moment)),
    menu: Boolean(m.menu?.visible && inWindow(m.menu.window, moment)),
    lodging: Boolean(m.lodging?.visible),
    materials: Boolean(m.materials?.visible),
    questions: Boolean(m.questions?.visible),
    map: Boolean(m.map?.visible),
  };
}

export function hasNav(mods: Modules): boolean {
  return mods.program || mods.menu || mods.lodging || mods.materials || mods.questions;
}

interface Item { page: string; label: string; icon: IconName; id: string }

/** Barra inferior propia (los módulos cambian por persona y retiro; la del kit se fija al crear la cáscara). */
export function mountNav(root: HTMLElement, base: string, mods: Modules, current: string): () => void {
  if (!hasNav(mods)) return () => undefined;
  const items: Item[] = [
    { page: '', label: t('nav.home'), icon: 'home', id: 'nav-home' },
    ...(mods.program ? [{ page: 'programa', label: t('nav.program'), icon: 'calendar' as IconName, id: 'nav-program' }] : []),
    ...(mods.menu ? [{ page: 'menu', label: t('nav.menu'), icon: 'chef' as IconName, id: 'nav-menu' }] : []),
    ...(mods.lodging ? [{ page: 'alojamiento', label: t('nav.lodging'), icon: 'bed' as IconName, id: 'nav-lodging' }] : []),
    { page: 'mas', label: t('nav.more'), icon: 'more', id: 'nav-more' },
  ];
  const bar = el('nav', { class: 'gnav', id: 'guestNav', 'aria-label': t('nav.label'), 'data-feedback-id': 'guests.navegacion', 'data-feedback-label': 'Navegación' },
    ...items.map((item) => el('a', {
      href: item.page ? `${base}/${item.page}` : base, id: item.id, class: item.page === current ? 'on' : null,
      'aria-current': item.page === current ? 'page' : null,
    }, icon(item.icon, 20), el('span', null, item.label))));
  replace(root, bar);
  document.body.classList.add('has-gnav');
  return () => { replace(root); document.body.classList.remove('has-gnav'); };
}

/** «Más»: el resto de pantallas en una lista. */
export function mountMore(main: HTMLElement, ctx: GuestContext, base: string, mods: Modules, openHelp: () => void): () => void {
  const g = ctx.guest();
  const link = (href: string, ic: IconName, label: string, id: string) =>
    el('a', { class: 'card gcard glink', href, id, 'data-feedback-id': 'guests.mas.lista.abrir', 'data-feedback-label': 'Abrir sección' }, icon(ic, 20), el('span', null, el('strong', null, label)));
  replace(main,
    el('div', { class: 'pagehead' }, el('h2', null, t('nav.more'))),
    el('div', { class: 'gcards', id: 'moreList' },
      link(`${base}/info`, 'info', t('home.info'), 'more-info'),
      mods.materials ? link(`${base}/materiales`, 'attach', t('materials.title'), 'more-materials') : null,
      mods.questions ? link(`${base}/preguntas`, 'help', t('questions.title'), 'more-questions') : null,
      g.mode !== 'ninguno' ? link(`${base}/datos`, 'user', t('home.data'), 'more-data') : null,
      link(`${base}/alimentacion`, 'chef', t('home.diet'), 'more-diet'),
      g.mode === 'ses' ? link(`${base}/firma`, 'edit', t('home.sign'), 'more-sign') : null,
      el('button', { type: 'button', class: 'card gcard glink', id: 'more-help', 'data-feedback-id': 'guests.mas.ayuda.abrir', 'data-feedback-label': 'Ayuda y sugerencias', onclick: openHelp },
        icon('help', 20), el('span', null, el('strong', null, t('home.help'))))));
  return () => replace(main);
}
