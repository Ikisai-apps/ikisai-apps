/**
 * Bloque «Fechas posibles» de la ficha (Fase 2 de los portales): «Ikisai fija y el organizador propone». El personal crea,
 * ordena, edita y borra las opciones de Ikisai, ve las que propone el organizador (solo lectura) y puede fijar cualquiera
 * de ellas como fecha definitiva de la reserva en un solo `update`.
 */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, createSortableList, el, icon, positionBetween, renumber, type Sortable } from '@ikisai/ui-kit';
import { DATE_OPTIONS, RESERVATIONS, dateRange } from '../app/client.ts';
import { openRowSheet, type FieldSpec } from './form.ts';

type Row = SyncedRow & Record<string, any>;

export const DATE_OPTION_SPECS: FieldSpec[] = [
  { key: 'start_date', label: 'Inicio', type: 'date' },
  { key: 'end_date', label: 'Fin', type: 'date' },
  { key: 'arrival_time', label: 'Hora de llegada aproximada', type: 'time', hint: 'Opcional.' },
  { key: 'departure_time', label: 'Hora de salida aproximada', type: 'time', hint: 'Opcional.' },
];

/** Regla de la pantalla (la Edge la repite): hay inicio y fin, y el fin es posterior. */
export function checkDateRange(merged: Record<string, unknown>): string | null {
  const from = typeof merged.start_date === 'string' ? merged.start_date : '';
  const to = typeof merged.end_date === 'string' ? merged.end_date : '';
  if (!from || !to) return 'Indica el inicio y el fin.';
  return to > from ? null : 'El fin debe ser posterior al inicio.';
}

export interface DatesBlockOptions {
  client: SyncClient;
  reservation: Row;
  /** Opciones vivas de la reserva (de Ikisai y del organizador). */
  options: Row[];
  editable: boolean;
  run: (operations: RowOperation[], message: string) => Promise<boolean>;
}

export interface DatesBlock {
  render(options: DatesBlockOptions): HTMLElement;
  destroy(): void;
}

const range = (row: Row): string => dateRange({ start_date: row.start_date ?? null, end_date: row.end_date ?? null });
const hhmm =(value: unknown): string | null => (typeof value === 'string' && value ? value.slice(0, 5) : null);
const sig = (rows: Row[]) => rows.map((r) => `${r.id}:${r.revision}:${r.start_date}:${r.end_date}:${r.arrival_time}:${r.departure_time}:${r.organizer_ok}:${r._pending === true}`).join('|');
const byOrder = (a: Row, b: Row) => Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);

