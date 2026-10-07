/** Ficha de una reserva (canon §5): cabecera, acciones y bloques Resumen, Operación, Checklist, Huéspedes, Comidas y Cobro. */
import type { RowOperation, SyncedRow, TableName } from '@ikisai/sync-client';
import { confirmDialog, createSortableList, el, formatDate, icon, plural, positionBetween, renumber, renderMoneyBreakdown, replace, toast, type Child, type Sortable } from '@ikisai/ui-kit';
import {
  CHECKLIST_TYPES, CHECKLIST_TYPE_LABELS, PROCEDURES, TABLES, canHoldStatus, canSeeGuests, checklistSeedOperations, depositStatus, guestModeOf,
  eventPhase, missingForConfirmation, nights, requiresEvent, type ReservationStatus,
} from '@ikisai/domain-booking';
import { ASSIGNMENTS, BEDS, EVENTS, FINANCE, GUESTS, NEEDS, PROPOSALS, PROPOSAL_LINES, CONDITIONS, TIERS, RESERVATIONS, SPACES, STAFF, canRead, canWrite, dateRange, describeError, statusLabel, type ReservationRow, fullDay } from '../app/client.ts';
import { OPTIONS, expenseCategoryLabel, label } from '../app/labels.ts';
import { openRowSheet, type FieldSpec } from './form.ts';
import { fetchCalendarStatus, readCalendarCache, type CalendarStatus } from '../app/calendarStatus.ts';
import { fetchCosts, invoiceUrl, purchasesUrl, readCostCache, type CostResult } from '../app/costs.ts';
import { clearConfirmMark, getConfirmMark, setConfirmMark } from '../app/confirmMark.ts';
import { toCalendarEvent } from './calendar.ts';
import { loadLodging, lodgingSummary, renderLodgingBlock } from './lodging.ts';
import { createPortalBlock } from './portal.ts';
import { createSesBlock } from './ses.ts';
import { createStaffBlock, loadStaff, missingHoursWarning, staffSummary } from './staff.ts';
import { hasProposalMarks, loadMarks, loadProposals, renderProposalBlock } from './proposal.ts';
import type { ViewMount } from './shell.ts';

const RESTRICTIONS: TableName = TABLES.restrictions;
const CHECKLIST: TableName = TABLES.checklist;
const CONFIRMABLE: ReservationStatus[] = ['en_estudio', 'negociacion', 'pre_reservada'];
const MISSING = { start_date: 'la fecha de entrada', end_date: 'la fecha de salida', expected_guests: 'el número de personas' } as const;
const PHASE = { pendiente_preparacion: 'Pendiente de preparación', preparado: 'Preparado', en_ejecucion: 'En ejecución', cerrado: 'Cerrado', cancelado: 'Cancelado' } as const;
const DEPOSIT = { no_aplica: 'No aplica', pendiente: 'Pendiente', parcial: 'Parcial', completado: 'Completada' } as const;

type Row = SyncedRow & Record<string, any>;

const RESERVATION_SPECS: FieldSpec[] = [
  { key: 'title', label: 'Nombre del grupo o evento', type: 'text', max: 200, section: 'Datos principales' },
  { key: 'event_type', label: 'Tipo de evento', type: 'select', options: OPTIONS.eventType },
  { key: 'start_date', label: 'Fecha de entrada', type: 'date' },
  { key: 'end_date', label: 'Fecha de salida', type: 'date' },
  { key: 'expected_guests', label: 'Personas previstas', type: 'number' },
  { key: 'minors_count', label: 'Menores', type: 'number' },
  { key: 'contact_name', label: 'Nombre', type: 'text', max: 200, section: 'Contacto', personal: true },
  { key: 'contact_phone', label: 'Teléfono', type: 'tel', max: 40 },
  { key: 'contact_email', label: 'Correo', type: 'email', max: 320 },
  { key: 'customer_type', label: 'Tipo de cliente', type: 'select', options: OPTIONS.customerType, optional: true },
  { key: 'uses_accommodation', label: 'Alojamiento', type: 'check', section: 'Servicios' },
  { key: 'requires_meals', label: 'Comidas', type: 'check' },
  { key: 'uses_interpretation_center', label: 'Centro de interpretación', type: 'check' },
  { key: 'uses_outdoors', label: 'Exteriores', type: 'check' },
  { key: 'uses_pool', label: 'Piscina', type: 'check' },
  { key: 'meal_plan_requested', label: 'Régimen solicitado', type: 'select', options: OPTIONS.mealPlan, optional: true, section: 'Alimentación' },
  { key: 'menu_style_requested', label: 'Tipo de menú solicitado', type: 'select', options: OPTIONS.menuStyle, optional: true },
  { key: 'meal_notes', label: 'Notas de alimentación', type: 'textarea' },
  { key: 'status', label: 'Estado', type: 'select', options: OPTIONS.status, section: 'Comercial' },
  { key: 'priority', label: 'Prioridad', type: 'select', options: OPTIONS.priority },
  { key: 'briefing_received', label: 'Briefing final recibido', type: 'check' },
  { key: 'special_setup', label: 'Montaje especial', type: 'check', section: 'Más información' },
  { key: 'technical_support', label: 'Soporte técnico', type: 'check' },
  { key: 'customer_notes', label: 'Observaciones del cliente', type: 'textarea' },
  { key: 'internal_notes', label: 'Notas internas', type: 'textarea' },
];

