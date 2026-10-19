/**
 * Piezas de Cocina y Preparación (tanda 27; MUELA-035 y 068 §1–2): la fila de paso, el selector de días, las cifras de
 * color y la hoja «Cambiar hora o día». Las dos pantallas usan las mismas, con la capa pura `_domain/food/kitchen.ts`.
 * Clases propias con el prefijo `fd-`; las de siempre (`.preprow`, `.preptime`, `.preptext`, `.bigcheck`) se conservan.
 */
import type { RowOperation } from '@ikisai/sync-client';
import { nextResponsible, shiftTime, type PreparationItem, type PrepStats } from '@ikisai/domain-food';
import { el, initialsOf, openSheet, renderMedal, renderStats, type Sheet } from '@ikisai/ui-kit';
import { T, type Mirror } from '../app/client.ts';
import { longDay, shortTime } from '../app/events.ts';

export type PrepRow = Mirror<PreparationItem>;

export interface StepRowOptions {
  writable: boolean;
  /** «para la cena de las 20:30». */
  purpose?: string | null;
  /** Nombre del plato, para el medallón (iniciales si no hay foto). */
  dish?: string | null;
  image?: string | null;
  flag?: 'siguiente' | 'atrasado' | null;
  /** Los nombres de responsable del plan, en orden, para el círculo. */
  names: string[];
  onDone(step: PrepRow, done: boolean): void;
  onEdit(step: PrepRow): void;
  onMove(step: PrepRow): void;
  onResponsible(step: PrepRow, name: string | null): void;
}

/** La fila de paso: casilla, hora con «Propuesta / Paso propio», medallón, texto, para qué servicio, aviso y responsable. */
export function stepRow(step: PrepRow, options: StepRowOptions): HTMLElement {
  const { writable } = options;
  const done = el('input', { 'data-feedback-id': 'food.menu.preparacion.fila.hecho', 'data-feedback-label': 'Hecho', type: 'checkbox', class: 'bigcheck', checked: step.done, disabled: !writable,
    'aria-label': `Hecho: ${step.text}`, onchange: () => options.onDone(step, done.checked) });
  const time = shortTime(step.scheduled_time) || '—';
  const who = step.responsible?.trim() || null;
  const nextName = nextResponsible(who, options.names);
  const circle = el('button', { 'data-feedback-id': 'food.menu.preparacion.fila.responsable', 'data-feedback-label': 'Responsable', class: 'fd-who', type: 'button', disabled: !writable || (!who && !options.names.length),
    'data-empty': String(!who),
    'aria-label': who ? `Responsable: ${who}.${writable ? ` Cambiar a ${nextName ?? 'nadie'}` : ''}` : `Sin responsable.${writable && nextName ? ` Asignar a ${nextName}` : ''}`,
    onclick: () => options.onResponsible(step, nextName) }, who ? initialsOf(who) : '+');
  return el('div', { 'data-feedback-id': 'food.menu.preparacion.fila', 'data-feedback-label': 'Paso', class: 'preprow fd-step', 'data-id': step.id, 'data-done': String(step.done), 'data-pending': String(step._pending === true), 'data-flag': options.flag ?? '' },
    el('label', { class: 'fd-check' }, done),
    el('span', { class: 'fd-when' },
      writable
        ? el('button', { 'data-feedback-id': 'food.menu.preparacion.fila.hora', 'data-feedback-label': 'Cambiar hora o día', class: 'preptime fd-time', type: 'button', 'aria-label': `Cambiar hora o día: ${step.text}`, onclick: () => options.onMove(step) }, time)
        : el('span', { class: 'preptime' }, time),
      el('span', { class: 'fd-kind' }, step.manual ? 'Paso propio' : 'Propuesta')),
    renderMedal({ name: options.dish ?? step.text, image: options.image ?? null, size: 44 }),
    el('button', { 'data-feedback-id': 'food.menu.preparacion.fila.editar', 'data-feedback-label': 'Editar paso', class: 'preptext', type: 'button', disabled: !writable, 'aria-label': `Editar: ${step.text}`, onclick: () => options.onEdit(step) },
      el('strong', null, step.text),
      options.purpose ? el('span', { class: 'fd-purpose' }, options.purpose) : null,
      options.flag ? el('span', { class: `fd-flag fd-flag-${options.flag}` }, options.flag === 'siguiente' ? 'Siguiente' : 'Atrasado') : null,
      el('span', { class: 'recipemeta', 'data-feedback-ignore': '' }, [who, step._pending ? 'pendiente de sincronizar' : null].filter(Boolean).join(' · '))),
    circle,
  );
}

/** «para la cena de las 20:30» / «para la comida». */
export function purposeText(serviceLabel: string | null, time: string | null): string | null {
  if (!serviceLabel) return null;
  return `para la ${serviceLabel.toLowerCase()}${time ? ` de las ${shortTime(time)}` : ''}`;
}

export interface DayChoice {
  /** `YYYY-MM-DD`, o `''` para «Sin día». */
  key: string;
  label: string;
  /** «3/12 · 1 atrasado». */
  sub?: string | null;
  alert?: boolean;
}

