/**
 * Food · rango de días de la compra y la preparación del menú de casa (O3b; docs/food/API.md §2.6). Se elige al generar:
 * por defecto, esta semana (lunes a domingo). El rango elegido se conserva al pasar de Compra a Preparación.
 */
import { PERIOD_MAX_DAYS, weekDays, type Period } from '@ikisai/domain-food';
import { el, toast } from '@ikisai/ui-kit';
import { todayKey } from '../app/events.ts';

let current: Period | null = null;

const week = (offset: number): Period => { const days = weekDays(todayKey(), offset); return { start: days[0]!, end: days[6]! }; };

export function housePeriod(): Period {
  current ??= week(0);
  return current;
}

export function setHousePeriod(period: Period): void {
  current = period;
}

/** «13 oct – 19 oct». */
export function periodLabel(period: Period): string {
  const short = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replace('.', '');
  return `${short(period.start)} – ${short(period.end)}`;
}

export const samePeriod = (a: Period, b: { period_start?: string | null; period_end?: string | null }) => a.start === b.period_start && a.end === b.period_end;

/** Barra «Del … al …» con «Esta semana» y «La que viene». `onChange` repinta la pestaña. */
export function periodBar(onChange: () => void): HTMLElement {
  const period = housePeriod();
  const set = (next: Period) => { setHousePeriod(next); onChange(); };
  const from = el('input', { 'data-field-none': '', 'data-feedback-id': 'food.menu.casa.rango.desde', 'data-feedback-label': 'Desde', id: 'periodStart', type: 'date', class: 'compact', value: period.start, 'aria-label': 'Desde' });
  const to = el('input', { 'data-field-none': '', 'data-feedback-id': 'food.menu.casa.rango.hasta', 'data-feedback-label': 'Hasta', id: 'periodEnd', type: 'date', class: 'compact', value: period.end, 'aria-label': 'Hasta' });
  const apply = () => {
    const next = { start: from.value, end: to.value };
    if (!next.start || !next.end) return;
    const days = (Date.parse(next.end) - Date.parse(next.start)) / 86400000 + 1;
    if (days < 1) { toast('El último día no puede ser anterior al primero.'); from.value = period.start; to.value = period.end; return; }
    if (days > PERIOD_MAX_DAYS) { toast(`Como mucho ${PERIOD_MAX_DAYS} días.`); from.value = period.start; to.value = period.end; return; }
    set(next);
  };
  from.addEventListener('change', apply);
  to.addEventListener('change', apply);
  const quick = (label: string, offset: number, id: string, feedbackId: string) => {
    const target = week(offset);
    return el('button', { 'data-feedback-id': feedbackId, 'data-feedback-label': label, class: samePeriod(target, { period_start: period.start, period_end: period.end }) ? 'chip ok' : 'chip', type: 'button', id, onclick: () => set(target) }, label);
  };
  return el('div', { 'data-feedback-id': 'food.menu.casa.rango', 'data-feedback-label': 'Días', class: 'periodbar', id: 'periodBar' },
    el('label', null, el('span', null, 'Del'), from),
    el('label', null, el('span', null, 'al'), to),
    el('div', { class: 'chips' },
      quick('Esta semana', 0, 'periodThisWeek', 'food.menu.casa.rango.esta_semana'),
      quick('La que viene', 1, 'periodNextWeek', 'food.menu.casa.rango.siguiente')));
}
