/**
 * Central · Revisión semanal de Dirección (C01, migración 1521; decisiones de VG del 27-10). Una por semana ISO, con un paso
 * cada vez: lo que está en crítico o en atención (con la nota de la semana anterior), las notas y quién estuvo, y cerrar,
 * que guarda la foto de esos indicadores. La preparan el owner y los editores con el ámbito de Dirección; los demás la
 * leen (la foto, editor y owner: puede llevar importes). Van por `commands`; cerrar necesita el panel, así que pide red.
 */
import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, icon, replace, toast } from '@ikisai/ui-kit';
import {
  canPrepareReview, formatKpi, formatPeriod, formatWeek, isoWeek, madridToday, previousNote, validateOperations, weeklySnapshot, type WeeklyKpi,
} from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { APP_NAMES } from './dashboard.ts';
import type { ViewMount } from './shell.ts';

type Review = { id: string; revision: number; code?: string | null; week: string; held_on?: string | null; attendee_ids?: string[] | null; summary?: string | null; status: string; deleted_at?: string | null };
type Item = { id: string; review_id: string; app: string; kpi: string; label: string; period: string; value: number | null; unit: string; target: number | null; state: string; note?: string | null; deleted_at?: string | null };
type Person = { id: string; display_name: string; active?: boolean; house_level?: string | null; deleted_at?: string | null; merged_into?: string | null };

const STATE_LABELS: Record<string, string> = { critico: 'Crítico', atencion: 'Atención' };