const EVENT_SPECS: FieldSpec[] = [
  { key: 'responsible_name', label: 'Responsable', type: 'text', max: 200, section: 'Llegada y salida' },
  { key: 'arrival_time', label: 'Hora de llegada', type: 'time' },
  { key: 'departure_time', label: 'Hora de salida', type: 'time' },
  { key: 'final_guests', label: 'Personas finales', type: 'number' },
  { key: 'meal_plan_confirmed', label: 'Régimen confirmado', type: 'select', options: OPTIONS.mealPlan, optional: true, section: 'Comidas' },
  { key: 'menu_style_confirmed', label: 'Tipo de menú confirmado', type: 'select', options: OPTIONS.menuStyle, optional: true },
  { key: 'room_distribution', label: 'Distribución de habitaciones', type: 'textarea', section: 'Espacios' },
  { key: 'rooms_count', label: 'Número de habitaciones', type: 'number' },
  { key: 'setup_style', label: 'Montaje de salas', type: 'select', options: OPTIONS.setupStyle, optional: true },
  { key: 'technical_needs', label: 'Necesidades técnicas', type: 'select', options: OPTIONS.technicalNeeds, optional: true },
  { key: 'reinforced_cleaning', label: 'Limpieza reforzada', type: 'check' },
  { key: 'extra_support', label: 'Soporte extra', type: 'check' },
  { key: 'preparation_status', label: 'Preparación', type: 'select', options: OPTIONS.taskF, section: 'Estados' },
  { key: 'accommodation_status', label: 'Alojamiento', type: 'select', options: OPTIONS.taskM },
  { key: 'kitchen_status', label: 'Cocina', type: 'select', options: OPTIONS.taskM },
  { key: 'cleaning_status', label: 'Limpieza', type: 'select', options: OPTIONS.taskF },
  { key: 'traveler_registration_status', label: 'Registro de viajeros', type: 'select', options: OPTIONS.travelerRegistration },
  { key: 'operational_notes', label: 'Notas operativas', type: 'textarea' },
  { key: 'incidents', label: 'Incidencias', type: 'textarea', section: 'Cierre' },
  { key: 'post_event_notes', label: 'Observaciones tras el evento', type: 'textarea' },
];

const FINANCE_SPECS: FieldSpec[] = [
  { key: 'budget_amount', label: 'Importe presupuestado (€)', type: 'number', decimal: true },
  { key: 'final_amount', label: 'Importe final (€)', type: 'number', decimal: true },
  { key: 'deposit_required', label: 'Señal requerida (€)', type: 'number', decimal: true },
  { key: 'deposit_paid', label: 'Señal pagada (€)', type: 'number', decimal: true },
  { key: 'payment_type', label: 'Tipo de pago', type: 'select', options: OPTIONS.paymentType, optional: true, section: 'Pago del organizador' },
  { key: 'payment_date', label: 'Fecha del pago', type: 'date' },
  { key: 'payment_holder', label: 'Titular del pago', type: 'text', max: 200, personal: true },
];

export const RESTRICTION_SPECS: FieldSpec[] = [
  { key: 'restriction_type', label: 'Tipo', type: 'select', options: OPTIONS.restrictionType },
  { key: 'subject', label: 'Alérgeno o producto', type: 'text', max: 200, hint: 'Obligatorio en alergias, intolerancias y «otra».' },
  { key: 'severity', label: 'Gravedad', type: 'select', options: OPTIONS.severity, optional: true, hint: 'Solo en alergias e intolerancias.' },
  { key: 'servings', label: 'Número de personas', type: 'number' },
  { key: 'kitchen_notes', label: 'Notas para cocina', type: 'textarea', max: 2000, hint: 'Sin nombres de personas.' },
  { key: 'active', label: 'Activa', type: 'check' },
];

const CHECKLIST_SPECS: FieldSpec[] = [
  { key: 'checklist_type', label: 'Lista', type: 'select', options: CHECKLIST_TYPES.map((t) => [t, CHECKLIST_TYPE_LABELS[t]] as const) },
  { key: 'label', label: 'Tarea', type: 'text', max: 200 },
  { key: 'status', label: 'Estado', type: 'select', options: OPTIONS.checklistStatus },
  { key: 'responsible_name', label: 'Responsable', type: 'text', max: 200 },
  { key: 'reviewed_on', label: 'Fecha de revisión', type: 'date' },
  { key: 'notes', label: 'Notas', type: 'textarea' },
];

const kv = (...pairs: Array<[string, Child] | null>): HTMLElement =>
  el('dl', { class: 'kv' }, pairs.filter((pair): pair is [string, Child] => pair !== null).flatMap(([term, value]) => [el('dt', null, term), el('dd', null, value)]));
