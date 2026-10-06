/** Bloque «Personal» de la ficha (docs/booking/API.md §15.3): turnos del evento y necesidades de refuerzo. Solo nombres: sin teléfono ni documento. */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { createSortableList, el, icon, plural, positionBetween, renumber, type Sortable } from '@ikisai/ui-kit';
import { shiftsWithoutActualHours, staffTotals } from '@ikisai/domain-booking';
import { NEEDS, STAFF, canRead, fullDay } from '../app/client.ts';
import { OPTIONS, label } from '../app/labels.ts';
import { openRowSheet, type FieldSpec } from './form.ts';

type Row = SyncedRow & Record<string, any>;

export interface StaffData {
  /** Turnos vivos de este evento. */
  shifts: Row[];
  /** Necesidades de refuerzo vivas de este evento. */
  needs: Row[];
}

const byPosition = (a: Row, b: Row) => Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
const byCreation = (a: Row, b: Row) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
const hoursText = (value: number | string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : `${Number(value).toLocaleString('es-ES', { maximumFractionDigits: 2 })} h`;

/** Lee del espejo lo del evento; `null` si el rol no puede leer el personal. */
export async function loadStaff(client: SyncClient, eventId: string): Promise<StaffData | null> {
  if (![STAFF, NEEDS].every((table) => canRead(client, table))) return null;
  const live = (rows: SyncedRow[]) => (rows as Row[]).filter((row) => row.deleted_at === null && row.event_id === eventId);
  return { shifts: live(await client.list(STAFF)).sort(byPosition), needs: live(await client.list(NEEDS)).sort(byCreation) };
}

/** «N turnos · X h previstas · Y h reales», o null si no hay turnos. */
export function staffSummary(data: StaffData | null): string | null {
  if (!data || data.shifts.length === 0) return null;
  const totals = staffTotals(data.shifts as any);
  return `${plural(totals.shifts, 'turno', 'turnos')} · ${hoursText(totals.planned)} previstas · ${hoursText(totals.actual)} reales`;
}

/** Aviso del cierre operativo: «N turnos sin horas reales», o null si no falta ninguno. */
export function missingHoursWarning(data: StaffData | null): string | null {
  const missing = data ? shiftsWithoutActualHours(data.shifts as any).length : 0;
  return missing === 0 ? null : plural(missing, 'turno sin horas reales', 'turnos sin horas reales');
}

const del = (table: TableName, row: Row): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });

export interface StaffBlockOptions {
  client: SyncClient;
  reservation: Row;
  event: Row;
  data: StaffData;
  editable: boolean;
  /** Para ejecutar un lote con aviso (el de la ficha). */
  run(operations: RowOperation[], message: string): Promise<boolean>;
}

export interface StaffBlock {
  render(options: StaffBlockOptions): HTMLElement;
  destroy(): void;
}

const NO_DAY = '';

/**
 * Controlador del bloque. Las listas de turnos se conservan entre repintados (como las del checklist): así cada movimiento
 * lleva las revisiones al día y el asa con el foco no se pierde.
 */
