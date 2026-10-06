import type { RowOperation } from '@ikisai/sync-client';
import { eventSnapshot, isMenuStale, proposeServices, validateOperations, type FoodEvent, type Menu, type ProposedService, type ServiceType } from '@ikisai/domain-food';
import { closeSheet, el, formatDate, listRow, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { T, describeError, type Mirror } from '../app/client.ts';
import {
  allergyCount, dateRange, guestsLabel, isCancelled, longDay, mealPlanLabel, needsMenu, refreshEvents, restrictionLabel, shortTime, sortedRestrictions, todayKey, watchEvents, whenLabel,
  type EventsSnapshot,
} from '../app/events.ts';
import type { ViewMount } from './shell.ts';

export const MENU_STATUS_LABELS: Record<Menu['status'], string> = { borrador: 'Borrador', revisar: 'Por revisar', validado: 'Validado', cerrado: 'Cerrado' };
export const SERVICE_LABELS: Record<ServiceType, string> = { desayuno: 'Desayuno', comida: 'Comida', cena: 'Cena', picnic: 'Picnic', merienda: 'Merienda', otro: 'Otro' };

type Filter = 'proximos' | 'sin_menu' | 'pasados';

/** Chip con el estado del menú de un evento, o «sin menú». */
export function menuChip(event: FoodEvent, menu: Mirror<Menu> | undefined): HTMLElement | null {
  if (isCancelled(event)) return el('span', { class: 'chip trash' }, 'Cancelado');
  if (!needsMenu(event)) return el('span', { class: 'chip trash' }, 'Sin comidas');
  if (!menu) return el('span', { class: 'chip' }, 'Sin menú');
  if (isMenuStale(menu, event)) return el('span', { class: 'chip alert' }, 'Menú desactualizado');
  return el('span', { class: menu.status === 'validado' || menu.status === 'cerrado' ? 'chip ok' : 'chip' }, `Menú: ${MENU_STATUS_LABELS[menu.status].toLowerCase()}`);
}

/** Eventos: los retiros confirmados en Booking tal como los ve cocina, con caché local para verlos sin red. */
export const mountEvents: ViewMount = ({ main, client, navigate }) => {
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let menus: Mirror<Menu>[] = [];
  let filter: Filter = 'proximos';
  let sheet: Sheet | null = null;
  const canWrite = () => client.bootstrap()?.membership.role !== 'reader';

  const tab = (value: Filter, label: string) => el('button', { type: 'button', 'data-filter': value, 'aria-pressed': String(filter === value),
    onclick: () => { filter = value; for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === value)); paint(); } }, label);
  const tabs = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Filtro de eventos' }, tab('proximos', 'Próximos'), tab('sin_menu', 'Sin menú'), tab('pasados', 'Pasados'));
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
    if (filter === 'sin_menu') return upcoming.filter((e) => needsMenu(e) && !menuOf(e));
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
        chips: [menuChip(event, menu), restrictions ? el('span', { class: allergyCount(event.dietary_restrictions) ? 'chip alert' : 'chip' }, restrictions === 1 ? '1 restricción' : `${restrictions} restricciones`) : null],
        pending: menu?._pending === true,
        label: `Abrir ${event.title}`,
        onClick: () => openEvent(event),
      });
    }));
    const empty = snapshot.fetchedAt === null
      ? el('div', { class: 'empty' }, el('strong', null, 'Todavía no se han podido leer los eventos'), 'Hace falta conexión la primera vez. Después se pueden consultar sin red.')
      : el('div', { class: 'empty plain' }, filter === 'sin_menu' ? 'Todos los eventos próximos con comidas tienen ya su menú.' : filter === 'pasados' ? 'No hay eventos pasados.' : 'No hay eventos próximos confirmados en Booking.');
    replace(host, events.length ? list : empty);
    stamp.textContent = snapshot.fetchedAt ? `Datos de los eventos a fecha de ${formatDate(snapshot.fetchedAt)}.` : '';
  }

  // --- Ficha del evento y alta del menú ---------------------------------------------------
  function openEvent(event: FoodEvent): void {
    const menu = menuOf(event);
    const restrictions = sortedRestrictions(event.dietary_restrictions);
    const proposal = proposeServices(event);
    const picks = proposal.map((service, index) => {
      const box = el('input', { type: 'checkbox', checked: true, id: `propose-${index}` });
      return { service, box, node: el('label', { class: 'checkline', for: box.id }, box, el('span', null, `${longDay(service.service_date)} · ${SERVICE_LABELS[service.service_type]} · ${shortTime(service.service_time)}`)) };
    });
    const create = el('button', { class: 'primary', type: 'button', id: 'createMenu', onclick: () => void createMenu(event, picks.filter((p) => p.box.checked).map((p) => p.service)) }, 'Crear menú');
    const open = el('button', { class: 'primary', type: 'button', id: 'openMenu', onclick: () => { void sheet?.close(true); navigate(`#/menus/${menu!.id}`); } }, 'Abrir menú');
    const close = el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar');
    const canCreate = !menu && needsMenu(event) && canWrite();

    const body = el('div', { class: 'ficha' },
      el('dl', { class: 'kv' },
        el('dt', null, 'Fechas'), el('dd', null, dateRange(event)),
        el('dt', null, 'Personas'), el('dd', null, guestsLabel(event) + (event.minors_count ? ` · ${event.minors_count} menores` : '')),
        el('dt', null, 'Régimen'), el('dd', null, mealPlanLabel(event.meal_plan)),
        el('dt', null, 'Tipo de menú'), el('dd', null, event.menu_style ?? '—'),
        el('dt', null, 'Llegada y salida'), el('dd', null, `${shortTime(event.arrival_time) || '—'} · ${shortTime(event.departure_time) || '—'}`),
        el('dt', null, 'Códigos'), el('dd', null, [event.event_code, event.reservation_code].filter(Boolean).join(' · ') || '—'),
      ),
      event.meal_notes ? el('p', null, el('strong', null, 'Notas de alimentación: '), event.meal_notes) : null,
      el('section', { class: 'restrictions' }, el('h4', null, 'Restricciones'),
        restrictions.length ? el('ul', { class: 'plainlist' }, ...restrictions.map((r) => el('li', { class: r.type === 'alergia' || r.type === 'intolerancia' ? 'warnline' : '' }, restrictionLabel(r)))) : el('p', { class: 'muted' }, 'Ninguna comunicada.')),
      isCancelled(event) ? el('p', null, el('span', { class: 'chip trash' }, 'La reserva está cancelada: no hace falta menú.')) : null,
      canCreate ? el('fieldset', { class: 'formblock' }, el('legend', null, 'Servicios propuestos'),
        proposal.length ? el('div', null, ...picks.map((p) => p.node)) : el('p', { class: 'muted' }, 'Sin propuesta para este régimen: los servicios se añaden después a mano.'),
        el('span', { class: 'hint' }, 'Es solo una propuesta según el régimen. Después se pueden añadir, quitar y cambiar de hora.')) : null,
    );

    sheet = openSheet({
      title: event.title,
      meta: snapshot.fetchedAt ? `Datos a fecha de ${formatDate(snapshot.fetchedAt)}` : undefined,
      body,
      foot: menu ? [close, open] : canCreate ? [close, create] : [close],
      onClose: () => { sheet = null; },
    });
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
      await client.commit(operations);
      await sheet?.close(true);
      navigate(`#/menus/${menuId}`);
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function loadMenus(): Promise<void> {
    menus = (await client.list(T.menus)) as Mirror<Menu>[];
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
