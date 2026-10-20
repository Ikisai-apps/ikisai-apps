import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, isOverdue, isStale, localDayKey, nextStep, prepStats, preparationSources, shareOut, stepDay, stepService, validateOperations, type MenuService,
} from '@ikisai/domain-food';
import { confirmDialog, createSortableList, el, formatDate, icon, openSheet, replace, toast, type Sheet, type Sortable } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { T, describeError } from '../app/client.ts';
import { longDay, shortTime } from '../app/events.ts';
import { MENU_TABLES, loadMenuData, type MenuData } from '../app/menu-data.ts';
import type { TabContext } from './menu-shopping.ts';
import { usage } from '../app/usage.ts';
import { fb } from './feedback.ts';
import { housePeriod, periodBar, periodLabel } from './house-period.ts';
import { SERVICE_LABELS } from './events.ts';
import { onlineBinder } from './online.ts';
import { dayChoiceLabel, daySelector, openMoveSheet, prepStatsView, purposeText, stepRow, type PrepRow } from './prep-row.ts';

interface RegenerateResult { inserted: number; updated: number; deleted: number; kept: number }

/** El día elegido de cada menú, mientras dura la sesión (volver a la pestaña no lo pierde). */
const chosenDay = new Map<string, string>();

/** «3 de 4 listos», «12 pasos · Marga 7 · Tomás 5». */
const readyText = (rows: PrepRow[]) => `${rows.filter((r) => r.done).length} de ${rows.length} ${rows.length === 1 ? 'listo' : 'listos'}`;
export function shareText(rows: PrepRow[]): string {
  const people = shareOut(rows);
  return [`${rows.length} ${rows.length === 1 ? 'paso' : 'pasos'}`, ...people.map((p) => `${p.name} ${p.count}`)].join(' · ');
}

/**
 * Plan de preparación (tanda 27; MUELA-035 y 068 §2): un día cada vez, con botones arriba («Hoy · 3/12 · 1 atrasado») y
 * «Sin día (n)»; cifras de color del plan y del día; el día por servicios, con los pasos sueltos primero.
 * Propuesta por plato (con red) y, sin red, marcar hecho, responsable, mover, pasos propios y orden a mano.
 * Dentro de cada bloque los pasos van por hora hasta que alguien los ordena a mano; desde entonces manda ese orden (`position`).
 */
