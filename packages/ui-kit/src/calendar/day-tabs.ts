/**
 * Lista de días deslizable (programa de Guests, U5): una pestaña por día en una tira horizontal con desplazamiento suave,
 * el día de hoy marcado y, por defecto, seleccionado si está en la lista. Accesible como `tablist`: flechas, Inicio y Fin
 * mueven la selección; la pestaña elegida se centra al cambiar. Los nombres salen con `Intl` en el idioma del kit.
 */
import { el, replace } from '../dom.ts';
import { kitLocaleTag, kt, onKitLocaleChange } from '../i18n/i18n.ts';

export interface DayTabsOptions {
  /** Días `YYYY-MM-DD`, en orden. */
  days: readonly string[];
  /** Día elegido al empezar; por defecto hoy si está, si no el primero. */
  selected?: string;
  /** Hoy (`YYYY-MM-DD`); por defecto la fecha local. Útil para la hora de Madrid o las pruebas. */
  today?: string;
  /** Etiqueta accesible de la lista; por defecto «Días». */
  label?: string;
  /** Contador pequeño por día (actividades); `null` lo oculta. */
  count?: (day: string) => number | null | undefined;
  onSelect?: (day: string) => void;
  /** Id del panel que controlan las pestañas (`aria-controls`). */
  panelId?: string;
}

export interface DayTabs {
  element: HTMLElement;
  get(): string | null;
  select(day: string, focus?: boolean): void;
  setDays(days: readonly string[], selected?: string): void;
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const asDate = (day: string) => new Date(`${day}T12:00:00`);

export function createDayTabs(options: DayTabsOptions): DayTabs {
  let days = options.days.slice();
  const today = options.today ?? localToday();
  let current: string | null = options.selected ?? (days.includes(today) ? today : days[0] ?? null);
  const strip = el('div', { class: 'daytabs', role: 'tablist', 'aria-orientation': 'horizontal' });

  function paint(focus = false): void {
    const weekday = new Intl.DateTimeFormat(kitLocaleTag(), { weekday: 'short' });
    const month = new Intl.DateTimeFormat(kitLocaleTag(), { month: 'short' });
    const full = new Intl.DateTimeFormat(kitLocaleTag(), { weekday: 'long', day: 'numeric', month: 'long' });
    strip.setAttribute('aria-label', options.label ?? kt('Días'));
    replace(strip, ...days.map((day) => {
      const date = asDate(day);
      const on = day === current;
      const count = options.count?.(day);
      return el('button', {
        type: 'button', role: 'tab', class: `daytab${on ? ' on' : ''}${day === today ? ' today' : ''}`,
        'aria-selected': String(on), tabindex: on ? '0' : '-1', dataset: { day },
        'aria-controls': options.panelId ?? null,
        'aria-label': `${full.format(date)}${day === today ? ` · ${kt('Hoy')}` : ''}`,
        onclick: () => select(day, true),
      },
        el('span', { class: 'daytab-wd' }, day === today ? kt('Hoy') : weekday.format(date).replace('.', '')),
        el('strong', { class: 'daytab-d' }, String(date.getDate())),
        el('span', { class: 'daytab-m' }, month.format(date).replace('.', '')),
        typeof count === 'number' && count > 0 ? el('span', { class: 'daytab-count', 'aria-hidden': 'true' }, String(count)) : null);
    }));
    const selectedTab = strip.querySelector<HTMLElement>('.daytab.on');
    if (selectedTab) {
      // Centrar la elegida sin mover la página (solo la tira).
      requestAnimationFrame(() => {
        const left = selectedTab.offsetLeft - (strip.clientWidth - selectedTab.offsetWidth) / 2;
        strip.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
      });
      if (focus) selectedTab.focus({ preventScroll: true });
    }
  }

  function select(day: string, focus = false): void {
    if (!days.includes(day)) return;
    const changed = day !== current;
    current = day;
    paint(focus);
    if (changed) options.onSelect?.(day);
  }

  strip.addEventListener('keydown', (e) => {
    if (!current) return;
    const at = days.indexOf(current);
    const next = e.key === 'ArrowRight' ? days[at + 1] : e.key === 'ArrowLeft' ? days[at - 1] : e.key === 'Home' ? days[0] : e.key === 'End' ? days[days.length - 1] : undefined;
    if (next === undefined) return;
    e.preventDefault();
    select(next, true);
  });
  onKitLocaleChange(() => paint());
  paint();

  return {
    element: strip,
    get: () => current,
    select,
    setDays(next, selected) {
      days = next.slice();
      current = selected ?? (current && days.includes(current) ? current : days.includes(today) ? today : days[0] ?? null);
      paint();
    },
  };
}
