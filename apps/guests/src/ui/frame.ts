/**
 * Cabecera del retiro (MUELA-059, «portada que se pliega», con los añadidos de VG; tanda 31):
 * - **portada** del retiro con la pieza del kit `createCoverCarousel`: imagen con velo (la primera imagen publicada en
 *   materiales que no es el logotipo; sin ella, color e iniciales), estado en texto, título, fechas y caras; flechas y
 *   puntos de 46 px y deslizar con el dedo para pasar de retiro. Encima, el selector de persona y la casa de Outsider;
 * - **«tu retiro de un vistazo»**: estado, noches, cama y, con la familia junta, quién va;
 * - **secciones** con icono que se quedan fijas bajo la cabecera al bajar, con una barra plegada (miniatura, título y
 *   estado) que solo se ve plegada;
 * - **aviso fijo** «Estás viendo «X», no el retiro en el que estás ahora (Y).» con «Ir a mi retiro», si hoy hay un retiro
 *   en curso y se está viendo otro (para no meter datos en el retiro equivocado). Se minimiza, no se cierra.
 * Las caras son las personas de la propia cuenta; nunca otros huéspedes.
 */
import { createCoverCarousel, el, icon, renderMedal, replace, type CoverSlide, type IconName } from '@ikisai/ui-kit';
import { formatDate, localeTag, t } from '../app/i18n.ts';
import { dateRange } from '../app/labels.ts';
import { entriesFor, type Person, type Retreat, type Selection } from '../app/roster.ts';
import { sectionLabel, type Section } from './nav.ts';

/** «13–15 sep» en el idioma elegido. */
export function shortRange(start: string | null, end: string | null): string {
  if (!start) return '';
  const fmt = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });
  const a = new Date(`${start}T12:00:00Z`);
  return !end || end === start ? fmt.format(a) : fmt.formatRange(a, new Date(`${end}T12:00:00Z`));
}

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
const weekdayDay = (day: string) => formatDate(day, { weekday: 'short', day: 'numeric' });

/** Estado de un retiro en texto, con la fecha de Madrid: «Ahora · hasta el dom 18», «Ya pasó», «Mañana», «Dentro de 12 días». */
export function retreatState(r: Pick<Retreat, 'start' | 'end'>, today: string): { key: 'past' | 'now' | 'next'; text: string } {
  if (r.end && today > r.end) return { key: 'past', text: t('frame.past') };
  if (r.start && today >= r.start) return { key: 'now', text: r.end ? t('frame.nowUntil', { day: weekdayDay(r.end) }) : t('frame.now') };
  if (!r.start) return { key: 'next', text: '' };
  const n = days(today, r.start);
  return { key: 'next', text: n === 1 ? t('frame.tomorrow') : t('frame.inDays', { count: n }) };
}

/** «Mañana» o «En 12 días», corto para la fila de datos. */
function nextShort(r: Pick<Retreat, 'start'>, today: string): string {
  if (!r.start) return '';
  const n = days(today, r.start);
  return n === 1 ? t('frame.tomorrow') : t('frame.inDaysShort', { count: n });
}

/** Selector de persona «Todos · Marta · Nico», con su cara; solo si la cuenta tiene más de una. */
export function personSelector(persons: Person[], selection: Selection, onPick: (selection: Selection) => void): HTMLElement | null {
  if (persons.length < 2) return null;
  const button = (value: Selection, label: string, face: HTMLElement) => el('button', {
    type: 'button', class: selection === value ? 'on' : '', 'aria-pressed': String(selection === value), dataset: { person: value },
    'data-feedback-id': 'guests.retiros.persona.elegir', 'data-feedback-label': 'Elegir persona',
    onclick: () => { if (selection !== value) onPick(value); },
  }, face, el('span', null, label));
  return el('div', { class: 'segmented gpersons', id: 'persons', role: 'group', 'aria-label': t('family.label'), 'data-feedback-ignore': '' },
    button('all', t('family.all'), el('span', { class: 'gface', 'aria-hidden': 'true' }, icon('people', 14))),
    ...persons.map((p) => button(p.key, p.name || t('picker.unknown'), renderMedal({ name: p.name || '·', size: 26 }))));
}

const SECTION_ICONS: Record<Section, IconName> = { inicio: 'home', programa: 'calendar', menu: 'chef', alojamiento: 'bed' };