export function createStaffBlock(): StaffBlock {
  const lists = new Map<string, { sortable: Sortable<Row>; sig: string }>();
  let current: StaffBlockOptions | null = null;
  const sig = (rows: Row[]) => rows.map((r) => `${r.id}:${r.revision}:${r.status}:${r.person_name}:${r.function}:${r.planned_hours}:${r.actual_hours}:${r._pending === true}`).join('|');

  function shiftSpecs(o: StaffBlockOptions): FieldSpec[] {
    return [
      { key: 'person_name', label: 'Persona', type: 'text', max: 120, hint: 'Solo el nombre: sin teléfono ni documento' },
      { key: 'function', label: 'Función', type: 'select', options: OPTIONS.staffFunction },
      { key: 'work_date', label: 'Día', type: 'date', hint: 'Opcional. Sin día, el turno vale para todo el evento.', dateMin: o.reservation.start_date, dateMax: o.reservation.end_date },
      { key: 'planned_hours', label: 'Horas previstas', type: 'number', decimal: true },
      { key: 'actual_hours', label: 'Horas reales', type: 'number', decimal: true },
      { key: 'status', label: 'Estado', type: 'select', options: OPTIONS.staffStatus },
      { key: 'notes', label: 'Notas', type: 'textarea' },
    ];
  }

  /** Reglas de pantalla: el día dentro de las fechas de la reserva y los turnos de un día no pasan de 24 horas. */
  const shiftCheck = (o: StaffBlockOptions, original: Row | null) => (merged: Record<string, unknown>): string | null => {
    if (typeof merged.person_name !== 'string' || !merged.person_name.trim()) return 'Escribe el nombre de la persona.';
    const day = merged.work_date as string | null;
    const { start_date: start, end_date: end } = o.reservation;
    if (day && day !== original?.work_date && ((start && day < start) || (end && day > end))) return 'El día debe estar dentro de las fechas de la reserva.';
    for (const [key, name] of [['planned_hours', 'previstas'], ['actual_hours', 'reales']] as const) {
      const value = merged[key];
      if (typeof value === 'number' && day && value > 24) return `Las horas ${name} de un día no pueden pasar de 24.`;
    }
    return null;
  };

  const openShift = (o: StaffBlockOptions, shift: Row | null): void => {
    const position = o.data.shifts.reduce((max, s) => Math.max(max, Number(s.position)), 0) + 1;
    openRowSheet({
      client: o.client, title: shift ? 'Editar turno' : 'Nuevo turno', table: STAFF, row: shift, specs: shiftSpecs(o),
      defaults: { function: 'apoyo_logistico', status: 'prevista' }, insertFields: { event_id: o.event.id, position },
      check: shiftCheck(o, shift), savedMessage: shift ? 'Turno guardado.' : 'Turno anotado.',
      remove: shift ? { label: 'Quitar turno', operations: () => [del(STAFF, shift)], confirmDialog: { title: 'Quitar turno', text: `Se quita el turno de ${shift.person_name}. Se puede restaurar desde la papelera de la reserva.`, confirmLabel: 'Quitar' } } : undefined,
    });
  };

  const openNeed = (o: StaffBlockOptions, need: Row | null): void => {
    openRowSheet({
      client: o.client, title: need ? 'Editar refuerzo' : 'Nuevo refuerzo', table: NEEDS, row: need,
      specs: [
        { key: 'need_type', label: 'Tipo', type: 'select', options: OPTIONS.needType },
        { key: 'persons', label: 'Personas', type: 'number' },
        { key: 'priority', label: 'Prioridad', type: 'select', options: OPTIONS.needPriority },
        { key: 'status', label: 'Estado', type: 'select', options: OPTIONS.needStatus },
        { key: 'notes', label: 'Notas', type: 'textarea' },
      ],
      defaults: { need_type: 'cocina', persons: 1, priority: 'media', status: 'detectado' }, insertFields: { event_id: o.event.id },
      savedMessage: need ? 'Refuerzo guardado.' : 'Refuerzo anotado.',
      remove: need ? { label: 'Quitar refuerzo', operations: () => [del(NEEDS, need)], confirmDialog: { title: 'Quitar refuerzo', text: 'Se quita esta necesidad de refuerzo. Se puede restaurar desde la papelera de la reserva.', confirmLabel: 'Quitar' } } : undefined,
    });
  };

  const shiftItem = (shift: Row): HTMLElement => {
    const o = current!;
    const name = String(shift.person_name);
    return el('div', { class: 'staff-item', dataset: { status: shift.status, pending: String(shift._pending === true) } },
      el('div', { class: 'staff-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, name),
          el('span', { class: `chip${shift.status === 'cancelada' ? ' muted' : ''}`, dataset: { role: 'status' } }, label(shift.status))),
        el('div', { class: 'row-meta' }, `${label(shift.function)} · Previstas ${hoursText(shift.planned_hours)} / reales ${hoursText(shift.actual_hours)}`)),
      o.editable ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar turno de ${name}`, onclick: () => openShift(current!, shift) }, icon('edit', 16)) : null);
  };

  /** Un solo `update` del turno movido con `position` entre sus vecinos de la lista; solo si no cabe, se renumera la lista entera. */
  async function reorder(ordered: Row[], moved: Row, to: number): Promise<void> {
    const o = current!;
    const prev = ordered[to - 1], next = ordered[to + 1];
    const a = prev ? Number(prev.position) : null, b = next ? Number(next.position) : null;
    const position = positionBetween(a, b);
    const fits = Number.isFinite(position) && (a === null || position > a) && (b === null || position < b);
    if (fits) {
      await o.run([{ op: 'update', table: STAFF, id: moved.id, expectedRevision: moved.revision, fields: { position } }], 'Orden de los turnos guardado.');
      return;
    }
    const positions = renumber(ordered.length);
    await o.run(ordered.map((row, i): RowOperation => ({ op: 'update', table: STAFF, id: row.id, expectedRevision: row.revision, fields: { position: positions[i]! } })), 'Orden de los turnos guardado.');
  }

  function shiftList(key: string, items: Row[], title: string): HTMLElement {
    const o = current!;
    if (!o.editable) return el('ul', { class: 'staff-list' }, items.map((item) => el('li', null, shiftItem(item))));
    const kept = lists.get(key);
    if (kept) {
      const next = sig(items);
      if (kept.sig !== next) { kept.sig = next; kept.sortable.setItems(items); }
      return kept.sortable.element;
    }
    const sortable = createSortableList<Row>({
      items, key: (item) => item.id, name: (item) => String(item.person_name), label: `Turnos de ${title}`,
      render: (item) => shiftItem(item), rowClass: 'staff-row',
      onReorder: (ordered, move) => reorder(ordered, move.item, move.to),
    });
    sortable.element.querySelector('ul')?.classList.add('staff-list');
    lists.set(key, { sortable, sig: sig(items) });
    return sortable.element;
  }

  function needRow(o: StaffBlockOptions, need: Row): HTMLElement {
    const hot = need.priority === 'urgente' || need.priority === 'alta';
    const covered = need.status === 'cubierto';
    return el('li', { class: 'row', dataset: { pending: String(need._pending === true), status: need.status, priority: need.priority } },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, `${label(need.need_type)} · ${plural(Number(need.persons), 'persona', 'personas')}`),
        el('span', { class: `chip${hot && !covered ? ' alert' : ''}`, dataset: { role: 'priority' } }, label(need.priority)),
        el('span', { class: `chip${covered ? ' ok' : ''}`, dataset: { role: 'status' } }, label(need.status))),
      need.notes ? el('div', { class: 'row-meta' }, need.notes) : null,
      o.editable ? el('div', { class: 'row-actions' },
        covered ? null : el('button', { class: 'ghost small', type: 'button', dataset: { action: 'cover' }, 'aria-label': `Marcar cubierto el refuerzo de ${label(need.need_type)}`,
          onclick: () => void o.run([{ op: 'update', table: NEEDS, id: need.id, expectedRevision: need.revision, fields: { status: 'cubierto' } }], 'Refuerzo cubierto.') }, 'Cubierto'),
        el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar refuerzo de ${label(need.need_type)}`, onclick: () => openNeed(o, need) }, icon('edit', 16))) : null);
  }

  return {
    render(o) {
      current = o;
      // Grupos por día: primero «Todo el evento», luego las fechas en orden.
      const days = [...new Set(o.data.shifts.map((s) => (s.work_date as string | null) ?? NO_DAY))].sort((a, b) => (a === NO_DAY ? -1 : b === NO_DAY ? 1 : a.localeCompare(b)));
      for (const [key, kept] of lists) if (!days.includes(key)) { kept.sortable.destroy(); lists.delete(key); }
      const summary = staffSummary(o.data);
      return el('article', { class: 'card', id: 'blockStaff' },
        el('div', { class: 'cardhead' }, el('h3', null, 'Personal')),
        o.data.shifts.length === 0 ? el('p', { class: 'hint' }, 'Sin turnos todavía.') : [
          el('p', { id: 'staffTotals', class: 'staff-totals' }, summary),
          days.map((day) => {
            const title = day === NO_DAY ? 'Todo el evento' : fullDay(day);
            const items = o.data.shifts.filter((s) => ((s.work_date as string | null) ?? NO_DAY) === day);
            return el('section', { class: 'staff-day', dataset: { day: day === NO_DAY ? 'all' : day } }, el('div', { class: 'sectionlabel' }, title, el('span', { class: 'count' }, String(items.length))), shiftList(day, items, title));
          }),
        ],
        o.editable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'addShift', onclick: () => openShift(current!, null) }, 'Anotar turno')) : null,
        el('div', { class: 'sectionlabel', style: 'margin-top:18px' }, 'Refuerzos', el('span', { class: 'count' }, String(o.data.needs.length))),
        o.data.needs.length === 0 ? el('p', { class: 'hint' }, 'Sin necesidades de refuerzo.') : el('ul', { class: 'list', id: 'needList' }, o.data.needs.map((need) => needRow(o, need))),
        o.editable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'addNeed', onclick: () => openNeed(current!, null) }, 'Anotar refuerzo')) : null);
    },
    destroy() { lists.forEach(({ sortable }) => sortable.destroy()); lists.clear(); },
  };
}
