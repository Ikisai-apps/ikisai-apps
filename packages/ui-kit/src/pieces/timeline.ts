/**
 * Tu año en una línea de tiempo (MUELA-075: Booking Estancias y Guests): doce meses en horizontal, una pista por
 * persona con sus estancias como barras y, arriba, una franja con los retiros; la raya de hoy. Debajo, la misma
 * información en texto, mes a mes. Qué choca, qué es pasado y cuántas noches hay lo calcula la app y lo pasa.
 * - Se desliza en horizontal en el móvil (región enfocable, flechas nativas); en escritorio cabe entero.
 * - Cada barra es un botón (con `onClick`) o un elemento con nombre: «Ana · 3–7 nov · Hab 3 · choca con Luis».
 * - Barras y franjas miden 46 px de alto (y al menos 46 de ancho si se pueden tocar).
 * Prefijo de clases: `year-`.
 */
import { el, type Child } from '../dom.ts';
import { kitLocaleTag, kt } from '../i18n/i18n.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface TimelineItem {
  id: string;
  /** `YYYY-MM-DD`, ambos incluidos. */
  from: string;
  to: string;
  /** Nombre completo para el lector y el título («Ana · 3–7 nov · Hab 3»). */
  label: string;
  /** Texto corto dentro de la barra, si cabe. */
  short?: string;
  past?: boolean;
  /** Choca con otra: rayas y «!». */
  clash?: boolean;
  onClick?: () => void;
}

export interface TimelineLane {
  id: string;
  label: string;
  medal?: MedalOptions | null;
  /** Para colorear por tipo (`outsider`, `staff`…). */
  kind?: string;
  items: TimelineItem[];
}

export interface TimelineOptions {
  label: string;
  /** Primer día de la ventana (`YYYY-MM-DD`; se toma el día 1 de ese mes). */
  from: string;
  months?: number;
  today: string;
  lanes: TimelineLane[];
  /** Franja de arriba (retiros). */
  bands?: TimelineItem[];
  bandsLabel?: string;
  /** Resumen en texto por mes (`YYYY-MM` → «12 noches ocupadas»). */
  summary?: Record<string, string>;
  summaryLabel?: string;
  emptyText?: string;
}

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const key = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Ventana de `months` meses desde el día 1 del mes de `from`: `{ start, end }` (fin exclusivo, `YYYY-MM-DD`). */
export function timelineWindow(from: string, months = 12): { start: string; end: string } {
  const y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)) - 1;
  return { start: key(Date.UTC(y, m, 1)), end: key(Date.UTC(y, m + months, 1)) };
}

/** Posición de un tramo en la ventana, en %: `null` si no cae dentro; `cutStart`/`cutEnd` si se sale por un lado. */
export function timelineSpan(from: string, to: string, win: { start: string; end: string }): { left: number; width: number; cutStart: boolean; cutEnd: boolean } | null {
  const s = utc(win.start), e = utc(win.end), a = utc(from), b = utc(to) + DAY;
  if (b <= s || a >= e) return null;
  const total = e - s;
  const left = Math.max(a, s), right = Math.min(b, e);
  return { left: ((left - s) / total) * 100, width: ((right - left) / total) * 100, cutStart: a < s, cutEnd: b > e };
}

export function renderTimeline(options: TimelineOptions): HTMLElement {
  const win = timelineWindow(options.from, options.months ?? 12);
  const fmtMonth = new Intl.DateTimeFormat(kitLocaleTag(), { month: 'short', timeZone: 'UTC' });
  const fmtLong = new Intl.DateTimeFormat(kitLocaleTag(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const months: string[] = [];
  for (let t = utc(win.start); t < utc(win.end); t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) months.push(key(t));
  const todaySpan = timelineSpan(options.today, options.today, win);
  const now = todaySpan ? el('span', { class: 'year-today', 'aria-hidden': 'true', style: `left:${todaySpan.left}%` }) : null;

  const bar = (item: TimelineItem, cls: string): Child => {
    const sp = timelineSpan(item.from, item.to, win);
    if (!sp) return null;
    const attrs = {
      class: `${cls}${item.past ? ' year-past' : ''}${item.clash ? ' year-clash' : ''}${sp.cutStart ? ' year-cut-start' : ''}${sp.cutEnd ? ' year-cut-end' : ''}`,
      style: `left:${sp.left}%;width:${sp.width}%`, title: item.label, dataset: { id: item.id },
    };
    const inner = [el('span', { class: 'year-barlabel' }, item.short ?? ''), item.clash ? el('span', { class: 'year-bang', 'aria-hidden': 'true' }, '!') : null];
    return item.onClick
      ? el('button', { type: 'button', ...attrs, 'aria-label': item.label, onclick: () => item.onClick!() }, ...inner)
      : el('span', { ...attrs, role: 'img', 'aria-label': item.label }, ...inner);
  };

  const lane = (labelNode: Child, items: TimelineItem[], cls: string, kind?: string) => el('div', { class: `year-lane ${cls}`, dataset: kind ? { kind } : {} },
    el('div', { class: 'year-lanelabel' }, labelNode),
    el('div', { class: 'year-track' }, now ? now.cloneNode(true) : null, ...items.map((i) => bar(i, cls === 'year-bands' ? 'year-band' : 'year-bar'))));

  const first = fmtLong.format(new Date(`${win.start}T12:00:00Z`));
  const last = fmtLong.format(new Date(utc(win.end) - DAY));
  const any = options.lanes.some((l) => l.items.some((i) => timelineSpan(i.from, i.to, win)));
  return el('section', { class: 'year-box', 'aria-label': options.label },
    el('div', { class: 'year-scroll', role: 'region', tabindex: '0', 'aria-label': kt('{label}, de {from} a {to}. Se desliza en horizontal.', { label: options.label, from: first, to: last }) },
      el('div', { class: 'year-grid', style: `--year-months:${months.length}` },
        el('div', { class: 'year-lane year-monthsrow', 'aria-hidden': 'true' },
          el('div', { class: 'year-lanelabel' }),
          el('div', { class: 'year-track' }, ...months.map((m) => el('span', { class: 'year-month' }, fmtMonth.format(new Date(`${m}T12:00:00Z`)).replace('.', ''))),
            todaySpan ? el('span', { class: 'year-todaylabel', style: `left:${todaySpan.left}%` }, kt('hoy')) : null)),
        options.bands?.length ? lane(el('strong', null, options.bandsLabel ?? kt('Retiros')), options.bands, 'year-bands') : null,
        ...options.lanes.map((l) => lane([l.medal ? renderMedal({ size: 28, name: l.label, ...l.medal }) : null, el('span', null, l.label)], l.items, 'year-person', l.kind)))),
    any ? null : el('p', { class: 'hint year-empty' }, options.emptyText ?? kt('Nada en estos meses.')),
    options.summary ? el('ul', { class: 'year-summary', 'aria-label': options.summaryLabel ?? kt('Mes a mes') },
      ...months.filter((m) => options.summary![m.slice(0, 7)]).map((m) => {
        const name = fmtLong.format(new Date(`${m}T12:00:00Z`));
        return el('li', null, el('strong', null, name.charAt(0).toLocaleUpperCase() + name.slice(1)), ': ', options.summary![m.slice(0, 7)]!);
      })) : null);
}
