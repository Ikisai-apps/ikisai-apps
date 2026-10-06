import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, icon, listRow, openSheet, plural, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  EVENT_TYPES, TABLES, canHoldStatus, dayNumber, missingForConfirmation, nights, validateFields,
  type ReservationStatus,
} from '@ikisai/domain-booking';
import { guard } from '../app/guard.ts';
import {
  EVENT_TYPE_LABELS, EVENTS, FINANCE, GUESTS, RESERVATIONS, canRead, canWrite, dateRange, describeError, statusLabel, today,
  type ReservationRow,
} from '../app/client.ts';
import type { ViewMount } from './shell.ts';

type Filter = 'proximas' | 'activas' | 'pre' | 'confirmadas' | 'cerradas' | 'canceladas';

const FILTERS: Array<[Filter, string]> = [
  ['proximas', 'Próximas'], ['activas', 'Activas'], ['pre', 'Pre-reservas'], ['confirmadas', 'Confirmadas'], ['cerradas', 'Cerradas'], ['canceladas', 'Canceladas'],
];
const OPEN: ReservationStatus[] = ['en_estudio', 'negociacion', 'pre_reservada', 'confirmada', 'en_ejecucion'];
const MISSING_LABELS = { start_date: 'la fecha de entrada', end_date: 'la fecha de salida', expected_guests: 'el número de personas' } as const;

function matches(row: ReservationRow, filter: Filter, now: number): boolean {
  switch (filter) {
    case 'proximas': return OPEN.includes(row.status) && (dayNumber(row.end_date) ?? Infinity) >= now;
    case 'activas': return OPEN.includes(row.status);
    case 'pre': return row.status === 'pre_reservada';
    case 'confirmadas': return row.status === 'confirmada' || row.status === 'en_ejecucion';
    case 'cerradas': return row.status === 'cerrada';
    case 'canceladas': return row.status === 'cancelada' || row.status === 'perdida';
  }
}

interface FormValues {
  title: string;
  event_type: string;
  status: string;
  start_date: string;
  end_date: string;
  expected_guests: string;
  contact_name: string;
  contact_phone: string;
}

function valuesOf(): FormValues {
  return { title: '', event_type: 'retiro', status: 'en_estudio', start_date: '', end_date: '', expected_guests: '', contact_name: '', contact_phone: '' };
}

function toFields(values: FormValues): Record<string, unknown> {
  const guests = values.expected_guests.trim();
  return {
    title: values.title.trim(),
    event_type: values.event_type,
    status: values.status,
    start_date: values.start_date || null,
    end_date: values.end_date || null,
    expected_guests: guests === '' ? null : Number(guests),
    contact_name: values.contact_name.trim() || null,
    contact_phone: values.contact_phone.trim() || null,
  };
}