export function mountPreparation({ client, menuId, host, canWrite, house = false }: TabContext): () => void {
  let data: MenuData | null = null;
  let steps: PrepRow[] = [];
  let sheet: Sheet | null = null;
  let busy = false;
  // Una lista reordenable del kit por día; se conservan entre repintados y se actualizan con `setItems`.
  const dayLists = new Map<string, Sortable<PrepRow>>();
  const listSigs = new Map<string, string>();
  let shape = '';
  const top = el('div');
  const listsHost = el('div', { 'data-feedback-id': 'food.menu.preparacion.dias', 'data-feedback-label': 'Pasos por día', id: 'preparationDays' });
  const rowSig = (rows: PrepRow[]) => rows.map((r) => `${r.id}:${r.revision}:${r.position}:${r._pending ? 1 : 0}`).join(',');
  const sortSteps = (rows: PrepRow[]) => [...rows].sort((a, b) => (a.scheduled_date ?? '9999').localeCompare(b.scheduled_date ?? '9999')
    || Number(a.position) - Number(b.position) || (a.scheduled_time ?? '99').localeCompare(b.scheduled_time ?? '99') || a.created_at.localeCompare(b.created_at));
  const dropLists = () => {
    for (const list of dayLists.values()) list.destroy();
    dayLists.clear(); listSigs.clear(); shape = '';
  };

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
      const result = await usage.run('food.preparacion.generar', () => runCall<RegenerateResult>(client, FOOD_PROCEDURES.regeneratePreparation, {
        menu_id: menuId, ...(house ? { period_start: housePeriod().start, period_end: housePeriod().end } : {}) }));
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
    const text = el('textarea', { 'data-feedback-id': 'food.menu.preparacion.paso.texto', 'data-feedback-label': 'Qué hay que hacer', id: 'p-text', rows: '2', maxlength: '300' });
    text.value = step?.text ?? '';
    const date = el('input', { 'data-feedback-id': 'food.menu.preparacion.paso.dia', 'data-feedback-label': 'Día', id: 'p-date', type: 'date', value: step?.scheduled_date ?? '' });
    const time = el('input', { 'data-feedback-id': 'food.menu.preparacion.paso.hora', 'data-feedback-label': 'Hora', id: 'p-time', type: 'time', value: shortTime(step?.scheduled_time ?? null) });
    const responsible = el('input', { 'data-feedback-id': 'food.menu.preparacion.paso.responsable', 'data-feedback-label': 'Responsable', 'data-feedback-ignore': '', id: 'p-responsible', type: 'text', maxlength: '120', value: step?.responsible ?? '' });
    const error = el('p', { class: 'formerror', role: 'alert' });
    const field = (label: string, control: HTMLElement) => el('label', { class: 'field' }, el('span', null, label), control);
    const save = async () => {
      const label = text.value.trim();
      if (!label) { error.textContent = 'Escribe qué hay que hacer.'; text.focus(); return; }
      const fields = { text: label, scheduled_date: date.value || null, scheduled_time: time.value || null, responsible: responsible.value.trim() || null };
      let operations: RowOperation[];
      if (!step) {
        // Si ese día ya se ordenó a mano, el paso nuevo va al final; si no, se coloca por su hora.
        const last = Math.max(0, ...steps.filter((x) => (x.scheduled_date ?? null) === fields.scheduled_date).map((x) => Number(x.position)));
        operations = [{ op: 'insert', table: T.preparation, id: crypto.randomUUID(), fields: { menu_id: menuId, ...fields, manual: true, ...(last > 0 ? { position: last + 1 } : {}) } }];
      } else {
        const changed: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
          (key === 'scheduled_time' ? shortTime(step.scheduled_time) || null : step[key] ?? null) !== value));
        if (Object.keys(changed).length === 0) { await sheet?.close(true); return; }
        if (!step.manual && ('text' in changed || 'scheduled_date' in changed || 'scheduled_time' in changed)) changed.manual = true;
        operations = [{ op: 'update', table: T.preparation, id: step.id, expectedRevision: step.revision, fields: changed }];
      }
      const saved = await commitSafely(operations);
      usage.track('food.preparacion.guardar_paso', saved ? 'success' : 'error');
      if (saved) await sheet?.close(true);
    };
    sheet = openSheet({
      title: step ? 'Editar paso' : 'Nuevo paso',
      meta: step && !step.manual ? 'Propuesta del menú: si cambias el texto o la hora pasa a ser un paso tuyo y no se recalcula.' : undefined,
      body: el('div', { 'data-feedback-id': 'food.menu.preparacion.paso', 'data-feedback-label': 'Paso de preparación' }, field('Qué hay que hacer', text), field('Día', date), field('Hora', time), field('Responsable', responsible), error,
        step ? el('div', { class: 'zone' }, el('button', { 'data-feedback-id': 'food.menu.preparacion.paso.quitar', 'data-feedback-label': 'Quitar paso', class: 'danger', type: 'button', id: 'deleteStep', onclick: async () => {
          if (!(await confirmDialog({ title: '¿Quitar este paso?', text: step.text, confirmLabel: 'Quitar', danger: true }))) return;
          if (await commitSafely([{ op: 'delete', table: T.preparation, id: step.id, expectedRevision: step.revision }])) await sheet?.close(true);
        } }, icon('trash', 18), 'Quitar paso')) : null),
      foot: [el('button', { 'data-feedback-id': 'food.menu.preparacion.paso.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), el('button', { 'data-feedback-id': 'food.menu.preparacion.paso.guardar', 'data-feedback-label': 'Guardar paso', class: 'primary', type: 'button', id: 'saveStep', onclick: () => void save() }, 'Guardar')],
      initialFocus: text,
      onClose: () => { sheet = null; },
    });
  }

  const dayOf = (step: PrepRow) => (data ? stepDay(step, data.items, data.services) : step.scheduled_date);
  const serviceOf = (step: PrepRow): MenuService | null => (data ? stepService(step, data.items, data.services) : null);

  /** Los nombres del plan para el círculo del responsable, de más a menos pasos. */
  const names = () => shareOut(steps).map((p) => p.name);

  function rowFor(step: PrepRow, next: PrepRow | null, now: Date): HTMLElement {
    const service = serviceOf(step);
    const item = step.menu_item_id ? data?.items.find((i) => i.id === step.menu_item_id) : undefined;
    const recipe = data?.recipes.find((r) => r.id === (item?.recipe_id ?? step.recipe_id));
    const flag = isOverdue(step, dayOf(step), now) ? 'atrasado' : next?.id === step.id ? 'siguiente' : null;
    return stepRow(step, {
      writable: canWrite(),
      purpose: service ? purposeText(SERVICE_LABELS[service.service_type], service.service_time) : null,
      dish: recipe?.name ?? null,
      flag,
      names: names(),
      onDone: (row, done) => void commitSafely([{ op: 'update', table: T.preparation, id: row.id, expectedRevision: row.revision, fields: { done } }]).then((ok) => usage.track('food.preparacion.marcar_hecho', ok ? 'success' : 'error')),
      onEdit: (row) => openStep(row),
      onMove: (row) => { sheet = openMoveSheet(row, days(), commitSafely); },
      onResponsible: (row, name) => void commitSafely([{ op: 'update', table: T.preparation, id: row.id, expectedRevision: row.revision, fields: { responsible: name } }]),
    });
  }

  /** Guarda el orden de los pasos de un bloque: `position` 1, 2, 3…; solo se envían los que cambian. */
  async function reorder(ordered: PrepRow[]): Promise<void> {
    const operations = ordered
      .map((row, i): RowOperation | null => (Number(row.position) === i + 1 ? null : { op: 'update', table: T.preparation, id: row.id, expectedRevision: (row as SyncedRow).revision, fields: { position: i + 1 } }))
      .filter((op): op is RowOperation => op !== null);
    if (operations.length) await commitSafely(operations);
  }

  function blockList(key: string, label: string, rows: PrepRow[], render: (row: PrepRow) => HTMLElement): HTMLElement {
    if (!canWrite() || rows.length < 2) return el('ul', { 'data-feedback-id': 'food.menu.preparacion.lista', 'data-feedback-label': 'Pasos del servicio', class: 'preplist' }, ...rows.map((row) => el('li', null, render(row))));
    const list = createSortableList<PrepRow>({
      items: rows,
      key: (row) => row.id,
      name: (row) => row.text,
      label,
      rowClass: 'preprow-sortable',
      render,
      onReorder: (ordered) => reorder(ordered),
    });
    fb(list.element, { feedbackId: 'food.menu.preparacion.lista', feedbackLabel: 'Pasos del servicio' });
    dayLists.set(key, list);
    listSigs.set(key, rowSig(rows));
    return list.element;
  }

  /** Los días del plan, en orden (sin «Sin día»). */
  const days = () => Array.from(new Set(steps.map(dayOf).filter((d): d is string => !!d))).sort();

  /** El día que se enseña: el elegido si sigue; si no, hoy, el primero con algo pendiente o el primero. `''` = «Sin día». */
  function currentDay(): string {
    const all = days();
    const noDay = steps.some((s) => !dayOf(s));
    const chosen = chosenDay.get(menuId);
    if (chosen !== undefined && (all.includes(chosen) || (chosen === '' && noDay))) return chosen;
    const today = localDayKey(new Date());
    if (all.includes(today)) return today;
    return all.find((d) => steps.some((s) => dayOf(s) === d && !s.done)) ?? all[0] ?? '';
  }

  /** Los bloques de un día: los pasos sueltos primero y uno por servicio, por fecha y hora del servicio. */
  function blocks(rows: PrepRow[]): Array<{ key: string; title: string; rows: PrepRow[] }> {
    const loose = rows.filter((r) => !serviceOf(r));
    const byService = new Map<string, { service: MenuService; rows: PrepRow[] }>();
    for (const r of rows) {
      const service = serviceOf(r);
      if (!service) continue;
      const entry = byService.get(service.id) ?? { service, rows: [] };
      entry.rows.push(r);
      byService.set(service.id, entry);
    }
    const ordered = [...byService.values()].sort((a, b) => a.service.service_date.localeCompare(b.service.service_date)
      || (a.service.service_time ?? '99').localeCompare(b.service.service_time ?? '99') || Number(a.service.position) - Number(b.service.position));
    const out = loose.length ? [{ key: 'sueltos', title: `Pasos sueltos · ${readyText(loose)}`, rows: loose }] : [];
    for (const { service, rows: list } of ordered) {
      const when = [SERVICE_LABELS[service.service_type], shortTime(service.service_time)].filter(Boolean).join(' · ');
      const other = list.some((r) => dayOf(r) !== service.service_date) ? ` del ${longDay(service.service_date)}` : '';
      out.push({ key: service.id, title: `${when}${other} · ${readyText(list)}`, rows: list });
    }
    return out;
  }

  // Generar y regenerar necesitan red (MUELA-086): sin ella, desactivados con el motivo.
  const net = onlineBinder(client);
  const bindNet = () => host.querySelectorAll<HTMLElement>('#generatePreparation, #regeneratePreparation').forEach((b) => net.bind(b, 'Generar la propuesta necesita conexión; añadir y marcar pasos, no.'));

  function paint(): void {
    net.release();
    if (!data?.menu) { dropLists(); replace(host); return; }
    const writable = canWrite();
    const menu = data.menu;
    // En casa no hay marca de «generada» del menú entero: cuenta lo que haya en los días elegidos.
    const generated = house ? null : menu.preparation_generated_at;
    const houseHead = house ? periodBar(() => { dropLists(); void load(); }) : null;
    if (!generated && steps.length === 0) {
      dropLists();
      replace(host, houseHead, el('div', { 'data-feedback-id': 'food.menu.preparacion.vacia', 'data-feedback-label': 'Sin plan de preparación', class: 'empty', id: 'preparationEmpty' },
        el('strong', null, house ? `Todavía no hay pasos para ${periodLabel(housePeriod())}` : 'Todavía no hay plan de preparación'),
        'La propuesta pone un paso por plato a la hora del servicio menos la antelación de cada receta. Después se edita y se ordena a mano.',
        writable ? el('p', { style: 'margin-top:10px' },
          el('button', { 'data-feedback-id': 'food.menu.preparacion.generar', 'data-feedback-label': 'Generar propuesta', class: 'primary', type: 'button', id: 'generatePreparation', disabled: busy, onclick: () => void regenerate() }, 'Generar propuesta'), ' ',
          el('button', { 'data-feedback-id': 'food.menu.preparacion.anadir_paso', 'data-feedback-label': 'Añadir paso', class: 'ghost', type: 'button', id: 'addStep', onclick: () => openStep(null) }, 'Añadir paso')) : null,
        el('span', { class: 'hint' }, 'Generar necesita conexión; añadir pasos, no.')));
      bindNet();
      return;
    }
    const now = new Date();
    const today = localDayKey(now);
    const stale = !!generated && (data.pending || isStale(menu.preparation_source_revisions, preparationSources(data.graph)));
    const sorted = sortSteps(steps);
    const doneCount = sorted.filter((s) => s.done).length;
    const day = currentDay();
    const ofDay = sorted.filter((s) => (dayOf(s) ?? '') === day);
    const noDay = sorted.filter((s) => !dayOf(s));
    const next = nextStep(sorted, dayOf, now);
    const choices = days().map((d) => {
      const rows = sorted.filter((s) => dayOf(s) === d);
      const late = rows.filter((s) => isOverdue(s, d, now)).length;
      return { key: d, label: dayChoiceLabel(d, today), sub: `${rows.filter((s) => s.done).length}/${rows.length}${late ? ` · ${late} ${late === 1 ? 'atrasado' : 'atrasados'}` : ''}`, alert: late > 0 };
    });
    if (noDay.length) choices.push({ key: '', label: `Sin día (${noDay.length})`, sub: `${noDay.filter((s) => s.done).length}/${noDay.length}`, alert: false });

    replace(top, houseHead,
      stale ? el('div', { 'data-feedback-id': 'food.menu.preparacion.aviso_cambios', 'data-feedback-label': 'Aviso de cambios', class: 'banner warn notice', id: 'preparationStale', role: 'status' },
        el('div', null, el('strong', null, 'El menú ha cambiado desde que se generó la propuesta.'), ' Regenerar no toca tus pasos ni lo ya hecho.'),
        writable ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.menu.preparacion.regenerar', 'data-feedback-label': 'Regenerar propuesta', class: 'ghost', type: 'button', id: 'regeneratePreparation', disabled: busy, onclick: () => void regenerate() }, 'Regenerar propuesta')) : null) : null,
      el('div', { 'data-feedback-id': 'food.menu.preparacion.progreso', 'data-feedback-label': 'Progreso', class: 'tabhead' },
        el('div', { class: 'chips' }, el('span', { class: doneCount === sorted.length && sorted.length ? 'chip ok' : 'chip', id: 'preparationProgress' }, `${doneCount} de ${sorted.length} hechos`)),
        generated ? el('p', { class: 'muted' }, `Propuesta generada el ${formatDate(generated)}.`) : null),
      prepStatsView(prepStats(sorted, dayOf, now), house ? 'Cifras de los días elegidos' : 'Cifras del plan', 'food.menu.preparacion.cifras'),
      writable ? el('div', { 'data-feedback-id': 'food.menu.preparacion.acciones', 'data-feedback-label': 'Acciones de preparación', class: 'btnrow menuactions' },
        el('button', { 'data-feedback-id': 'food.menu.preparacion.anadir_paso', 'data-feedback-label': 'Añadir paso', class: 'ghost', type: 'button', id: 'addStep', onclick: () => openStep(null) }, icon('plus', 18), 'Añadir paso'),
        !stale ? el('button', { 'data-feedback-id': 'food.menu.preparacion.regenerar', 'data-feedback-label': 'Regenerar propuesta', class: 'linkbtn', type: 'button', id: 'regeneratePreparation', disabled: busy, onclick: () => void regenerate() }, generated || house ? 'Regenerar propuesta' : 'Generar propuesta') : null) : null,
      choices.length > 1 || noDay.length ? daySelector(choices, day, (key) => { chosenDay.set(menuId, key); paint(); }) : null,
    );
    if (top.parentElement !== host) { dropLists(); replace(host, top, listsHost); }
    bindNet();

    // Estructura (día, bloques y qué pasos hay en cada uno). Si no cambia, solo se actualizan las filas de cada lista.
    const parts = blocks(ofDay);
    const shapeNow = JSON.stringify({ writable, day, next: next?.id ?? null, blocks: parts.map((b) => [b.key, b.rows.length > 1 ? b.rows.map((r) => r.id).sort() : rowSig(b.rows)]) });
    const dayStats = prepStats(ofDay, dayOf, now);
    const statsNode = () => { const node = prepStatsView(dayStats, day ? `Cifras del ${longDay(day)}` : 'Cifras de los pasos sin día', 'food.menu.preparacion.dia.cifras'); node.classList.add('fd-daystats'); return node; };
    if (writable && shapeNow === shape) {
      // Mismas filas: se actualizan en su sitio (no se pierde el foco al marcar ni al ordenar con el teclado).
      for (const b of parts) {
        const list = dayLists.get(b.key);
        if (list && listSigs.get(b.key) !== rowSig(b.rows)) { listSigs.set(b.key, rowSig(b.rows)); list.setItems(b.rows); }
        const header = listsHost.querySelector(`.fd-block[data-block="${b.key}"] > h4`);
        if (header) header.textContent = b.title;
      }
      listsHost.querySelector('.fd-daystats')?.replaceWith(statsNode());
      const share = listsHost.querySelector('.fd-share');
      if (share) share.textContent = shareText(ofDay);
      return;
    }
    dropLists();
    shape = shapeNow;
    const render = (row: PrepRow) => rowFor(row, next, now);
    replace(listsHost, el('section', { 'data-feedback-id': 'food.menu.preparacion.dia', 'data-feedback-label': 'Día', class: 'menuday', 'data-day': day },
      el('h3', null, day ? longDay(day) : 'Sin día'),
      statsNode(),
      ofDay.length ? el('p', { class: 'fd-share', 'data-feedback-ignore': '' }, shareText(ofDay)) : el('p', { class: 'muted' }, 'Ningún paso este día.'),
      ...parts.map((b) => el('div', { 'data-feedback-id': 'food.menu.preparacion.bloque', 'data-feedback-label': 'Servicio', class: 'fd-block', 'data-block': b.key },
        el('h4', null, b.title),
        blockList(b.key, b.key === 'sueltos' ? 'Pasos sueltos' : `Pasos de ${b.title.split(' · ')[0]}`, b.rows, render)))));
  }

  async function load(): Promise<void> {
    data = await loadMenuData(client, menuId);
    steps = ((await client.list(T.preparation)) as PrepRow[]).filter((s) => s.menu_id === menuId);
    if (house && data.menu) {
      // En casa, los pasos de los días elegidos: los de un plato, por el día de su servicio; los propios, por su día.
      const { start, end } = housePeriod();
      const serviceDay = new Map(data.items.map((i) => [i.id, data!.services.find((s) => s.id === i.service_id)?.service_date ?? null]));
      steps = steps.filter((s) => {
        const day = (s.menu_item_id ? serviceDay.get(s.menu_item_id) : null) ?? s.scheduled_date;
        return !!day && day >= start && day <= end;
      });
    }
    paint();
  }

  void load();
  const offs = [...MENU_TABLES, T.preparation].map((table) => client.onTable(table, () => { if (!sheet && !busy) void load(); }));
  return () => {
    net.release();
    offs.forEach((off) => off());
    dropLists();
    void sheet?.close(true);
  };
}
