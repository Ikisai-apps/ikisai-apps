/**
 * Agenda por horas con la línea de ahora (MUELA-075: Guests y Food): las cosas del día en orden, lo ya terminado
 * plegado («3 actividades antes»), la raya «Ahora · 12:20» entre lo hecho y lo que viene, y lo de ahora y lo siguiente
 * destacados. Va debajo de `createDayTabs`. Qué está «ahora» (y la regla de «sin hora de fin») lo decide la app con
 * `state`; sin `now`, no hay raya (otro día, o antes del retiro).
 * Prefijo de clases: `hour-`.
 */
import { el, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';

export interface HourItem {
  id: string;
  /** `HH:MM`. */
  time: string;
  end?: string | null;
  title: string;
  /** Lugar, «hasta las 13:30», nota. */
  sub?: string | null;
  /** Para colorear (p. ej. `meal`). */
  kind?: string | null;
  state: 'done' | 'now' | 'next' | 'later';
  /** Lo que se añade al de ahora o al siguiente («Ver en el plano»). */
  extra?: Child;
}

export interface HourAgendaOptions {
  label: string;
  items: HourItem[];
  /** Hora de ahora (`HH:MM`) para la raya; solo si el día es hoy. */
  now?: string | null;
  emptyText?: string;
}

export function renderHourAgenda(options: HourAgendaOptions): HTMLElement {
  const done = options.items.filter((i) => i.state === 'done');
  const rest = options.items.filter((i) => i.state !== 'done');
  const row = (i: HourItem) => el('li', { class: `hour-item hour-${i.state}${i.kind ? ` hour-kind-${i.kind}` : ''}`, dataset: { id: i.id } },
    el('span', { class: 'hour-time' }, i.time),
    el('span', { class: 'hour-bar', 'aria-hidden': 'true' }),
    el('span', { class: 'hour-text' }, el('strong', null, i.title),
      i.sub || i.end ? el('small', null, [i.sub, i.end ? kt('hasta las {time}', { time: i.end }) : null].filter(Boolean).join(' · ')) : null,
      i.extra ?? null),
    i.state === 'now' ? el('span', { class: 'chip hour-chip' }, kt('Ahora')) : i.state === 'next' ? el('span', { class: 'chip hour-chip' }, kt('Después')) : null);
  const nowLine = options.now ? el('li', { class: 'hour-nowline', 'aria-label': kt('Ahora · {time}', { time: options.now }) }, el('span', { 'aria-hidden': 'true' }, kt('Ahora · {time}', { time: options.now }))) : null;
  if (!options.items.length) return el('section', { class: 'hour-box', 'aria-label': options.label }, el('p', { class: 'hint' }, options.emptyText ?? kt('Nada este día.')));
  return el('section', { class: 'hour-box', 'aria-label': options.label },
    done.length ? el('details', { class: 'hour-earlier' },
      el('summary', null, done.length === 1 ? kt('1 actividad antes') : kt('{n} actividades antes', { n: String(done.length) })),
      el('ul', { class: 'hour-list' }, ...done.map(row))) : null,
    el('ul', { class: 'hour-list' }, nowLine, ...rest.map(row)));
}
