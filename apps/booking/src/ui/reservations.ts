import type { RowOperation } from '@ikisai/sync-client';
import { el, icon, listRow, openSheet, plural, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  EVENT_TYPES, PROCEDURES, RESERVATION_STATUSES, canHoldStatus, dayNumber, missingForConfirmation, nights, requiresEvent, validateFields,
  type ReservationStatus,
} from '@ikisai/domain-booking';
import { guard } from '../app/guard.ts';
import {
  EVENTS, EVENT_TYPE_LABELS, FINANCE, RESERVATIONS, canRead, canWrite, dateRange, describeError, statusLabel, today,
  type EventRow, type ReservationRow,
} from '../app/client.ts';
import type { ViewMount } from './shell.ts';

type Filter = 'proximas' | 'activas' | 'pre' | 'confirmadas' | 'cerradas' | 'canceladas';

const FILTERS: Array<[Filter, string]> = [
  ['proximas', 'Próximas'], ['activas', 'Activas'], ['pre', 'Pre-reservas'], ['confirmadas', 'Confirmadas'], ['cerradas', 'Cerradas'], ['canceladas', 'Canceladas'],
];
const OPEN: ReservationStatus[] = ['en_estudio', 'negociacion', 'pre_reservada', 'confirmada', 'en_ejecucion'];
const CONFIRMABLE: ReservationStatus[] = ['en_estudio', 'negociacion', 'pre_reservada'];
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