export interface FrameOptions {
  /** Etiqueta de una ficha de equipo («Organizas», «Equipo» o «Dirección», §9.17 d). */
  role?: string | null;
  retreats: Retreat[];
  current: Retreat;
  persons: Person[];
  selection: Selection;
  today: string;
  sections: Section[];
  section: Section;
  /** Enlace de una sección del retiro que se ve. */
  sectionHref(section: Section): string;
  /** Enlace de otro retiro, conservando la sección. */
  retreatHref(retreat: Retreat): string;
  navigate(hash: string): void;
  onPerson(selection: Selection): void;
  /** Casa de Outsider (nivel de casa `outsider`). */
  outsiderHref?: string | null;
  /** Nombres de la familia que van a cada retiro (con «Todos»). */
  who(retreat: Retreat): string[];
  /** Imagen de portada de un retiro (URL de 5 minutos), si la tiene. */
  cover?(retreat: Retreat): Promise<string | null>;
  /** Cama de quien mira en el retiro que se ve («Habitación 3 · Cama 2»). */
  bed?(): Promise<string | null>;
  /** Nombre del lugar (Central), para «N noches · La Muela». */
  placeName?(): Promise<string | null>;
  /** La silueta de cabecera que eligió Central (URL de 10 minutos), bajo la portada; sin ella, nada. */
  silhouette?(): Promise<{ url: string; title: string | null } | null>;
}

export interface Frame {
  element: HTMLElement;
  /** El aviso fijo de otro retiro (va fuera del marco, sobre la barra). */
  away: HTMLElement | null;
  destroy(): void;
}

/** Retiros cuyo aviso está minimizado (mientras se siga en otro retiro). */
const minimized = new Set<string>();