const text = (value: unknown): string => (value === null || value === undefined || value === '' ? '—' : String(value));
const money = (value: unknown): string => (value === null || value === undefined || value === '' ? '—' : `${Number(value).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
const time = (value: unknown): string => (typeof value === 'string' && value ? value.slice(0, 5) : '—');
const del = (table: TableName, row: Row): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });

/** Monta la ficha de la reserva `id`. */
export function mountReservation(id: string): ViewMount {
  return ({ main, client, navigate }) => {
    const writable = canWrite(client);
    const boot = client.bootstrap();
    const owner = boot?.membership.role === 'owner';
    const seesGuests = boot ? canSeeGuests(boot.membership) : false;
    const seesFinance = canRead(client, FINANCE);
    const host = el('div');
    replace(main, host);

    async function run(operations: RowOperation[], message: string): Promise<boolean> {
      try {
        await client.commit(operations);
        toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
        return true;
      } catch (error) {
        toast(describeError(error));
        return false;
      }
    }

    // El menú «Más» solo se pliega por debajo de 1024 px; en escritorio queda abierto y sus botones se ven en línea.
    const wide = window.matchMedia('(min-width: 1024px)');
    const syncMore = () => { const menu = host.querySelector<HTMLDetailsElement>('#moreActions'); if (menu) menu.open = wide.matches; };
    wide.addEventListener('change', syncMore);

    // Listas reordenables del checklist: se conservan entre repintados y se actualizan con `setItems`, de modo que
    // cada movimiento lleva revisiones al día y el foco del asa no se pierde (receta de Food).
    const staffBlock = createStaffBlock();
    const portalBlock = createPortalBlock();
    const sesBlock = createSesBlock();
    const checklistLists = new Map<string, { sortable: Sortable<Row>; sig: string }>();
    let renderChecklistItem: (item: Row) => HTMLElement = () => el('div');
    let onChecklistReorder: (ordered: Row[], moved: Row, to: number) => Promise<void> = async () => undefined;
    const rowSig = (rows: Row[]) => rows.map((r) => `${r.id}:${r.revision}:${r.status}:${r.label}:${r._pending === true}`).join('|');

    async function paint(): Promise<void> {
      const reservation = (await client.get(RESERVATIONS, id)) as (ReservationRow & Row) | null;
      if (!reservation) {
        replace(host, el('div', { class: 'empty' }, el('strong', null, 'Reserva no encontrada'), 'Puede que se haya borrado o que aún no se haya sincronizado.'),
          el('p', null, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.reserva.no_encontrada.volver', 'data-feedback-label': 'Volver a Reservas', onclick: () => navigate('#/reservas') }, 'Volver a Reservas')));
        return;
      }
      const deleted = reservation.deleted_at !== null;
      const event = ((await client.list(EVENTS, { includeDeleted: true })) as Row[]).find((e) => e.reservation_id === id) ?? null;
      const liveEvent = event && event.deleted_at === null ? event : null;
      const finance = seesFinance ? ((await client.get(FINANCE, id)) as Row | null) : null;
      const ofEvent = (rows: SyncedRow[]) => (rows as Row[]).filter((r) => liveEvent && r.event_id === liveEvent.id);
      // Orden estable (por alta): el espejo local no garantiza ninguno.
      const restrictions = ofEvent(await client.list(RESTRICTIONS)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
      const checklist = ofEvent(await client.list(CHECKLIST)).sort((a, b) => Number(a.position) - Number(b.position));
      const guests = seesGuests ? ofEvent(await client.list(GUESTS)) : [];
      const lodging = liveEvent ? await loadLodging(client, liveEvent.id) : null;
      const staff = liveEvent ? await loadStaff(client, liveEvent.id) : null;
      const editable = writable && !deleted;
      const proposalData = writable ? await loadProposals(client, id) : null;
      const proposalMarks = proposalData ? await loadMarks(client, id, proposalData.proposals) : null;

      // Confirmación enviada sin red: la marca vive hasta que aparece el evento (API §10).
      let mark = getConfirmMark(id);
      if (mark && event) { clearConfirmMark(id); mark = null; }
      const rejectedBatch = mark ? (await client.rejected()).find((batch) => batch.requestId === mark!.requestId) ?? null : null;
      // Marca huérfana: ya no hay nada en cola ni rechazado y sigue sin haber evento. Se retira para no dejar la reserva sin botón «Confirmar».
      if (mark && !rejectedBatch && client.status().pendingCommands === 0) { clearConfirmMark(id); mark = null; }
      const confirmPending = mark !== null && rejectedBatch === null;

      // --- acciones de cabecera
      const editReservation = () => openRowSheet({
        client, title: 'Editar reserva', table: RESERVATIONS, row: reservation, feedbackId: 'booking.reserva.editar', feedbackLabel: 'Editar reserva',
        specs: RESERVATION_SPECS.map((spec) => spec.key !== 'status' ? spec
          : { ...spec, options: OPTIONS.status.filter(([value]) => !requiresEvent(value as ReservationStatus) || liveEvent !== null || value === reservation.status) }),
        check: (merged) => {
          const row = merged as unknown as ReservationRow;
          return canHoldStatus(row, row.status) ? null : `Para el estado «${statusLabel(row.status)}» falta ${missingForConfirmation(row).map((key) => MISSING[key]).join(', ')}.`;
        },
        savedMessage: 'Reserva guardada.',
      });

      async function confirmReservation(): Promise<void> {
        const missing = missingForConfirmation(reservation!);
        if (missing.length) return void toast(`Para confirmar falta ${missing.map((key) => MISSING[key]).join(', ')}.`);
        const go = await confirmDialog({ title: 'Confirmar reserva', text: 'Se crea el evento operativo de esta reserva. Podrás completar llegada, salida, checklist y huéspedes.', confirmLabel: 'Confirmar' });
        if (!go) return;
        try {
          const { requestId } = await client.commit([{ op: 'call', procedure: PROCEDURES.confirmReservation, args: { reservation_id: id, event_id: crypto.randomUUID(), from_status: reservation!.status } }]);
          setConfirmMark({ reservationId: id, requestId });
          toast(navigator.onLine ? 'Confirmación enviada.' : 'Confirmación pendiente de enviar. Se enviará al reconectar.');
          void paint();
        } catch (error) {
          toast(describeError(error));
        }
      }

      async function trash(): Promise<void> {
        if (event && !owner) return void toast('Esta reserva ya tiene evento operativo: solo un propietario puede borrarla. Puedes cancelarla o archivarla.');
        const children = liveEvent ? [...ofEvent(await client.list(CHECKLIST)).map((r) => del(CHECKLIST, r)), ...restrictions.map((r) => del(RESTRICTIONS, r)),
          ...(canRead(client, ASSIGNMENTS) ? ofEvent(await client.list(ASSIGNMENTS)).map((r) => del(ASSIGNMENTS, r)) : []),
          ...(staff ? [...staff.shifts.map((r) => del(STAFF, r)), ...staff.needs.map((r) => del(NEEDS, r))] : []), ...guests.map((r) => del(GUESTS, r))] : [];
        if (liveEvent && !seesGuests) return void toast('No puedes ver los huéspedes de este evento; pide a un propietario que la borre.');
        const go = await confirmDialog({
          title: 'Enviar a la papelera',
          text: liveEvent ? `Se envían a la papelera la reserva, su evento operativo y ${plural(children.length, 'elemento asociado', 'elementos asociados')}. Se puede restaurar.` : 'La reserva va a la papelera. Se puede restaurar.',
          confirmLabel: 'Enviar a la papelera', danger: true,
        });
        if (!go) return;
        const operations = [...children, ...(liveEvent ? [del(EVENTS, liveEvent)] : []), ...(finance && finance.deleted_at === null ? [del(FINANCE, finance)] : []), del(RESERVATIONS, reservation!)];
        if (await run(operations, 'Reserva enviada a la papelera.')) navigate('#/reservas');
      }

      async function restore(): Promise<void> {
        // Vuelve todo lo que se borró junto con la reserva: misma marca de borrado, con dos segundos de margen
        // (el servidor usa la hora de la transacción; el espejo local, la del dispositivo).
        const stamp = Date.parse(reservation!.deleted_at ?? '');
        const together = (row: Row) => row.deleted_at !== null && Math.abs(Date.parse(row.deleted_at) - stamp) <= 2000;
        const same = async (table: TableName, filter: (row: Row) => boolean) =>
          ((await client.list(table, { includeDeleted: true })) as Row[]).filter((row) => together(row) && filter(row))
            .map((row): RowOperation => ({ op: 'restore', table, id: row.id, expectedRevision: row.revision }));
        const eventOps = event && together(event) ? await same(EVENTS, (row) => row.id === event.id) : [];
        if (eventOps.length && !owner) return void toast('Restaurar una reserva con evento operativo es cosa de un propietario.');
        const operations = [
          { op: 'restore', table: RESERVATIONS, id, expectedRevision: reservation!.revision } as RowOperation,
          ...(seesFinance ? await same(FINANCE, (row) => row.id === id) : []),
          ...eventOps,
          ...(event ? [...(seesGuests ? await same(GUESTS, (row) => row.event_id === event.id) : []), ...await same(RESTRICTIONS, (row) => row.event_id === event.id), ...await same(CHECKLIST, (row) => row.event_id === event.id),
        ...(canRead(client, ASSIGNMENTS) ? await same(ASSIGNMENTS, (row) => row.event_id === event.id) : []),
        ...(canRead(client, STAFF) ? await same(STAFF, (row) => row.event_id === event.id) : []),
        ...(canRead(client, NEEDS) ? await same(NEEDS, (row) => row.event_id === event.id) : [])] : []),
        ];
        await run(operations, 'Reserva restaurada.');
      }

      const archived = reservation.archived_at !== null;
      const archiveButton = el('button', { class: 'ghost', type: 'button', id: 'archiveReservation', 'data-feedback-id': 'booking.reserva.acciones.archivar', 'data-feedback-label': 'Archivar', onclick: () => void run(
        [{ op: 'update', table: RESERVATIONS, id, expectedRevision: reservation.revision, fields: { archived_at: archived ? null : new Date().toISOString() } }],
        archived ? 'Reserva desarchivada.' : 'Reserva archivada.') }, archived ? 'Desarchivar' : 'Archivar');
      const trashButton = el('button', { class: 'ghost', type: 'button', id: 'trashReservation', 'data-feedback-id': 'booking.reserva.acciones.papelera', 'data-feedback-label': 'Papelera', onclick: () => void trash() }, icon('trash'), 'Papelera');
      const actions = deleted
        ? [writable ? el('button', { class: 'primary', type: 'button', id: 'restoreReservation', 'data-feedback-id': 'booking.reserva.acciones.restaurar', 'data-feedback-label': 'Restaurar', onclick: () => void restore() }, icon('restore'), 'Restaurar') : null]
        : !writable ? [] : [
            el('button', { class: 'primary', type: 'button', id: 'editReservation', 'data-feedback-id': 'booking.reserva.acciones.editar', 'data-feedback-label': 'Editar', onclick: editReservation }, icon('edit'), 'Editar'),
            !liveEvent && !confirmPending && CONFIRMABLE.includes(reservation.status)
              ? el('button', { class: 'ghost', type: 'button', id: 'confirmReservation', 'data-feedback-id': 'booking.reserva.acciones.confirmar', 'data-feedback-label': 'Confirmar', onclick: () => void confirmReservation() }, icon('check'), 'Confirmar') : null,
            // En móvil «Archivar» y «Papelera» van a un menú «Más»; en escritorio se ven todas (CSS `.more`).
            el('details', { class: 'more', id: 'moreActions', 'data-feedback-id': 'booking.reserva.acciones.mas', 'data-feedback-label': 'Más acciones' }, el('summary', { class: 'ghost' }, 'Más'),
              el('div', { class: 'more-items' }, archiveButton, trashButton)),
          ];

      // --- bloques
      const n = nights(reservation.start_date, reservation.end_date);
      const services = [['uses_accommodation', 'Alojamiento'], ['requires_meals', 'Comidas'], ['uses_interpretation_center', 'Centro de interpretación'], ['uses_outdoors', 'Exteriores'], ['uses_pool', 'Piscina']]
        .filter(([key]) => reservation[key as string] === true).map(([, name]) => name).join(' · ');
      const BLOCK_IDS: Record<string, string> = {
        blockSummary: 'booking.reserva.resumen', blockOperation: 'booking.reserva.operacion', blockChecklist: 'booking.reserva.checklist', blockGuests: 'booking.reserva.huespedes',
        blockMeals: 'booking.reserva.comidas', blockFinance: 'booking.reserva.cobro', blockCosts: 'booking.reserva.coste',
      };
      const block = (idAttr: string, title: string, body: Child, action?: Child) =>
        el('article', { class: 'card', id: idAttr, 'data-feedback-id': BLOCK_IDS[idAttr], 'data-feedback-label': title }, el('div', { class: 'cardhead' }, el('h3', null, title), action ?? null), body);
      const EDIT_IDS: Record<string, string> = { editOperation: 'booking.reserva.operacion.editar', editFinance: 'booking.reserva.cobro.editar' };
      const editLink = (idAttr: string, textLabel: string, onclick: () => void) => (editable ? el('button', { class: 'linkbtn', type: 'button', id: idAttr, 'data-feedback-id': EDIT_IDS[idAttr], 'data-feedback-label': textLabel, onclick }, textLabel) : null);

      const summary = block('blockSummary', 'Resumen', kv(
        ['Fechas', dateRange(reservation)], ['Noches', n === null ? '—' : String(n)],
        ['Personas', `${text(reservation.expected_guests)} previstas · ${text(liveEvent?.final_guests)} finales`],
        ['Menores', text(reservation.minors_count)], ['Tipo', label(reservation.event_type)],
        ['Contacto', el('span', { 'data-feedback-ignore': '' }, [reservation.contact_name, reservation.contact_phone, reservation.contact_email].filter(Boolean).join(' · ') || '—')],
        ['Servicios', services || '—'], ['Prioridad', label(reservation.priority)],
        ['Briefing final', reservation.briefing_received ? 'Recibido' : 'Pendiente'],
        reservation.customer_notes ? ['Observaciones', reservation.customer_notes] : null,
        reservation.internal_notes ? ['Notas internas', reservation.internal_notes] : null,
      ));

      // Cierre operativo: si faltan horas reales en algún turno, la hoja de cierre lo avisa (aviso, no bloquea).
      async function toggleClose(): Promise<void> {
        const reopening = !!liveEvent!.closed_at;
        const warning = reopening ? null : missingHoursWarning(staff);
        if (warning && !(await confirmDialog({ title: 'Anotar cierre operativo', text: `${warning}. Es solo un aviso: puedes anotar el cierre igualmente.`, confirmLabel: 'Anotar cierre' }))) return;
        await run([{ op: 'update', table: EVENTS, id: liveEvent!.id, expectedRevision: liveEvent!.revision, fields: { closed_at: reopening ? null : new Date().toISOString() } }],
          reopening ? 'Evento reabierto.' : 'Cierre operativo anotado.');
      }

      const operation = !liveEvent
        ? block('blockOperation', 'Operación', el('p', { class: 'hint' }, 'El evento operativo se crea al confirmar la reserva.'))
        : block('blockOperation', 'Operación', [
            kv(['Evento', `${text(liveEvent.code ?? 'código pendiente')} · ${PHASE[eventPhase(reservation, liveEvent as any)]}`],
              ['Llegada', time(liveEvent.arrival_time)], ['Salida', time(liveEvent.departure_time)], ['Responsable', text(liveEvent.responsible_name)],
              ['Preparación', label(liveEvent.preparation_status)], ['Alojamiento', label(liveEvent.accommodation_status)],
              ['Cocina', label(liveEvent.kitchen_status)], ['Limpieza', label(liveEvent.cleaning_status)],
              ['Registro de viajeros', label(liveEvent.traveler_registration_status)],
              ['Montaje', label(liveEvent.setup_style)], ['Habitaciones', [liveEvent.rooms_count, lodgingSummary(lodging) ?? liveEvent.room_distribution].filter((v) => v !== null && v !== '').join(' · ') || '—'],
              ['Personal', staffSummary(staff) ?? '—'],
              liveEvent.operational_notes ? ['Notas', liveEvent.operational_notes] : null,
              ['Cierre', liveEvent.closed_at ? formatDate(liveEvent.closed_at) : 'Abierto'],
              liveEvent.incidents ? ['Incidencias', liveEvent.incidents] : null),
            editable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'closeEvent', 'data-feedback-id': 'booking.reserva.operacion.cierre', 'data-feedback-label': 'Cierre operativo', onclick: () => void toggleClose() }, liveEvent.closed_at ? 'Reabrir evento' : 'Anotar cierre operativo')) : null,
          ], editLink('editOperation', 'Editar', () => openRowSheet({ client, title: 'Operación', table: EVENTS, row: liveEvent, specs: EVENT_SPECS, savedMessage: 'Operación guardada.', feedbackId: 'booking.reserva.operacion.hoja', feedbackLabel: 'Editar operación' })));

      const lodgingBlock = !liveEvent || !lodging ? null : renderLodgingBlock({ client, reservation, event: liveEvent, data: lodging, guests, seesGuests, editable, navigate });

      const portalCard = editable ? portalBlock.render({ client, reservation, editable }) : null;
      const staffCard =!liveEvent || !staff ? null : staffBlock.render({ client, reservation, event: liveEvent, data: staff, editable, run });

      // Un ítem de la lista: checkbox y botón de editar (el asa y los botones «Subir/Bajar» los pone el kit).
      const checklistItem = (item: Row): HTMLElement => el('div', { class: 'checklist-item', dataset: { status: item.status, pending: String(item._pending === true) }, 'data-feedback-id': 'booking.reserva.checklist.tarea', 'data-feedback-label': 'Tarea' },
        el('label', { class: 'check', 'data-feedback-id': 'booking.reserva.checklist.tarea.casilla', 'data-feedback-label': 'Marcar como hecha' },
          el('input', { type: 'checkbox', checked: item.status === 'hecho', disabled: !editable || item.status === 'no_aplica', 'aria-label': item.label,
            onchange: () => void run([{ op: 'update', table: CHECKLIST, id: item.id, expectedRevision: item.revision, fields: { status: item.status === 'hecho' ? 'pendiente' : 'hecho' } }], 'Checklist actualizado.') }),
          el('span', null, item.label, item.status === 'no_aplica' ? ' (no aplica)' : '')),
        editable ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar ${item.label}`, 'data-feedback-id': 'booking.reserva.checklist.tarea.editar', 'data-feedback-label': 'Editar tarea', onclick: () => openRowSheet({
          client, title: 'Tarea del checklist', table: CHECKLIST, row: item, specs: CHECKLIST_SPECS, feedbackId: 'booking.reserva.checklist.hoja', feedbackLabel: 'Editar tarea',
          remove: { label: 'Quitar', operations: () => [del(CHECKLIST, item)] } }) }, icon('edit', 16)) : null);

      // Reordenar: un solo `update` del ítem movido con `position` entre sus vecinos; solo si no cabe, se renumera la lista entera en un lote.
      async function reorderChecklist(ordered: Row[], moved: Row, to: number): Promise<void> {
        const prev = ordered[to - 1], next = ordered[to + 1];
        const a = prev ? Number(prev.position) : null, b = next ? Number(next.position) : null;
        const position = positionBetween(a, b);
        const fits = Number.isFinite(position) && (a === null || position > a) && (b === null || position < b);
        if (fits) {
          await run([{ op: 'update', table: CHECKLIST, id: moved.id, expectedRevision: moved.revision, fields: { position } }], 'Orden del checklist guardado.');
          return;
        }
        const positions = renumber(ordered.length);
        await run(ordered.map((row, i): RowOperation => ({ op: 'update', table: CHECKLIST, id: row.id, expectedRevision: row.revision, fields: { position: positions[i]! } })), 'Orden del checklist guardado.');
      }

      // El asa con el foco (teclado) se recupera al final: reutilizar la lista en la ficha nueva la saca del DOM y le quita el foco.
      // Se lee aquí, antes de construir los bloques, porque al reutilizar la lista ya se mueve.
      const focusedHandle = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#blockChecklist .sortable-row')?.dataset.key ?? null;
      renderChecklistItem = checklistItem;
      onChecklistReorder = reorderChecklist;
      const checklistList = (type: string): HTMLElement => {
        const items = checklist.filter((item) => item.checklist_type === type);
        if (!editable) return el('ul', { class: 'checklist', 'data-feedback-id': 'booking.reserva.checklist.lista', 'data-feedback-label': 'Lista de tareas' }, items.map((item) => el('li', null, checklistItem(item))));
        const kept = checklistLists.get(type);
        if (kept) {
          const sig = rowSig(items);
          if (kept.sig !== sig) { kept.sig = sig; kept.sortable.setItems(items); }
          return kept.sortable.element;
        }
        const sortable = createSortableList<Row>({
          items, key: (item) => item.id, name: (item) => item.label, label: `Tareas de ${CHECKLIST_TYPE_LABELS[type as keyof typeof CHECKLIST_TYPE_LABELS]}`,
          render: (item) => renderChecklistItem(item), rowClass: 'checklist-row',
          onReorder: (ordered, move) => onChecklistReorder(ordered, move.item, move.to),
        });
        sortable.element.querySelector('ul')?.classList.add('checklist');
        sortable.element.setAttribute('data-feedback-id', 'booking.reserva.checklist.lista');
        sortable.element.setAttribute('data-feedback-label', 'Lista de tareas');
        checklistLists.set(type, { sortable, sig: rowSig(items) });
        return sortable.element;
      };

      const checklistBlock = !liveEvent ? null : block('blockChecklist', 'Checklist', [
        checklist.length === 0 ? el('p', { class: 'hint' }, 'Sin tareas todavía.') : CHECKLIST_TYPES.filter((type) => checklist.some((item) => item.checklist_type === type)).map((type) => [
          el('div', { class: 'sectionlabel' }, CHECKLIST_TYPE_LABELS[type], el('span', { class: 'count' }, `${checklist.filter((i) => i.checklist_type === type && i.status !== 'pendiente').length}/${checklist.filter((i) => i.checklist_type === type).length}`)),
          checklistList(type),
        ]),
        editable ? el('div', { class: 'choices', style: 'margin-top:10px' },
          el('button', { class: 'ghost small', type: 'button', id: 'seedChecklist', 'data-feedback-id': 'booking.reserva.checklist.base', 'data-feedback-label': 'Añadir checklist base', onclick: () => {
            const operations = checklistSeedOperations(liveEvent.id, () => crypto.randomUUID(), { existing: checklist as any }) as unknown as RowOperation[];
            if (operations.length === 0) return void toast('El checklist base ya está completo.');
            void run(operations, `Añadidas ${operations.length} tareas del checklist base.`);
          } }, 'Añadir checklist base'),
          el('button', { class: 'ghost small', type: 'button', id: 'addChecklistItem', 'data-feedback-id': 'booking.reserva.checklist.anadir', 'data-feedback-label': 'Añadir tarea', onclick: () => openRowSheet({
            client, title: 'Nueva tarea', table: CHECKLIST, row: null, specs: CHECKLIST_SPECS, feedbackId: 'booking.reserva.checklist.nueva', feedbackLabel: 'Nueva tarea', defaults: { checklist_type: 'preparacion_general', status: 'pendiente' },
            insertFields: { event_id: liveEvent.id, position: checklist.length + 1 } }) }, 'Añadir tarea')) : null,
      ]);

      const sesCard = sesBlock.render({ client, reservation, event: liveEvent, finance, editable, run });
      const guestMode = guestModeOf(reservation);
      const guestsBlock = !liveEvent ? null : block('blockGuests', 'Huéspedes',
        guestMode === 'ninguno' ? el('p', { class: 'hint', id: 'guestsNone' }, 'Esta reserva no pide datos de huéspedes.')
        : seesGuests && guestMode === 'operativo' ? kv(['Registrados', String(guests.length)], ['Menores', String(guests.filter((g) => g.is_minor).length)])
        : seesGuests
          ? kv(['Registrados', String(guests.length)], ['Menores', String(guests.filter((g) => g.is_minor).length)],
              ['Firmados', String(guests.filter((g) => g.signed_at).length)], ['Enviados a SES', String(guests.filter((g) => g.ses_status === 'enviado_SES').length)])
          : el('p', { class: 'hint' }, 'El detalle de huéspedes está restringido a los responsables designados.'),
        guestMode === 'ninguno' ? null : el('button', { class: 'linkbtn', type: 'button', id: 'openGuests', 'data-feedback-id': 'booking.reserva.huespedes.abrir', 'data-feedback-label': 'Abrir huéspedes', onclick: () => navigate(`#/huespedes/${liveEvent.id}`) }, 'Abrir'));

      const restrictionSummary = restrictions.filter((r) => r.active).map((r) => `${r.guest_id ? 1 : r.servings} ${label(r.restriction_type).toLowerCase()}${r.subject ? ` a ${r.subject}` : ''}`).join(' · ');
      const meals = block('blockMeals', 'Comidas', [
        kv(['Régimen', `${label(reservation.meal_plan_requested)} solicitado · ${label(liveEvent?.meal_plan_confirmed)} confirmado`],
          ['Tipo de menú', `${label(reservation.menu_style_requested)} solicitado · ${label(liveEvent?.menu_style_confirmed)} confirmado`],
          reservation.meal_notes ? ['Notas', reservation.meal_notes] : null),
        liveEvent ? [
          el('div', { class: 'sectionlabel' }, 'Restricciones', el('span', { class: 'count' }, String(restrictions.length))),
          restrictions.length === 0 ? el('p', { class: 'hint' }, 'Ninguna registrada.') : [
            el('p', { id: 'restrictionSummary', 'data-feedback-id': 'booking.reserva.comidas.resumen', 'data-feedback-label': 'Resumen de restricciones' }, restrictionSummary || 'Todas inactivas.'),
            el('ul', { class: 'list', id: 'restrictionList', 'data-feedback-id': 'booking.reserva.comidas.restricciones', 'data-feedback-label': 'Restricciones alimentarias' }, restrictions.map((r) => el('li', { class: 'row', dataset: { pending: String(r._pending === true) }, 'data-feedback-id': 'booking.reserva.comidas.restricciones.fila', 'data-feedback-label': 'Restricción' },
              el('div', { class: 'row-title' }, el('span', { class: 'name' }, `${label(r.restriction_type)}${r.subject ? ` · ${r.subject}` : ''}`),
                r.severity ? el('span', { class: `chip${r.severity === 'grave' ? ' alert' : ''}` }, label(r.severity)) : null, r.active ? null : el('span', { class: 'chip' }, 'Inactiva')),
              el('div', { class: 'row-meta' }, r.guest_id ? 'De un huésped concreto' : plural(Number(r.servings), 'persona', 'personas'), r.kitchen_notes ? ` · ${r.kitchen_notes}` : ''),
              editable ? el('div', { class: 'row-actions' }, el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Editar restricción ${label(r.restriction_type)}`, 'data-feedback-id': 'booking.reserva.comidas.restricciones.editar', 'data-feedback-label': 'Editar restricción', onclick: () => openRowSheet({
                client, title: 'Restricción alimentaria', table: RESTRICTIONS, row: r, feedbackId: 'booking.reserva.comidas.restriccion', feedbackLabel: 'Editar restricción', specs: RESTRICTION_SPECS.filter((s) => s.key !== 'servings' || !r.guest_id),
                remove: { label: 'Quitar', operations: () => [del(RESTRICTIONS, r)] } }) }, icon('edit', 16))) : null)))],
          editable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'addRestriction', 'data-feedback-id': 'booking.reserva.comidas.anadir', 'data-feedback-label': 'Añadir restricción', onclick: () => openRowSheet({
            client, title: 'Nueva restricción', table: RESTRICTIONS, row: null, feedbackId: 'booking.reserva.comidas.nueva', feedbackLabel: 'Nueva restricción', specs: RESTRICTION_SPECS, defaults: { restriction_type: 'vegetariano', servings: 1, active: true },
            insertFields: { event_id: liveEvent.id } }) }, 'Añadir restricción')) : null,
        ] : null,
      ]);

      const proposalBlock = !proposalData || !proposalMarks ? null : renderProposalBlock({ client, reservation, data: proposalData, marks: proposalMarks, editable, navigate, refresh: () => void paint() });

      const cobro = !seesFinance ? null : block('blockFinance', 'Cobro', kv(
        ['Presupuesto', money(finance?.budget_amount)], ['Importe final', money(finance?.final_amount)],
        ['Señal', `${money(finance?.deposit_paid)} de ${money(finance?.deposit_required)} · ${DEPOSIT[depositStatus(finance as any)]}`],
        ['Pago', [label(finance?.payment_type), finance?.payment_date, finance?.payment_holder].filter((v) => v && v !== '—').join(' · ') || '—']),
        editLink('editFinance', 'Editar', () => openRowSheet({
          client, title: 'Cobro', table: FINANCE, row: finance && finance.deleted_at === null ? finance : null, insertId: id, specs: FINANCE_SPECS, savedMessage: 'Cobro guardado.', feedbackId: 'booking.reserva.cobro.hoja', feedbackLabel: 'Editar cobro' })));

      // Coste real: compras de Invoices asignadas a la reserva y su evento. Caché local al instante y refresco con red.
      const costByCategory = el('div', { id: 'costByCategory', 'data-feedback-id': 'booking.reserva.coste.categorias', 'data-feedback-label': 'Coste por categoría' });
      const costList = el('ul', { class: 'list', id: 'costList', 'data-feedback-id': 'booking.reserva.coste.facturas', 'data-feedback-label': 'Facturas' });
      const costNote = el('p', { class: 'hint', id: 'costNote', role: 'status' });
      const costBody = el('div', { id: 'costBody' }, costByCategory, costList, costNote);
      const costUnavailable = el('p', { class: 'hint', id: 'costUnavailable', role: 'status', hidden: true }, 'Coste real no disponible.');
      const paintCosts = (result: CostResult | null, unavailable = false): void => {
        costBody.hidden = unavailable;
        costUnavailable.hidden = !unavailable;
        if (unavailable) return;
        const summary = result?.summary;
        // Desglose del kit: total frente a lo presupuestado y una línea por categoría con enlace a las compras en Invoices.
        const budget = Number(finance && finance.deleted_at === null ? finance.budget_amount : null);
        const breakdown = renderMoneyBreakdown({
          totalLabel: 'Coste real',
          total: summary?.total ?? 0,
          compare: budget > 0 ? { label: 'presupuestados', amount: budget } : null,
          lines: (summary?.categories ?? []).map((c) => ({
            id: `${c.investment ? 'i' : 'g'}:${c.category}`,
            label: `${expenseCategoryLabel(c.category)}${c.investment ? ' · inversión' : ''}`,
            amount: c.amount,
            meta: plural(c.invoices, 'factura', 'facturas'),
            href: purchasesUrl('reservation', id),
          })),
          emptyText: 'Invoices no ha asignado compras a esta reserva.',
        });
        breakdown.querySelector('.mb-amount')?.setAttribute('id', 'costTotal');
        replace(costByCategory, summary ? breakdown : null);
        replace(costList, ...(summary?.rows ?? []).map((r) => el('li', { class: 'row', 'data-feedback-id': 'booking.reserva.coste.facturas.fila', 'data-feedback-label': 'Factura' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, r.supplier), el('span', null, money(r.amount))),
          el('div', { class: 'row-meta' }, r.date ? fullDay(r.date) : '—', ' · ',
            r.code ? el('a', { href: invoiceUrl(r.code), 'data-feedback-id': 'booking.reserva.coste.facturas.enlace', 'data-feedback-label': 'Abrir factura', target: '_blank', rel: 'noopener' }, r.code) : 'sin código'))));
        costNote.textContent = !result ? (navigator.onLine ? 'Cargando…' : 'Se actualizará al reconectar.')
          : !navigator.onLine ? 'Se actualizará al reconectar.' : '';
      };
      const costs = !seesFinance ? null : block('blockCosts', 'Coste real', [costBody, costUnavailable]);
      if (seesFinance) {
        paintCosts(readCostCache(id));
        if (navigator.onLine) void fetchCosts(client, id, liveEvent?.id ?? null).then((fresh) => { if (fresh) paintCosts(fresh); }, () => paintCosts(null, true));
      }

      // Pastilla de Calendar: lo último que se supo (caché) y, con red, refresco en segundo plano solo de esta reserva.
      const published = toCalendarEvent(reservation) !== null;
      const calendarChip = el('span', { class: 'chip', id: 'calendarChip', hidden: true, 'data-feedback-id': 'booking.reserva.cabecera.calendar', 'data-feedback-label': 'Estado de Calendar' });
      const paintCalendar = (status: CalendarStatus | null): void => {
        const item = status?.items.find((i) => i.reservationId === id);
        const state = !published || !status || status.health === 'not_configured' || item?.syncStatus === 'deleted' ? null
          : item?.syncStatus === 'error' ? 'error' : item?.syncStatus === 'synced' && !item.pendingJob ? 'sincronizado' : 'pendiente';
        calendarChip.hidden = state === null;
        calendarChip.textContent = state === null ? '' : `Calendar: ${state}`;
        calendarChip.className = `chip${state === 'error' ? ' alert' : state === 'pendiente' ? ' pending' : ''}`;
        calendarChip.title = navigator.onLine ? '' : 'Se actualizará al reconectar.';
      };
      paintCalendar(readCalendarCache());
      if (published) void fetchCalendarStatus(client, id).then((fresh) => { if (fresh) paintCalendar(fresh); });

      replace(host,
        el('p', null, el('button', { class: 'linkbtn', type: 'button', id: 'backToList', 'data-feedback-id': 'booking.reserva.cabecera.volver', 'data-feedback-label': 'Volver a Reservas', onclick: () => navigate('#/reservas') }, '← Reservas')),
        el('div', { class: 'pagehead ficha', 'data-feedback-id': 'booking.reserva.cabecera', 'data-feedback-label': 'Cabecera' }, el('div', null,
          el('h2', null, reservation.title),
          el('p', null, `${dateRange(reservation)} · ${reservation.expected_guests === null ? 'personas sin definir' : plural(reservation.expected_guests, 'persona', 'personas')} · ${reservation.code ?? 'código pendiente'}`),
          el('div', { class: 'chips' },
            el('span', { class: 'chip', dataset: { status: reservation.status }, id: 'statusChip', 'data-feedback-id': 'booking.reserva.cabecera.estado', 'data-feedback-label': 'Estado' }, statusLabel(reservation.status)),
            calendarChip,
            confirmPending ? el('span', { class: 'chip pending', id: 'confirmPendingChip', 'data-feedback-id': 'booking.reserva.cabecera.confirmacion', 'data-feedback-label': 'Confirmación pendiente' }, 'Confirmación pendiente de enviar') : null,
            archived ? el('span', { class: 'chip' }, 'Archivada') : null,
            deleted ? el('span', { class: 'chip trash' }, 'En la papelera') : null,
            reservation._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null))),
        rejectedBatch ? el('div', { class: 'banner alert', id: 'confirmRejected', role: 'alert', 'data-feedback-id': 'booking.reserva.confirmacion_rechazada', 'data-feedback-label': 'Confirmación rechazada' },
          el('span', null, `No se pudo confirmar la reserva: ${describeError(rejectedBatch.error)}`),
          el('button', { class: 'ghost small', type: 'button', id: 'dismissConfirmRejected', 'data-feedback-id': 'booking.reserva.confirmacion_rechazada.entendido', 'data-feedback-label': 'Entendido', onclick: async () => {
            await client.discardRejected(rejectedBatch.requestId);
            clearConfirmMark(id);
            void paint();
          } }, 'Entendido')) : null,
        el('div', { class: 'choices', id: 'reservationActions', 'data-feedback-id': 'booking.reserva.acciones', 'data-feedback-label': 'Acciones' }, actions),
        el('div', { class: 'cardgrid ficha-grid' }, summary, operation, sesCard, lodgingBlock, staffCard, portalCard, checklistBlock, guestsBlock, meals, proposalBlock, cobro, costs),
      );
      if (focusedHandle) host.querySelector<HTMLElement>(`#blockChecklist .sortable-row[data-key="${focusedHandle}"] .sortable-handle`)?.focus({ preventScroll: true });
      syncMore();
    }

    void paint();
    const offs = [RESERVATIONS, EVENTS, FINANCE, RESTRICTIONS, CHECKLIST, GUESTS, SPACES, BEDS, ASSIGNMENTS, STAFF, NEEDS].filter((table) => canRead(client, table) || table === RESERVATIONS)
      .map((table) => client.onTable(table, () => void paint()));
    // Un lote rechazado o terminado no toca ninguna tabla: la marca de confirmación necesita su propio aviso.
    offs.push(client.onStatus(() => { if (getConfirmMark(id) || hasProposalMarks(id)) void paint(); }));
    // Propuestas y sus tablas: solo las lee el equipo con permiso de escritura.
    for (const table of [PROPOSALS, PROPOSAL_LINES, CONDITIONS, TIERS]) if (writable && canRead(client, table)) offs.push(client.onTable(table, () => void paint()));
    return () => { offs.forEach((off) => off()); wide.removeEventListener('change', syncMore); checklistLists.forEach(({ sortable }) => sortable.destroy()); staffBlock.destroy(); portalBlock.destroy(); sesBlock.destroy(); };
  };
}
