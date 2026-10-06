import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';

/** Fecha local `YYYY-MM-DD`. */
export type DayKey = string;

export interface CalendarEvent {
  id: string;
  title: string;
  /** Primer día (incluido). */
  start: DayKey;
  /** Último día (incluido); por defecto `start`. */
  end?: DayKey;
  /** Color propio (estado de la reserva, área): tiñe la barra. */
  color?: string | null;
  /** Texto corto que acompaña al título (p. ej. «[PRE]»). */
  badge?: string;
  /** Título abreviado para los tramos del mes en móvil («Ortega», «Yoga»); sin él, en móvil el tramo es solo una barra. */
  abbr?: string;
  /** Clase extra para el estado (`data-status`). */
  status?: string;
}

export type CalendarView = 'month' | 'week';

export interface CalendarOptions {
  view?: CalendarView;
  /** Día de referencia; por defecto hoy. */
  date?: DayKey;
  /** Eventos del rango visible; puede devolver una promesa. */
  events: (range: { from: DayKey; to: DayKey }) => CalendarEvent[] | Promise<CalendarEvent[]>;
  onSelectDay?: (day: DayKey, events: CalendarEvent[]) => void;
  onSelectEvent?: (event: CalendarEvent, day: DayKey) => void;
  onRangeChange?: (range: { from: DayKey; to: DayKey; view: CalendarView }) => void;
  /** 1 = lunes (por defecto), 0 = domingo. */
  weekStartsOn?: 0 | 1;
  /** Mostrar el selector Mes / Semana; por defecto sí. */
  viewSwitch?: boolean;
  /** Máximo de eventos visibles por día en el mes antes de «+N». */
  maxPerDay?: number;
  locale?: string;
}

export interface Calendar {
  element: HTMLElement;
  setView(view: CalendarView): void;
  setDate(date: DayKey): void;
  getRange(): { from: DayKey; to: DayKey; view: CalendarView };
  refresh(): Promise<void>;
  destroy(): void;
}

const DAY = 86_400_000;

