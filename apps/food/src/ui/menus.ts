import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, HOUSE_MENU_ID, LOCKED_MENU_STATUSES, SERVICE_TYPES, consumptionLines, serviceConsumption, type Consumption, isHouseMenu, isQuickPending, quickDishOperations, weekDays, dishCost, prepLabel, priceFor, eventChanges, eventSnapshot, isMenuStale, menuWarnings, scaledIngredients, serviceCosts, validateOperations,
  type Equipment, type EventChange, type FoodEvent, type Ingredient, type Menu, type MenuComment, type MenuGraph, type MenuItem, type MenuService, type MenuWarning, type RecipeEquipment,
  type RecipeIngredient,
} from '@ikisai/domain-food';
import { closeSheet, confirmDialog, createSortableList, el, formatDate, icon, listRow, openSheet, plural, renderMoneyBreakdown, replace, toast, type Sheet, type Sortable } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { ALLERGEN_LABELS, CATEGORY_LABELS, DIET_LABELS, T, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import {
  dateRange, eventDays, guestsLabel, longDay, mealPlanLabel, refreshEvents, todayKey, restrictionLabel, shortTime, sortedRestrictions, watchEvents, type EventsSnapshot,
} from '../app/events.ts';
import { HOUSE_MENU_HASH, loadHouseToday, type HouseToday } from '../app/house.ts';
import { confirmConsumption, loadInventory, type DishDecision, type InventoryData } from '../app/consumption.ts';
import { HOUSE_SUGGESTIONS_HASH, houseSuggestionsSummary, pendingDishesText } from './house-suggestions.ts';
import { loadMenuData, type RecipeRow } from '../app/menu-data.ts';
import { showPhoto } from '../app/photos.ts';
import { loadPurchases, type PurchasesSnapshot } from '../app/purchases.ts';
import { methodStepsView } from './method-steps.ts';
import { mountClosing } from './menu-closing.ts';
import { mountOrganizer } from './menu-organizer.ts';
import { mountPreparation } from './menu-preparation.ts';
import { mountShopping } from './menu-shopping.ts';
import { MENU_STATUS_LABELS, SERVICE_LABELS, menuChip } from './events.ts';
import type { ViewContext, ViewMount } from './shell.ts';
import { usage } from '../app/usage.ts';
import { fb, fbRows, type FbMark } from './feedback.ts';

type MenuRow = Mirror<Menu>;
type ServiceRow = Mirror<MenuService>;
type ItemRow = Mirror<MenuItem>;
type CommentRow = Mirror<MenuComment>;

const COMMENT_KIND_LABELS: Record<MenuComment['kind'], string> = { prefiero_que_no: 'Prefiere que no', comentario: 'Comentario' };
const COMMENT_STATUS_LABELS: Record<MenuComment['status'], string> = { nuevo: 'Nuevo', visto: 'Visto', resuelto: 'Resuelto' };
const REPLY_MAX = 1000;
/** «3 comentarios nuevos» (con «del organizador» en la ficha). */
const newCommentsText = (n: number) => plural(n, 'comentario nuevo', 'comentarios nuevos');
/** Al pulsar el aviso desde otra pestaña: la ficha vuelve a Menú y baja a los comentarios. */
let scrollToComments = false;

export type MenuTab = 'menu' | 'compra' | 'preparacion' | 'organizador' | 'cierre';
const TABS: Array<[MenuTab, string]> = [['menu', 'Menú'], ['compra', 'Compra'], ['preparacion', 'Preparación'], ['organizador', 'Organizador'], ['cierre', 'Cierre']];
const TAB_MARKS: Record<MenuTab, FbMark> = {
  menu: { feedbackId: 'food.menu.pestanas.menu', feedbackLabel: 'Menú' },
  compra: { feedbackId: 'food.menu.pestanas.compra', feedbackLabel: 'Compra' },
  preparacion: { feedbackId: 'food.menu.pestanas.preparacion', feedbackLabel: 'Preparación' },
  organizador: { feedbackId: 'food.menu.pestanas.organizador', feedbackLabel: 'Organizador' },
  cierre: { feedbackId: 'food.menu.pestanas.cierre', feedbackLabel: 'Cierre' },
};

const removeOp = (table: (typeof T)[keyof typeof T], row: SyncedRow): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });

/** Menús: uno por evento, con su estado. */
export const mountMenus: ViewMount = ({ main, client, navigate }) => {
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let menus: MenuRow[] = [];
  let fresh = new Map<string, number>(); // comentarios nuevos del organizador por menú
  const list = el('ul', { class: 'list', id: 'menuList', 'aria-label': 'Menús' });
  const host = el('div');
  let house: HouseToday = { exists: false, lines: [] };
  let suggestions: { pending: number } | null = null; // platos sugeridos (O3c): solo si hay alguno y se pueden revisar
  const houseHost = el('div', { id: 'houseMenu' });
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Menús'), el('p', null, 'El menú de cada evento. Se crean desde Eventos.'))),
    houseHost,
    host,
  );

  /** El menú de casa, fijo arriba: siempre abierto, con lo de hoy (O3a), y los platos sugeridos debajo (O3c). */
  function paintHouse(): void {
    replace(houseHost, el('ul', { class: 'list houselist', 'aria-label': 'Menú de casa' }, fb(listRow({
      id: HOUSE_MENU_ID,
      title: 'Menú de casa',
      meta: house.lines.length ? [`Hoy: ${house.lines.join('; ')}`] : [house.exists ? 'Hoy no hay nada previsto' : 'El día a día de la casa, sin evento'],
      label: 'Abrir el menú de casa',
      onClick: () => navigate(HOUSE_MENU_HASH),
    }), { feedbackId: 'food.menus.casa', feedbackLabel: 'Menú de casa' }),
    suggestions ? fb(listRow({
      id: 'houseSuggestions',
      title: 'Platos sugeridos',
      meta: ['Propuestas de fuera para el menú de casa'],
      chips: [el('span', { class: suggestions.pending ? 'chip warn' : 'chip' }, pendingDishesText(suggestions.pending))],
      label: 'Revisar los platos sugeridos',
      onClick: () => navigate(HOUSE_SUGGESTIONS_HASH),
    }), { feedbackId: 'food.menus.sugerencias', feedbackLabel: 'Platos sugeridos' }) : null));
  }

  function paint(): void {
    paintHouse();
    const events = new Map(snapshot.events.map((e) => [e.event_id, e]));
    const rows = menus.filter((m) => !m.deleted_at && !isHouseMenu(m))
      .map((menu) => ({ menu, event: menu.event_id ? events.get(menu.event_id) : undefined }))
      .sort((a, b) => (b.event?.start_date ?? '').localeCompare(a.event?.start_date ?? ''));
    replace(list, ...rows.map(({ menu, event }) => listRow({
      id: menu.id,
      title: event?.title ?? 'Evento no disponible',
      meta: event ? [dateRange(event), guestsLabel(event), mealPlanLabel(event.meal_plan)] : ['Sin datos del evento en este dispositivo'],
      chips: [event ? menuChip(event, menu) : el('span', { class: 'chip' }, MENU_STATUS_LABELS[menu.status]),
        fresh.get(menu.id) ? el('span', { class: 'chip warn menucomments-new' }, newCommentsText(fresh.get(menu.id)!)) : null].filter((c): c is HTMLElement => c !== null),
      pending: menu._pending === true,
      label: `Abrir el menú de ${event?.title ?? 'este evento'}`,
      onClick: () => navigate(`#/menus/${menu.id}`),
    })));
    fbRows(list, { feedbackId: 'food.menus.lista', feedbackLabel: 'Menús' }, { feedbackId: 'food.menus.lista.menu', feedbackLabel: 'Menú' });
    replace(host, rows.length ? list : el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay menús'),
      'Abre un evento en Eventos y pulsa «Crear menú» en su ficha.', el('p', { style: 'margin-top:10px' }, el('button', { 'data-feedback-id': 'food.menus.ir_eventos', 'data-feedback-label': 'Ir a Eventos', class: 'ghost', type: 'button', onclick: () => navigate('#/eventos') }, 'Ir a Eventos'))));
  }

  async function load(): Promise<void> {
    const [rows, comments] = await Promise.all([client.list(T.menus) as Promise<MenuRow[]>, client.list(T.menuComments) as Promise<CommentRow[]>]);
    menus = rows;
    house = await loadHouseToday(client);
    fresh = new Map();
    for (const c of comments) if (c.status === 'nuevo' && !c.deleted_at) fresh.set(c.menu_id, (fresh.get(c.menu_id) ?? 0) + 1);
    paint();
  }
  void load();
  void houseSuggestionsSummary(client).then((s) => { suggestions = s; paintHouse(); });
  const offEvents = watchEvents(client, (next) => { snapshot = next; paint(); });
  const offTables = [T.menus, T.menuComments, T.menuServices, T.menuItems].map((table) => client.onTable(table, () => void load()));
  return () => { offEvents(); offTables.forEach((off) => off()); };
};