/** Vista Reservas: lista con filtros y búsqueda, alta (la edición y la confirmación viven en la ficha). */
export const mountReservations: ViewMount = ({ main, client, navigate }) => {
  let rows: ReservationRow[] = [];
  let filter: Filter = 'proximas';
  let query = '';
  let sheet: Sheet | null = null;
  const writable = canWrite(client);

  const search = el('input', { type: 'search', id: 'reservationSearch', placeholder: 'Buscar por nombre, contacto o código', 'aria-label': 'Buscar reservas', autocomplete: 'off',
    oninput: () => { query = search.value.trim().toLowerCase(); paint(); } });
  const filterBar = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filtrar reservas' });
  const count = el('span', { class: 'count', id: 'reservationCount' }, '0');
  const listHost = el('div');
  const trashList = el('ul', { class: 'list', 'aria-label': 'Reservas en la papelera' });
  const trashCount = el('span', { class: 'count', id: 'trashCount' }, '0');
  const owner = client.bootstrap()?.membership.role === 'owner';
  const trash = el('details', { id: 'trash', hidden: true }, el('summary', { class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', trashCount), trashList,
    owner ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'danger small', type: 'button', id: 'emptyTrash', onclick: () => void emptyTrash() }, icon('trash', 16), 'Vaciar papelera')) : null);

  /**
   * Borrado definitivo de todo lo que hay en la papelera de Booking (contrato §11.2: solo el propietario, con recuento).
   * El orden va de hijos a padres para respetar las claves ajenas.
   */
  async function emptyTrash(): Promise<void> {
    if (!navigator.onLine) return void toast('Vaciar la papelera necesita conexión.');
    if (client.status().pendingCommands > 0) return void toast('Hay cambios sin sincronizar. Espera a que se envíen antes de vaciar la papelera.');
    const tables = [TABLES.checklist, TABLES.restrictions, TABLES.roomAssignments, GUESTS, EVENTS, FINANCE, RESERVATIONS, TABLES.beds, TABLES.spaces];
    const counts = await Promise.all(tables.map(async (table) => ((await client.list(table, { includeDeleted: true })).filter((row) => row.deleted_at !== null).length)));
    const reservations = counts[tables.indexOf(RESERVATIONS)]!;
    const others = counts.reduce((sum, n) => sum + n, 0) - reservations;
    const go = await confirmDialog({
      title: 'Vaciar papelera',
      text: `Se borran definitivamente ${plural(reservations, 'reserva', 'reservas')} y ${plural(others, 'elemento asociado', 'elementos asociados')} (eventos, huéspedes, restricciones, tareas, importes, asignaciones de alojamiento, camas y espacios). No se puede deshacer.`,
      confirmLabel: 'Vaciar papelera', danger: true,
    });
    if (!go) return;
    try {
      const out = await client.api<{ purged: number }>('/trash/purge', { method: 'POST', json: { requestId: `purge-${crypto.randomUUID()}`, tables } });
      await client.sync();
      toast(`Papelera vaciada: ${plural(out.purged, 'elemento borrado', 'elementos borrados')}.`);
    } catch (error) {
      const e = error as { code?: string; details?: { reason?: string } };
      if (e.code === 'INVALID_OPERATION' && e.details?.reason === 'calendar event still alive') toast('Alguna reserva de la papelera aún tiene su evento en Google Calendar. Se retira solo en unos minutos; inténtalo después.');
      else if (e.code === 'CONSTRAINT_VIOLATION') toast('No se puede vaciar: algún evento de la papelera tiene un menú en Food. Pide a cocina que lo retire.');
      else toast(describeError(error));
    }
  }
  let deleted: ReservationRow[] = [];

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Reservas'), el('p', null, 'Del primer contacto al cierre: fechas, personas y estado.'))),
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    filterBar,
    el('div', { class: 'sectionlabel' }, 'Reservas', count),
    listHost,
    trash,
    writable ? el('button', { class: 'fab', type: 'button', id: 'newReservation', onclick: () => openForm() }, icon('plus'), 'Nueva reserva') : null,
  );

  function paintFilters(): void {
    replace(filterBar, FILTERS.map(([key, label]) => el('button', {
      class: `softbtn small${filter === key ? ' active' : ''}`, type: 'button', 'aria-pressed': String(filter === key), dataset: { filter: key },
      onclick: () => { filter = key; paintFilters(); paint(); },
    }, label)));
  }

  function paint(): void {
    const now = dayNumber(today())!;
    const visible = rows
      .filter((r) => !r.archived_at && matches(r, filter, now))
      .filter((r) => !query || [r.title, r.contact_name, r.code].some((v) => typeof v === 'string' && v.toLowerCase().includes(query)))
      .sort((a, b) => (dayNumber(a.start_date) ?? Infinity) - (dayNumber(b.start_date) ?? Infinity) || a.title.localeCompare(b.title, 'es'));
    count.textContent = String(visible.length);
    trash.hidden = deleted.length === 0;
    trashCount.textContent = String(deleted.length);
    replace(trashList, deleted.map((r) => listRow({ id: r.id, title: r.title, meta: [dateRange(r), r.code ?? 'código pendiente'], deleted: true, pending: r._pending === true,
      onClick: () => navigate(`#/reservas/${r.id}`), label: `Abrir ${r.title} en la papelera` })));
    if (visible.length === 0) {
      replace(listHost, el('div', { class: 'empty' }, rows.length === 0
        ? [el('strong', null, 'Todavía no hay reservas'), writable ? 'Crea la primera con «Nueva reserva». Funciona también sin conexión.' : 'Cuando alguien cree una reserva aparecerá aquí.']
        : 'Ninguna reserva coincide con el filtro o la búsqueda.'));
      return;
    }
    replace(listHost, el('ul', { class: 'list', id: 'reservationList', 'aria-label': 'Reservas' }, visible.map((r) => {
      const n = nights(r.start_date, r.end_date);
      return listRow({
        id: r.id,
        title: r.title,
        meta: [dateRange(r), r.expected_guests !== null ? plural(r.expected_guests, 'persona', 'personas') : null, n !== null ? plural(n, 'noche', 'noches') : null,
          EVENT_TYPE_LABELS[r.event_type] ?? r.event_type, r.code ?? 'código pendiente'],
        chips: [el('span', { class: 'chip', dataset: { status: r.status } }, statusLabel(r.status))],
        pending: r._pending === true,
        onClick: () => navigate(`#/reservas/${r.id}`),
        label: `Abrir ${r.title}`,
      });
    })));
  }

  /** Hoja de alta. La edición de una reserva vive en su ficha. */
  function openForm(): void {
    const initial = valuesOf();
    const field = (label: string, control: HTMLElement) => el('label', { class: 'field' }, el('span', null, label), control);
    const input = (id: string, type: string, value: string, extra: Record<string, string | number | boolean> = {}) =>
      el('input', { id, type, value, autocomplete: 'off', oninput: onChange, ...extra });
    const select = (id: string, options: Array<[string, string]>, value: string) => {
      const node = el('select', { id, onchange: onChange }, options.map(([v, text]) => el('option', { value: v }, text)));
      node.value = value;
      return node;
    };

    const title = input('resTitle', 'text', initial.title, { maxlength: 200, required: true });
    const type = select('resType', EVENT_TYPES.map((t) => [t, EVENT_TYPE_LABELS[t]]), initial.event_type);
    // «Confirmada» y posteriores solo se alcanzan confirmando desde la ficha (se crea el evento operativo).
    const status = select('resStatus', (['en_estudio', 'negociacion', 'pre_reservada'] as const).map((s): [string, string] => [s, statusLabel(s)]), initial.status);
    const start = input('resStart', 'date', initial.start_date);
    const end = input('resEnd', 'date', initial.end_date);
    const guests = input('resGuests', 'number', initial.expected_guests, { min: 0, step: 1, inputmode: 'numeric' });
    const contact = input('resContact', 'text', initial.contact_name, { maxlength: 200 });
    const phone = input('resPhone', 'tel', initial.contact_phone, { maxlength: 40 });
    const error = el('p', { class: 'formerror', id: 'reservationError', role: 'alert', hidden: true });
    const save = el('button', { class: 'primary', type: 'button', id: 'saveReservation', onclick: () => void submit() }, 'Guardar');

    function current(): FormValues {
      return { title: title.value, event_type: type.value, status: status.value, start_date: start.value, end_date: end.value, expected_guests: guests.value, contact_name: contact.value, contact_phone: phone.value };
    }
    function dirty(): boolean {
      const now = current();
      return (Object.keys(initial) as Array<keyof FormValues>).some((key) => now[key].trim() !== initial[key].trim());
    }
    function onChange(): void {
      guard.dirtyEditor = dirty();
      showError(null);
    }
    function showError(message: string | null): void {
      error.hidden = !message;
      error.textContent = message ?? '';
    }

    async function submit(): Promise<void> {
      const fields = toFields(current());
      const issue = validateFields(RESERVATIONS, fields, 'insert')[0];
      if (issue) return showError(issue.message);
      const id = crypto.randomUUID();
      const operations: RowOperation[] = [{ op: 'insert', table: RESERVATIONS, id, fields }];
      // La fila de importes nace con la reserva (mismo id); un lector no llega aquí.
      if (canRead(client, FINANCE)) operations.push({ op: 'insert', table: FINANCE, id, fields: {} });
      const merged = fields as unknown as ReservationRow;
      if (!canHoldStatus(merged, merged.status)) {
        const missing = missingForConfirmation(merged).map((key) => MISSING_LABELS[key]).join(', ');
        return showError(`Para el estado «${statusLabel(merged.status)}» falta ${missing}.`);
      }
      try {
        save.disabled = true;
        await client.commit(operations);
        guard.dirtyEditor = false;
        await sheet?.close(true);
        toast(navigator.onLine ? 'Reserva guardada.' : 'Guardada en este dispositivo. Se enviará al reconectar.');
      } catch (e) {
        showError(describeError(e));
      } finally {
        save.disabled = false;
      }
    }

    sheet = openSheet({
      title: 'Nueva reserva',
      body: el('form', { id: 'reservationForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        field('Nombre del grupo o evento', title),
        el('div', { class: 'row2' }, field('Tipo', type), field('Estado', status)),
        el('div', { class: 'row2' }, field('Entrada', start), field('Salida', end)),
        field('Personas previstas', guests),
        el('div', { class: 'row2' }, field('Contacto', contact), field('Teléfono', phone)),
        error,
      ),
      foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar')),
      beforeClose: () => !dirty() || confirm('Hay cambios sin guardar. ¿Cerrar sin guardar?'),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
      initialFocus: title,
    });
  }

  async function load(): Promise<void> {
    const all = (await client.list(RESERVATIONS, { includeDeleted: true })) as ReservationRow[];
    rows = all.filter((r) => r.deleted_at === null);
    deleted = all.filter((r) => r.deleted_at !== null);
    paint();
  }

  paintFilters();
  void load();
  const offs = [client.onTable(RESERVATIONS, () => void load())];
  return () => {
    offs.forEach((off) => off());
    void sheet?.close(true);
    guard.dirtyEditor = false;
  };
};
