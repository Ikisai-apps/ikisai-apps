/**
 * Calendario de la persona (O4a; kit 0.33, `createCalendar` con capas): sus retiros, pasados y futuros, en un mes de lunes
 * a domingo. Tocar un retiro abre su pestaña. Con «Todos», un retiro que no es de todos lleva el nombre de a quién toca.
 * Debajo, la lista de todos los retiros con sus fechas: así se llega a uno lejano sin pasar meses, y se lee bien con un
 * lector de pantalla. En O4b se añaden las estancias, «hay alguien», las notas y los retiros abiertos.
 */
import { createCalendar, el, icon, replace, type CalendarEvent } from '@ikisai/ui-kit';
import { localeTag, t } from '../app/i18n.ts';
import { dateRange } from '../app/labels.ts';
import { retreatsFor, whenOf, type Retreat, type Roster, type Selection } from '../app/roster.ts';
import { fbIgnore } from './common.ts';
import { todayMadrid } from './home.ts';

export interface CalendarActions {
  href(retreat: Retreat): string;
  navigate(hash: string): void;
  /** Nombres de a quién toca un retiro si no es de todos (vacío si es de todos). */
  who(retreat: Retreat): string;
}

export function mountCalendar(main: HTMLElement, roster: Roster, selection: Selection, actions: CalendarActions, header: HTMLElement | null): () => void {
  const list = retreatsFor(roster, selection);
  const byId = new Map(list.map((r) => [r.reservation_id, r]));
  const events: CalendarEvent[] = list.filter((r) => r.start).map((r) => {
    const who = actions.who(r);
    const title = `${r.title ?? t('picker.unknown')}${who ? ` · ${who}` : ''}`;
    return { id: r.reservation_id, title, abbr: title, start: r.start!, end: r.end ?? r.start!, layer: 'mine' };
  });
  const calendar = createCalendar({
    label: t('calendar.title'),
    feedbackId: 'guests.calendario',
    viewSwitch: false,
    locale: localeTag(),
    date: todayMadrid(),
    layers: [{ id: 'mine', label: t('calendar.mine'), color: 'var(--accent)' }],
    events: () => events,
    onSelectEvent: (event) => { const r = byId.get(event.id); if (r) actions.navigate(actions.href(r)); },
  });
  calendar.element.id = 'calendar';
  const today = todayMadrid();
  const when = { before: t('calendar.before'), during: t('calendar.during'), after: t('calendar.after') };
  const label = (r: Retreat) => when[whenOf(r, today)];
  replace(main,
    header,
    el('div', { class: 'pagehead' }, el('h2', null, t('calendar.title'))),
    calendar.element,
    el('section', { class: 'gcalendar-list', 'aria-labelledby': 'calendarListTitle' },
      el('h3', { id: 'calendarListTitle' }, t('calendar.list')),
      list.length
        ? fbIgnore(el('div', { class: 'gcards', id: 'calendarList' }, ...list.map((r) => el('a', {
          class: 'card gcard glink', href: actions.href(r), dataset: { reservation: r.reservation_id },
          'data-feedback-id': 'guests.calendario.retiro.abrir', 'data-feedback-label': 'Abrir retiro',
        }, icon('calendar', 20), el('span', null,
          el('strong', null, r.title ?? t('picker.unknown')),
          el('span', { class: 'muted small' }, [dateRange(r.start, r.end), label(r), actions.who(r)].filter(Boolean).join(' · ')))))))
        : el('p', { class: 'card gcard muted', id: 'calendarEmpty' }, t('calendar.empty'))));
  return () => calendar.destroy();
}