function valuesOf(row: ReservationRow | null): FormValues {
  return {
    title: row?.title ?? '',
    event_type: row?.event_type ?? 'retiro',
    status: row?.status ?? 'en_estudio',
    start_date: row?.start_date ?? '',
    end_date: row?.end_date ?? '',
    expected_guests: row?.expected_guests === null || row?.expected_guests === undefined ? '' : String(row.expected_guests),
    contact_name: row?.contact_name ?? '',
    contact_phone: row?.contact_phone ?? '',
  };
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

/** Vista Reservas: lista con filtros y búsqueda, alta y edición de los datos principales, y confirmación. */
export const mountReservations: ViewMount = ({ main, client, navigate }) => {
  let rows: ReservationRow[] = [];
  let eventByReservation = new Map<string, EventRow>();
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
  const trash = el('details', { id: 'trash', hidden: true }, el('summary', { class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', trashCount), trashList);
  let deleted: ReservationRow[] = [];

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Reservas'), el('p', null, 'Del primer contacto al cierre: fechas, personas y estado.'))),
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    filterBar,
    el('div', { class: 'sectionlabel' }, 'Reservas', count),
    listHost,
    trash,
    writable ? el('button', { class: 'fab', type: 'button', id: 'newReservation', onclick: () => openForm(null) }, icon('plus'), 'Nueva reserva') : null,
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

  function openForm(row: ReservationRow | null): void {
    const initial = valuesOf(row);
    const hasEvent = row ? eventByReservation.has(row.id) : false;
    const field = (label: string, control: HTMLElement) => el('label', { class: 'field' }, el('span', null, label), control);
    const input = (id: string, type: string, value: string, extra: Record<string, string | number | boolean> = {}) =>
      el('input', { id, type, value, autocomplete: 'off', oninput: onChange, ...extra });
    const select = (id: string, options: Array<[string, string, boolean?]>, value: string) => {
      const node = el('select', { id, onchange: onChange }, options.map(([v, text, disabled]) => el('option', { value: v, disabled: disabled === true }, text)));
      node.value = value;
      return node;
    };

    const title = input('resTitle', 'text', initial.title, { maxlength: 200, required: true });
    const type = select('resType', EVENT_TYPES.map((t) => [t, EVENT_TYPE_LABELS[t]]), initial.event_type);
    // «Confirmada» y posteriores solo se alcanzan confirmando (se crea el evento operativo).
    const statuses = (row ? RESERVATION_STATUSES : (['en_estudio', 'negociacion', 'pre_reservada'] as const))
      .map((s): [string, string, boolean?] => [s, statusLabel(s), requiresEvent(s) && !hasEvent]);
    const status = select('resStatus', statuses, initial.status);
    const start = input('resStart', 'date', initial.start_date);
    const end = input('resEnd', 'date', initial.end_date);
    const guests = input('resGuests', 'number', initial.expected_guests, { min: 0, step: 1, inputmode: 'numeric' });
    const contact = input('resContact', 'text', initial.contact_name, { maxlength: 200 });
    const phone = input('resPhone', 'tel', initial.contact_phone, { maxlength: 40 });
    const error = el('p', { class: 'formerror', id: 'reservationError', role: 'alert', hidden: true });
    const save = el('button', { class: 'primary', type: 'button', id: 'saveReservation', onclick: () => void submit() }, 'Guardar');
    const confirmButton = row && !hasEvent && CONFIRMABLE.includes(row.status)
      ? el('button', { class: 'ghost', type: 'button', id: 'confirmReservation', onclick: () => void confirmReservation(row) }, icon('check'), 'Confirmar reserva')
      : null;

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
      sheet?.setFootHidden(!!row && !guard.dirtyEditor);
      if (confirmButton) confirmButton.disabled = guard.dirtyEditor;
    }
    function showError(message: string | null): void {
      error.hidden = !message;
      error.textContent = message ?? '';
    }

    async function submit(): Promise<void> {
      const fields = toFields(current());
      let operations: RowOperation[];
      if (!row) {
        const issue = validateFields(RESERVATIONS, fields, 'insert')[0];
        if (issue) return showError(issue.message);
        const id = crypto.randomUUID();
        operations = [{ op: 'insert', table: RESERVATIONS, id, fields }];
        // La fila de importes nace con la reserva (mismo id); un lector no llega aquí.
        if (canRead(client, FINANCE)) operations.push({ op: 'insert', table: FINANCE, id, fields: {} });
      } else {
        const before = toFields(initial);
        const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== before[key]));
        if (Object.keys(changed).length === 0) return void sheet?.close(true);
        const issue = validateFields(RESERVATIONS, changed, 'update')[0];
        if (issue) return showError(issue.message);
        operations = [{ op: 'update', table: RESERVATIONS, id: row.id, expectedRevision: row.revision, fields: changed }];
      }
      const merged = { ...(row ?? {}), ...fields } as ReservationRow;
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

    async function confirmReservation(target: ReservationRow): Promise<void> {
      const missing = missingForConfirmation(target);
      if (missing.length) return showError(`Para confirmar falta ${missing.map((key) => MISSING_LABELS[key]).join(', ')}.`);
      try {
        await client.commit([{ op: 'call', procedure: PROCEDURES.confirmReservation, args: { reservation_id: target.id, event_id: crypto.randomUUID(), from_status: target.status } }]);
        await sheet?.close(true);
        toast(navigator.onLine ? 'Confirmación enviada: se crea el evento operativo.' : 'Confirmación pendiente de enviar. El evento se creará al reconectar.');
      } catch (e) {
        showError(describeError(e));
      }
    }

    sheet = openSheet({
      title: row ? 'Editar reserva' : 'Nueva reserva',
      ...(row ? { meta: `${row.code ?? 'Código pendiente'} · Revisión ${row.revision}` } : {}),
      body: el('form', { id: 'reservationForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        field('Nombre del grupo o evento', title),
        el('div', { class: 'row2' }, field('Tipo', type), field('Estado', status)),
        el('div', { class: 'row2' }, field('Entrada', start), field('Salida', end)),
        field('Personas previstas', guests),
        el('div', { class: 'row2' }, field('Contacto', contact), field('Teléfono', phone)),
        row && hasEvent ? el('p', { class: 'hint' }, `Evento operativo ${eventByReservation.get(row.id)?.code ?? ''} creado.`) : null,
        confirmButton ? el('p', { style: 'margin-top:12px' }, confirmButton) : null,
        error,
      ),
      foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar')),
      footHidden: !!row,
      beforeClose: () => !dirty() || confirm('Hay cambios sin guardar. ¿Cerrar sin guardar?'),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
      initialFocus: title,
    });
  }

  async function load(): Promise<void> {
    const all = (await client.list(RESERVATIONS, { includeDeleted: true })) as ReservationRow[];
    rows = all.filter((r) => r.deleted_at === null);
    deleted = all.filter((r) => r.deleted_at !== null);
    eventByReservation = new Map(((await client.list(EVENTS)) as EventRow[]).map((e) => [e.reservation_id, e]));
    paint();
  }

  paintFilters();
  void load();
  const offs = [client.onTable(RESERVATIONS, () => void load()), client.onTable(EVENTS, () => void load())];
  return () => {
    offs.forEach((off) => off());
    void sheet?.close(true);
    guard.dirtyEditor = false;
  };
};
