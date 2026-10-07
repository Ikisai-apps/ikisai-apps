import type { RowOperation } from '@ikisai/sync-client';
import { eventSnapshot, isMenuStale, menuTotals, proposeServices, validateOperations, type FoodEvent, type Menu, type ProposedService, type ServiceType } from '@ikisai/domain-food';
import { closeSheet, el, formatDate, listRow, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { loadAllMenuGraphs } from '../app/menu-data.ts';
import { loadPurchases } from '../app/purchases.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import {
  MEAL_PLAN_LABELS, bookingReservationUrl, allergyCount, dateRange, guestsLabel, isCancelled, longDay, mealPlanLabel, mealsGap, needsMenu, noMealsInBooking, refreshEvents, restrictionLabel, shortTime, sortedRestrictions, todayKey, watchEvents, whenLabel,
  type EventsSnapshot,
} from '../app/events.ts';
import type { ViewMount } from './shell.ts';
import { fb, fbIgnore, fbRows, type FbMark } from './feedback.ts';
import { usage } from '../app/usage.ts';

export const MENU_STATUS_LABELS: Record<Menu['status'], string> = { borrador: 'Borrador', revisar: 'Por revisar', validado: 'Validado', cerrado: 'Cerrado' };
export const SERVICE_LABELS: Record<ServiceType, string> = { desayuno: 'Desayuno', comida: 'Comida', cena: 'Cena', picnic: 'Picnic', merienda: 'Merienda', otro: 'Otro' };

type Filter = 'proximos' | 'sin_menu' | 'pasados';

const FILTER_MARKS: Record<Filter, FbMark> = {
  proximos: { feedbackId: 'food.eventos.filtros.proximos', feedbackLabel: 'Próximos' },
  sin_menu: { feedbackId: 'food.eventos.filtros.sin_menu', feedbackLabel: 'Sin menú' },
  pasados: { feedbackId: 'food.eventos.filtros.pasados', feedbackLabel: 'Pasados' },
};

/** Chip con el estado del menú de un evento, o «sin menú». */
export function menuChip(event: FoodEvent, menu: Mirror<Menu> | undefined): HTMLElement | null {
  if (isCancelled(event)) return el('span', { class: 'chip trash' }, 'Cancelado');
  if (menu) {
    if (isMenuStale(menu, event)) return el('span', { class: 'chip alert' }, 'Menú desactualizado');
    return el('span', { class: menu.status === 'validado' || menu.status === 'cerrado' ? 'chip ok' : 'chip' }, `Menú: ${MENU_STATUS_LABELS[menu.status].toLowerCase()}`);
  }
  if (noMealsInBooking(event)) return el('span', { class: 'chip trash' }, 'Sin comidas en Booking');
  return el('span', { class: 'chip' }, 'Sin menú');
}

