/** Bloque «Alojamiento» de la ficha (docs/booking/API.md §15.1): asignaciones del evento a habitaciones, camas, salas y zonas. */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { el, icon, openSheet, plural, replace, toast, type Child, type Sheet } from '@ikisai/ui-kit';
import { TABLES, assignmentNights, bedConflicts, dayNumber, eventOccupancy, extraBedsInUse, isBookable, isExtraBed, validateFields } from '@ikisai/domain-booking';
import { ASSIGNMENTS, BEDS, EVENTS, RESERVATIONS, SPACES, canRead, describeError, shortDay } from '../app/client.ts';
import { guard } from '../app/guard.ts';
import { settleBatch } from '../app/settle.ts';

type Row = SyncedRow & Record<string, any>;

/** Reservas que ya no ocupan camas: canceladas, perdidas, archivadas o borradas. */
const RELEASED = ['cancelada', 'perdida'];

export interface LodgingData {
  spaces: Row[];
  beds: Row[];
  /** Asignaciones vivas de este evento. */
  assignments: Row[];
}

const byPosition = (a: Row, b: Row) => Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
const guestName = (g: Row): string => [g.first_name, g.last_name_1, g.last_name_2].filter(Boolean).join(' ');

/** Lee del espejo lo necesario para el bloque; `null` si el rol no puede leer el inventario. */
export async function loadLodging(client: SyncClient, eventId: string): Promise<LodgingData | null> {
  if (![SPACES, BEDS, ASSIGNMENTS].every((table) => canRead(client, table))) return null;
  const live = (rows: SyncedRow[]) => (rows as Row[]).filter((row) => row.deleted_at === null);
  return {
    spaces: live(await client.list(SPACES)).sort(byPosition),
    beds: live(await client.list(BEDS)).sort(byPosition),
    assignments: live(await client.list(ASSIGNMENTS)).filter((a) => a.event_id === eventId),
  };
}

/** «N personas en M espacios» si el evento tiene asignaciones. */
export function lodgingSummary(data: LodgingData | null): string | null {
  if (!data || data.assignments.length === 0) return null;
  const persons = data.assignments.reduce((sum, a) => sum + Number(a.persons), 0);
  const spaces = new Set(data.assignments.map((a) => a.space_id)).size;
  return `${plural(persons, 'persona', 'personas')} en ${plural(spaces, 'espacio', 'espacios')}`;
}

interface SheetOptions {
  client: SyncClient;
  reservation: Row;
  event: Row;
  data: LodgingData;
  guests: Row[];
  seesGuests: boolean;
  assignment: Row | null;
}

/** Asignaciones de toda la app con las fechas de su reserva (para avisar de camas ocupadas, también sin red). */
async function loadOthers(client: SyncClient): Promise<Array<{ assignment: Row; reservation: Row; title: string }>> {
  const [assignments, events, reservations] = await Promise.all([client.list(ASSIGNMENTS), client.list(EVENTS), client.list(RESERVATIONS)]) as [Row[], Row[], Row[]];
  const reservationOf = new Map(reservations.filter((r) => r.deleted_at === null && r.archived_at === null && !RELEASED.includes(r.status)).map((r) => [r.id, r]));
  const reservationByEvent = new Map(events.filter((e) => e.deleted_at === null).map((e) => [e.id, reservationOf.get(e.reservation_id)]));
  return assignments.filter((a) => a.deleted_at === null && a.bed_id !== null && reservationByEvent.get(a.event_id)).map((assignment) => {
    const reservation = reservationByEvent.get(assignment.event_id)!;
    return { assignment, reservation, title: String(reservation.title) };
  });
}

