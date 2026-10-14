/**
 * Cabecera de «Retiros» (O4a; preparación de O4 §2.2 y §2.3):
 * - **selector de persona** «Todos · Marta · Nico», solo si la cuenta tiene más de una (por defecto, la familia junta);
 * - **pestañas de retiros** deslizables (pasados, en curso y próximos, por fecha), la elegida centrada; solo si hay más de uno;
 * - **secciones del retiro**: Resumen, Programa, Menú y Alojamiento (las que estén activas).
 * Todo son enlaces o botones normales: se llega con un toque y los enlaces directos `#/p/<id>/<sección>` siguen valiendo.
 */
import { el } from '@ikisai/ui-kit';
import { localeTag, t } from '../app/i18n.ts';
import type { Person, Retreat, Selection } from '../app/roster.ts';
import { sectionLabel, type Section } from './nav.ts';

/** «13–15 sep» en el idioma elegido. */
export function shortRange(start: string | null, end: string | null): string {
  if (!start) return '';
  const fmt = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });
  const a = new Date(`${start}T12:00:00Z`);
  return !end || end === start ? fmt.format(a) : fmt.formatRange(a, new Date(`${end}T12:00:00Z`));
}

export function personSelector(persons: Person[], selection: Selection, onPick: (selection: Selection) => void): HTMLElement | null {
  if (persons.length < 2) return null;
  const button = (value: Selection, label: string) => el('button', {
    type: 'button', class: selection === value ? 'on' : '', 'aria-pressed': String(selection === value), dataset: { person: value },
    'data-feedback-id': 'guests.retiros.persona.elegir', 'data-feedback-label': 'Elegir persona',
    onclick: () => { if (selection !== value) onPick(value); },
  }, label);
  return el('div', { class: 'segmented gpersons', id: 'persons', role: 'group', 'aria-label': t('family.label'), 'data-feedback-ignore': '' },
    button('all', t('family.all')), ...persons.map((p) => button(p.key, p.name || t('picker.unknown'))));
}

export interface RetreatTabsOptions {
  retreats: Retreat[];
  current: string | null;
  href(retreat: Retreat): string;
  /** Iniciales de a quién toca si no es de todos («Todos» con varias personas). */
  who?(retreat: Retreat): string;
  /**
   * Pestaña Outsider (O4b): entre los retiros pasados y los demás, donde estaría «ahora» (boceto aprobado de O4 §2.2).
   * `on` si es la que se ve.
   */
  outsider?: { href: string; on: boolean; today: string };
}

export function retreatTabs(options: RetreatTabsOptions): HTMLElement | null {
  const total = options.retreats.length + (options.outsider ? 1 : 0);
  const today = options.outsider?.today ?? '';
  // Posición de la pestaña Outsider: delante del primer retiro que no ha pasado (al final si todos pasaron).
  const found = options.retreats.findIndex((r) => !(r.end && r.end < today));
  const firstNotPast = !options.outsider ? -1 : found < 0 ? options.retreats.length : found;
  if (total < 2) return null;
  const strip = el('nav', { class: 'daytabs gretreats', id: 'retreatTabs', 'aria-label': t('retreats.label'), 'data-feedback-id': 'guests.retiros.pestanas', 'data-feedback-label': 'Pestañas de retiros' },
    ...options.retreats.flatMap((r, i) => {
      const before = options.outsider && i === firstNotPast ? [outsiderTab(options.outsider)] : [];
      return [...before, retreatTab(r)];
    }),
    ...(options.outsider && firstNotPast === options.retreats.length ? [outsiderTab(options.outsider)] : []));
  // La pestaña elegida, centrada (como los días del programa).
  requestAnimationFrame(() => strip.querySelector<HTMLElement>('.gretreat.on')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
  return strip;

  function retreatTab(r: Retreat): HTMLElement {
    const on = r.reservation_id === options.current;
    const who = options.who?.(r) ?? '';
    return el('a', {
      class: `daytab gretreat${on ? ' on' : ''}`, href: options.href(r), 'aria-current': on ? 'page' : null, dataset: { reservation: r.reservation_id },
      'data-feedback-id': 'guests.retiros.pestana.abrir', 'data-feedback-label': 'Abrir retiro',
    },
    el('span', { class: 'gretreat-title' }, r.title ?? t('picker.unknown')),
    el('span', { class: 'daytab-m' }, [shortRange(r.start, r.end), who].filter(Boolean).join(' · ')));
  }
}

function outsiderTab(o: { href: string; on: boolean }): HTMLElement {
  return el('a', {
    class: `daytab gretreat goutsider${o.on ? ' on' : ''}`, href: o.href, 'aria-current': o.on ? 'page' : null, id: 'outsiderTab',
    'data-feedback-id': 'guests.outsider.pestana.abrir', 'data-feedback-label': 'Abrir la pestaña Outsider',
  }, el('span', { class: 'gretreat-title' }, t('outsider.tab')), el('span', { class: 'daytab-m' }, t('outsider.tabSub')));
}

export function sectionLinks(sections: Section[], current: Section, href: (section: Section) => string): HTMLElement | null {
  if (sections.length < 2) return null;
  return el('nav', { class: 'segmented gsections', id: 'sections', 'aria-label': t('sections.label') },
    ...sections.map((s) => el('a', {
      href: href(s), class: s === current ? 'on' : '', 'aria-current': s === current ? 'page' : null, dataset: { section: s },
      'data-feedback-id': 'guests.retiros.seccion.abrir', 'data-feedback-label': 'Sección del retiro',
    }, sectionLabel(s))));
}