const CHANGE_LABELS: Record<EventChange['field'], string> = { guest_count: 'Personas', dates: 'Fechas', meal_plan: 'Régimen', menu_style: 'Tipo de menú', restrictions: 'Restricciones' };

function changeText(change: EventChange): string {
  const show = (value: unknown): string => {
    if (change.field === 'dates') { const [start, end] = value as [string, string]; return dateRange({ start_date: start, end_date: end }); }
    if (change.field === 'meal_plan') return mealPlanLabel(value as string | null);
    if (change.field === 'restrictions') return (value as FoodEvent['dietary_restrictions']).map(restrictionLabel).join(', ') || 'ninguna';
    return value === null || value === undefined ? '—' : String(value);
  };
  return `${CHANGE_LABELS[change.field]}: ${show(change.before)} → ${show(change.after)}`;
}

/** Ficha de un menú: cabecera con el evento y sus restricciones siempre a la vista, y pestañas Menú · Compra · Preparación · Organizador · Cierre. */
export function mountMenu(menuId: string, tab: MenuTab = 'menu'): ViewMount {
  return ({ main, client, navigate }: ViewContext) => {
    let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
    let menu: MenuRow | null = null;
    let services: ServiceRow[] = [];
    let items: ItemRow[] = [];
    let comments: CommentRow[] = [];
    const replyDrafts = new Map<string, string>(); // lo escrito en cada respuesta sobrevive a los repintados
    let recipes: RecipeRow[] = [];
    let recipeLines: Mirror<RecipeIngredient>[] = [];
    let ingredients: Mirror<Ingredient>[] = [];
    let equipment: Mirror<Equipment>[] = [];
    let needs: Mirror<RecipeEquipment>[] = [];
    let menuGraph: MenuGraph = { services: [], items: [], recipes: [], recipe_ingredients: [], ingredients: [] };
    // Consumo al acabar el servicio (R5c): solo con inventario, es decir, con sitios de cocina en Recursos.
    let inventory: InventoryData | null = null;
    let consumptions: Array<Mirror<Consumption>> = [];
    const consumptionOf = (service: ServiceRow) => (inventory?.kitchen.size ? serviceConsumption(service, menuGraph, consumptions, inventory.movements, new Date()) : null);
    let sheet: Sheet | null = null;
    let busy = false;
    // Listas reordenables del constructor (kit): servicios de cada día y, dentro, platos de cada servicio.
    // Se conservan entre repintados y se actualizan con `setItems`: así cada movimiento lleva revisiones al día y no se pierde el foco.
    const dayLists = new Map<string, Sortable<ServiceRow>>();
    const dishLists = new Map<string, Sortable<ItemRow>>();
    const listSigs = new Map<string, string>();
    let builderShape = '';
    let cook = false; // vista de cocinero: cada plato con sus ingredientes escalados, maquinaria y elaboración
    let unmountTab: (() => void) | null = null;
    const canWrite = () => client.bootstrap()?.membership.role !== 'reader';
    const event = () => snapshot.events.find((e) => e.event_id === menu?.event_id) ?? null;
    const locked = () => !menu || LOCKED_MENU_STATUSES.includes(menu.status) || !canWrite();
    /** Menú de casa (O3a): sin evento, siempre abierto, por semanas y con plato rápido. */
    const house = () => menuId === HOUSE_MENU_ID || isHouseMenu(menu);
    let weekOffset = 0;
    const defaultServings = () => (house() ? Number(menu?.house_servings ?? 0) || 1 : event()?.guest_count ?? 1);

    const head = el('div', { 'data-feedback-id': 'food.menu.cabecera', 'data-feedback-label': 'Cabecera del menú', class: 'pagehead' });
    // Platos sugeridos pendientes (O3c): un aviso en la cabecera del menú de casa, si hay alguno.
    let suggested: { pending: number } | null = null;
    if (menuId === HOUSE_MENU_ID) void houseSuggestionsSummary(client).then((s) => { suggested = s; if (house()) paintHouseHead(); });
    const banner = el('div', { id: 'menuStale' });
    const restrictionsHost = el('section', { 'data-feedback-id': 'food.menu.restricciones', 'data-feedback-label': 'Restricciones', 'data-feedback-ignore': '', class: 'restrictions card', id: 'menuRestrictions' });
    const builder = el('div', { 'data-feedback-id': 'food.menu.constructor', 'data-feedback-label': 'Constructor del menú', class: 'menubuilder', id: 'menuBuilder' });
    const costHost = el('section', { 'data-feedback-id': 'food.menu.coste', 'data-feedback-label': 'Coste estimado', class: 'card menucost', id: 'menuCost', hidden: true });
    let purchases: PurchasesSnapshot = { purchases: [], prices: new Map(), fetchedAt: null };
    const actions = el('div', { 'data-feedback-id': 'food.menu.estado', 'data-feedback-label': 'Estado del menú', class: 'btnrow menuactions', id: 'menuActions' });
    const cookToggle = el('button', { 'data-feedback-id': 'food.menu.vista_cocinero', 'data-feedback-label': 'Vista de cocinero', class: 'linkbtn', type: 'button', id: 'cookView', 'aria-pressed': 'false',
      onclick: () => { cook = !cook; cookToggle.setAttribute('aria-pressed', String(cook)); cookToggle.textContent = cook ? 'Volver al constructor' : 'Vista de cocinero'; paintBuilder(); } }, 'Vista de cocinero');
    const tabs = el('nav', { 'data-feedback-id': 'food.menu.pestanas', 'data-feedback-label': 'Secciones del menú', class: 'segmented menutabs', 'aria-label': 'Secciones del menú' }, ...TABS.map(([value, label]) => {
      const hash = `#/menus/${menuId}${value === 'menu' ? '' : `/${value}`}`;
      return fb(el('a', { href: hash, 'data-tab': value, 'aria-current': value === tab ? 'page' : 'false', onclick: (e: Event) => { e.preventDefault(); navigate(hash); } }, label), TAB_MARKS[value]);
    }));
    const tabHost = el('div', { id: 'menuTab' });
    const commentsNotice = el('div', { id: 'menuCommentsNotice' });
    const shareHost = el('section', { 'data-feedback-id': 'food.menu.organizador_portal', 'data-feedback-label': 'Compartir con el organizador', class: 'card menushare', id: 'menuShare' });
    const commentsHost = el('section', { 'data-feedback-id': 'food.menu.comentarios', 'data-feedback-label': 'Comentarios del organizador', class: 'card menucomments', id: 'menuComments', hidden: true, tabindex: '-1' });
    replace(main, head, banner, commentsNotice, restrictionsHost, tabs,
      tab === 'menu' ? el('div', null, actions, shareHost, commentsHost, el('div', { class: 'btnrow' }, cookToggle), costHost, builder) : tabHost);

    const graph = (): MenuGraph => menuGraph;
    const warnings = (): MenuWarning[] => { const e = event(); return e ? menuWarnings(e, graph()) : []; };

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

    /** Acción de servidor: solo con red; al terminar refresca eventos y espejo. */
    async function call(procedure: string, args: Record<string, unknown>, okMessage: string): Promise<boolean> {
      if (busy) return false;
      busy = true;
      paintActions();
      try {
        await runCall(client, procedure, args);
        toast(okMessage);
        return true;
      } catch (error) {
        toast(describeError(error));
        if ((error as { code?: string }).code === 'EVENT_CHANGED') await refreshEvents(client, true);
        return false;
      } finally {
        busy = false;
        await load();
      }
    }

    // --- Cabecera, aviso de evento cambiado y restricciones ---------------------------------
    function paintHead(): void {
      if (house()) { paintHouseHead(); return; }
      const e = event();
      replace(head, el('div', null,
        el('p', { class: 'crumb' }, el('a', { 'data-feedback-id': 'food.menu.cabecera.volver', 'data-feedback-label': 'Volver a Menús', href: '#/menus', onclick: (ev: Event) => { ev.preventDefault(); navigate('#/menus'); } }, '← Menús')),
        el('h2', { 'data-feedback-ignore': '' }, e?.title ?? 'Menú'),
        el('p', null, e ? `${dateRange(e)} · ${guestsLabel(e)} · ${mealPlanLabel(e.meal_plan)}` : 'Los datos del evento no están en este dispositivo todavía.'),
        el('div', { class: 'chips', style: 'margin-top:8px' },
          menu ? el('span', { class: menu.status === 'validado' || menu.status === 'cerrado' ? 'chip ok' : 'chip', id: 'menuStatus' }, MENU_STATUS_LABELS[menu.status]) : null,
          menu?._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null),
      ));
    }

    /** Cabecera del menú de casa: siempre abierto y con las personas en casa, que son las raciones por defecto. */
    function paintHouseHead(): void {
      const current = () => (menu?.house_servings === null || menu?.house_servings === undefined ? null : Number(menu.house_servings));
      const people = el('input', { 'data-feedback-id': 'food.menu.casa.personas', 'data-feedback-label': 'Personas en casa', id: 'houseServings', type: 'text', inputmode: 'decimal', class: 'servings compact',
        value: current() ? formatQuantity(current()!) : '', placeholder: '—', 'aria-label': 'Personas en casa', disabled: !canWrite(),
        onchange: async () => {
          if (!menu) return;
          const value = people.value.trim() ? parseQuantity(people.value) : null;
          if (value !== null && value <= 0) { toast('Las personas deben ser un número mayor que cero.'); people.value = current() ? formatQuantity(current()!) : ''; return; }
          if (value !== current()) {
            const ok = await commitSafely([{ op: 'update', table: T.menus, id: menu.id, expectedRevision: menu.revision, fields: { house_servings: value } }]);
            usage.track('food.menu.casa.personas', ok ? 'success' : 'error');
          }
        } });
      replace(head, el('div', null,
        el('p', { class: 'crumb' }, el('a', { 'data-feedback-id': 'food.menu.cabecera.volver', 'data-feedback-label': 'Volver a Menús', href: '#/menus', onclick: (ev: Event) => { ev.preventDefault(); navigate('#/menus'); } }, '← Menús')),
        el('h2', null, 'Menú de casa'),
        el('p', null, 'Siempre abierto: lo que se come en casa, día a día. No se valida ni se cierra.'),
        el('label', { class: 'houseservings' }, el('span', null, 'Personas en casa'), people, el('span', { class: 'muted' }, 'raciones por defecto de cada plato')),
        menu?._pending ? el('div', { class: 'chips', style: 'margin-top:8px' }, el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar'))) : null,
        suggested?.pending ? el('div', { class: 'chips', style: 'margin-top:8px' },
          el('a', { 'data-feedback-id': 'food.menu.casa.sugerencias', 'data-feedback-label': 'Platos sugeridos', id: 'houseSuggestionsChip', class: 'chip warn', href: HOUSE_SUGGESTIONS_HASH,
            onclick: (ev: Event) => { ev.preventDefault(); navigate(HOUSE_SUGGESTIONS_HASH); } },
          suggested.pending === 1 ? '1 plato sugerido por revisar' : `${suggested.pending} platos sugeridos por revisar`)) : null,
      ));
    }

    function paintBanner(): void {
      const e = event();
      if (!menu || !e || !isMenuStale(menu, e)) { replace(banner); return; }
      const changes = eventChanges(menu.source_event_snapshot, e).map(changeText);
      const isLocked = LOCKED_MENU_STATUSES.includes(menu.status);
      replace(banner, el('div', { 'data-feedback-id': 'food.menu.aviso_evento', 'data-feedback-label': 'Aviso de evento cambiado', class: 'banner warn notice', role: 'status' },
        el('div', null,
          el('strong', null, 'La información del evento ha cambiado.'), ' Revisar antes de validar.',
          changes.length ? el('ul', { class: 'plainlist', 'data-feedback-ignore': '' }, ...changes.map((c) => el('li', null, c))) : null),
        canWrite() ? el('div', { class: 'btnrow' },
          isLocked
            ? el('button', { 'data-feedback-id': 'food.menu.aviso_evento.sigue_valido', 'data-feedback-label': 'Sigue siendo válido', class: 'ghost', type: 'button', id: 'revalidate', disabled: busy, onclick: () => void validate() }, 'Sigue siendo válido')
            : el('button', { 'data-feedback-id': 'food.menu.aviso_evento.revisado', 'data-feedback-label': 'He revisado los cambios', class: 'ghost', type: 'button', id: 'acknowledgeEvent', disabled: busy,
                onclick: () => void call(FOOD_PROCEDURES.acknowledgeEvent, { menu_id: menu!.id, expectedRevision: menu!.revision, event_revision: e.event_revision, event_snapshot: eventSnapshot(e) }, 'Cambios del evento revisados.') },
                'He revisado los cambios'),
          menu.status === 'validado' ? el('button', { 'data-feedback-id': 'food.menu.aviso_evento.reabrir', 'data-feedback-label': 'Reabrir para cambiar', class: 'ghost', type: 'button', id: 'reopenStale', disabled: busy, onclick: () => void setStatus('revisar', 'Menú reabierto.') }, 'Reabrir para cambiar') : null,
        ) : null,
      ));
    }

    function paintRestrictions(): void {
      restrictionsHost.hidden = house();
      if (house()) { replace(restrictionsHost); return; }
      const e = event();
      const list = sortedRestrictions(e?.dietary_restrictions);
      const found = warnings();
      replace(restrictionsHost,
        el('h3', null, icon('warn', 18), ' Restricciones'),
        list.length ? el('ul', { class: 'plainlist' }, ...list.map((r) => el('li', { class: r.type === 'alergia' || r.type === 'intolerancia' ? 'warnline' : '' }, restrictionLabel(r))))
          : el('p', { class: 'muted' }, e ? 'Ninguna comunicada.' : '—'),
        found.length ? el('ul', { class: 'warninglist', id: 'menuWarnings' }, ...found.map((w) =>
          el('li', { class: w.requiresAck ? 'warnline' : 'muted' }, w.text))) : null,
      );
    }

    // --- Portal del organizador: compartir y comentarios ------------------------------------
    const shared = () => menu?.organizer_shared === true;

    function goToComments(): void {
      if (tab !== 'menu') { scrollToComments = true; navigate(`#/menus/${menuId}`); return; }
      commentsHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
      commentsHost.focus({ preventScroll: true });
    }

    function paintCommentsNotice(): void {
      const count = comments.filter((c) => c.status === 'nuevo').length;
      if (!count) { replace(commentsNotice); return; }
      replace(commentsNotice, el('div', { 'data-feedback-id': 'food.menu.comentarios.aviso', 'data-feedback-label': 'Aviso de comentarios nuevos', class: 'banner info', role: 'status' },
        el('span', null, el('strong', null, `${newCommentsText(count)} del organizador`)),
        el('button', { 'data-feedback-id': 'food.menu.comentarios.ver', 'data-feedback-label': 'Ver comentarios', class: 'linkbtn', type: 'button', id: 'goComments', onclick: goToComments }, 'Ver comentarios')));
    }

    async function setShared(value: boolean): Promise<void> {
      if (!menu) return;
      const ok = await commitSafely([{ op: 'update', table: T.menus, id: menu.id, expectedRevision: menu.revision, fields: { organizer_shared: value } }]);
      if (value) usage.track('food.menu.compartir', ok ? 'success' : 'error');
      if (ok) toast(value ? 'Menú compartido con el organizador.' : 'El organizador ya no ve este menú.');
    }

    function paintShare(): void {
      shareHost.hidden = house();
      if (!menu || house()) { replace(shareHost); return; }
      const hint = el('p', { class: 'hint' }, 'El organizador lo verá en su portal como propuesta hasta que esté validado.');
      if (!shared()) {
        replace(shareHost, el('h3', null, 'Portal del organizador'),
          canWrite()
            ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.menu.organizador_portal.compartir', 'data-feedback-label': 'Compartir con el organizador', class: 'ghost', type: 'button', id: 'shareMenu', onclick: () => void setShared(true) }, 'Compartir con el organizador'))
            : el('p', { class: 'muted' }, 'Este menú no se ha compartido con el organizador.'),
          hint);
        return;
      }
      replace(shareHost, el('h3', null, 'Portal del organizador'),
        el('div', { class: 'btnrow' },
          el('span', { class: 'chip ok', id: 'menuShared' }, 'Compartido con el organizador'),
          canWrite() ? el('button', { 'data-feedback-id': 'food.menu.organizador_portal.dejar_compartir', 'data-feedback-label': 'Dejar de compartir', class: 'linkbtn', type: 'button', id: 'unshareMenu', onclick: () => void setShared(false) }, 'Dejar de compartir') : null),
        hint);
    }

    /** A qué se refiere el comentario: el plato (nombre interno de la receta), el servicio o el menú entero. */
    function commentTarget(comment: CommentRow): string {
      const serviceText = (service: ServiceRow | undefined) => (service ? `${SERVICE_LABELS[service.service_type]} · ${longDay(service.service_date)}` : null);
      if (comment.menu_item_id) {
        const item = items.find((i) => i.id === comment.menu_item_id);
        if (!item) return 'Plato retirado del menú';
        const where = serviceText(services.find((s) => s.id === item.service_id));
        return `${recipeOf(item)?.name ?? 'Receta retirada'}${where ? ` (${where})` : ''}`;
      }
      if (comment.service_id) return serviceText(services.find((s) => s.id === comment.service_id)) ?? 'Servicio retirado del menú';
      return 'Menú en general';
    }

    const updateComment = (comment: CommentRow, fields: Partial<Pick<MenuComment, 'status' | 'reply'>>) =>
      commitSafely([{ op: 'update', table: T.menuComments, id: comment.id, expectedRevision: comment.revision, fields }]);

    async function reply(comment: CommentRow, text: string): Promise<void> {
      const value = text.trim();
      if (value.length > REPLY_MAX) { toast(`La respuesta no puede pasar de ${REPLY_MAX} caracteres.`); return; }
      // Responder implica haberlo leído: un comentario nuevo pasa a visto.
      const ok = await updateComment(comment, { reply: value || null, ...(comment.status === 'nuevo' ? { status: 'visto' as const } : {}) });
      usage.track('food.menu.responder_comentario', ok ? 'success' : 'error');
      if (ok) { replyDrafts.delete(comment.id); toast(value ? 'Respuesta guardada.' : 'Respuesta borrada.'); paintComments(true); }
    }

    function commentRow(comment: CommentRow): HTMLElement {
      const statusClass = comment.status === 'nuevo' ? 'chip warn' : comment.status === 'resuelto' ? 'chip ok' : 'chip';
      let actionsRow: HTMLElement | null = null;
      if (canWrite()) {
        const field = el('textarea', { 'data-feedback-id': 'food.menu.comentarios.respuesta', 'data-feedback-label': 'Respuesta al organizador', class: 'replytext', maxlength: String(REPLY_MAX),
          rows: '2', 'aria-label': 'Respuesta al organizador', placeholder: 'Respuesta para el organizador',
          oninput: () => replyDrafts.set(comment.id, field.value) });
        field.value = replyDrafts.get(comment.id) ?? comment.reply ?? '';
        actionsRow = el('div', null, field,
          el('div', { class: 'btnrow' },
            el('button', { 'data-feedback-id': 'food.menu.comentarios.responder', 'data-feedback-label': 'Responder', class: 'ghost', type: 'button', onclick: () => void reply(comment, field.value) }, 'Responder'),
            comment.status === 'nuevo' ? el('button', { 'data-feedback-id': 'food.menu.comentarios.visto', 'data-feedback-label': 'Marcar como visto', class: 'ghost', type: 'button', onclick: () => void updateComment(comment, { status: 'visto' }) }, 'Visto') : null,
            comment.status !== 'resuelto' ? el('button', { 'data-feedback-id': 'food.menu.comentarios.resuelto', 'data-feedback-label': 'Marcar como resuelto', class: 'ghost', type: 'button', onclick: () => void updateComment(comment, { status: 'resuelto' }) }, 'Resuelto') : null),
          el('p', { class: 'hint' }, 'El organizador verá la respuesta en su portal.'));
      }
      return el('li', { 'data-feedback-id': 'food.menu.comentarios.comentario', 'data-feedback-label': 'Comentario del organizador', class: 'menucomment', 'data-id': comment.id, 'data-status': comment.status },
        el('div', { class: 'commenthead' },
          el('strong', null, commentTarget(comment)),
          el('span', { class: comment.kind === 'prefiero_que_no' ? 'chip alert' : 'chip' }, COMMENT_KIND_LABELS[comment.kind]),
          el('span', { class: `${statusClass} commentstatus` }, COMMENT_STATUS_LABELS[comment.status]),
          comment._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null),
        el('p', { class: 'commentmeta' }, formatDate(comment.created_at)),
        comment.message ? el('p', { class: 'commentmsg', 'data-feedback-ignore': '' }, comment.message) : null,
        comment.reply && !canWrite() ? el('p', { class: 'commentreply', 'data-feedback-ignore': '' }, el('strong', null, 'Respuesta: '), comment.reply) : null,
        actionsRow);
    }

    /** Solo se rehace si cambia algo de lo que enseña: así no se pierde el foco de una respuesta a medio escribir. */
    let commentsSig = '';
    function paintComments(force = false): void {
      const sig = JSON.stringify([shared(), canWrite(), comments.map((c) => `${c.id}:${c.revision}:${c._pending ? 1 : 0}`), comments.map(commentTarget)]);
      if (!force && sig === commentsSig) return;
      commentsSig = sig;
      if (!menu || (!comments.length && !shared())) { commentsHost.hidden = true; replace(commentsHost); return; }
      commentsHost.hidden = false;
      replace(commentsHost, el('h3', null, 'Comentarios del organizador'),
        comments.length ? el('ul', { class: 'commentlist' }, ...comments.map(commentRow)) : el('p', { class: 'muted' }, 'Sin comentarios del organizador.'));
    }

    // --- Estados ----------------------------------------------------------------------------
    const setStatus = (status: Menu['status'], okMessage: string) =>
      call(FOOD_PROCEDURES.setMenuStatus, { menu_id: menu!.id, expectedRevision: menu!.revision, status }, okMessage);

    function paintActions(): void {
      if (!menu || !canWrite() || house()) { replace(actions); return; }
      const button = (id: string, label: string, kind: 'primary' | 'ghost', onclick: () => void, mark: FbMark) => fb(el('button', { class: kind, type: 'button', id, disabled: busy, onclick }, label), mark);
      const validateButton = button('validateMenu', 'Validar', 'primary', () => void validate(), { feedbackId: 'food.menu.estado.validar', feedbackLabel: 'Validar' });
      const byStatus: Record<Menu['status'], HTMLElement[]> = {
        borrador: [button('toReview', 'Pasar a revisar', 'ghost', () => void setStatus('revisar', 'Menú listo para revisar.'), { feedbackId: 'food.menu.estado.pasar_revisar', feedbackLabel: 'Pasar a revisar' }), validateButton],
        revisar: [button('toDraft', 'Volver a borrador', 'ghost', () => void setStatus('borrador', 'Menú de nuevo en borrador.'), { feedbackId: 'food.menu.estado.volver_borrador', feedbackLabel: 'Volver a borrador' }), validateButton],
        validado: [button('reopenMenu', 'Reabrir para cambiar', 'ghost', () => void setStatus('revisar', 'Menú reabierto.'), { feedbackId: 'food.menu.estado.reabrir', feedbackLabel: 'Reabrir para cambiar' }),
          button('closeMenu', 'Cerrar menú', 'ghost', () => void setStatus('cerrado', 'Menú cerrado.').then((ok) => usage.track('food.cierre.cerrar', ok ? 'success' : 'error')), { feedbackId: 'food.menu.estado.cerrar', feedbackLabel: 'Cerrar menú' })],
        cerrado: [button('uncloseMenu', 'Volver a validado', 'ghost', () => void setStatus('validado', 'Menú de nuevo en validado.'), { feedbackId: 'food.menu.estado.volver_validado', feedbackLabel: 'Volver a validado' })],
      };
      replace(actions, ...byStatus[menu.status],
        menu.status === 'borrador' || menu.status === 'revisar' ? el('button', { 'data-feedback-id': 'food.menu.estado.borrar', 'data-feedback-label': 'Borrar menú', class: 'linkbtn', type: 'button', id: 'deleteMenu', disabled: busy, onclick: () => void deleteMenu() }, 'Borrar menú') : null,
        el('span', { class: 'hint' }, 'Validar y cambiar de estado necesitan conexión.'));
    }

    /** Validar: con los datos del evento recién leídos y aceptando uno a uno los avisos que lo exigen. */
    async function validate(): Promise<void> {
      if (!menu) return;
      if (!navigator.onLine) { toast(describeError({ code: 'OFFLINE' })); return; }
      await refreshEvents(client, true);
      const e = event();
      if (!e) { toast(describeError({ code: 'EVENT_NOT_FOUND' })); return; }
      paintBanner(); paintRestrictions();
      const required = menuWarnings(e, graph()).filter((w) => w.requiresAck);
      const send = async () => {
        const ok = await call(FOOD_PROCEDURES.validateMenu, {
          menu_id: menu!.id, expectedRevision: menu!.revision, event_revision: e.event_revision, event_snapshot: eventSnapshot(e),
          acknowledged: required.map((w) => ({ key: w.key, kind: w.kind, text: w.text })),
        }, 'Menú validado.');
        usage.track('food.menu.validar', ok ? 'success' : 'error');
        return ok;
      };
      if (required.length === 0) { await send(); return; }

      const boxes = required.map((w, index) => {
        const box = el('input', { 'data-feedback-id': 'food.menu.validar.aviso', 'data-feedback-label': 'Aviso tenido en cuenta', type: 'checkbox', id: `ack-${index}`, onchange: () => { confirm.disabled = !boxes.every((b) => b.box.checked); } });
        return { box, node: el('label', { class: 'checkline ackline', for: box.id }, box, el('span', { 'data-feedback-ignore': '' }, w.text)) };
      });
      const confirm = el('button', { 'data-feedback-id': 'food.menu.validar.confirmar', 'data-feedback-label': 'Validar menú', class: 'primary', type: 'button', id: 'confirmValidate', disabled: true,
        onclick: async () => { await sheet?.close(true); await send(); } }, 'Validar menú');
      sheet = openSheet({
        title: 'Antes de validar',
        body: el('div', { 'data-feedback-id': 'food.menu.validar', 'data-feedback-label': 'Antes de validar' },
          el('p', null, 'Hay avisos de restricciones. Marca cada uno para confirmar que lo has tenido en cuenta; quedará anotado en el menú.'),
          el('div', { id: 'ackList' }, ...boxes.map((b) => b.node))),
        foot: [el('button', { 'data-feedback-id': 'food.menu.validar.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), confirm],
        onClose: () => { sheet = null; },
      });
    }

    async function deleteMenu(): Promise<void> {
      if (!menu) return;
      if (!(await confirmDialog({ title: '¿Borrar este menú?', text: 'Se va a la papelera con sus servicios y sus platos. El evento queda libre para otro menú.', confirmLabel: 'Borrar menú', danger: true }))) return;
      const live = services.map((s) => s.id);
      const ok = await commitSafely([
        ...items.filter((i) => live.includes(i.service_id)).map((i) => removeOp(T.menuItems, i)),
        ...services.map((s) => removeOp(T.menuServices, s)),
        removeOp(T.menus, menu),
      ]);
      usage.track('food.menu.borrar', ok ? 'success' : 'error');
      if (ok) navigate('#/menus');
    }

    /** Guarda un orden completo: `position` 1, 2, 3… y solo se envían las filas cuya posición cambia. */
    async function reorder<R extends SyncedRow & { position: number }>(table: (typeof T)[keyof typeof T], ordered: R[]): Promise<void> {
      const operations = ordered
        .map((row, i): RowOperation | null => (Number(row.position) === i + 1 ? null : { op: 'update', table, id: row.id, expectedRevision: row.revision, fields: { position: i + 1 } }))
        .filter((op): op is RowOperation => op !== null);
      if (operations.length) await commitSafely(operations);
    }

    // --- Constructor por días ---------------------------------------------------------------
    const rowSig = (rows: Array<SyncedRow & { position: number; _pending?: boolean }>) => rows.map((r) => `${r.id}:${r.revision}:${r.position}:${r._pending ? 1 : 0}`).join(',');
    const sortServices = (rows: ServiceRow[]) => [...rows].sort((a, b) => a.service_date.localeCompare(b.service_date) || Number(a.position) - Number(b.position) || (a.service_time ?? '99').localeCompare(b.service_time ?? '99'));
    const dishesOf = (service: ServiceRow) => items.filter((i) => i.service_id === service.id).sort((a, b) => Number(a.position) - Number(b.position) || a.created_at.localeCompare(b.created_at));
    const editable = () => !locked() && !cook;
    const recipeOf = (item: ItemRow) => recipes.find((r) => r.id === item.recipe_id);
    const dropLists = () => {
      for (const list of [...dayLists.values(), ...dishLists.values()]) list.destroy();
      dayLists.clear(); dishLists.clear(); listSigs.clear();
    };

    /** Lo que el cocinero necesita de un plato: cantidades para sus raciones, alérgenos, maquinaria y elaboración. */
    function cookDetails(item: ItemRow): HTMLElement | null {
      const recipe = recipeOf(item);
      if (!recipe) return null;
      const prep = prepLabel(recipe.prep_minutes);
      const names = new Map(ingredients.map((i) => [i.id, i.name]));
      const machines = new Map(equipment.map((m) => [m.id, m]));
      const scaled = scaledIngredients(graph(), item.id);
      const required = needs.filter((n) => n.recipe_id === recipe.id && !n.deleted_at);
      return el('div', { class: 'cookdetails' },
        scaled.length ? el('table', { class: 'ingredients' }, el('tbody', null, ...scaled.map((line) => el('tr', null,
          el('td', null, names.get(line.ingredient_id) ?? '—'), el('td', { class: 'num' }, formatQuantity(line.quantity)), el('td', null, UNIT_LABELS[line.unit])))))
          : el('p', { class: 'muted' }, 'La receta no tiene ingredientes.'),
        recipe.allergens.length ? el('p', { class: 'warnline' }, `Alérgenos: ${recipe.allergens.map((a) => ALLERGEN_LABELS[a]).join(', ')}`) : null,
        required.length ? el('p', null, el('strong', null, 'Maquinaria: '), required.map((n) => `${n.quantity_required} × ${machines.get(n.equipment_id)?.name ?? 'máquina retirada'}`).join(', ')) : null,
        prep ? el('p', { class: 'cookprep' }, el('strong', null, 'Antelación: '), prep) : null,
        methodStepsView(recipe),
        recipe.service_notes ? el('p', null, el('strong', null, 'Servicio: '), recipe.service_notes) : null,
        purchases.fetchedAt ? costLine(item) : null);
    }

    const euros = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

    /** Coste estimado del plato en la vista de cocinero, con aviso si a algún ingrediente le falta precio. */
    function costLine(item: ItemRow): HTMLElement {
      const cost = dishCost(graph(), item.id, purchases.prices);
      const per = Number(item.servings) > 0 ? cost.amount / Number(item.servings) : 0;
      return el('p', { class: 'dishcost' }, el('strong', null, 'Coste estimado: '), `${euros(cost.amount)} (${euros(per)} por ración)`,
        cost.missing.length ? el('span', { class: 'muted' }, ` · sin precio: ${cost.missing.map((id) => ingredients.find((i) => i.id === id)?.name ?? '—').join(', ')}`) : null,
        cost.stale.length ? el('span', { class: 'muted' }, ` · ${staleText(cost.stale, item)}`) : null);
    }

    /** «precio de la última compra: Arroz (20 jun)»: ingredientes sin compras en los últimos tres meses. */
    function staleText(ids: string[], item?: ItemRow): string {
      const unitOf = (id: string) => (item ? recipeLines.find((l) => l.recipe_id === item.recipe_id && l.ingredient_id === id)?.unit : undefined) ?? recipeLines.find((l) => l.ingredient_id === id)?.unit ?? 'kg';
      const date = (id: string) => { const d = priceFor(id, unitOf(id), purchases.prices)?.lastDate; return d ? ` (${formatDate(d).replace(/,.*$/, '')})` : ''; };
      return `precio de la última compra, de hace más de 3 meses: ${ids.map((id) => `${ingredients.find((i) => i.id === id)?.name ?? '—'}${date(id)}`).join(', ')}`;
    }

    /** Coste estimado del menú con las compras reales de Invoices: total, por persona y por servicio. */
    function paintCost(): void {
      if (!purchases.fetchedAt || items.length === 0) { costHost.hidden = true; return; }
      const costs = serviceCosts(graph(), purchases.prices);
      const total = costs.reduce((sum, c) => sum + c.amount, 0);
      const missing = new Set(costs.flatMap((c) => c.missing));
      const stale = new Set(costs.flatMap((c) => c.stale));
      const people = house() ? Number(menu?.house_servings ?? 0) : event()?.guest_count ?? 0;
      const byId = new Map(services.map((s) => [s.id, s]));
      costHost.hidden = false;
      replace(costHost,
        el('h3', null, 'Coste estimado'),
        el('p', { class: 'muted' }, people > 0 ? `${euros(total / people)} por persona · ` : '', `media de las compras de los últimos 3 meses registradas en Invoices (datos de ${formatDate(purchases.fetchedAt)}).`),
        renderMoneyBreakdown({
          totalLabel: 'Total del menú',
          format: euros,
          sort: false,
          emptyText: 'Ningún plato tiene todavía ingredientes con precio.',
          lines: costs.filter((c) => byId.has(c.service_id)).map((c) => {
            const s = byId.get(c.service_id)!;
            return { id: c.service_id, label: `${SERVICE_LABELS[s.service_type]} · ${longDay(s.service_date)}`, amount: c.amount,
              meta: c.servings > 0 ? `${euros(c.amount / c.servings)} por ración` : undefined };
          }),
        }),
        stale.size ? el('p', { class: 'warnline costmissing' }, `${staleText([...stale]).replace(/^p/, 'P')}.`) : null,
        missing.size ? el('p', { class: 'warnline costmissing' }, `Sin precio (no hay compras con unidad compatible): ${[...missing].map((id) => ingredients.find((i) => i.id === id)?.name ?? '—').join(', ')}. El coste real será mayor.`) : null,
      );
    }

    function dishRow(item: ItemRow): HTMLElement {
      const recipe = recipeOf(item);
      const canEdit = editable();
      const img = el('img', { alt: '', hidden: true });
      if (recipe) showPhoto(client, img, recipe.photo_thumb_file_id ?? recipe.photo_file_id);
      const servings = el('input', { 'data-feedback-id': 'food.menu.platos.raciones', 'data-feedback-label': 'Raciones', type: 'text', inputmode: 'decimal', class: 'servings compact', value: formatQuantity(item.servings), 'aria-label': `Raciones de ${recipe?.name ?? 'plato'}`, disabled: !canEdit,
        onchange: async () => {
          const value = parseQuantity(servings.value);
          if (value === null || value <= 0) { toast('Las raciones deben ser un número mayor que cero.'); servings.value = formatQuantity(item.servings); return; }
          if (value !== Number(item.servings)) await commitSafely([{ op: 'update', table: T.menuItems, id: item.id, expectedRevision: item.revision, fields: { servings: value } }]);
        } });
      return el('div', { 'data-feedback-id': 'food.menu.platos.plato', 'data-feedback-label': 'Plato', class: 'dish', 'data-id': item.id, 'data-pending': String(item._pending === true) },
        el('span', { class: 'dishphoto' }, icon('chef', 20), img),
        el('span', { class: 'dishname' }, el('strong', null, recipe?.name ?? 'Receta retirada'),
          recipe ? el('span', { class: 'recipemeta' }, [CATEGORY_LABELS[recipe.category], ...recipe.diet_tags.map((t) => DIET_LABELS[t])].join(' · ')) : null,
          recipe && isQuickPending(recipe, recipeLines) ? el('span', { class: 'chips' }, el('span', { class: 'chip warn quickchip' }, 'Rápida · por completar')) : null),
        el('span', { class: 'dishside' }, servings, el('span', { class: 'muted' }, 'rac.'),
          canEdit ? el('button', { 'data-feedback-id': 'food.menu.platos.quitar', 'data-feedback-label': 'Quitar plato', class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${recipe?.name ?? 'plato'}`, onclick: () => void commitSafely([removeOp(T.menuItems, item)]) }, icon('close', 18)) : null),
        cook ? cookDetails(item) : null,
      );
    }

    /** Platos de un servicio. Con el constructor abierto y más de uno: lista del kit con arrastre, teclado y subir/bajar. */
    function dishList(service: ServiceRow, dishes: ItemRow[]): HTMLElement {
      if (!editable() || dishes.length < 2) return el('ul', { 'data-feedback-id': 'food.menu.platos.lista', 'data-feedback-label': 'Platos del servicio', class: 'dishes' }, ...dishes.map((dish) => el('li', null, dishRow(dish))));
      const key = `s:${service.id}`;
      let list = dishLists.get(service.id);
      if (!list) {
        list = createSortableList<ItemRow>({
          items: dishes,
          key: (dish) => dish.id,
          name: (dish) => recipeOf(dish)?.name ?? 'plato',
          label: `Platos de ${SERVICE_LABELS[service.service_type]}`,
          rowClass: 'dishrow',
          render: (dish) => dishRow(dish),
          onReorder: (ordered) => reorder(T.menuItems, ordered),
        });
        fb(list.element, { feedbackId: 'food.menu.platos.lista', feedbackLabel: 'Platos del servicio' });
        dishLists.set(service.id, list);
      } else if (listSigs.get(key) !== rowSig(dishes)) {
        list.setItems(dishes);
      }
      listSigs.set(key, rowSig(dishes));
      return list.element;
    }

    function serviceBlock(service: ServiceRow): HTMLElement {
      const canEdit = editable();
      const label = SERVICE_LABELS[service.service_type];
      const dishes = dishesOf(service);
      const time = el('input', { 'data-feedback-id': 'food.menu.servicios.hora', 'data-feedback-label': 'Hora del servicio', type: 'time', class: 'compact', value: shortTime(service.service_time), 'aria-label': `Hora de ${label}`, disabled: !canEdit,
        onchange: () => void commitSafely([{ op: 'update', table: T.menuServices, id: service.id, expectedRevision: service.revision, fields: { service_time: time.value || null } }]) });
      const consumption = consumptionOf(service);
      const consumeBar = !consumption ? null
        : (consumption.state === 'por_confirmar' || consumption.state === 'automatico') && canWrite()
          ? el('div', { class: 'consumebar' },
              el('button', { 'data-feedback-id': 'food.menu.servicios.confirmar_consumo', 'data-feedback-label': 'Confirmar consumo', class: 'ghost consumebtn', type: 'button', 'aria-label': `Confirmar consumo de ${label}`, onclick: () => openConsumption(service) }, icon('check', 18), 'Confirmar consumo'),
              el('span', { class: 'hint' }, 'Si nadie lo confirma, se descuenta solo a las 24 h.'))
          : consumption.state === 'hecho' ? el('div', { class: 'chips consumebar' }, el('span', { class: 'chip ok' }, 'Consumo anotado')) : null;
      return el('section', { 'data-feedback-id': 'food.menu.servicios.servicio', 'data-feedback-label': 'Servicio', class: 'service', 'data-id': service.id, 'data-type': service.service_type },
        el('header', null, el('h4', null, label), time,
          canEdit ? el('button', { 'data-feedback-id': 'food.menu.servicios.quitar', 'data-feedback-label': 'Quitar servicio', class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${label}`,
            onclick: async () => {
              if (dishes.length && !(await confirmDialog({ title: `¿Quitar ${label.toLowerCase()}?`, text: `Se quitan también sus ${dishes.length} platos.`, confirmLabel: 'Quitar', danger: true }))) return;
              await commitSafely([...dishes.map((d) => removeOp(T.menuItems, d)), removeOp(T.menuServices, service)]);
            } }, icon('trash', 18)) : null),
        consumeBar,
        dishes.length ? dishList(service, dishes) : el('p', { class: 'muted' }, 'Sin platos todavía.'),
        canEdit ? el('button', { 'data-feedback-id': 'food.menu.platos.anadir', 'data-feedback-label': 'Añadir plato', class: 'ghost addDish', type: 'button', onclick: () => pickRecipe(service, Math.max(0, ...dishesOf(service).map((d) => Number(d.position)))) }, icon('plus', 18), 'Añadir plato') : null,
      );
    }

    /**
     * «Confirmar consumo» (R5c): cada plato pendiente con lo que gasta a sus raciones, para corregir cantidades o marcar
     * que no se hizo. Al confirmar se descuenta en Recursos (primero lo que caduca antes) y se anota.
     */
    function openConsumption(service: ServiceRow): void {
      const state = consumptionOf(service);
      if (!state || !inventory) return;
      const label = `${SERVICE_LABELS[service.service_type]} del ${longDay(service.service_date)}`;
      const forms = state.pending.map((menuItemId) => {
        const dish = items.find((i) => i.id === menuItemId)!;
        const recipe = recipes.find((r) => r.id === dish.recipe_id);
        const lines = consumptionLines(menuGraph, menuItemId, inventory!.items);
        const done = el('input', { type: 'checkbox', checked: true, 'aria-label': `${recipe?.name ?? 'Plato'}: se hizo` }) as HTMLInputElement;
        const inputs = lines.map((line) => el('input', { type: 'text', inputmode: 'decimal', class: 'qty compact', value: formatQuantity(line.quantity), 'aria-label': `${line.name} gastado en ${recipe?.name ?? 'el plato'}`, disabled: line.reason !== null }) as HTMLInputElement);
        const node = el('div', { 'data-feedback-id': 'food.menu.consumo.plato', 'data-feedback-label': 'Plato del consumo', class: 'consumedish' },
          el('label', { class: 'checkline' }, done, el('strong', null, recipe?.name ?? 'Plato'), el('span', { class: 'muted' }, ` · ${formatQuantity(dish.servings)} raciones`)),
          lines.length ? el('table', { class: 'ingredients' }, el('tbody', null, ...lines.map((line, index) => el('tr', null,
            el('td', null, line.name, line.reason ? el('span', { class: 'consumewhy' }, line.reason === 'sin_articulo' ? 'no se descuenta: sin artículo' : `no se descuenta: no se pasa a ${line.baseUnit}`) : null),
            el('td', { class: 'num' }, inputs[index]!), el('td', null, UNIT_LABELS[line.unit])))))
            : el('p', { class: 'muted' }, 'La receta no tiene ingredientes: no se descuenta nada.'));
        done.addEventListener('change', () => { inputs.forEach((input, index) => { input.disabled = !done.checked || lines[index]!.reason !== null; }); });
        return { menuItemId, recipe, done, inputs, lines, node };
      });
      const error = el('p', { class: 'formerror', role: 'alert' });
      const confirm = el('button', { 'data-feedback-id': 'food.menu.consumo.confirmar', 'data-feedback-label': 'Confirmar consumo', class: 'primary', type: 'button', id: 'confirmConsumption',
        onclick: async () => {
          const decisions: DishDecision[] = [];
          for (const form of forms) {
            const quantities: number[] = [];
            for (const [index, input] of form.inputs.entries()) {
              const value = parseQuantity(input.value);
              if (form.done.checked && form.lines[index]!.reason === null && (value === null || value < 0)) { error.textContent = `Revisa la cantidad de ${form.lines[index]!.name}.`; input.focus(); return; }
              quantities.push(value ?? 0);
            }
            decisions.push({ menuItemId: form.menuItemId, done: form.done.checked, quantities });
          }
          confirm.disabled = true;
          try {
            await usage.run('food.menu.consumo.confirmar', () => confirmConsumption(client, menuGraph, inventory!, decisions, {
              noteOf: (id) => `${forms.find((f) => f.menuItemId === id)?.recipe?.name ?? 'Plato'} · ${label.toLowerCase()}`,
            }));
            toast('Consumo anotado: el inventario de cocina se ha actualizado.');
            await sheet?.close(true);
            await load();
          } catch (failure) {
            error.textContent = describeError(failure);
            confirm.disabled = false;
          }
        } }, 'Confirmar');
      sheet = openSheet({
        title: 'Confirmar consumo',
        meta: label,
        body: el('div', { 'data-feedback-id': 'food.menu.consumo', 'data-feedback-label': 'Confirmar consumo', id: 'consumptionSheet' },
          el('p', { class: 'muted' }, 'Lo que piden los platos a sus raciones. Corrige lo que se gastó de verdad o desmarca lo que no se hizo.'),
          ...forms.map((f) => f.node), error),
        foot: [el('button', { 'data-feedback-id': 'food.menu.consumo.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), confirm],
        onClose: () => { sheet = null; },
      });
    }

    /** Servicios de un día. Con más de uno y el constructor abierto: lista del kit (los platos van anidados dentro). */
    function serviceList(day: string, ofDay: ServiceRow[]): HTMLElement | null {
      if (ofDay.length === 0) return el('p', { class: 'muted' }, 'Sin servicios este día.');
      if (!editable() || ofDay.length < 2) return el('div', { 'data-feedback-id': 'food.menu.servicios.lista', 'data-feedback-label': 'Servicios del día' }, ...ofDay.map(serviceBlock));
      const list = createSortableList<ServiceRow>({
        items: ofDay,
        key: (service) => service.id,
        name: (service) => SERVICE_LABELS[service.service_type],
        label: `Servicios del ${longDay(day)}`,
        rowClass: 'servicerow',
        render: (service) => serviceBlock(service),
        onReorder: (ordered) => reorder(T.menuServices, ordered),
      });
      fb(list.element, { feedbackId: 'food.menu.servicios.lista', feedbackLabel: 'Servicios del día' });
      dayLists.set(day, list);
      listSigs.set(`d:${day}`, rowSig(ofDay));
      return list.element;
    }

    function paintBuilder(): void {
      const e = event();
      const canEdit = editable();
      const sorted = sortServices(services);
      const days = house() ? weekDays(todayKey(), weekOffset) : Array.from(new Set([...(e ? eventDays(e) : []), ...sorted.map((s) => s.service_date)])).sort();
      const used = new Set(items.map((i) => i.recipe_id));
      // Todo lo que obliga a rehacer el constructor entero. Lo que no está aquí (orden y datos de las filas de una lista) se actualiza en su lista.
      const shape = JSON.stringify({
        canEdit, cook, days, guests: e?.guest_count ?? null, house: house() ? Number(menu?.house_servings ?? 0) : null,
        quick: recipes.filter((r) => used.has(r.id) && isQuickPending(r, recipeLines)).map((r) => r.id).sort(),
        recipes: recipes.filter((r) => used.has(r.id)).map((r) => `${r.id}:${r.revision}`).sort(),
        consumption: sorted.map((s) => consumptionOf(s)?.state ?? ''),
        services: days.map((day) => {
          const ofDay = sorted.filter((s) => s.service_date === day);
          return [ofDay.length > 1 ? ofDay.map((s) => s.id).sort() : rowSig(ofDay), ofDay.map((service) => {
            const dishes = dishesOf(service);
            return dishes.length > 1 ? dishes.map((d) => d.id).sort() : rowSig(dishes);
          })];
        }),
      });

      if (canEdit && shape === builderShape) {
        // Misma estructura: solo han cambiado filas de alguna lista (orden, raciones, hora). Se actualizan en su sitio.
        for (const [day, list] of dayLists) {
          const ofDay = sorted.filter((s) => s.service_date === day);
          if (listSigs.get(`d:${day}`) !== rowSig(ofDay)) { listSigs.set(`d:${day}`, rowSig(ofDay)); list.setItems(ofDay); }
        }
        for (const [serviceId, list] of dishLists) {
          const service = services.find((sv) => sv.id === serviceId);
          const dishes = service ? dishesOf(service) : [];
          if (listSigs.get(`s:${serviceId}`) !== rowSig(dishes)) { listSigs.set(`s:${serviceId}`, rowSig(dishes)); list.setItems(dishes); }
        }
        return;
      }

      dropLists();
      builderShape = shape;
      const lastPosition = (day: string) => Math.max(0, ...services.filter((sv) => sv.service_date === day).map((sv) => Number(sv.position)));
      replace(builder, house() ? weekNav(days) : null, ...days.map((day) => {
        const ofDay = sorted.filter((s) => s.service_date === day);
        return el('section', { 'data-feedback-id': 'food.menu.dia', 'data-feedback-label': 'Día', class: 'menuday', 'data-day': day },
          el('h3', null, longDay(day), house() && day === todayKey() ? el('span', { class: 'chip ok todaychip' }, 'Hoy') : null),
          serviceList(day, ofDay),
          canEdit && house() ? el('div', { class: 'btnrow dayactions' },
            el('button', { 'data-feedback-id': 'food.menu.casa.anadir_comida', 'data-feedback-label': 'Añadir comida', class: 'ghost quickService', type: 'button', 'aria-label': `Añadir comida el ${longDay(day)}`, onclick: () => void quickService(day, 'comida', lastPosition(day)) }, icon('plus', 18), 'Comida'),
            el('button', { 'data-feedback-id': 'food.menu.casa.anadir_cena', 'data-feedback-label': 'Añadir cena', class: 'ghost quickService', type: 'button', 'aria-label': `Añadir cena el ${longDay(day)}`, onclick: () => void quickService(day, 'cena', lastPosition(day)) }, icon('plus', 18), 'Cena'),
            el('button', { 'data-feedback-id': 'food.menu.servicios.anadir', 'data-feedback-label': 'Añadir servicio', class: 'linkbtn addService', type: 'button', onclick: () => addService(day, lastPosition(day)) }, icon('plus', 18), 'Añadir servicio'))
            : canEdit ? el('button', { 'data-feedback-id': 'food.menu.servicios.anadir', 'data-feedback-label': 'Añadir servicio', class: 'linkbtn addService', type: 'button', onclick: () => addService(day, lastPosition(day)) }, icon('plus', 18), 'Añadir servicio') : null,
        );
      }));
    }

    /** Semanas del menú de casa: ‹ anterior · esta semana · siguiente ›. */
    function weekNav(days: string[]): HTMLElement {
      const go = (delta: number) => { weekOffset = delta === 0 ? 0 : weekOffset + delta; builderShape = ''; paintBuilder(); };
      const label = weekOffset === 0 ? 'Esta semana' : weekOffset === 1 ? 'La semana que viene' : weekOffset === -1 ? 'La semana pasada' : `${longDay(days[0]!)} – ${longDay(days[6]!)}`;
      return el('nav', { 'data-feedback-id': 'food.menu.casa.semanas', 'data-feedback-label': 'Semanas', class: 'weeknav', 'aria-label': 'Semanas' },
        el('button', { 'data-feedback-id': 'food.menu.casa.semana_anterior', 'data-feedback-label': 'Semana anterior', class: 'iconbtn', type: 'button', id: 'weekPrev', 'aria-label': 'Semana anterior', onclick: () => go(-1) }, '‹'),
        el('strong', { id: 'weekLabel' }, label),
        weekOffset !== 0 ? el('button', { 'data-feedback-id': 'food.menu.casa.semana_actual', 'data-feedback-label': 'Volver a esta semana', class: 'linkbtn', type: 'button', id: 'weekToday', onclick: () => go(0) }, 'Hoy') : null,
        el('button', { 'data-feedback-id': 'food.menu.casa.semana_siguiente', 'data-feedback-label': 'Semana siguiente', class: 'iconbtn', type: 'button', id: 'weekNext', 'aria-label': 'Semana siguiente', onclick: () => go(1) }, '›'));
    }

    /** «+ Comida» y «+ Cena» del menú de casa: un toque, con la hora habitual. */
    async function quickService(day: string, type: 'comida' | 'cena', count: number): Promise<void> {
      const ok = await commitSafely([{ op: 'insert', table: T.menuServices, id: crypto.randomUUID(),
        fields: { menu_id: menuId, service_date: day, service_type: type, service_time: type === 'comida' ? '14:00' : '20:30', position: count + 1 } }]);
      usage.track('food.menu.casa.anadir_servicio', ok ? 'success' : 'error');
    }

    function addService(day: string, count: number): void {
      const type = el('select', { 'data-feedback-id': 'food.menu.servicios.nuevo.tipo', 'data-feedback-label': 'Tipo de servicio', id: 's-type' }, ...SERVICE_TYPES.map((t) => el('option', { value: t }, SERVICE_LABELS[t])));
      const time = el('input', { 'data-feedback-id': 'food.menu.servicios.nuevo.hora', 'data-feedback-label': 'Hora', id: 's-time', type: 'time' });
      sheet = openSheet({
        title: `Nuevo servicio · ${longDay(day)}`,
        body: el('div', { 'data-feedback-id': 'food.menu.servicios.nuevo', 'data-feedback-label': 'Nuevo servicio' }, el('label', { class: 'field' }, el('span', null, 'Servicio'), type), el('label', { class: 'field' }, el('span', null, 'Hora'), time)),
        foot: [el('button', { 'data-feedback-id': 'food.menu.servicios.nuevo.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'),
          el('button', { 'data-feedback-id': 'food.menu.servicios.nuevo.anadir', 'data-feedback-label': 'Añadir servicio', class: 'primary', type: 'button', id: 'saveService', onclick: async () => {
            const ok = await commitSafely([{ op: 'insert', table: T.menuServices, id: crypto.randomUUID(),
              fields: { menu_id: menuId, service_date: day, service_type: type.value, service_time: time.value || null, position: count + 1 } }]);
            usage.track('food.menu.anadir_servicio', ok ? 'success' : 'error');
            if (ok) await sheet?.close(true);
          } }, 'Añadir')],
        onClose: () => { sheet = null; },
      });
    }

    /** Selector de plato: el recetario visual, con las raciones del evento por defecto. */
    function pickRecipe(service: ServiceRow, count: number): void {
      const search = el('input', { 'data-feedback-id': 'food.menu.platos.selector.buscar', 'data-feedback-label': 'Buscar receta', type: 'search', placeholder: house() ? 'Buscar receta o escribir un plato nuevo' : 'Buscar receta', 'aria-label': 'Buscar receta', autocomplete: 'off', oninput: () => fill(),
        onkeydown: (ev: Event) => { if ((ev as KeyboardEvent).key === 'Enter') (quickHost.querySelector('button') as HTMLButtonElement | null)?.click(); } });
      const grid = el('ul', { 'data-feedback-id': 'food.menu.platos.selector', 'data-feedback-label': 'Selector de recetas', class: 'recipegrid picker', id: 'recipePicker' });
      const servings = defaultServings();
      const quickHost = el('div', { class: 'quickdish' });
      /** Plato rápido (solo en casa): la receta mínima y el plato, en un lote. Se completa después en el Recetario. */
      async function addQuick(name: string): Promise<void> {
        const ok = await commitSafely(quickDishOperations({ recipeId: crypto.randomUUID(), itemId: crypto.randomUUID(), name, serviceId: service.id, serviceType: service.service_type, servings, position: count + 1 }) as RowOperation[]);
        usage.track('food.menu.casa.plato_rapido', ok ? 'success' : 'error');
        if (ok) await sheet?.close(true);
      }
      function fill(): void {
        const query = search.value.trim().toLowerCase();
        const options = recipes.filter((r) => !r.deleted_at && r.status !== 'archivada' && (!query || r.name.toLowerCase().includes(query))).sort((a, b) => a.name.localeCompare(b.name, 'es'));
        const typed = search.value.trim();
        const exact = recipes.some((r) => !r.deleted_at && r.name.trim().toLowerCase() === query);
        replace(quickHost, house() && canWrite() && typed && !exact
          ? el('button', { 'data-feedback-id': 'food.menu.casa.plato_rapido', 'data-feedback-label': 'Añadir como plato rápido', class: 'primary', type: 'button', id: 'quickDish', onclick: () => void addQuick(typed) },
            icon('plus', 18), `Añadir «${typed}» como plato rápido`)
          : null);
        replace(grid, ...options.map((recipe) => {
          const img = el('img', { alt: '', loading: 'lazy', hidden: true });
          showPhoto(client, img, recipe.photo_thumb_file_id ?? recipe.photo_file_id);
          // Salvaguarda (O3a): en un retiro, un plato rápido por completar se ve pero no se puede elegir.
          const blocked = !house() && isQuickPending(recipe, recipeLines);
          if (blocked) {
            return el('li', null, el('div', { 'data-feedback-id': 'food.menu.platos.selector.rapida', 'data-feedback-label': 'Plato rápido por completar', class: 'recipecard disabled' },
              el('span', { class: 'recipephoto' }, icon('chef', 30)),
              el('span', { class: 'recipebody' }, el('strong', null, recipe.name),
                el('span', { class: 'recipemeta' }, 'Rápida: complétala (alérgenos e ingredientes) para usarla en un retiro.'),
                el('a', { 'data-feedback-id': 'food.menu.platos.selector.completar', 'data-feedback-label': 'Completar en el Recetario', href: `#/recetario?receta=${recipe.id}`, class: 'linkbtn',
                  onclick: (ev: Event) => { ev.preventDefault(); void sheet?.close(true).then(() => navigate(`#/recetario?receta=${recipe.id}`)); } }, 'Completar en el Recetario'))));
          }
          return el('li', null, el('button', { 'data-feedback-id': 'food.menu.platos.selector.receta', 'data-feedback-label': 'Receta', class: 'recipecard', type: 'button', 'aria-label': `Añadir ${recipe.name}`,
            onclick: async () => {
              const ok = await commitSafely([{ op: 'insert', table: T.menuItems, id: crypto.randomUUID(), fields: { service_id: service.id, recipe_id: recipe.id, servings, position: count + 1 } }]);
              usage.track('food.menu.anadir_plato', ok ? 'success' : 'error');
              if (ok) await sheet?.close(true);
            } },
            el('span', { class: 'recipephoto' }, icon('chef', 30), img),
            el('span', { class: 'recipebody' }, el('strong', null, recipe.name),
              el('span', { class: 'recipemeta' }, [CATEGORY_LABELS[recipe.category], ...recipe.diet_tags.map((t) => DIET_LABELS[t])].join(' · ')),
              recipe.status === 'en_prueba' ? el('span', { class: 'chips' }, el('span', { class: 'chip' }, 'En prueba'), isQuickPending(recipe, recipeLines) ? el('span', { class: 'chip warn' }, 'Rápida') : null) : null)));
        }));
        // En casa, el botón del plato rápido ya dice qué hacer; en un retiro, como siempre.
        if (options.length === 0) replace(grid, quickHost.childElementCount ? null : el('li', { class: 'muted' }, 'No hay recetas que coincidan. Créalas en el Recetario.'));
      }
      fill();
      sheet = openSheet({
        title: `Añadir plato · ${SERVICE_LABELS[service.service_type]}`,
        meta: `${formatQuantity(servings)} raciones por defecto; se pueden cambiar después.`,
        body: el('div', null, el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)), quickHost, grid),
        initialFocus: search,
        onClose: () => { sheet = null; },
      });
    }

    function paintActionsAndRest(): void {
      // En casa: Menú, Compra y Preparación (O3b); sin Organizador ni Cierre.
      for (const link of tabs.querySelectorAll<HTMLAnchorElement>('a[data-tab="organizador"], a[data-tab="cierre"]')) link.hidden = house();
      paintHead(); paintBanner(); paintCommentsNotice(); paintRestrictions();
      if (tab === 'menu') {
        paintActions(); paintShare(); paintComments(); paintBuilder(); paintCost();
        if (scrollToComments && !commentsHost.hidden) { scrollToComments = false; goToComments(); }
        return;
      }
      if (!unmountTab) {
        const context = { client, menuId, host: tabHost, canWrite, house: house() };
        unmountTab = tab === 'compra' ? mountShopping(context) : tab === 'preparacion' ? mountPreparation(context) : tab === 'organizador' ? mountOrganizer(context) : mountClosing(context);
      }
    }

    let creatingHouse = false;
    async function load(): Promise<void> {
      const data = await loadMenuData(client, menuId);
      if (!data.menu && menuId === HOUSE_MENU_ID && canWrite() && !creatingHouse) {
        creatingHouse = true;
        try {
          await client.commit([{ op: 'insert', table: T.menus, id: HOUSE_MENU_ID, fields: { kind: 'casa' } }]);
          usage.track('food.menu.casa.crear', 'success');
        } catch (error) {
          toast(describeError(error));
        }
        await load();
        return;
      }
      if (!data.menu) {
        menu = null;
        unmountTab?.();
        unmountTab = null;
        replace(main, el('div', { class: 'empty' }, el('strong', null, 'Este menú no existe o está en la papelera'),
          el('p', { style: 'margin-top:10px' }, el('button', { 'data-feedback-id': 'food.menu.volver_menus', 'data-feedback-label': 'Volver a Menús', class: 'ghost', type: 'button', onclick: () => navigate('#/menus') }, 'Volver a Menús'))));
        return;
      }
      menu = data.menu;
      ({ services, items, recipes, ingredients, equipment, needs } = data);
      comments = ((await client.list(T.menuComments)) as CommentRow[])
        .filter((c) => c.menu_id === menuId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      recipeLines = data.lines;
      menuGraph = data.graph;
      consumptions = (await client.list(T.consumptions)) as Array<Mirror<Consumption>>;
      inventory = await loadInventory(client).catch(() => null);
      if (tab === 'menu') void loadPurchases(client).then((next) => { const changed = next.fetchedAt !== purchases.fetchedAt; purchases = next; if (changed) { builderShape = ''; paintActionsAndRest(); } });
      paintActionsAndRest();
    }

    void load();
    const offEvents = watchEvents(client, (next) => { snapshot = next; if (menu) paintActionsAndRest(); });
    const offs = [T.menus, T.menuServices, T.menuItems, T.recipes, T.menuComments, T.consumptions].map((table) => client.onTable(table, () => { if (!sheet) void load(); }));
    const offStatus = client.onStatus(() => void refreshEvents(client));
    return () => {
      offEvents();
      offs.forEach((off) => off());
      offStatus();
      unmountTab?.();
      dropLists();
      void closeSheet(true);
    };
  };
}