/** Botones de día arriba («Hoy · 3/12 · 1 atrasado»): uno pulsado; se pasa con las flechas. */
export function daySelector(days: DayChoice[], current: string, onPick: (key: string) => void, feedbackId = 'food.menu.preparacion.dias.selector'): HTMLElement {
  const buttons = days.map((d) => el('button', { type: 'button', class: 'fd-day', 'data-day': d.key, 'aria-pressed': String(d.key === current), 'data-alert': String(!!d.alert),
    onclick: () => onPick(d.key),
    onkeydown: (event: Event) => {
      const e = event as KeyboardEvent;
      const at = days.findIndex((x) => x.key === d.key);
      const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : -1;
      if (to >= 0 && to < days.length) { e.preventDefault(); onPick(days[to]!.key); requestAnimationFrame(() => (document.querySelector(`.fd-day[data-day="${days[to]!.key}"]`) as HTMLElement | null)?.focus()); }
    } },
    el('span', { class: 'fd-day-name' }, d.label), d.sub ? el('span', { class: 'fd-day-sub' }, d.sub) : null));
  return el('div', { 'data-feedback-id': feedbackId, 'data-feedback-label': 'Días', class: 'fd-days', role: 'group', 'aria-label': 'Día' }, ...buttons);
}

const SHORT_WEEKDAY = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });

/** «Hoy», «Mañana» o «Sáb 18». */
export function dayChoiceLabel(day: string, today: string): string {
  if (day === today) return 'Hoy';
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (day === tomorrow) return 'Mañana';
  const text = SHORT_WEEKDAY.format(new Date(`${day}T00:00:00Z`)).replace(/[.,]/g, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Cifras de color: pendientes · atrasados · % hecho («atrasado», en color de alerta y con su palabra). */
export function prepStatsView(stats: PrepStats, label: string, feedbackId: string): HTMLElement {
  const view = renderStats([
    { value: stats.pending, label: stats.pending === 1 ? 'pendiente' : 'pendientes' },
    { value: stats.overdue, label: stats.overdue === 1 ? 'atrasado' : 'atrasados', tone: stats.overdue ? 'alert' : null },
    { value: `${stats.pct} %`, label: 'hecho', tone: stats.total && stats.pct === 100 ? 'ok' : null },
  ], { label });
  view.setAttribute('data-feedback-id', feedbackId);
  view.setAttribute('data-feedback-label', label);
  return view;
}

/**
 * «Cambiar hora o día» de un toque: ±30 y ±60 minutos y los días del plan. Si es una propuesta, avisa de que pasa a ser
 * un paso propio (no se recalcula al regenerar).
 */
export function openMoveSheet(step: PrepRow, days: string[], commit: (operations: RowOperation[]) => Promise<boolean>): Sheet {
  let time = shortTime(step.scheduled_time) || null;
  let day = step.scheduled_date;
  const timeText = el('strong', { class: 'fd-move-time', 'aria-live': 'polite' });
  const paint = () => { timeText.textContent = time ?? 'Sin hora'; for (const b of dayButtons) b.setAttribute('aria-pressed', String(b.dataset.day === (day ?? ''))); };
  const shift = (minutes: number) => el('button', { type: 'button', class: 'ghost fd-shift', onclick: () => { time = shiftTime(time, minutes); paint(); } }, `${minutes > 0 ? '+' : '−'}${Math.abs(minutes)} min`);
  const dayButtons = [...days, ''].map((d) => el('button', { type: 'button', class: 'fd-day', 'data-day': d, 'aria-pressed': 'false', onclick: () => { day = d || null; paint(); } },
    el('span', { class: 'fd-day-name' }, d ? longDay(d) : 'Sin día')));
  let sheet: Sheet | null = null;
  const save = async () => {
    const fields: Record<string, unknown> = {};
    if ((time ?? null) !== (shortTime(step.scheduled_time) || null)) fields.scheduled_time = time;
    if ((day ?? null) !== (step.scheduled_date ?? null)) fields.scheduled_date = day;
    if (!Object.keys(fields).length) { await sheet?.close(true); return; }
    if (!step.manual) fields.manual = true;
    if (await commit([{ op: 'update', table: T.preparation, id: step.id, expectedRevision: step.revision, fields }])) await sheet?.close(true);
  };
  sheet = openSheet({
    title: 'Cambiar hora o día',
    meta: step.manual ? step.text : `${step.text} · es una propuesta: al moverla pasa a ser un paso propio y no se recalcula al regenerar.`,
    body: el('div', { 'data-feedback-id': 'food.menu.preparacion.mover', 'data-feedback-label': 'Cambiar hora o día', class: 'fd-move' },
      el('p', { class: 'fd-move-row' }, el('span', null, 'Hora: '), timeText),
      el('div', { class: 'btnrow' }, shift(-60), shift(-30), shift(30), shift(60)),
      el('p', { class: 'fd-move-row' }, 'Día'),
      el('div', { class: 'fd-days', role: 'group', 'aria-label': 'Día' }, ...dayButtons)),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'),
      el('button', { 'data-feedback-id': 'food.menu.preparacion.mover.guardar', 'data-feedback-label': 'Guardar', class: 'primary', type: 'button', id: 'saveMove', onclick: () => void save() }, 'Guardar')],
  });
  paint();
  return sheet;
}