export function retreatFrame(options: FrameOptions): Frame {
  const { retreats, current, today } = options;
  const at = Math.max(0, retreats.findIndex((r) => r.reservation_id === current.reservation_id));
  const faces = (r: Retreat) => options.who(r).map((name) => ({ name }));
  const slides: CoverSlide[] = retreats.map((r) => {
    const state = retreatState(r, today);
    // Con «Todos», un retiro que no es de toda la familia dice a quién toca (también en texto, no solo con las caras).
    const names = options.who(r);
    const partial = options.persons.length > 1 && names.length && names.length < options.persons.length;
    return { id: r.reservation_id, title: r.title ?? t('picker.unknown'), state: state.text, meta: [dateRange(r.start, r.end), partial ? names.join(', ') : null].filter(Boolean).join(' · '), faces: faces(r) };
  });
  const outsider = options.outsiderHref
    ? el('a', { class: 'goutsider-pill', href: options.outsiderHref, id: 'outsiderTab', 'aria-label': t('frame.outsiderLabel'),
      'data-feedback-id': 'guests.outsider.pestana.abrir', 'data-feedback-label': 'Abrir la pestaña Outsider' }, icon('home', 20), el('span', null, t('outsider.tab')))
    : null;
  const persons = personSelector(options.persons, options.selection, options.onPerson);
  const top = persons || outsider ? el('div', { class: 'ghero-top' }, persons ?? el('span'), outsider) : undefined;
  const carousel = createCoverCarousel({
    label: t('retreats.label'), slides, index: at, ...(top ? { top } : {}), feedbackId: 'guests.retiros.portada',
    onChange: (slide) => {
      const r = retreats.find((x) => x.reservation_id === slide.id);
      if (r) options.navigate(options.retreatHref(r));
    },
  });
  carousel.element.id = 'retreatHero';
  carousel.element.classList.add('ghero');
  const dots = carousel.element.querySelector('.cover-dots');
  if (dots) dots.id = 'retreatTabs';

  // Portada: la imagen llega aparte (URL firmada); se pone en la diapositiva que se ve y en su dato, para las vueltas.
  let alive = true;
  void options.cover?.(current).then((url) => {
    if (!alive || !url) return;
    slides[at]!.image = url;
    const box = carousel.element.querySelector<HTMLElement>('.cover-slide');
    if (box && box.dataset.id === current.reservation_id) {
      box.classList.add('cover-has-image');
      box.style.setProperty('--cover-image', `url("${url.replace(/["\\]/g, '')}")`);
      box.querySelector('.cover-initials')?.remove();
    }
    mini.replaceChildren(renderMedal({ image: url, name: current.title ?? '', size: 44 }));
  });

  // Tu retiro de un vistazo.
  const state = retreatState(current, today);
  const nights = current.start && current.end ? days(current.start, current.end) : null;
  const stateFact = fact(state.key === 'now' ? 'sun' : state.key === 'past' ? 'history' : 'calendar',
    state.key === 'now' ? t('frame.now') : state.key === 'past' ? t('frame.past') : nextShort(current, today),
    state.key === 'now' && current.end ? t('frame.until', { day: weekdayDay(current.end) }) : shortRange(current.start, current.end), state.key === 'now');
  const nightsFact = nights && nights > 0 ? fact('moon', t('frame.nights', { count: nights }), '') : null;
  const bedFact = fact('bed', '', '');
  bedFact.hidden = true;
  const names = options.who(current);
  const whoFact = names.length > 1 ? fact('people', new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(names), t('frame.together')) : null;
  const roleFact = options.role ? el('li', { class: 'grole-fact', id: 'teamRole' }, el('span', { class: 'chip small grole' }, options.role)) : null;
  const facts = el('ul', { class: 'gfacts', 'aria-label': t('frame.glance'), 'data-feedback-ignore': '' }, stateFact, nightsFact, bedFact, whoFact, roleFact);
  void options.placeName?.().then((name) => { if (alive && name && nightsFact) nightsFact.querySelector('small')!.textContent = name; });
  void options.bed?.().then((bed) => {
    if (!alive || !bed) return;
    const [room, ...rest] = bed.split(' · ');
    bedFact.querySelector('strong')!.textContent = room ?? bed;
    bedFact.querySelector('small')!.textContent = rest.join(' · ');
    bedFact.hidden = false;
  });

  // Secciones fijas al bajar, con la barra plegada encima.
  const mini = el('span', { class: 'gbar-cover' }, renderMedal({ name: current.title ?? '', size: 44 }));
  const bar = el('div', { class: 'gbar', 'aria-hidden': 'true' }, mini,
    el('span', { class: 'gbar-text' }, el('strong', null, current.title ?? ''), el('small', null, state.text)));
  const sections = options.sections.length > 1 ? el('nav', { class: 'segmented gsections', id: 'sections', 'aria-label': t('sections.label') },
    ...options.sections.map((s) => el('a', {
      href: options.sectionHref(s), class: s === options.section ? 'on' : '', 'aria-current': s === options.section ? 'page' : null, dataset: { section: s },
      'data-feedback-id': 'guests.retiros.seccion.abrir', 'data-feedback-label': 'Sección del retiro',
    }, icon(SECTION_ICONS[s], 18), el('span', null, sectionLabel(s))))) : null;
  const sticky = sections ? el('div', { class: 'gsticky' }, bar, sections) : null;

  // La silueta del edificio bajo la portada (decorativa: el nombre del lugar ya va en los datos).
  const skyline = el('div', { class: 'gskyline', id: 'headerSilhouette', 'aria-hidden': 'true' });
  skyline.hidden = true;
  void options.silhouette?.().then((s) => {
    if (!alive || !s) return;
    const img = el('img', { src: s.url, alt: '', decoding: 'async' }) as HTMLImageElement;
    img.addEventListener('load', () => { skyline.hidden = false; }, { once: true });
    img.addEventListener('error', () => skyline.remove(), { once: true });
    skyline.replaceChildren(img);
  }).catch(() => undefined);

  const element = el('div', { class: 'gframe', id: 'retreatFrame' }, carousel.element, skyline, facts, sticky);

  // Plegado: cuando la portada sale de la vista, la barra se enseña; la posición fija la da `position: sticky`.
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(([entry]) => { element.classList.toggle('gfolded', !entry!.isIntersecting); }, { rootMargin: '-80px 0px 0px 0px' })
    : null;
  observer?.observe(carousel.element);

  // Aviso fijo: hoy hay un retiro en curso (visible para la selección) y se ve otro.
  const live = retreats.find((r) => r.reservation_id !== current.reservation_id && retreatState(r, today).key === 'now');
  let away: HTMLElement | null = null;
  if (live && retreatState(current, today).key !== 'now') {
    const go = () => { minimized.delete(current.reservation_id); options.navigate(options.retreatHref(live)); };
    const paint = () => {
      const min = minimized.has(current.reservation_id);
      away!.classList.toggle('min', min);
      replace(away!, min
        ? el('button', { type: 'button', class: 'gaway-pill', 'aria-label': t('frame.awayShow'), 'data-feedback-id': 'guests.retiros.aviso.mostrar', 'data-feedback-label': 'Mostrar el aviso de otro retiro',
          onclick: () => { minimized.delete(current.reservation_id); paint(); } }, icon('warn', 16), el('span', null, t('frame.awayPill')))
        : el('p', { class: 'gaway-text' }, icon('warn', 18), ' ', t('frame.away', { title: current.title ?? '', live: live.title ?? '' })),
      el('div', { class: 'gaway-btns' },
        el('button', { type: 'button', class: 'primary gaway-go', 'data-feedback-id': 'guests.retiros.aviso.ir', 'data-feedback-label': 'Ir a mi retiro', onclick: go }, t('frame.awayGo')),
        min ? null : el('button', { type: 'button', class: 'iconbtn gaway-min', 'aria-label': t('frame.awayMin'), 'data-feedback-id': 'guests.retiros.aviso.minimizar', 'data-feedback-label': 'Minimizar el aviso',
          onclick: () => { minimized.add(current.reservation_id); paint(); } }, icon('chevronDown', 18))));
    };
    away = el('div', { class: 'gaway', id: 'otherRetreat', role: 'status' });
    paint();
  }

  return {
    element,
    away,
    destroy() { alive = false; observer?.disconnect(); away?.remove(); },
  };

  function fact(ic: IconName, main: string, sub: string, on = false): HTMLElement {
    return el('li', { class: on ? 'on' : '' }, el('span', { class: 'gfact-ico', 'aria-hidden': 'true' }, icon(ic, 20)),
      el('span', { class: 'gfact-text' }, el('strong', null, main), el('small', null, sub)));
  }
}
