import type { RowOperation } from '@ikisai/sync-client';
import { FOOD_PROCEDURES, isStale, preparationSources, validateOperations, type PreparationItem } from '@ikisai/domain-food';
import { confirmDialog, el, formatDate, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import { longDay, shortTime } from '../app/events.ts';
import { MENU_TABLES, loadMenuData, type MenuData } from '../app/menu-data.ts';
import type { TabContext } from './menu-shopping.ts';

type PrepRow = Mirror<PreparationItem>;

interface RegenerateResult { inserted: number; updated: number; deleted: number; kept: number }

/** Plan de preparación: propuesta por plato (con red) y, sin red, marcar hecho, asignar responsable y pasos propios. */
export function mountPreparation({ client, menuId, host, canWrite }: TabContext): () => void {
  let data: MenuData | null = null;
  let steps: PrepRow[] = [];
  let sheet: Sheet | null = null;
  let busy = false;

  async function commitSafely(operations: RowOperation[]): Promise<boolean> {
    const issue = validateOperations(operations);
    if (issue) { toast(issue.message); return false; }
    try {
      await client.commit(operations);
      await load();
      return true;
    } catch (error) {
      toast(describeError(error));
      return false;
    }
  }

  async function regenerate(): Promise<void> {
    if (busy) return;
    busy = true;
    paint();
    try {
      const result = await runCall<RegenerateResult>(client, FOOD_PROCEDURES.regeneratePreparation, { menu_id: menuId });
      toast(`Propuesta lista: ${result.inserted} pasos nuevos, ${result.updated} actualizados, ${result.deleted} retirados.`);
    } catch (error) {
      toast(describeError(error));
    } finally {
      busy = false;
      await load();
    }
  }

  /** Editar o crear un paso. Reescribir el texto o el horario de una propuesta la convierte en un paso propio. */
  function openStep(step: PrepRow | null): void {
    const text = el('textarea', { id: 'p-text', rows: '2', maxlength: '300' });
    text.value = step?.text ?? '';
    const date = el('input', { id: 'p-date', type: 'date', value: step?.scheduled_date ?? '' });
    const time = el('input', { id: 'p-time', type: 'time', value: shortTime(step?.scheduled_time ?? null) });
    const responsible = el('input', { id: 'p-responsible', type: 'text', maxlength: '120', value: step?.responsible ?? '' });
    const error = el('p', { class: 'formerror', role: 'alert' });
    const field = (label: string, control: HTMLElement) => el('label', { class: 'field' }, el('span', null, label), control);
    const save = async () => {
      const label = text.value.trim();
      if (!label) { error.textContent = 'Escribe qué hay que hacer.'; text.focus(); return; }
      const fields = { text: label, scheduled_date: date.value || null, scheduled_time: time.value || null, responsible: responsible.value.trim() || null };
      let operations: RowOperation[];
      if (!step) {
        operations = [{ op: 'insert', table: T.preparation, id: crypto.randomUUID(), fields: { menu_id: menuId, ...fields, manual: true } }];
      } else {
        const changed: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
          (key === 'scheduled_time' ? shortTime(step.scheduled_time) || null : step[key] ?? null) !== value));
        if (Object.keys(changed).length === 0) { await sheet?.close(true); return; }
        if (!step.manual && ('text' in changed || 'scheduled_date' in changed || 'scheduled_time' in changed)) changed.manual = true;
        operations = [{ op: 'update', table: T.preparation, id: step.id, expectedRevision: step.revision, fields: changed }];
      }
      if (await commitSafely(operations)) await sheet?.close(true);
    };
    sheet = openSheet({
      title: step ? 'Editar paso' : 'Nuevo paso',
      meta: step && !step.manual ? 'Propuesta del menú: si cambias el texto o la hora pasa a ser un paso tuyo y no se recalcula.' : undefined,
      body: el('div', null, field('Qué hay que hacer', text), field('Día', date), field('Hora', time), field('Responsable', responsible), error,
        step ? el('div', { class: 'zone' }, el('button', { class: 'danger', type: 'button', id: 'deleteStep', onclick: async () => {
          if (!(await confirmDialog({ title: '¿Quitar este paso?', text: step.text, confirmLabel: 'Quitar', danger: true }))) return;
          if (await commitSafely([{ op: 'delete', table: T.preparation, id: step.id, expectedRevision: step.revision }])) await sheet?.close(true);
        } }, icon('trash', 18), 'Quitar paso')) : null),
      foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), el('button', { class: 'primary', type: 'button', id: 'saveStep', onclick: () => void save() }, 'Guardar')],
      initialFocus: text,
      onClose: () => { sheet = null; },
    });
  }

  function stepRow(step: PrepRow): HTMLElement {
    const writable = canWrite();
    const done = el('input', { type: 'checkbox', class: 'bigcheck', checked: step.done, disabled: !writable, 'aria-label': `Hecho: ${step.text}`,
      onchange: () => void commitSafely([{ op: 'update', table: T.preparation, id: step.id, expectedRevision: step.revision, fields: { done: done.checked } }]) });
    return el('li', { class: 'preprow', 'data-id': step.id, 'data-done': String(step.done), 'data-pending': String(step._pending === true) },
      done,
      el('span', { class: 'preptime' }, shortTime(step.scheduled_time) || '—'),
      el('button', { class: 'preptext', type: 'button', disabled: !writable, 'aria-label': `Editar: ${step.text}`, onclick: () => openStep(step) },
        el('strong', null, step.text),
        el('span', { class: 'recipemeta' }, [step.responsible, step.manual ? 'paso propio' : null, step._pending ? 'pendiente de sincronizar' : null].filter(Boolean).join(' · '))),
    );
  }

  function paint(): void {
    if (!data?.menu) { replace(host); return; }
    const writable = canWrite();
    const menu = data.menu;
    const generated = menu.preparation_generated_at;
    if (!generated && steps.length === 0) {
      replace(host, el('div', { class: 'empty', id: 'preparationEmpty' }, el('strong', null, 'Todavía no hay plan de preparación'),
        'La propuesta pone un paso por plato a la hora del servicio menos la antelación de cada receta. Después se edita a mano.',
        writable ? el('p', { style: 'margin-top:10px' },
          el('button', { class: 'primary', type: 'button', id: 'generatePreparation', disabled: busy, onclick: () => void regenerate() }, 'Generar propuesta'), ' ',
          el('button', { class: 'ghost', type: 'button', id: 'addStep', onclick: () => openStep(null) }, 'Añadir paso')) : null,
        el('span', { class: 'hint' }, 'Generar necesita conexión; añadir pasos, no.')));
      return;
    }
    const stale = !!generated && (data.pending || isStale(menu.preparation_source_revisions, preparationSources(data.graph)));
    const sorted = [...steps].sort((a, b) => (a.scheduled_date ?? '9999').localeCompare(b.scheduled_date ?? '9999')
      || (a.scheduled_time ?? '99').localeCompare(b.scheduled_time ?? '99') || Number(a.position) - Number(b.position) || a.created_at.localeCompare(b.created_at));
    const days = Array.from(new Set(sorted.map((s) => s.scheduled_date ?? '')));
    const doneCount = sorted.filter((s) => s.done).length;

    replace(host,
      stale ? el('div', { class: 'banner warn', id: 'preparationStale', role: 'status' },
        el('div', null, el('strong', null, 'El menú ha cambiado desde que se generó la propuesta.'), ' Regenerar no toca tus pasos ni lo ya hecho.'),
        writable ? el('div', { class: 'btnrow' }, el('button', { class: 'ghost', type: 'button', id: 'regeneratePreparation', disabled: busy, onclick: () => void regenerate() }, 'Regenerar propuesta')) : null) : null,
      el('div', { class: 'tabhead' },
        el('div', { class: 'chips' }, el('span', { class: doneCount === sorted.length && sorted.length ? 'chip ok' : 'chip', id: 'preparationProgress' }, `${doneCount} de ${sorted.length} hechos`)),
        generated ? el('p', { class: 'muted' }, `Propuesta generada el ${formatDate(generated)}.`) : null),
      writable ? el('div', { class: 'btnrow menuactions' },
        el('button', { class: 'ghost', type: 'button', id: 'addStep', onclick: () => openStep(null) }, icon('plus', 18), 'Añadir paso'),
        !stale ? el('button', { class: 'linkbtn', type: 'button', id: 'regeneratePreparation', disabled: busy, onclick: () => void regenerate() }, generated ? 'Regenerar propuesta' : 'Generar propuesta') : null) : null,
      ...days.map((day) => el('section', { class: 'menuday' },
        el('h3', null, day ? longDay(day) : 'Sin día'),
        el('ul', { class: 'preplist' }, ...sorted.filter((s) => (s.scheduled_date ?? '') === day).map(stepRow)))),
    );
  }

  async function load(): Promise<void> {
    data = await loadMenuData(client, menuId);
    steps = ((await client.list(T.preparation)) as PrepRow[]).filter((s) => s.menu_id === menuId);
    paint();
  }

  void load();
  const offs = [...MENU_TABLES, T.preparation].map((table) => client.onTable(table, () => { if (!sheet && !busy) void load(); }));
  return () => {
    offs.forEach((off) => off());
    void sheet?.close(true);
  };
}