export function createDatesBlock(): DatesBlock {
  let current: DatesBlockOptions | null = null;
  let expanded = false;
  let sortable: Sortable<Row> | null = null;
  let listSig = '';
  let card: HTMLElement | null = null;

  const times = (row: Row): string | null => {
    const parts = [hhmm(row.arrival_time) ? `llegada ${hhmm(row.arrival_time)}` : null, hhmm(row.departure_time) ? `salida ${hhmm(row.departure_time)}` : null].filter(Boolean);
    return parts.length ? `${parts.join(' · ')} (aprox.)` : null;
  };

  async function fix(row: Row): Promise<void> {
    const o = current!;
    const go = await confirmDialog({
      title: 'Fijar esta fecha',
      text: `La reserva pasa a tener fecha definitiva (${range(row)}). El organizador la verá fija y no podrá proponer otras.`,
      confirmLabel: 'Fijar fecha',
    });
    if (!go) return;
    await o.run([{ op: 'update', table: RESERVATIONS, id: o.reservation.id, expectedRevision: o.reservation.revision,
      fields: { start_date: row.start_date, end_date: row.end_date, dates_definitive: true } }], 'Fecha fijada como definitiva.');
  }

  const fixButton = (row: Row, group: string): HTMLElement => el('button', { class: 'ghost small', type: 'button', 'aria-label': `Fijar la fecha ${range(row)}`,
    'data-feedback-id': `booking.reserva.fechas.${group}.fijar`, 'data-feedback-label': 'Fijar esta fecha', onclick: () => void fix(row) }, 'Fijar esta fecha');

  function ikisaiItem(row: Row): HTMLElement {
    const o = current!;
    return el('div', { class: 'date-option', dataset: { pending: String(row._pending === true) }, 'data-feedback-id': 'booking.reserva.fechas.opcion', 'data-feedback-label': 'Fecha posible' },
      el('div', { class: 'date-main' }, el('strong', null, range(row)),
        row.organizer_ok === true ? el('span', { class: 'chip ok', 'data-feedback-id': 'booking.reserva.fechas.opcion.organizador', 'data-feedback-label': 'Le viene bien al organizador' }, 'Le viene bien al organizador') : null),
      times(row) ? el('div', { class: 'hint' }, times(row)) : null,
      o.editable ? el('div', { class: 'date-actions' }, fixButton(row, 'opcion'),
        el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar la fecha ${range(row)}`, 'data-feedback-id': 'booking.reserva.fechas.opcion.editar', 'data-feedback-label': 'Editar fecha posible', onclick: () => openRowSheet({
          client: o.client, title: 'Fecha posible', table: DATE_OPTIONS, row, specs: DATE_OPTION_SPECS, check: checkDateRange, savedMessage: 'Fecha guardada.',
          feedbackId: 'booking.reserva.fechas.hoja', feedbackLabel: 'Editar fecha posible',
          remove: { label: 'Quitar', operations: () => [{ op: 'delete', table: DATE_OPTIONS, id: row.id, expectedRevision: row.revision }], confirmDialog: { title: 'Quitar fecha posible', text: `Se quita la opción ${range(row)}.`, confirmLabel: 'Quitar' } },
        }) }, icon('edit', 16))) : null);
  }

  // Reordenar: un solo `update` del ítem movido con `position` entre sus vecinos; solo si no cabe, se renumera la lista en un lote.
  async function reorder(ordered: Row[], moved: Row, to: number): Promise<void> {
    const o = current!;
    const prev = ordered[to - 1], next = ordered[to + 1];
    const a = prev ? Number(prev.position) : null, b = next ? Number(next.position) : null;
    const position = positionBetween(a, b);
    const fits = Number.isFinite(position) && (a === null || position > a) && (b === null || position < b);
    if (fits) {
      await o.run([{ op: 'update', table: DATE_OPTIONS, id: moved.id, expectedRevision: moved.revision, fields: { position } }], 'Orden de las fechas guardado.');
      return;
    }
    const positions = renumber(ordered.length);
    await o.run(ordered.map((row, i): RowOperation => ({ op: 'update', table: DATE_OPTIONS, id: row.id, expectedRevision: row.revision, fields: { position: positions[i]! } })), 'Orden de las fechas guardado.');
  }

  function ikisaiList(rows: Row[], editable: boolean): HTMLElement {
    if (!editable) return el('ul', { class: 'date-list', 'data-feedback-id': 'booking.reserva.fechas.lista', 'data-feedback-label': 'Fechas de Ikisai' }, rows.map((row) => el('li', null, ikisaiItem(row))));
    if (!sortable) {
      sortable = createSortableList<Row>({
        items: rows, key: (item) => item.id, name: (item) => range(item), label: 'Fechas posibles de Ikisai',
        render: (item) => ikisaiItem(item), rowClass: 'checklist-row',
        onReorder: (ordered, move) => reorder(ordered, move.item, move.to),
      });
      sortable.element.setAttribute('data-feedback-id', 'booking.reserva.fechas.lista');
      sortable.element.setAttribute('data-feedback-label', 'Fechas de Ikisai');
      listSig = sig(rows);
    } else if (listSig !== sig(rows)) {
      listSig = sig(rows);
      sortable.setItems(rows);
    }
    return sortable.element;
  }

  function render(options: DatesBlockOptions): HTMLElement {
    current = options;
    const { reservation, editable } = options;
    const definitive = reservation.dates_definitive === true;
    const live = options.options.filter((r) => r.deleted_at === null);
    const ikisai = live.filter((r) => r.proposed_by !== 'organizer').sort(byOrder);
    const organizer = live.filter((r) => r.proposed_by === 'organizer').sort(byOrder);
    // Sin opciones la lista no existe: se descarta para que la siguiente se cree con las filas nuevas.
    if (ikisai.length === 0) { sortable?.destroy(); sortable = null; listSig = ''; }

    const next = el('article', { class: 'card', id: 'blockDates', 'data-feedback-id': 'booking.reserva.fechas', 'data-feedback-label': 'Fechas posibles' }, el('div', { class: 'cardhead' }, el('h3', null, 'Fechas posibles')));
    const toggle = (open: boolean) => () => { expanded = open; if (current && card) { const old = card; old.replaceWith(render(current)); } };
    card = next;
    if (definitive && !expanded) {
      next.append(el('p', { class: 'hint' }, 'La fecha es definitiva: el organizador la ve fija y no puede proponer otras.'),
        el('button', { class: 'linkbtn', type: 'button', id: 'showDateOptions', 'data-feedback-id': 'booking.reserva.fechas.ver', 'data-feedback-label': 'Ver fechas posibles', onclick: toggle(true) }, 'Ver fechas posibles'));
      return next;
    }
    const insertFields = () => ({ reservation_id: reservation.id, proposed_by: 'ikisai', position: live.reduce((max, r) => Math.max(max, Number(r.position) || 0), 0) + 1 });
    const parts: Array<Node | null> = [
      ikisai.length === 0 ? el('p', { class: 'hint', id: 'dateOptionsEmpty' }, 'Todavía no hay fechas posibles. Añade las que Ikisai puede ofrecer.') : ikisaiList(ikisai, editable),
      editable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'addDateOption', 'data-feedback-id': 'booking.reserva.fechas.anadir', 'data-feedback-label': 'Añadir fecha posible', onclick: () => openRowSheet({
        client: options.client, title: 'Nueva fecha posible', table: DATE_OPTIONS, row: null, specs: DATE_OPTION_SPECS, check: checkDateRange, savedMessage: 'Fecha añadida.',
        feedbackId: 'booking.reserva.fechas.nueva', feedbackLabel: 'Nueva fecha posible', insertFields: insertFields() }) }, 'Añadir fecha posible')) : null,
      el('div', { class: 'sectionlabel' }, 'Propuestas por el organizador', el('span', { class: 'count' }, String(organizer.length))),
      organizer.length === 0 ? el('p', { class: 'hint' }, 'El organizador no ha propuesto ninguna fecha.')
        : el('ul', { class: 'date-list', id: 'organizerDates', 'data-feedback-id': 'booking.reserva.fechas.organizador', 'data-feedback-label': 'Propuestas del organizador' }, organizer.map((row) => el('li', null,
          el('div', { class: 'date-option', 'data-feedback-id': 'booking.reserva.fechas.organizador.fila', 'data-feedback-label': 'Propuesta del organizador' },
            el('div', { class: 'date-main' }, el('strong', null, range(row))),
            times(row) ? el('div', { class: 'hint' }, times(row)) : null,
            editable ? el('div', { class: 'date-actions' }, fixButton(row, 'organizador')) : null)))),
      definitive ? el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'booking.reserva.fechas.ocultar', 'data-feedback-label': 'Ocultar fechas posibles', onclick: toggle(false) }, 'Ocultar fechas posibles') : null,
    ];
    next.append(...parts.filter((part): part is Node => part !== null));
    return next;
  }

  return { render, destroy: () => { sortable?.destroy(); sortable = null; current = null; card = null; } };
}
