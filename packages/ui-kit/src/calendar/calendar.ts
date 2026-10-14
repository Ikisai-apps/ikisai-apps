import { el, replace, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';

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
  /** Capa a la que pertenece (`layers`): toma su color y su estilo si no trae los suyos, y se oculta con ella. */
  layer?: string;
}

/** Capa de eventos (retiros apuntados, retiros abiertos, estancias…), con su leyenda y su interruptor. */
export interface CalendarLayer {
  id: string;
  label: string;
  color: string;
  /** `solid` (por defecto), `outline` (borde discontinuo: «abierto, puedes apuntarte») o `soft` (más claro). */
  style?: 'solid' | 'outline' | 'soft';
  /** Visible al empezar; por defecto sí. */
  visible?: boolean;
}

/** Nota con hora de un día («18:00 · Llego en tren»). */
export interface CalendarNote {
  id: string;
  /** `HH:MM`; sin hora, es de todo el día. */
  time?: string | null;
  text: string;
  author?: string | null;
}

/** Lo que hay en un día aparte de los eventos. */
export interface CalendarDayInfo {
  /** Día sombreado (rayado), p. ej. «hay alguien del staff», sin nombres. */
  shaded?: boolean;
  /** Qué significa el sombreado; lo lee el lector de pantalla y sale en el panel del día. */
  shadeLabel?: string;
  notes?: CalendarNote[];
}

export interface CalendarRange { from: DayKey; to: DayKey }

/** Elegir un rango de días (crear o cambiar una estancia): dos toques, arrastre en escritorio o Intro, flechas e Intro. */
export interface CalendarSelectOptions {
  /** Botón de guardar («Guardar estancia»). */
  label: string;
  onSelect: (range: CalendarRange & { eventId?: string }) => void | Promise<void>;
  minDays?: number;
  maxDays?: number;
  /** Días que no se pueden elegir. */
  allowed?: (day: DayKey) => boolean;
  /** Segunda línea de la barra («3 días · Hab 3, cama 1»). */
  describe?: (range: CalendarRange) => string;
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
  /** Capas de eventos. Con `legend`, una fila de chips para encender y apagar cada una. */
  layers?: CalendarLayer[];
  legend?: boolean;
  /** Texto del sombreado en la leyenda («Hay alguien»), como entrada fija. */
  shadeLegend?: string;
  /** Recuerda en el navegador las capas apagadas. */
  storageKey?: string;
  /** Sombreado y notas de cada día del rango visible. */
  dayInfo?: (range: CalendarRange) => Record<DayKey, CalendarDayInfo> | Promise<Record<DayKey, CalendarDayInfo>>;
  /**
   * Panel del día elegido (debajo en el móvil, a la derecha en escritorio): eventos, sombreado y notas. `renderDay`
   * añade lo de la app al final («Cambiar fechas», «Añadir nota», «Apuntarme»).
   */
  agenda?: boolean | { renderDay?: (day: DayKey, events: CalendarEvent[], info: CalendarDayInfo) => Child };
  /** Elegir días. Se entra con `selectRange()`. */
  select?: CalendarSelectOptions;
  /** Cambiar de mes o semana deslizando a los lados en pantallas táctiles; por defecto sí. */
  swipe?: boolean;
  /** Nombre accesible del calendario. */
  label?: string;
  /** Marca de feedback y uso (`CALENDAR_MARKS` para sus partes). */
  feedbackId?: string;
}

export interface Calendar {
  element: HTMLElement;
  setView(view: CalendarView): void;
  setDate(date: DayKey): void;
  getRange(): { from: DayKey; to: DayKey; view: CalendarView };
  refresh(): Promise<void>;
  /** Entra en «elegir días» (requiere `select`), con un rango ya marcado si se da (cambiar fechas de `eventId`). */
  selectRange(initial?: { from?: DayKey; to?: DayKey; eventId?: string }): void;
  cancelSelect(): void;
  /** Capas visibles. */
  setLayers(visible: string[]): void;
  /** Día del panel (`agenda`). */
  selectDay(day: DayKey): void;
  destroy(): void;
}

/** Marcas de feedback de las partes del calendario (`feedbackId` + sufijo). */
export const CALENDAR_MARKS = {
  layer: ['capa', 'Capa del calendario'],
  day: ['dia', 'Día del calendario'],
  save: ['guardar_dias', 'Guardar días elegidos'],
  cancel: ['cancelar_dias', 'Cancelar la elección de días'],
} as const;

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