/** Eventos: los retiros confirmados en Booking tal como los ve cocina, con caché local para verlos sin red. */
export const mountEvents: ViewMount = ({ main, client, navigate }) => {
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let menus: Mirror<Menu>[] = [];
  let totals = new Map<string, { total: number; missing: number; stale: number }>();
  let filter: Filter = 'proximos';
  let sheet: Sheet | null = null;
  const canWrite = () => client.bootstrap()?.membership.role !== 'reader';

  const tab = (value: Filter, label: string) => fb(el('button', { type: 'button', 'data-filter': value, 'aria-pressed': String(filter === value),
    onclick: () => { filter = value; for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === value)); paint(); } }, label), FILTER_MARKS[value]);
  const tabs = el('div', { 'data-feedback-id': 'food.eventos.filtros', 'data-feedback-label': 'Filtro de eventos', class: 'segmented', role: 'group', 'aria-label': 'Filtro de eventos' }, tab('proximos', 'Próximos'), tab('sin_menu', 'Sin menú'), tab('pasados', 'Pasados'));
  const list = el('ul', { class: 'list', id: 'eventList', 'aria-label': 'Eventos' });
  const host = el('div');
  const stamp = el('p', { class: 'muted stamp', id: 'eventsStamp' });

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Eventos'), el('p', null, 'Los retiros confirmados en Booking: personas, régimen y restricciones. Aquí no se editan.'))),
    el('div', { class: 'toolbar' }, tabs),
    host,
    stamp,
  );

  const menuOf = (event: FoodEvent) => menus.find((m) => m.event_id === event.event_id && !m.deleted_at);

  function visible(): FoodEvent[] {
    const today = todayKey();
    const upcoming = snapshot.events.filter((e) => e.end_date >= today);
    if (filter === 'proximos') return upcoming;
    if (filter === 'sin_menu') return upcoming.filter((e) => !isCancelled(e) && !menuOf(e));
    return snapshot.events.filter((e) => e.end_date < today).reverse();
  }

  function paint(): void {
    const events = visible();
    replace(list, ...events.map((event) => {
      const menu = menuOf(event);
      const restrictions = event.dietary_restrictions?.length ?? 0;
      return listRow({
        id: event.event_id,
        title: event.title,
        meta: [`${dateRange(event)} (${whenLabel(event).toLowerCase()})`, guestsLabel(event), mealPlanLabel(event.meal_plan)],
        // Con alguna alergia o intolerancia en el grupo, el aviso de restricciones va en rojo.
        chips: [menuChip(event, menu), menu && (totals.get(menu.id)?.total ?? 0) > 0 ? el('span', { class: totals.get(menu.id)!.missing || totals.get(menu.id)!.stale ? 'chip alert' : 'chip', title: [totals.get(menu.id)!.missing ? 'Faltan precios de algún ingrediente' : '', totals.get(menu.id)!.stale ? 'Algún precio es de la última compra, de hace más de 3 meses' : ''].filter(Boolean).join('. ') || 'Coste estimado con las compras de Invoices de los últimos 3 meses' }, `≈ ${Math.round(totals.get(menu.id)!.total).toLocaleString('es-ES')} €${totals.get(menu.id)!.missing ? '+' : ''}${totals.get(menu.id)!.stale ? ' *' : ''}`) : null, restrictions ? el('span', { class: allergyCount(event.dietary_restrictions) ? 'chip alert' : 'chip' }, restrictions === 1 ? '1 restricción' : `${restrictions} restricciones`) : null],
        pending: menu?._pending === true,
        label: `Abrir ${event.title}`,
        onClick: () => openEvent(event),
      });
    }));
    const empty = snapshot.fetchedAt === null
      ? el('div', { class: 'empty' }, el('strong', null, 'Todavía no se han podido leer los eventos'), 'Hace falta conexión la primera vez. Después se pueden consultar sin red.')
      : el('div', { class: 'empty plain' }, filter === 'sin_menu' ? 'Todos los eventos próximos con comidas tienen ya su menú.' : filter === 'pasados' ? 'No hay eventos pasados.' : 'No hay eventos próximos confirmados en Booking.');
    fbRows(list, { feedbackId: 'food.eventos.lista', feedbackLabel: 'Eventos' }, { feedbackId: 'food.eventos.lista.evento', feedbackLabel: 'Evento' });
    replace(host, events.length ? list : empty);
    stamp.textContent = snapshot.fetchedAt ? `Datos de los eventos a fecha de ${formatDate(snapshot.fetchedAt)}.` : '';
  }

  // --- Ficha del evento y alta del menú ---------------------------------------------------
  function openEvent(event: FoodEvent): void {
    const menu = menuOf(event);
    const restrictions = sortedRestrictions(event.dietary_restrictions);
    // Régimen con el que proponer servicios: el de Booking si lo hay; si no, lo elige la cocina (o ninguno).
    const gap = mealsGap(event);
    const plan = el('select', { 'data-feedback-id': 'food.eventos.ficha.regimen', 'data-feedback-label': 'Régimen de la propuesta', id: 'proposalPlan', 'aria-label': 'Proponer servicios como', onchange: () => paintPicks() },
      el('option', { value: '' }, 'Ninguno: añadiré los servicios a mano'),
      ...['pension_completa', 'media_pension', 'desayuno'].map((value) => el('option', { value, selected: event.meal_plan === value }, MEAL_PLAN_LABELS[value]!)));
    if (!gap && event.meal_plan && !['pension_completa', 'media_pension', 'desayuno'].includes(event.meal_plan)) plan.value = '';
    let picks: Array<{ service: ProposedService; box: HTMLInputElement }> = [];
    const picksHost = el('div', { 'data-feedback-id': 'food.eventos.ficha.servicios', 'data-feedback-label': 'Servicios propuestos', id: 'proposedServices' });
    function paintPicks(): void {
      const proposal = plan.value ? proposeServices({ ...event, meal_plan: plan.value }) : [];
      picks = proposal.map((service, index) => ({ service, box: el('input', { 'data-feedback-id': 'food.eventos.ficha.servicio_propuesto', 'data-feedback-label': 'Servicio propuesto', type: 'checkbox', checked: true, id: `propose-${index}` }) }));
      replace(picksHost, ...(picks.length
        ? picks.map((p) => el('label', { class: 'checkline', for: p.box.id }, p.box, el('span', null, `${longDay(p.service.service_date)} · ${SERVICE_LABELS[p.service.service_type]} · ${shortTime(p.service.service_time)}`)))
        : [el('p', { class: 'muted' }, 'Sin servicios propuestos: el menú se crea vacío y los servicios se añaden después.')]));
    }
    paintPicks();
    const create = el('button', { 'data-feedback-id': 'food.eventos.ficha.crear_menu', 'data-feedback-label': 'Crear menú', class: 'primary', type: 'button', id: 'createMenu', onclick: () => void createMenu(event, picks.filter((p) => p.box.checked).map((p) => p.service)) }, 'Crear menú');
    const open = el('button', { 'data-feedback-id': 'food.eventos.ficha.abrir_menu', 'data-feedback-label': 'Abrir menú', class: 'primary', type: 'button', id: 'openMenu', onclick: () => { void sheet?.close(true); navigate(`#/menus/${menu!.id}`); } }, 'Abrir menú');
    const close = el('button', { 'data-feedback-id': 'food.eventos.ficha.cerrar', 'data-feedback-label': 'Cerrar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar');
    const cancelled = isCancelled(event);
    const canCreate = !menu && !cancelled && canWrite();

    const body = el('div', { 'data-feedback-id': 'food.eventos.ficha', 'data-feedback-label': 'Ficha del evento', class: 'ficha' },
      el('dl', { 'data-feedback-id': 'food.eventos.ficha.datos', 'data-feedback-label': 'Datos del evento', class: 'kv' },
        el('dt', null, 'Fechas'), el('dd', null, dateRange(event)),
        el('dt', null, 'Personas'), el('dd', null, guestsLabel(event) + (event.minors_count ? ` · ${event.minors_count} menores` : '')),
        el('dt', null, 'Régimen'), el('dd', null, mealPlanLabel(event.meal_plan)),
        el('dt', null, 'Tipo de menú'), el('dd', null, event.menu_style ?? '—'),
        el('dt', null, 'Llegada y salida'), el('dd', null, `${shortTime(event.arrival_time) || '—'} · ${shortTime(event.departure_time) || '—'}`),
        el('dt', null, 'Códigos'), el('dd', { 'data-feedback-ignore': '' }, [event.event_code, event.reservation_code].filter(Boolean).join(' · ') || '—'),
      ),
      event.meal_notes ? el('p', { 'data-feedback-ignore': '' }, el('strong', null, 'Notas de alimentación: '), event.meal_notes) : null,
      el('section', { 'data-feedback-id': 'food.eventos.ficha.restricciones', 'data-feedback-label': 'Restricciones', 'data-feedback-ignore': '', class: 'restrictions' }, el('h4', null, 'Restricciones'),
        restrictions.length ? el('ul', { class: 'plainlist' }, ...restrictions.map((r) => el('li', { class: r.type === 'alergia' || r.type === 'intolerancia' ? 'warnline' : '' }, restrictionLabel(r)))) : el('p', { class: 'muted' }, 'Ninguna comunicada.')),
      cancelled ? el('p', null, el('span', { class: 'chip trash' }, 'La reserva está cancelada en Booking: no hace falta menú.')) : null,
      !menu && !cancelled && !canWrite() ? el('p', { class: 'muted' }, 'Tu cuenta es de solo lectura: el menú lo crea alguien de cocina.') : null,
      canCreate && gap ? el('div', { 'data-feedback-id': 'food.eventos.ficha.aviso_comidas', 'data-feedback-label': 'Aviso de comidas', class: 'banner warn notice', id: 'mealsGap', role: 'note' },
        el('div', { 'data-feedback-ignore': '' }, el('strong', null, gap), ' Puedes crear el menú igualmente. Si este grupo come aquí, corrígelo también en Booking',
          event.reservation_code ? ` (reserva ${event.reservation_code})` : '', ' para que los datos coincidan.'),
        el('div', { class: 'btnrow' }, el('a', { 'data-feedback-id': 'food.eventos.ficha.abrir_booking', 'data-feedback-label': 'Abrir en Booking', class: 'ghost', href: bookingReservationUrl(event), target: '_blank', rel: 'noopener', id: 'openBooking' }, event.reservation_id ? 'Abrir la reserva en Booking' : 'Abrir Booking'))) : null,
      canCreate ? el('fieldset', { 'data-feedback-id': 'food.eventos.ficha.propuesta', 'data-feedback-label': 'Propuesta de servicios', class: 'formblock' }, el('legend', null, 'Servicios propuestos'),
        el('label', { class: 'field' }, el('span', null, gap ? 'Proponer servicios como' : 'Régimen de la propuesta'), plan),
        picksHost,
        el('span', { class: 'hint' }, 'Es solo una propuesta. Después se pueden añadir, quitar, ordenar y cambiar de hora.')) : null,
    );

    sheet = openSheet({
      title: event.title,
      meta: snapshot.fetchedAt ? `Datos a fecha de ${formatDate(snapshot.fetchedAt)}` : undefined,
      body,
      foot: menu ? [close, open] : canCreate ? [close, create] : [close],
      onClose: () => { sheet = null; },
    });
    // El título del evento viene de Booking (nombre del grupo).
    const sheetTitle = sheet.panel.querySelector('.sheet-head h2');
    if (sheetTitle) fbIgnore(sheetTitle);
  }

  async function createMenu(event: FoodEvent, services: ProposedService[]): Promise<void> {
    const menuId = crypto.randomUUID();
    const operations: RowOperation[] = [
      { op: 'insert', table: T.menus, id: menuId, fields: { event_id: event.event_id, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) } },
      ...services.map((s, index): RowOperation => ({ op: 'insert', table: T.menuServices, id: crypto.randomUUID(),
        fields: { menu_id: menuId, service_date: s.service_date, service_type: s.service_type, service_time: s.service_time, position: index + 1 } })),
    ];
    const issue = validateOperations(operations);
    if (issue) { toast(issue.message); return; }
    try {
      await usage.run('food.eventos.crear_menu', () => client.commit(operations));
      await sheet?.close(true);
      navigate(`#/menus/${menuId}`);
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function loadMenus(): Promise<void> {
    menus = (await client.list(T.menus)) as Mirror<Menu>[];
    const [graphs, purchases] = await Promise.all([loadAllMenuGraphs(client), loadPurchases(client)]);
    totals = purchases.fetchedAt ? menuTotals(graphs, purchases.prices) : new Map();
    paint();
  }

  void loadMenus();
  const offEvents = watchEvents(client, (next) => { snapshot = next; paint(); });
  const offMenus = client.onTable(T.menus, () => void loadMenus());
  const offStatus = client.onStatus(() => void refreshEvents(client));
  return () => {
    offEvents();
    offMenus();
    offStatus();
    void closeSheet(true);
  };
};