export const mountWeekly: ViewMount = ({ main, client, usage }) => {
  let alive = true;
  const membership = client.bootstrap()?.membership ?? { role: 'reader' };
  const prepares = canPrepareReview(membership);
  const week = isoWeek(madridToday());
  const notes = new Map<string, string>();
  const current = el('section', { id: 'weeklyCurrent', 'data-feedback-id': 'central.semana.actual', 'data-feedback-label': 'Revisión de esta semana' });
  const history = el('section', { id: 'weeklyHistory', 'data-feedback-id': 'central.semana.anteriores', 'data-feedback-label': 'Revisiones anteriores' });
  replace(main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.semana.cabecera', 'data-feedback-label': 'Cabecera de la revisión semanal' },
      el('div', null, el('h2', null, 'Revisión semanal'), el('p', null, 'Lo que Dirección ve cada semana y lo que decide.'))),
    current, history);

  async function data() {
    const [reviews, items, people] = await Promise.all([client.list(T.weeklyReviews), client.list(T.weeklyItems), client.list(T.people)]);
    return {
      reviews: (reviews as unknown as Review[]).filter((r) => !r.deleted_at).sort((a, b) => b.week.localeCompare(a.week)),
      items: (items as unknown as Item[]).filter((i) => !i.deleted_at),
      people: (people as unknown as Person[]).filter((p) => !p.deleted_at && p.active !== false && !p.merged_into),
    };
  }

  async function commit(operations: RowOperation[], done: string, op: 'central.semana.empezar' | 'central.semana.guardar' | 'central.semana.cerrar'): Promise<boolean> {
    const issue = validateOperations(operations, membership);
    if (issue) { toast(issue.message); return false; }
    try {
      await usage.run(op, () => client.commit(operations));
      toast(done);
      await paint();
      return true;
    } catch (e) { toast(describeError(e)); return false; }
  }

  async function paint(): Promise<void> {
    const { reviews, items, people } = await data();
    if (!alive) return;
    const mine = reviews.find((r) => r.week === week) ?? null;
    paintCurrent(mine, reviews, items, people);
    paintHistory(reviews.filter((r) => r.status === 'cerrada'), items, people);
  }

  function paintCurrent(review: Review | null, reviews: Review[], items: Item[], people: Person[]): void {
    const head = el('div', { class: 'blockhead' }, el('h3', null, formatWeek(week)), review?.code ? el('span', { class: 'muted small', 'data-feedback-ignore': '' }, review.code) : null);
    if (!review) {
      replace(current, head, prepares
        ? el('div', null, el('p', { class: 'hint' }, 'Aún no se ha empezado la revisión de esta semana.'),
          el('button', { class: 'primary', type: 'button', id: 'weeklyStart', 'data-feedback-id': 'central.semana.empezar', 'data-feedback-label': 'Empezar la revisión', onclick: () => void commit([{ op: 'insert', table: T.weeklyReviews, id: crypto.randomUUID(), fields: { week } }], 'Revisión empezada.', 'central.semana.empezar') }, 'Empezar la de esta semana'))
        : el('p', { class: 'hint' }, 'Aún no se ha empezado la revisión de esta semana. La preparan quien administra Central y quien tiene el ámbito de Dirección.'));
      return;
    }
    if (review.status === 'cerrada') {
      replace(current, head, el('p', { class: 'hint', id: 'weeklyClosedNote' }, icon('check', 16), ` Cerrada${review.held_on ? ` el ${review.held_on}` : ''}. Está abajo, con las anteriores.`));
      return;
    }
    const red = el('div', { id: 'weeklyRed', 'data-feedback-id': 'central.semana.rojo', 'data-feedback-label': 'Lo que está en rojo' }, el('p', { class: 'muted' }, 'Leyendo el panel…'));
    const summary = el('textarea', { id: 'weeklySummary', 'data-field-id': 'central.semana.summary', maxlength: 1000, rows: 4, disabled: !prepares }, review.summary ?? '') as HTMLTextAreaElement;
    const direction = people.filter((p) => p.house_level === 'direccion');
    const chosen = new Set(review.attendee_ids ?? []);
    const attendees = el('div', { class: 'chips', id: 'weeklyAttendees', role: 'group', 'aria-label': 'Quién estuvo', 'data-feedback-id': 'central.semana.asistentes', 'data-feedback-label': 'Quién estuvo' },
      ...(direction.length ? direction : people).slice(0, 40).map((p) => {
        const box = el('input', { type: 'checkbox', value: p.id, checked: chosen.has(p.id), disabled: !prepares }) as HTMLInputElement;
        return el('label', { class: 'check' }, box, el('span', null, p.display_name));
      }));
    const picked = () => [...attendees.querySelectorAll<HTMLInputElement>('input:checked')].map((b) => b.value);
    const save = prepares ? el('button', { class: 'ghost', type: 'button', id: 'weeklySave', 'data-feedback-id': 'central.semana.guardar', 'data-feedback-label': 'Guardar notas', onclick: () => void commit([{ op: 'update', table: T.weeklyReviews, id: review.id, expectedRevision: Number(review.revision), fields: { summary: summary.value.trim() || null, attendee_ids: picked() } }], 'Notas guardadas.', 'central.semana.guardar') }, 'Guardar') : null;
    const close = prepares ? el('button', { class: 'primary', type: 'button', id: 'weeklyClose', 'data-feedback-id': 'central.semana.cerrar', 'data-feedback-label': 'Cerrar la revisión', onclick: () => void doClose(review, summary.value, picked()) }, 'Cerrar la revisión') : null;
    replace(current, head,
      el('h4', { class: 'sectionlabel' }, 'Paso 1 · Lo que está en crítico o en atención'), red,
      el('h4', { class: 'sectionlabel' }, 'Paso 2 · Notas y quién estuvo'),
      el('label', { class: 'field', 'data-feedback-id': 'central.semana.resumen', 'data-feedback-label': 'Resumen de la semana' }, el('span', null, 'Resumen'), summary),
      attendees,
      el('h4', { class: 'sectionlabel' }, 'Paso 3 · Cerrar'),
      el('p', { class: 'muted small' }, 'Al cerrar se guarda la foto de los indicadores en crítico o en atención, con sus notas. Después ya no cambia.'),
      el('div', { class: 'toolbar' }, save, close));
    void paintRed(red, review, reviews, items);
  }

  let lastRed: WeeklyKpi[] = [];
  async function paintRed(host: HTMLElement, review: Review, reviews: Review[], items: Item[]): Promise<void> {
    try {
      const d = await client.api<{ items: WeeklyKpi[] }>('/dashboard');
      if (!alive) return;
      lastRed = weeklySnapshot(d.items);
      replace(host, lastRed.length ? el('ul', { class: 'list' }, ...lastRed.map((i) => {
        const before = previousNote(reviews, items, review.week, i.kpi);
        const note = el('textarea', { rows: 2, maxlength: 300, 'aria-label': `Nota: ${i.label}`, disabled: !prepares, 'data-kpi': i.kpi }, notes.get(i.kpi) ?? '') as HTMLTextAreaElement;
        note.addEventListener('input', () => notes.set(i.kpi, note.value));
        return el('li', { class: `agentrow ${i.state === 'critico' ? 'alert' : 'warn'}`, 'data-kpi': i.kpi },
          el('div', null,
            el('strong', null, i.label), el('span', { class: 'muted small' }, ` · ${APP_NAMES[i.app] ?? i.app} · ${formatPeriod(i.period)}`), ' ',
            el('span', { class: `chip ${i.state === 'critico' ? 'alert' : 'warn'}` }, STATE_LABELS[i.state ?? ''] ?? ''),
            el('div', { class: 'small' }, `${formatKpi(i.value, i.unit)}${i.target !== null ? ` · objetivo ${formatKpi(i.target, i.unit)}` : ''}`),
            before ? el('div', { class: 'muted small' }, `La semana pasada: ${before}`) : null,
            note));
      })) : el('p', { class: 'hint' }, 'Nada en crítico ni en atención esta semana.'));
    } catch (e) {
      if (alive) replace(host, el('p', { class: 'formerror' }, navigator.onLine ? describeError(e) : 'El panel se lee con conexión. Sin él no se puede cerrar la revisión.'));
    }
  }

  async function doClose(review: Review, summary: string, attendeeIds: string[]): Promise<void> {
    if (!(await confirmDialog({ title: `¿Cerrar la revisión de la ${formatWeek(review.week).toLowerCase()}?`, text: `Se guarda la foto de ${lastRed.length} ${lastRed.length === 1 ? 'indicador' : 'indicadores'} con sus notas. Después ya no cambia.`, confirmLabel: 'Cerrar' }))) return;
    const operations: RowOperation[] = [
      { op: 'update', table: T.weeklyReviews, id: review.id, expectedRevision: Number(review.revision), fields: { summary: summary.trim() || null, attendee_ids: attendeeIds, status: 'cerrada', held_on: madridToday() } },
      ...lastRed.map((i) => ({ op: 'insert' as const, table: T.weeklyItems, id: crypto.randomUUID(), fields: {
        review_id: review.id, app: i.app, kpi: i.kpi, label: i.label.slice(0, 80), period: i.period, value: i.value, unit: i.unit, target: i.target, state: i.state, note: notes.get(i.kpi)?.trim() || null,
      } })),
    ];
    if (await commit(operations, 'Revisión cerrada.', 'central.semana.cerrar')) notes.clear();
  }

  function paintHistory(closed: Review[], items: Item[], people: Person[]): void {
    const names = new Map(people.map((p) => [p.id, p.display_name]));
    replace(history, el('h3', null, 'Anteriores'), closed.length ? el('ul', { class: 'list' }, ...closed.map((r) => {
      const mine = items.filter((i) => i.review_id === r.id);
      const who = (r.attendee_ids ?? []).map((id) => names.get(id)).filter(Boolean).join(', ');
      return el('li', { 'data-review': r.id },
        el('details', { class: 'ctl-weekly' },
          el('summary', null, el('strong', null, formatWeek(r.week)), el('span', { class: 'muted small' }, ` · ${r.held_on ?? ''}${mine.length ? ` · ${mine.length} en rojo` : ''}`)),
          r.summary ? el('p', null, r.summary) : null,
          who ? el('p', { class: 'muted small' }, `Estuvieron: ${who}`) : null,
          mine.length ? el('ul', { class: 'list' }, ...mine.map((i) => el('li', { class: `agentrow ${i.state === 'critico' ? 'alert' : 'warn'}` },
            el('div', null, el('strong', null, i.label), el('span', { class: 'muted small' }, ` · ${formatKpi(i.value === null ? null : Number(i.value), i.unit)}`),
              i.note ? el('div', { class: 'small' }, i.note) : null)))) : null));
    })) : el('p', { class: 'hint' }, 'Aún no hay revisiones cerradas.'));
  }

  void paint();
  return () => { alive = false; };
};