export function toDayKey(date: Date): DayKey {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fromDayKey(key: DayKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

export function addDays(key: DayKey, days: number): DayKey {
  const date = fromDayKey(key);
  date.setDate(date.getDate() + days);
  return toDayKey(date);
}

export function todayKey(): DayKey {
  return toDayKey(new Date());
}

/** Lunes (o domingo) de la semana que contiene `key`. */
export function startOfWeek(key: DayKey, weekStartsOn: 0 | 1 = 1): DayKey {
  const date = fromDayKey(key);
  const diff = (date.getDay() - weekStartsOn + 7) % 7;
  return addDays(key, -diff);
}

export function startOfMonth(key: DayKey): DayKey {
  return `${key.slice(0, 7)}-01`;
}

export function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((fromDayKey(b).getTime() - fromDayKey(a).getTime()) / DAY);
}

function monthLabel(key: DayKey, locale: string): string {
  const text = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(fromDayKey(key));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function weekdayLabels(locale: string, weekStartsOn: 0 | 1, style: 'short' | 'long'): string[] {
  const base = startOfWeek('2024-01-07', weekStartsOn); // una semana cualquiera
  const fmt = new Intl.DateTimeFormat(locale, { weekday: style });
  return Array.from({ length: 7 }, (_, i) => {
    const text = fmt.format(fromDayKey(addDays(base, i)));
    return text.replace(/\.$/, '');
  });
}

function covers(event: CalendarEvent, day: DayKey): boolean {
  return day >= event.start && day <= (event.end ?? event.start);
}

/**
 * Calendario mensual y semanal de días completos (reservas, servicios), sin librerías, navegable con teclado:
 * flechas mueven el foco entre días, Enter selecciona, AvPág/RePág cambian de mes o semana, Inicio va a hoy.
 */
export function createCalendar(options: CalendarOptions): Calendar {
  const locale = options.locale ?? 'es-ES';
  const weekStartsOn = options.weekStartsOn ?? 1;
  const maxPerDay = options.maxPerDay ?? 3;
  let view: CalendarView = options.view ?? 'month';
  let cursor: DayKey = options.date ?? todayKey();
  let focused: DayKey = cursor;
  let events: CalendarEvent[] = [];
  let loading = 0;

  const title = el('h3', { class: 'cal-title', 'aria-live': 'polite' });
  const prev = el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Anterior', onclick: () => move(-1) }, icon('chevronLeft'));
  const next = el('button', { class: 'iconbtn small', type: 'button', 'aria-label': 'Siguiente', onclick: () => move(1) }, icon('chevronRight'));
  const today = el('button', { class: 'ghost small', type: 'button', onclick: () => { cursor = todayKey(); focused = cursor; void load(); } }, 'Hoy');
  const switcher = options.viewSwitch === false ? null : el('div', { class: 'segmented cal-switch', role: 'group', 'aria-label': 'Vista' },
    el('button', { type: 'button', dataset: { view: 'month' }, onclick: () => setView('month') }, 'Mes'),
    el('button', { type: 'button', dataset: { view: 'week' }, onclick: () => setView('week') }, 'Semana'),
  );
  const head = el('div', { class: 'cal-head' }, el('div', { class: 'cal-nav' }, prev, title, next), el('div', { class: 'cal-tools' }, today, switcher));
  const grid = el('div', { class: 'cal-grid', role: 'grid' });
  const element = el('section', { class: 'calendar', dataset: { view } }, head, grid);

  function range(): { from: DayKey; to: DayKey } {
    if (view === 'week') {
      const from = startOfWeek(cursor, weekStartsOn);
      return { from, to: addDays(from, 6) };
    }
    const first = startOfMonth(cursor);
    const from = startOfWeek(first, weekStartsOn);
    const lastOfMonth = addDays(startOfMonth(addDays(first, 35)), -1);
    const to = addDays(startOfWeek(lastOfMonth, weekStartsOn), 6);
    return { from, to };
  }

  function move(direction: 1 | -1): void {
    if (view === 'week') cursor = addDays(cursor, 7 * direction);
    else {
      const first = startOfMonth(cursor);
      cursor = direction === 1 ? addDays(first, 32).slice(0, 7) + '-01' : addDays(first, -1).slice(0, 7) + '-01';
    }
    focused = cursor;
    void load();
  }

  function setView(next: CalendarView): void {
    if (view === next) return;
    view = next;
    element.dataset.view = view;
    void load();
  }

  async function load(): Promise<void> {
    const r = range();
    const token = ++loading;
    element.classList.add('loading');
    try {
      const result = await options.events(r);
      if (token !== loading) return;
      events = result.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : daysBetween(b.start, b.end ?? b.start) - daysBetween(a.start, a.end ?? a.start)));
    } finally {
      if (token === loading) element.classList.remove('loading');
    }
    paint();
    options.onRangeChange?.({ ...r, view });
  }

  function dayCell(day: DayKey, inMonth: boolean): HTMLElement {
    const dayEvents = events.filter((e) => covers(e, day));
    const isToday = day === todayKey();
    const number = fromDayKey(day).getDate();
    const label = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(fromDayKey(day));
    const shown = view === 'week' ? dayEvents : dayEvents.slice(0, maxPerDay);
    const more = dayEvents.length - shown.length;
    const cell = el('div', {
      class: `cal-day${inMonth ? '' : ' outside'}${isToday ? ' today' : ''}${dayEvents.length ? ' has' : ''}`,
      role: 'gridcell',
      tabindex: day === focused ? '0' : '-1',
      dataset: { day },
      'aria-label': `${label}${dayEvents.length ? `, ${dayEvents.length} ${dayEvents.length === 1 ? 'evento' : 'eventos'}` : ''}`,
      'aria-selected': String(day === focused),
      onclick: () => { focused = day; focusDay(day); options.onSelectDay?.(day, dayEvents); },
      onkeydown: (e: Event) => onKey(e as KeyboardEvent, day, dayEvents),
    },
      el('span', { class: 'cal-num' }, view === 'week' ? `${weekdayLabels(locale, weekStartsOn, 'short')[(fromDayKey(day).getDay() - weekStartsOn + 7) % 7]} ${number}` : String(number)),
      el('div', { class: 'cal-events' },
        ...shown.map((event) => {
          const first = event.start === day || (fromDayKey(day).getDay() - weekStartsOn + 7) % 7 === 0;
          const last = (event.end ?? event.start) === day;
          return el('button', {
            type: 'button',
            class: `cal-event${event.start === day ? ' starts' : ''}${(event.end ?? event.start) === day ? ' ends' : ''}`,
            style: event.color ? `--event-color:${event.color}` : null,
            dataset: { eventId: event.id, status: event.status ?? '', abbr: event.abbr ?? '' },
            tabindex: '-1',
            title: event.title,
            'aria-label': `${event.title}${event.badge ? ` ${event.badge}` : ''}`,
            onclick: (e: Event) => { e.stopPropagation(); options.onSelectEvent?.(event, day); },
          }, first || view === 'week' ? el('span', { class: 'cal-event-text', dataset: { abbr: event.abbr ?? '' } }, event.badge ? `${event.badge} ` : '', event.title) : el('span', { class: 'cal-event-text', 'aria-hidden': 'true', dataset: { abbr: event.abbr ?? '' } }, last ? '' : ''));
        }),
        more > 0 ? el('span', { class: 'cal-more' }, `+${more}`) : null,
      ),
    );
    return cell;
  }

  function focusDay(day: DayKey): void {
    grid.querySelectorAll<HTMLElement>('.cal-day').forEach((cell) => {
      const active = cell.dataset.day === day;
      cell.tabIndex = active ? 0 : -1;
      cell.setAttribute('aria-selected', String(active));
      if (active) cell.focus({ preventScroll: true });
    });
  }

  function onKey(e: KeyboardEvent, day: DayKey, dayEvents: CalendarEvent[]): void {
    const r = range();
    let target: DayKey | null = null;
    switch (e.key) {
      case 'ArrowRight': target = addDays(day, 1); break;
      case 'ArrowLeft': target = addDays(day, -1); break;
      case 'ArrowDown': target = addDays(day, 7); break;
      case 'ArrowUp': target = addDays(day, -7); break;
      case 'Home': target = todayKey(); break;
      case 'PageDown': move(1); e.preventDefault(); return;
      case 'PageUp': move(-1); e.preventDefault(); return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        options.onSelectDay?.(day, dayEvents);
        return;
      default:
        return;
    }
    e.preventDefault();
    focused = target;
    if (target < r.from || target > r.to) {
      cursor = target;
      void load().then(() => focusDay(target!));
    } else focusDay(target);
  }

  function paint(): void {
    const r = range();
    title.textContent = view === 'week'
      ? `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(fromDayKey(r.from))} – ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(fromDayKey(r.to))}`
      : monthLabel(cursor, locale);
    switcher?.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.classList.toggle('on', b.dataset.view === view); b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
    const headers = view === 'month' ? el('div', { class: 'cal-weekdays', role: 'row' }, ...weekdayLabels(locale, weekStartsOn, 'short').map((d) => el('span', { role: 'columnheader' }, d))) : null;
    const days: HTMLElement[] = [];
    const month = cursor.slice(0, 7);
    for (let day = r.from; day <= r.to; day = addDays(day, 1)) days.push(dayCell(day, view === 'week' || day.startsWith(month)));
    if (!days.some((d) => d.tabIndex === 0)) { focused = cursor; days.find((d) => d.dataset.day === cursor)?.setAttribute('tabindex', '0'); }
    const rows: HTMLElement[] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(el('div', { class: 'cal-week', role: 'row' }, ...days.slice(i, i + 7)));
    replace(grid, headers, ...rows);
  }

  void load();

  return {
    element,
    setView,
    setDate(date) { cursor = date; focused = date; void load(); },
    getRange: () => ({ ...range(), view }),
    refresh: load,
    destroy() { element.remove(); },
  };
}
