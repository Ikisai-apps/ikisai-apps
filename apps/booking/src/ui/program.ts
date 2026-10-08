/**
 * Bloque «Programa» de la ficha (B16 / BG9): el programa del retiro que el organizador edita desde su portal y que ven los
 * huéspedes. El personal lo ve y lo corrige aquí con la sincronización normal.
 */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { el, formatDate, icon, type Child } from '@ikisai/ui-kit';
import { TABLES } from '@ikisai/domain-booking';
import { openRowSheet, type FieldSpec } from './form.ts';

export const PROGRAM: TableName = TABLES.programItems;

type Row = SyncedRow & Record<string, any>;

const KIND_OPTIONS = [['actividad', 'Actividad'], ['comida', 'Comida'], ['descanso', 'Descanso'], ['otro', 'Otro']] as const;

function specs(reservation: Row, spaces: Row[]): FieldSpec[] {
  return [
    { key: 'day', label: 'Día', type: 'date', dateMin: reservation.start_date ?? null, dateMax: reservation.end_date ?? null },
    { key: 'starts_at', label: 'Inicio', type: 'time', hint: 'Sin hora: «durante el día».' },
    { key: 'ends_at', label: 'Fin', type: 'time' },
    { key: 'title', label: 'Actividad', type: 'text', max: 120 },
    { key: 'kind', label: 'Tipo', type: 'select', options: KIND_OPTIONS },
    { key: 'space_id', label: 'Espacio', type: 'select', optional: true, options: spaces.map((s) => [s.id, s.public_name || s.name] as const) },
    { key: 'place_text', label: 'Otro lugar', type: 'text', max: 80, hint: 'Solo si no es un espacio de Ikisai («Excursión al pinar»).' },
    { key: 'public_note', label: 'Nota para los huéspedes', type: 'textarea', max: 500 },
    { key: 'internal_note', label: 'Nota interna', type: 'textarea', max: 2000, hint: 'La ven el personal y el organizador; nunca los huéspedes.' },
  ];
}

const hhmm = (value: unknown): string => (typeof value === 'string' && value ? value.slice(0, 5) : '');

export async function loadProgram(client: SyncClient, eventId: string): Promise<{ items: Row[]; spaces: Row[] }> {
  const items = ((await client.list(PROGRAM)) as Row[]).filter((r) => r.event_id === eventId)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)) || hhmm(a.starts_at).localeCompare(hhmm(b.starts_at)) || Number(a.position) - Number(b.position));
  const spaces = ((await client.list(TABLES.spaces as TableName)) as Row[]).filter((s) => !s.deleted_at && s.active && s.kind !== 'habitacion');
  return { items, spaces };
}

export function renderProgram(opts: {
  client: SyncClient; reservation: Row; eventId: string; data: { items: Row[]; spaces: Row[] }; editable: boolean;
  block: (id: string, title: string, body: Child) => HTMLElement;
}): HTMLElement {
  const { client, reservation, eventId, data, editable } = opts;
  const spaceName = (id: unknown) => { const s = data.spaces.find((x) => x.id === id); return s ? (s.public_name || s.name) : null; };
  const outOfRange = (day: string) => (reservation.start_date && day < reservation.start_date) || (reservation.end_date && day > reservation.end_date);
  const days = [...new Set(data.items.map((i) => String(i.day)))];
  const edit = (row: Row | null) => openRowSheet({
    client, title: row ? 'Actividad del programa' : 'Nueva actividad', table: PROGRAM, row, specs: specs(reservation, data.spaces),
    feedbackId: row ? 'booking.reserva.programa.hoja' : 'booking.reserva.programa.nueva', feedbackLabel: row ? 'Editar actividad' : 'Nueva actividad',
    savedMessage: 'Programa guardado.',
    defaults: { kind: 'actividad', day: reservation.start_date ?? null },
    insertFields: { event_id: eventId, position: data.items.length + 1 },
    remove: row ? { label: 'Quitar', operations: (): RowOperation[] => [{ op: 'delete', table: PROGRAM, id: row.id, expectedRevision: row.revision }] } : undefined,
  });
  return opts.block('blockProgram', 'Programa', [
    data.items.length === 0 ? el('p', { class: 'hint' }, 'Sin programa todavía. Lo suele preparar el organizador desde su portal.') : days.map((day) => [
      el('div', { class: 'sectionlabel' }, formatDate(day), outOfRange(day) ? el('span', { class: 'chip small warn' }, 'fuera de las fechas') : null),
      el('ul', { class: 'list', 'data-feedback-id': 'booking.reserva.programa.lista', 'data-feedback-label': 'Programa del día' }, data.items.filter((i) => String(i.day) === day).map((i) =>
        el('li', { class: 'row', dataset: { pending: String(i._pending === true) } },
          el('div', { class: 'row-title' },
            el('span', { class: 'name' }, `${hhmm(i.starts_at) ? `${hhmm(i.starts_at)}${hhmm(i.ends_at) ? `–${hhmm(i.ends_at)}` : ''} · ` : ''}${i.title}`),
            el('small', null, [spaceName(i.space_id) ?? i.place_text, i.public_note].filter(Boolean).join(' · '))),
          editable ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar ${i.title}`, 'data-feedback-id': 'booking.reserva.programa.editar', 'data-feedback-label': 'Editar actividad', onclick: () => edit(i) }, icon('edit', 16)) : null))),
    ]),
    editable ? el('button', { class: 'ghost small', type: 'button', id: 'addProgramItem', style: 'margin-top:10px', 'data-feedback-id': 'booking.reserva.programa.anadir', 'data-feedback-label': 'Añadir actividad', onclick: () => edit(null) }, 'Añadir actividad') : null,
  ]);
}
