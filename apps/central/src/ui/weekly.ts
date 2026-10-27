/**
 * Central · Revisión semanal de Dirección (C01, migración 1521; decisiones de VG del 27-10). Una por semana ISO, con un paso
 * cada vez: lo que está en crítico o en atención (con la nota de la semana anterior), las notas y quién estuvo, y cerrar,
 * que guarda la foto de esos indicadores. La preparan el owner y los editores con el ámbito de Dirección; los demás la
 * leen (la foto, editor y owner: puede llevar importes). Van por `commands`; cerrar necesita el panel, así que pide red.
 * Acciones (1523; VG, vg-41): cada punto puede terminar en una decisión (se elige una de Decisiones) o en una tarea de Tasks
 * (la pide la Edge, kind `central.weekly_action`). La revisión siguiente enseña cómo van las de la anterior.
 */
import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  DECISION_STATUS_LABELS, canPrepareReview, formatKpi, formatPeriod, formatWeek, isoWeek, madridToday, previousNote, validateOperations, weeklySnapshot, type WeeklyKpi,
} from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { APP_NAMES } from './dashboard.ts';
import type { ViewMount } from './shell.ts';

type Review = { id: string; revision: number; code?: string | null; week: string; held_on?: string | null; attendee_ids?: string[] | null; summary?: string | null; status: string; deleted_at?: string | null };
type Item = { id: string; review_id: string; app: string; kpi: string; label: string; period: string; value: number | null; unit: string; target: number | null; state: string; note?: string | null; deleted_at?: string | null };
type Action = { id: string; review_id: string; kpi: string; label: string; kind: 'decision' | 'task'; decision_id?: string | null; task_target_id?: string | null; task_label?: string | null; deleted_at?: string | null };
type Decision = { id: string; name: string; status: string; code?: string | null; deleted_at?: string | null };
type TaskStatus = { id: string; title?: string; done?: boolean; deleted?: boolean; pending?: boolean; visible?: boolean };
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
    const [reviews, items, people, actions, decisions] = await Promise.all([client.list(T.weeklyReviews), client.list(T.weeklyItems), client.list(T.people), client.list(T.weeklyActions), client.list(T.decisions)]);
    return {
      actions: (actions as unknown as Action[]).filter((a) => !a.deleted_at),
      decisions: (decisions as unknown as Decision[]).filter((d) => !d.deleted_at),
      reviews: (reviews as unknown as Review[]).filter((r) => !r.deleted_at).sort((a, b) => b.week.localeCompare(a.week)),
      items: (items as unknown as Item[]).filter((i) => !i.deleted_at),
      people: (people as unknown as Person[]).filter((p) => !p.deleted_at && p.active !== false && !p.merged_into),
    };
  }

  // Cada llamada lleva su id de uso literal (el catálogo de la publicación solo recoge literales: kit 0.18.2).
  const send = {
    empezar: (ops: RowOperation[]) => usage.run('central.semana.empezar', () => client.commit(ops)),
    guardar: (ops: RowOperation[]) => usage.run('central.semana.guardar', () => client.commit(ops)),
    cerrar: (ops: RowOperation[]) => usage.run('central.semana.cerrar', () => client.commit(ops)),
    decision: (ops: RowOperation[]) => usage.run('central.semana.enlazar_decision', () => client.commit(ops)),
  };
  async function commit(operations: RowOperation[], done: string, how: keyof typeof send): Promise<boolean> {
    const issue = validateOperations(operations, membership);
    if (issue) { toast(issue.message); return false; }
    try {
      await send[how](operations);
      toast(done);
      await paint();
      return true;
    } catch (e) { toast(describeError(e)); return false; }
  }

  async function paint(): Promise<void> {
    const { reviews, items, people, actions, decisions } = await data();
    if (!alive) return;
    ctxActions = actions; ctxDecisions = decisions;
    const mine = reviews.find((r) => r.week === week) ?? null;
    paintCurrent(mine, reviews, items, people);
    paintHistory(reviews.filter((r) => r.status === 'cerrada'), items, people);
  }

  let ctxActions: Action[] = [];
  let ctxDecisions: Decision[] = [];
  let taskStates = new Map<string, TaskStatus>();
  const decisionName = (id: string | null | undefined) => ctxDecisions.find((d) => d.id === id) ?? null;

  /** Cómo va una acción: la decisión con su estado; la tarea con lo que devuelve Tasks. */
  function actionLine(a: Action): HTMLElement {
    if (a.kind === 'decision') {
      const d = decisionName(a.decision_id);
      return el('li', { class: 'small', 'data-action': a.id }, icon('list', 14), ` Decisión: ${d ? `${d.name} (${DECISION_STATUS_LABELS[d.status as keyof typeof DECISION_STATUS_LABELS] ?? d.status})` : 'una que no ves'}`);
    }
    const t = a.task_target_id ? taskStates.get(a.task_target_id) : undefined;
    const state = !t ? '' : t.deleted ? ' · borrada en Tasks' : t.done ? ' · hecha' : t.pending ? ' · por clasificar en Tasks' : ' · abierta';
    return el('li', { class: 'small', 'data-action': a.id }, icon('check', 14), ` Tarea: ${a.task_label ?? 'en Tasks'}${state}`);
  }

  async function loadTaskStates(list: Action[]): Promise<void> {
    const ids = list.filter((a) => a.kind === 'task' && a.task_target_id).map((a) => a.task_target_id!);
    if (!ids.length || !navigator.onLine) return;
    try {
      const out = await client.api<{ items: TaskStatus[] }>('/requirements/tasks-status', { method: 'POST', json: { ids } });
      taskStates = new Map(out.items.map((t) => [t.id, t]));
    } catch { /* sin estado: se enseña la acción sin él */ }
  }

  function linkDecision(review: Review, i: WeeklyKpi): void {
    let sheet: Sheet | null = null;
    const live = ctxDecisions.filter((d) => d.status === 'vigente').sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const select = el('select', { id: 'weeklyDecision', 'data-field-id': 'central.semana.decision' }, el('option', { value: '' }, 'Elige una decisión'),
      ...live.map((d) => el('option', { value: d.id }, d.code ? `${d.code} · ${d.name}` : d.name))) as HTMLSelectElement;
    const save = el('button', { class: 'primary', type: 'button', id: 'weeklyDecisionSave', 'data-feedback-id': 'central.semana.decision.guardar', 'data-feedback-label': 'Enlazar la decisión', onclick: async () => {
      if (!select.value) { toast('Elige una decisión.'); return; }
      if (await commit([{ op: 'insert', table: T.weeklyActions, id: crypto.randomUUID(), fields: { review_id: review.id, kpi: i.kpi, label: i.label.slice(0, 80), kind: 'decision', decision_id: select.value } }], 'Decisión enlazada.', 'decision')) await sheet?.close(true);
    } }, 'Enlazar');
    sheet = openSheet({ title: 'Enlazar una decisión', meta: i.label,
      body: el('div', { 'data-feedback-id': 'central.semana.decision', 'data-feedback-label': 'Enlazar una decisión' },
        el('label', { class: 'field' }, el('span', null, 'Decisión vigente'), select),
        el('p', { class: 'muted small' }, 'Si aún no existe, créala en ', el('a', { href: '#/decisiones', 'data-feedback-id': 'central.semana.decision.ir', 'data-feedback-label': 'Ir a Decisiones' }, 'Decisiones'), ' y vuelve.')),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.semana.decision.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save], initialFocus: select });
  }

  function askTask(review: Review, i: WeeklyKpi): void {
    let sheet: Sheet | null = null;
    const title = el('input', { id: 'weeklyTaskTitle', 'data-field-id': 'central.semana.task_title', maxlength: 500, value: `${formatWeek(review.week)}: ${i.label}` }) as HTMLInputElement;
    const due = el('input', { id: 'weeklyTaskDue', 'data-field-id': 'central.semana.task_due', type: 'date' }) as HTMLInputElement;
    const note = el('textarea', { id: 'weeklyTaskNote', 'data-field-id': 'central.semana.task_note', maxlength: 2000, rows: 3 }, notes.get(i.kpi) ?? '') as HTMLTextAreaElement;
    const error = el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.semana.tarea.error', 'data-feedback-label': 'Error de la tarea' });
    const requestId = crypto.randomUUID();
    const save = el('button', { class: 'primary', type: 'button', id: 'weeklyTaskSave', 'data-feedback-id': 'central.semana.tarea.pedir', 'data-feedback-label': 'Pedir la tarea', onclick: async () => {
      if (!title.value.trim()) { error.textContent = 'Pon un título.'; return; }
      try {
        await usage.run('central.semana.pedir_tarea', () => client.api(`/weekly/${review.id}/task`, { method: 'POST', json: { requestId, code: review.code, kpi: i.kpi, label: i.label, title: title.value.trim(), note: note.value.trim(), due: due.value || null } }));
        toast('Tarea pedida a Tasks.');
        await client.sync().catch(() => undefined);
        await sheet?.close(true);
        await paint();
      } catch (e) { error.textContent = describeError(e); }
    } }, 'Pedir la tarea');
    sheet = openSheet({ title: 'Pedir una tarea a Tasks', meta: i.label,
      body: el('div', { 'data-feedback-id': 'central.semana.tarea', 'data-feedback-label': 'Pedir una tarea' },
        el('label', { class: 'field' }, el('span', null, 'Título'), title),
        el('label', { class: 'field' }, el('span', null, 'Para cuándo (opcional)'), due),
        el('label', { class: 'field' }, el('span', null, 'Nota'), note),
        error),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.semana.tarea.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save], initialFocus: title });
  }

  function paintCurrent(review: Review | null, reviews: Review[], items: Item[], people: Person[]): void {
    const head = el('div', { class: 'blockhead' }, el('h3', null, formatWeek(week)), review?.code ? el('span', { class: 'muted small', 'data-feedback-ignore': '' }, review.code) : null);
    if (!review) {
      replace(current, head, prepares
        ? el('div', null, el('p', { class: 'hint' }, 'Aún no se ha empezado la revisión de esta semana.'),
          el('button', { class: 'primary', type: 'button', id: 'weeklyStart', 'data-feedback-id': 'central.semana.empezar', 'data-feedback-label': 'Empezar la revisión', onclick: () => void commit([{ op: 'insert', table: T.weeklyReviews, id: crypto.randomUUID(), fields: { week } }], 'Revisión empezada.', 'empezar') }, 'Empezar la de esta semana'))
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
    const save = prepares ? el('button', { class: 'ghost', type: 'button', id: 'weeklySave', 'data-feedback-id': 'central.semana.guardar', 'data-feedback-label': 'Guardar notas', onclick: () => void commit([{ op: 'update', table: T.weeklyReviews, id: review.id, expectedRevision: Number(review.revision), fields: { summary: summary.value.trim() || null, attendee_ids: picked() } }], 'Notas guardadas.', 'guardar') }, 'Guardar') : null;
    const close = prepares ? el('button', { class: 'primary', type: 'button', id: 'weeklyClose', 'data-feedback-id': 'central.semana.cerrar', 'data-feedback-label': 'Cerrar la revisión', onclick: () => void doClose(review, summary.value, picked()) }, 'Cerrar la revisión') : null;
    const previous = reviews.find((r) => r.status === 'cerrada' && r.week < review.week) ?? null;
    const before = previous ? ctxActions.filter((a) => a.review_id === previous.id) : [];
    const pastBox = el('div', { id: 'weeklyPastActions', 'data-feedback-id': 'central.semana.acciones_anteriores', 'data-feedback-label': 'Acciones de la semana pasada' });
    if (before.length) void loadTaskStates(before).then(() => { if (alive) replace(pastBox, el('h4', { class: 'sectionlabel' }, `Cómo van las acciones de la ${formatWeek(previous!.week).toLowerCase()}`), el('ul', { class: 'list' }, ...before.map(actionLine))); });
    replace(current, head, pastBox,
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
  const mineActions = (review: Review, kpi: string) => ctxActions.filter((a) => a.review_id === review.id && a.kpi === kpi);
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
            note,
            mineActions(review, i.kpi).length ? el('ul', { class: 'ctl-weeklyactions' }, ...mineActions(review, i.kpi).map(actionLine)) : null,
            prepares ? el('div', { class: 'toolbar' },
              el('button', { class: 'ghost small', type: 'button', 'aria-label': `Enlazar una decisión: ${i.label}`, 'data-feedback-id': 'central.semana.enlazar_decision', 'data-feedback-label': 'Enlazar una decisión', onclick: () => linkDecision(review, i) }, 'Decisión'),
              el('button', { class: 'ghost small', type: 'button', 'aria-label': `Pedir una tarea: ${i.label}`, 'data-feedback-id': 'central.semana.pedir_tarea', 'data-feedback-label': 'Pedir una tarea', onclick: () => askTask(review, i) }, 'Tarea en Tasks')) : null));
      })) : el('p', { class: 'hint', id: 'weeklyNothingRed' }, 'Esta semana no hay indicadores en atención; puedes anotar igual.'));
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
    if (await commit(operations, 'Revisión cerrada.', 'cerrar')) notes.clear();
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
              i.note ? el('div', { class: 'small' }, i.note) : null,
              ...ctxActions.filter((a) => a.review_id === r.id && a.kpi === i.kpi).map(actionLine))))) : null));
    })) : el('p', { class: 'hint' }, 'Aún no hay revisiones cerradas.'));
  }

  void paint();
  return () => { alive = false; };
};