/** Hoja de alta o edición de una asignación. */
export async function openAssignmentSheet(options: SheetOptions): Promise<Sheet> {
  const { client, reservation, event, data, guests, seesGuests, assignment } = options;
  const others = await loadOthers(client);
  const spaceOptions = data.spaces.filter((s) => isBookable(s as any) || s.id === assignment?.space_id);
  const input = (attrs: Record<string, string | number | boolean>) => el('input', { autocomplete: 'off', ...attrs });

  const spaceSelect = el('select', { id: 'f-space_id' },
    assignment ? null : el('option', { value: '' }, '— Elige un espacio —'),
    spaceOptions.map((s) => el('option', { value: s.id }, `${s.name}${s.zone ? ` · ${s.zone}` : ''}`))) as HTMLSelectElement;
  const bedSelect = el('select', { id: 'f-bed_id' }) as HTMLSelectElement;
  const guestSelect = el('select', { id: 'f-guest_id' }, el('option', { value: '' }, 'Ninguno: es un grupo'),
    guests.map((g) => el('option', { value: g.id }, guestName(g)))) as HTMLSelectElement;
  const group = input({ id: 'f-group_label', type: 'text', maxlength: 120 }) as HTMLInputElement;
  const persons = input({ id: 'f-persons', type: 'number', min: 1, step: 1, inputmode: 'numeric' }) as HTMLInputElement;
  const from = input({ id: 'f-from_date', type: 'date' }) as HTMLInputElement;
  const to = input({ id: 'f-to_date', type: 'date' }) as HTMLInputElement;
  const conflict = el('p', { class: 'formerror', id: 'bedConflict', role: 'alert', hidden: true });
  const error = el('p', { class: 'formerror', role: 'alert', hidden: true });

  function fillBeds(keep: string | null): void {
    const spaceId = spaceSelect.value;
    const beds = data.beds.filter((b) => b.space_id === spaceId && (b.active || b.id === assignment?.bed_id));
    replace(bedSelect, el('option', { value: '' }, 'Sin cama concreta'), beds.map((b) => el('option', { value: b.id }, `${b.label}${isExtraBed(b as any) ? ' (supletoria)' : ''} · ${plural(Number(b.capacity), 'plaza', 'plazas')}`)));
    bedSelect.value = keep && beds.some((b) => b.id === keep) ? keep : '';
    bedSelect.disabled = beds.length === 0;
  }

  const read = () => ({
    space_id: spaceSelect.value || null,
    bed_id: bedSelect.value || null,
    guest_id: seesGuests ? guestSelect.value || null : (assignment?.guest_id ?? null),
    group_label: group.value.trim() || null,
    persons: persons.value === '' ? null : Number(persons.value),
    from_date: from.value || null,
    to_date: to.value || null,
  });

  // Valores de partida (edición) o por defecto (alta).
  spaceSelect.value = assignment?.space_id ?? '';
  fillBeds(assignment?.bed_id ?? null);
  guestSelect.value = assignment?.guest_id ?? '';
  group.value = assignment?.group_label ?? '';
  persons.value = String(assignment?.persons ?? 1);
  from.value = assignment?.from_date ?? '';
  to.value = assignment?.to_date ?? '';
  const initial = read();

  function syncGuest(): void {
    const forGuest = seesGuests && guestSelect.value !== '';
    group.disabled = forGuest;
    persons.disabled = forGuest;
    if (forGuest) { group.value = ''; persons.value = '1'; }
  }
  syncGuest();

  /** Aviso local: la cama elegida ya tiene a alguien en alguna de esas noches (reserva viva, no cancelada ni archivada). */
  function conflictMessage(): string | null {
    const values = read();
    if (!values.bed_id) return null;
    const nights = assignmentNights({ from_date: values.from_date, to_date: values.to_date }, reservation as any);
    if (!nights) return null;
    const clash = bedConflicts(values.bed_id, nights, others as any, assignment?.id)[0];
    if (!clash) return null;
    const title = others.find((o) => o.assignment.id === clash.id)?.title ?? 'otra reserva';
    return `Esa cama ya está ocupada esas noches en «${title}». Elige otra cama o cambia las fechas.`;
  }

  function refresh(): void {
    error.hidden = true;
    const message = conflictMessage();
    conflict.hidden = message === null;
    conflict.textContent = message ?? '';
    guard.dirtyEditor = JSON.stringify(read()) !== JSON.stringify(initial);
    sheet.setFootHidden(!!assignment && !guard.dirtyEditor);
  }

  const showError = (message: string): void => { error.hidden = false; error.textContent = message; };
  const save = el('button', { class: 'primary', type: 'button', id: 'saveRow', 'data-feedback-id': 'booking.reserva.alojamiento.hoja.guardar', 'data-feedback-label': 'Guardar', onclick: () => void submit() }, 'Guardar');
  let sheet: Sheet;

  async function finish(operations: RowOperation[], message: string, settle: boolean): Promise<void> {
    save.disabled = true;
    try {
      const { requestId } = await client.commit(operations);
      const rejected = settle ? await settleBatch(client, requestId) : null;
      if (rejected) return showError(describeError(rejected.error));
      guard.dirtyEditor = false;
      await sheet.close(true);
      toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
    } catch (e) {
      showError(describeError(e));
    } finally {
      save.disabled = false;
    }
  }

  async function submit(): Promise<void> {
    const values = read();
    if (!values.space_id) return showError('Elige un espacio.');
    if (!values.guest_id && !values.group_label) return showError('Indica un huésped o el nombre de un grupo.');
    if (values.guest_id) values.persons = 1;
    if (values.persons === null || !Number.isInteger(values.persons) || values.persons < 1) return showError('El número de personas debe ser 1 o más.');
    if (values.from_date && values.to_date && (dayNumber(values.to_date) ?? 0) <= (dayNumber(values.from_date) ?? 0)) return showError('La fecha de salida debe ser posterior a la de entrada.');
    const clash = conflictMessage();
    if (clash) return showError(clash);

    let fields: Record<string, unknown>;
    if (assignment) {
      fields = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== (initial as Record<string, unknown>)[key]));
      if (Object.keys(fields).length === 0) return void sheet.close(true);
    } else {
      fields = { event_id: event.id, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)) };
    }
    const issue = validateFields(TABLES.roomAssignments, fields, assignment ? 'update' : 'insert')[0];
    if (issue) return showError(issue.message);
    const operation: RowOperation = assignment
      ? { op: 'update', table: ASSIGNMENTS, id: assignment.id, expectedRevision: assignment.revision, fields }
      : { op: 'insert', table: ASSIGNMENTS, id: crypto.randomUUID(), fields };
    await finish([operation], assignment ? 'Asignación guardada.' : 'Alojamiento asignado.', true);
  }

  const field = (text: string, control: Child, key: string, hint?: string) => el('label', { class: 'field', 'data-feedback-id': `booking.reserva.alojamiento.hoja.${key}`, 'data-feedback-label': text, ...(key === 'huesped' ? { 'data-feedback-ignore': '' } : {}) }, el('span', null, text), control, hint ? el('small', { class: 'hint' }, hint) : null);
  const onEdit = () => { syncGuest(); refresh(); };
  spaceSelect.addEventListener('change', () => { fillBeds(null); refresh(); });
  for (const control of [bedSelect, from, to]) control.addEventListener('change', refresh);
  guestSelect.addEventListener('change', onEdit);
  for (const control of [group, persons, from, to]) control.addEventListener('input', refresh);

  const removeButton = assignment
    ? el('button', { class: 'danger', type: 'button', id: 'removeRow', 'data-feedback-id': 'booking.reserva.alojamiento.hoja.quitar', 'data-feedback-label': 'Quitar', onclick: () => void finish([{ op: 'delete', table: ASSIGNMENTS, id: assignment.id, expectedRevision: assignment.revision }], 'Asignación quitada.', false) }, 'Quitar')
    : null;

  sheet = openSheet({
    title: assignment ? 'Asignación de alojamiento' : 'Asignar alojamiento',
    ...(assignment ? { meta: `Revisión ${assignment.revision}` } : {}),
    body: el('form', { 'data-feedback-id': 'booking.reserva.alojamiento.hoja', 'data-feedback-label': 'Asignar alojamiento', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
      el('div', { class: 'rowform' },
        spaceOptions.length === 0 ? el('p', { class: 'hint' }, 'No hay espacios activos. Créalos en «Espacios y camas».') : null,
        field('Espacio', spaceSelect, 'espacio'), field('Cama', bedSelect, 'cama', 'Opcional. Sin cama concreta solo cuenta para la ocupación de la habitación.'),
        seesGuests ? field('Huésped', guestSelect, 'huesped', 'Para un grupo, déjalo en «Ninguno» y escribe su nombre.') : null,
        field('Nombre del grupo', group, 'grupo'), field('Personas', persons, 'personas'),
        el('div', { class: 'sectionlabel formsection' }, 'Fechas propias (opcional)'),
        field('Desde', from, 'desde', 'Si las dejas vacías, valen las de la reserva.'), field('Hasta', to, 'hasta'),
        conflict, error),
      removeButton ? el('p', { style: 'margin-top:18px' }, removeButton) : null),
    foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.reserva.alojamiento.hoja.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet.close() }, 'Cancelar')),
    footHidden: !!assignment,
    beforeClose: () => !guard.dirtyEditor || confirm('Hay cambios sin guardar. ¿Cerrar sin guardar?'),
    onClose: () => { guard.dirtyEditor = false; },
    initialFocus: spaceSelect,
  });
  refresh();
  return sheet;
}