function readHidden(key?: string): string[] | null {
  if (!key) return null;
  try { const raw = localStorage.getItem(`ikisai-calendar-layers:${key}`); return raw ? JSON.parse(raw) as string[] : null; } catch { return null; }
}

function saveHidden(key: string | undefined, hidden: string[]): void {
  if (!key) return;
  try { localStorage.setItem(`ikisai-calendar-layers:${key}`, JSON.stringify(hidden)); } catch { /* sin almacenamiento */ }
}

/**
 * Calendario mensual y semanal de días completos (reservas, servicios), sin librerías, navegable con teclado:
 * flechas mueven el foco entre días, Enter selecciona, AvPág/RePág cambian de mes o semana, Inicio va a hoy.
 *
 * Opcional (sin estas opciones se comporta igual que siempre): capas con leyenda (`layers`, `legend`), sombreado y
 * notas por día (`dayInfo`), panel del día (`agenda`), elegir días (`select` + `selectRange()`) y deslizar entre meses.
 */
export function createCalendar(options: CalendarOptions): Calendar {
  const locale = options.locale ?? 'es-ES';
  const weekStartsOn = options.weekStartsOn ?? 1;
  const maxPerDay = options.maxPerDay ?? 3;
  const layers = options.layers ?? [];
  const layerOf = new Map(layers.map((l) => [l.id, l]));
  const base = options.feedbackId;
  const mark = (key: keyof typeof CALENDAR_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${CALENDAR_MARKS[key][0]}`, 'data-feedback-label': CALENDAR_MARKS[key][1] } : {});
  const agendaOpt = options.agenda ? (options.agenda === true ? {} : options.agenda) : null;
  let view: CalendarView = options.view ?? 'month';
  let cursor: DayKey = options.date ?? todayKey();
  let focused: DayKey = cursor;
  let events: CalendarEvent[] = [];
  let info: Record<DayKey, CalendarDayInfo> = {};
  let loading = 0;
  let hidden = new Set(readHidden(options.storageKey) ?? layers.filter((l) => l.visible === false).map((l) => l.id));
  let picked: DayKey = cursor;
  /** Elegir días: `from` y `to` (incluidos); `to` null mientras falta el último. */
  let selecting: { from: DayKey | null; to: DayKey | null; eventId?: string; hover?: DayKey | null } | null = null;
  let saving = false;

  const longDay = (day: DayKey) => new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(fromDayKey(day));
  const shortDay = (day: DayKey) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(fromDayKey(day)).replace(/\.$/, '');
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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
  const legend = options.legend && (layers.length || options.shadeLegend) ? el('div', { class: 'cal-legend', role: 'group', 'aria-label': kt('Capas') }) : null;
  const agenda = agendaOpt ? el('section', { class: 'cal-agenda', 'aria-label': kt('Día elegido') }) : null;
  const live = el('p', { class: 'cal-live', 'aria-live': 'polite', role: 'status' });
  const barText = el('strong', { class: 'cal-selectbar-text' });
  const barSub = el('span', { class: 'cal-selectbar-sub' });
  const saveBtn = el('button', { type: 'button', class: 'primary', ...mark('save'), onclick: () => void save() }, options.select?.label ?? kt('Guardar')) as HTMLButtonElement;
  const bar = options.select ? el('div', { class: 'cal-selectbar', role: 'region', 'aria-label': options.select.label, hidden: true },
    el('div', { class: 'cal-selectbar-info' }, barText, barSub),
    el('div', { class: 'cal-selectbar-actions' },
      el('button', { type: 'button', class: 'ghost', ...mark('cancel'), onclick: () => cancelSelect() }, kt('Cancelar')),
      saveBtn),
  ) : null;
  const body = agenda ? el('div', { class: 'cal-body' }, grid, agenda) : grid;
  const element = el('section', {
    class: `calendar${agenda ? ' has-agenda' : ''}`, dataset: { view },
    ...(options.label ? { 'aria-label': options.label } : {}),
    ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label ?? kt('Calendario') } : {}),
  }, head, legend, body, bar, live);

  const visible = (e: CalendarEvent) => !e.layer || !hidden.has(e.layer);
  const shown = () => events.filter(visible);
  const announce = (text: string) => { live.textContent = ''; live.textContent = text; };

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
      const [result, days] = await Promise.all([options.events(r), options.dayInfo ? options.dayInfo(r) : Promise.resolve({})]);
      if (token !== loading) return;
      events = result.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : daysBetween(b.start, b.end ?? b.start) - daysBetween(a.start, a.end ?? a.start)));
      info = days ?? {};
    } finally {
      if (token === loading) element.classList.remove('loading');
    }
    paint();
    options.onRangeChange?.({ ...r, view });
  }

  // --- Elegir días ------------------------------------------------------------------------------------------
  const isAllowed = (day: DayKey) => options.select?.allowed?.(day) ?? true;
  /** Pantalla táctil sin ratón (Android, iPhone): pistas de toque en vez de teclado. */
  const touchOnly = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
  function hint(): string {
    if (!touchOnly()) return kt('Con teclado: Intro en el primero, flechas e Intro en el último. Esc cancela.');
    return options.swipe !== false && view === 'month' ? kt('Desliza a los lados para cambiar de mes.') : '';
  }
  /** En el móvil, «Nueva estancia» puede estar lejos del calendario: lo trae a la vista si el día no se ve. */
  function reveal(): void {
    const cell = grid.querySelector<HTMLElement>(`.cal-day[data-day="${focused}"]`);
    if (!cell || typeof innerHeight !== 'number') return;
    const r = cell.getBoundingClientRect();
    const covered = bar && !bar.hidden ? bar.getBoundingClientRect().height : 0;
    if (r.top >= 0 && r.bottom <= innerHeight - covered) return;
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    cell.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  }
  function rangeOf(): CalendarRange | null {
    if (!selecting?.from) return null;
    const end = selecting.to ?? selecting.hover ?? selecting.from;
    return end < selecting.from ? { from: end, to: selecting.from } : { from: selecting.from, to: end };
  }
  function problem(r: CalendarRange): string | null {
    const n = daysBetween(r.from, r.to) + 1;
    const s = options.select!;
    if (s.minDays && n < s.minDays) return kt('Elige al menos {n} días.', { n: String(s.minDays) });
    if (s.maxDays && n > s.maxDays) return kt('Elige como mucho {n} días.', { n: String(s.maxDays) });
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) if (!isAllowed(d)) return kt('El {day} no se puede elegir.', { day: shortDay(d) });
    return null;
  }
  function rangeText(r: CalendarRange): string {
    if (r.from === r.to) return capital(longDay(r.from));
    return kt('Del {from} al {to}', { from: shortDay(r.from), to: shortDay(r.to) });
  }
  function paintBar(): void {
    if (!bar || !selecting) return;
    const r = rangeOf();
    const complete = !!(selecting.from && selecting.to);
    const issue = complete && r ? problem(r) : null;
    barText.textContent = !selecting.from ? kt('Toca el primer día') : !complete ? kt('{day} · ahora toca el último día', { day: shortDay(selecting.from) }) : rangeText(r!);
    const n = r ? daysBetween(r.from, r.to) + 1 : 0;
    barSub.textContent = issue ?? (complete && r ? (options.select?.describe?.(r) ?? (n === 1 ? kt('1 día') : kt('{n} días', { n: String(n) }))) : hint());
    barSub.classList.toggle('error', !!issue);
    saveBtn.disabled = !complete || !!issue || saving;
  }
  function markRange(): void {
    const r = rangeOf();
    grid.querySelectorAll<HTMLElement>('.cal-day').forEach((cell) => {
      const day = cell.dataset.day!;
      const inside = !!r && day >= r.from && day <= r.to;
      cell.classList.toggle('in-range', inside);
      cell.classList.toggle('range-start', !!r && day === r.from);
      cell.classList.toggle('range-end', !!r && day === r.to);
      cell.classList.toggle('blocked', !!selecting && !isAllowed(day));
      if (selecting) cell.setAttribute('aria-selected', String(inside)); else cell.setAttribute('aria-selected', String(day === focused));
    });
  }
  function pick(day: DayKey): void {
    if (!selecting) return;
    if (!isAllowed(day)) { announce(kt('El {day} no se puede elegir.', { day: shortDay(day) })); return; }
    if (!selecting.from || selecting.to) {
      selecting.from = day; selecting.to = null; selecting.hover = null;
      announce(kt('Primer día: {day}. Ahora elige el último.', { day: longDay(day) }));
    } else {
      selecting.to = day; selecting.hover = null;
      const r = rangeOf()!;
      selecting.from = r.from; selecting.to = r.to;
      const issue = problem(r);
      announce(issue ?? `${rangeText(r)}. ${kt('Pulsa «{label}» para guardar.', { label: options.select!.label })}`);
    }
    markRange();
    paintBar();
  }
  async function save(): Promise<void> {
    const r = rangeOf();
    if (!selecting || !selecting.to || !r || problem(r) || saving) return;
    saving = true;
    paintBar();
    try {
      await options.select!.onSelect({ ...r, ...(selecting.eventId ? { eventId: selecting.eventId } : {}) });
      saving = false;
      cancelSelect(true);
    } catch (error) {
      saving = false;
      paintBar();
      throw error;
    }
  }
  function selectRange(initial: { from?: DayKey; to?: DayKey; eventId?: string } = {}): void {
    if (!options.select || !bar) return;
    selecting = { from: initial.from ?? null, to: initial.from ? (initial.to ?? initial.from) : null, ...(initial.eventId ? { eventId: initial.eventId } : {}) };
    element.classList.add('selecting');
    bar.hidden = false;
    const target = initial.from ?? focused;
    if (initial.from) { focused = initial.from; cursor = initial.from; }
    announce(initial.from ? kt('Cambia el primer día y el último, y guarda.') : kt('Elige el primer día y luego el último.'));
    const r = range();
    if (target < r.from || target > r.to) void load().then(() => { focusDay(focused); reveal(); });
    else { markRange(); paintBar(); focusDay(focused); reveal(); }
  }
  function cancelSelect(saved = false): void {
    if (!selecting) return;
    selecting = null;
    element.classList.remove('selecting');
    if (bar) bar.hidden = true;
    markRange();
    if (!saved) announce(kt('Elección de días cancelada.'));
  }

  // --- Celdas ------------------------------------------------------------------------------------------------
  function dayCell(day: DayKey, inMonth: boolean): HTMLElement {
    const dayEvents = shown().filter((e) => covers(e, day));
    const extra = info[day] ?? {};
    const notes = extra.notes ?? [];
    const isToday = day === todayKey();
    const number = fromDayKey(day).getDate();
    const label = longDay(day);
    const visibleEvents = view === 'week' ? dayEvents : dayEvents.slice(0, maxPerDay);
    const more = dayEvents.length - visibleEvents.length;
    const said = [
      label,
      dayEvents.length ? `${dayEvents.length} ${dayEvents.length === 1 ? 'evento' : 'eventos'}` : '',
      extra.shaded ? (extra.shadeLabel ?? kt('sombreado')) : '',
      notes.length ? (notes.length === 1 ? kt('1 nota') : kt('{n} notas', { n: String(notes.length) })) : '',
    ].filter(Boolean).join(', ');
    const cell = el('div', {
      class: `cal-day${inMonth ? '' : ' outside'}${isToday ? ' today' : ''}${dayEvents.length ? ' has' : ''}${extra.shaded ? ' shaded' : ''}${notes.length ? ' noted' : ''}${agenda && day === picked ? ' picked' : ''}`,
      role: 'gridcell',
      tabindex: day === focused ? '0' : '-1',
      dataset: { day },
      ...mark('day'),
      'aria-label': said,
      'aria-selected': String(day === focused),
      onclick: () => {
        if (suppressClick) { suppressClick = false; return; }
        if (selecting) { focused = day; pick(day); focusDay(day, false); return; }
        focused = day; focusDay(day); choose(day, dayEvents);
      },
      onkeydown: (e: Event) => onKey(e as KeyboardEvent, day, dayEvents),
    },
      el('span', { class: 'cal-num' }, view === 'week' ? `${weekdayLabels(locale, weekStartsOn, 'short')[(fromDayKey(day).getDay() - weekStartsOn + 7) % 7]} ${number}` : String(number)),
      notes.length ? el('span', { class: 'cal-note-mark', 'aria-hidden': 'true' }, icon('history', 10)) : null,
      el('div', { class: 'cal-events' },
        ...visibleEvents.map((event) => {
          const first = event.start === day || (fromDayKey(day).getDay() - weekStartsOn + 7) % 7 === 0;
          const layer = event.layer ? layerOf.get(event.layer) : undefined;
          const color = event.color ?? layer?.color;
          // El nombre corto solo en el primer día de cada tramo (inicio o principio de semana), no repetido cortado.
          return el('button', {
            type: 'button',
            class: `cal-event${event.start === day ? ' starts' : ''}${(event.end ?? event.start) === day ? ' ends' : ''}${layer?.style && layer.style !== 'solid' ? ` ${layer.style}` : ''}`,
            style: color ? `--event-color:${color}` : null,
            dataset: { eventId: event.id, status: event.status ?? '', abbr: event.abbr ?? '', ...(event.layer ? { layer: event.layer } : {}) },
            tabindex: '-1',
            title: event.title,
            'aria-label': `${event.title}${event.badge ? ` ${event.badge}` : ''}`,
            onclick: (e: Event) => {
              e.stopPropagation();
              if (suppressClick) { suppressClick = false; return; }
              if (selecting) { focused = day; pick(day); focusDay(day, false); return; }
              // Con panel del día, tocar una barra también elige ese día.
              if (agenda) { picked = day; focused = day; grid.querySelectorAll<HTMLElement>('.cal-day').forEach((c) => c.classList.toggle('picked', c.dataset.day === day)); paintAgenda(); }
              options.onSelectEvent?.(event, day);
            },
          }, first || view === 'week'
            ? el('span', { class: 'cal-event-text', dataset: { abbr: event.abbr ?? '' } }, event.badge ? `${event.badge} ` : '', event.title)
            : el('span', { class: 'cal-event-text', 'aria-hidden': 'true', dataset: { abbr: '' } }, ''));
        }),
        more > 0 ? el('span', { class: 'cal-more' }, `+${more}`) : null,
      ),
    );
    return cell;
  }

  function choose(day: DayKey, dayEvents: CalendarEvent[]): void {
    if (agenda) { picked = day; grid.querySelectorAll<HTMLElement>('.cal-day').forEach((c) => c.classList.toggle('picked', c.dataset.day === day)); paintAgenda(); }
    options.onSelectDay?.(day, dayEvents);
  }

  function focusDay(day: DayKey, select = true): void {
    grid.querySelectorAll<HTMLElement>('.cal-day').forEach((cell) => {
      const active = cell.dataset.day === day;
      cell.tabIndex = active ? 0 : -1;
      if (select && !selecting) cell.setAttribute('aria-selected', String(active));
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
      case 'Escape':
        if (selecting) { e.preventDefault(); cancelSelect(); }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (selecting) { pick(day); return; }
        choose(day, dayEvents);
        return;
      default:
        return;
    }
    e.preventDefault();
    focused = target;
    if (selecting?.from && !selecting.to) selecting.hover = target;
    if (target < r.from || target > r.to) {
      cursor = target;
      void load().then(() => focusDay(target!, !selecting));
    } else {
      focusDay(target, !selecting);
      if (selecting) { markRange(); paintBar(); }
    }
  }

  // --- Arrastre (ratón) y deslizar (táctil) ---------------------------------------------------------------
  // En el móvil se desliza también mientras se eligen días (estancias que cruzan de mes). `touch-action: pan-y`
  // en la rejilla (CSS) evita que Android cancele el gesto horizontal con `pointercancel`.
  let suppressClick = false;
  let drag: { start: DayKey; moved: boolean } | null = null;
  let swipe: { x: number; y: number } | null = null;
  const dayAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>('.cal-day')?.dataset.day ?? null;
  grid.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') {
      const day = dayAt(e.target);
      if (selecting && day && e.button === 0) drag = { start: day, moved: false };
    } else if (options.swipe !== false && view === 'month') swipe = { x: e.clientX, y: e.clientY };
  });
  grid.addEventListener('pointermove', (e) => {
    if (!selecting) return;
    const day = dayAt(document.elementFromPoint(e.clientX, e.clientY));
    if (!day) return;
    if (drag && day !== drag.start) {
      if (!drag.moved) { drag.moved = true; selecting.from = drag.start; selecting.to = null; }
      selecting.hover = day;
      markRange(); paintBar();
    } else if (!drag && e.pointerType === 'mouse' && selecting.from && !selecting.to && selecting.hover !== day) {
      selecting.hover = day;
      markRange();
    }
  });
  const endPointer = (e: PointerEvent) => {
    if (drag?.moved && selecting) {
      const day = dayAt(document.elementFromPoint(e.clientX, e.clientY)) ?? selecting.hover ?? drag.start;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      pick(day);
    }
    drag = null;
    if (swipe) {
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 40) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        move(dx < 0 ? 1 : -1);
      }
    }
  };
  document.addEventListener('pointerup', endPointer);
  grid.addEventListener('pointercancel', () => { drag = null; swipe = null; });

  // --- Leyenda y panel del día ------------------------------------------------------------------------------
  function paintLegend(): void {
    if (!legend) return;
    replace(legend, ...layers.map((l) => el('button', {
      type: 'button', class: 'filterchip cal-layer', 'aria-pressed': String(!hidden.has(l.id)), dataset: { layer: l.id }, ...mark('layer'),
      onclick: () => { if (hidden.has(l.id)) hidden.delete(l.id); else hidden.add(l.id); saveHidden(options.storageKey, [...hidden]); paintLegend(); paint(); },
    }, el('span', { class: `cal-swatch ${l.style ?? 'solid'}`, style: `--event-color:${l.color}`, 'aria-hidden': 'true' }), l.label)),
    options.shadeLegend ? el('span', { class: 'cal-legend-shade' }, el('span', { class: 'cal-swatch shade', 'aria-hidden': 'true' }), options.shadeLegend) : null);
  }

  function paintAgenda(): void {
    if (!agenda || !agendaOpt) return;
    const dayEvents = shown().filter((e) => covers(e, picked));
    const extra = info[picked] ?? {};
    const notes = (extra.notes ?? []).slice().sort((a, b) => (a.time ?? '') < (b.time ?? '') ? -1 : 1);
    const span = (e: CalendarEvent) => (e.end && e.end !== e.start ? `${shortDay(e.start)} – ${shortDay(e.end)}` : shortDay(e.start));
    replace(agenda,
      el('h3', { class: 'cal-agenda-title' }, capital(longDay(picked))),
      ...dayEvents.map((e) => {
        const layer = e.layer ? layerOf.get(e.layer) : undefined;
        return el('button', { type: 'button', class: 'cal-agenda-item', style: `--event-color:${e.color ?? layer?.color ?? 'var(--accent)'}`, dataset: { eventId: e.id }, onclick: () => options.onSelectEvent?.(e, picked) },
          el('span', { class: `cal-agenda-bar ${layer?.style ?? 'solid'}`, 'aria-hidden': 'true' }),
          el('span', { class: 'cal-agenda-text' }, el('strong', null, e.title), el('small', null, [layer?.label, span(e)].filter(Boolean).join(' · '))));
      }),
      extra.shaded ? el('p', { class: 'cal-agenda-item shade' }, el('span', { class: 'cal-swatch shade', 'aria-hidden': 'true' }), el('span', null, extra.shadeLabel ?? kt('Día sombreado'))) : null,
      notes.length ? el('p', { class: 'cal-agenda-label' }, kt('Notas')) : null,
      ...notes.map((n) => el('p', { class: 'cal-agenda-note', dataset: { noteId: n.id } },
        el('span', { class: 'cal-agenda-time' }, n.time ?? kt('Todo el día')),
        el('span', { class: 'cal-agenda-text' }, el('span', null, n.text), n.author ? el('small', null, n.author) : null))),
      !dayEvents.length && !extra.shaded && !notes.length ? el('p', { class: 'hint' }, kt('Nada este día.')) : null,
      agendaOpt.renderDay?.(picked, dayEvents, extra) ?? null,
    );
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
    if (selecting) { markRange(); paintBar(); }
    paintAgenda();
  }

  paintLegend();
  void load();

  return {
    element,
    setView,
    setDate(date) { cursor = date; focused = date; void load(); },
    getRange: () => ({ ...range(), view }),
    refresh: load,
    selectRange,
    cancelSelect: () => cancelSelect(),
    setLayers(ids) { hidden = new Set(layers.map((l) => l.id).filter((id) => !ids.includes(id))); saveHidden(options.storageKey, [...hidden]); paintLegend(); paint(); },
    selectDay(day) {
      picked = day; focused = day;
      const r = range();
      if (day < r.from || day > r.to) { cursor = day; void load(); } else paint();
    },
    destroy() { document.removeEventListener('pointerup', endPointer); element.remove(); },
  };
}