export interface LodgingBlockOptions {
  client: SyncClient;
  reservation: Row;
  event: Row;
  data: LodgingData;
  guests: Row[];
  seesGuests: boolean;
  editable: boolean;
  navigate(hash: string): void;
}

/** Tarjeta «Alojamiento»: ocupación por espacio con aviso si se pasa, y sus asignaciones. */
export function renderLodgingBlock(o: LodgingBlockOptions): HTMLElement {
  const { data, guests } = o;
  const occupancy = eventOccupancy(o.event.id, data.spaces as any, data.beds as any, data.assignments as any);
  const spaceById = new Map(data.spaces.map((s) => [s.id, s]));
  const bedById = new Map(data.beds.map((b) => [b.id, b]));
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const sheetOptions = (assignment: Row | null): SheetOptions => ({ client: o.client, reservation: o.reservation, event: o.event, data, guests, seesGuests: o.seesGuests, assignment });

  const who = (a: Row): string => (a.guest_id ? (o.seesGuests ? guestName(guestById.get(a.guest_id) ?? {} as Row) || 'Huésped asignado' : 'Huésped asignado') : String(a.group_label ?? 'Grupo'));
  const dates = (a: Row): string | null => (a.from_date || a.to_date ? `${shortDay(a.from_date ?? o.reservation.start_date)} → ${shortDay(a.to_date ?? o.reservation.end_date)}` : null);

  const extras = extraBedsInUse(o.event.id, data.beds as any, data.assignments as any).length;
  const sections = occupancy.sort((a, b) => Number(spaceById.get(a.spaceId)?.position) - Number(spaceById.get(b.spaceId)?.position)).map((occ) => {
    const space = spaceById.get(occ.spaceId)!;
    const own = data.assignments.filter((a) => a.space_id === space.id);
    return el('section', { class: 'lodging-space', dataset: { space: space.name, over: String(occ.over) }, 'data-feedback-id': 'booking.reserva.alojamiento.espacio', 'data-feedback-label': 'Espacio' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, space.name),
        el('span', { class: `chip${occ.over ? ' alert' : ''}`, dataset: { role: 'occupancy' } }, `${occ.persons} / ${occ.capacity} plazas`),
        occ.over ? el('span', { class: 'chip alert', role: 'status' }, 'Sobreocupada') : null),
      occ.over ? el('p', { class: 'hint lodging-over' }, `Hay más personas (${occ.persons}) que plazas (${occ.capacity}). Es un aviso: se puede guardar igualmente.`) : null,
      el('ul', { class: 'list', 'data-feedback-id': 'booking.reserva.alojamiento.asignaciones', 'data-feedback-label': 'Asignaciones' }, own.map((a) => {
        const bed = a.bed_id ? bedById.get(a.bed_id) : null;
        return el('li', { class: 'row', dataset: { pending: String(a._pending === true) }, 'data-feedback-id': 'booking.reserva.alojamiento.asignaciones.fila', 'data-feedback-label': 'Asignación' },
          el('div', { class: 'row-title' }, el('span', { class: 'name', 'data-feedback-ignore': '' }, who(a))),
          el('div', { class: 'row-meta' }, [plural(Number(a.persons), 'persona', 'personas'), bed ? `cama ${bed.label}` : null, dates(a)].filter(Boolean).join(' · ')),
          o.editable ? el('div', { class: 'row-actions' }, el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar asignación de ${who(a)} en ${space.name}`, 'data-feedback-id': 'booking.reserva.alojamiento.asignaciones.editar', 'data-feedback-label': 'Editar asignación', onclick: () => void openAssignmentSheet(sheetOptions(a)) }, icon('edit', 16))) : null);
      })));
  });

  return el('article', { class: 'card', id: 'blockLodging', 'data-feedback-id': 'booking.reserva.alojamiento', 'data-feedback-label': 'Alojamiento' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Alojamiento'),
      el('button', { class: 'linkbtn', type: 'button', id: 'openSpaces', 'data-feedback-id': 'booking.reserva.alojamiento.espacios', 'data-feedback-label': 'Espacios y camas', onclick: () => o.navigate('#/espacios') }, 'Espacios y camas')),
    sections.length === 0 ? el('p', { class: 'hint' }, 'Sin asignaciones todavía.') : sections,
    extras > 0 ? el('p', { class: 'hint', id: 'extraBeds' }, plural(extras, 'supletoria activada', 'supletorias activadas')) : null,
    o.editable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'addAssignment', 'data-feedback-id': 'booking.reserva.alojamiento.asignar', 'data-feedback-label': 'Asignar', onclick: () => void openAssignmentSheet(sheetOptions(null)) }, 'Asignar')) : null);
}
