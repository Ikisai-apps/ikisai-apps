import type { SyncStatus } from '@ikisai/sync-client';
import { HOUSE_MENU_ID, isMenuStale, kitchenStock, menuTotals, serviceConsumption, type Equipment, type Menu, type PreparationItem, type Recipe, type ShoppingList, type ShoppingListItem } from '@ikisai/domain-food';
import { el, formatDate, replace } from './dom.ts';
import { T, type Mirror } from '../app/client.ts';
import { allergyCount, dateRange, guestsLabel, longDay, mealPlanLabel, needsMenu, refreshEvents, todayKey, watchEvents, whenLabel, type EventsSnapshot } from '../app/events.ts';
import { MENU_STATUS_LABELS, SERVICE_LABELS } from './events.ts';
import { loadConsumptionGraph, loadInventory } from '../app/consumption.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { HOUSE_MENU_HASH, loadHouseToday, type HouseToday } from '../app/house.ts';
import { loadAllMenuGraphs } from '../app/menu-data.ts';
import { loadPurchases } from '../app/purchases.ts';
import type { ViewMount } from './shell.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as InstallPromptEvent;
});

/** Inicio: qué retiros vienen y qué les falta (canon §14), y debajo los accesos y el estado del dispositivo. */
export const mountHome: ViewMount = ({ main, client, navigate, logout }) => {
  const recipeCount = el('dd', null, '…');
  const recipeTrial = el('dd', null, '…');
  const equipmentCount = el('dd', null, '…');
  const equipmentDown = el('dd', null, '…');
  // Despensa (R5): solo si se lleva inventario (sitios de cocina en Recursos).
  const pantryHost = el('div', { id: 'pantryCard' });
  const network = el('dd');
  const pending = el('dd');
  const lastPull = el('dd');
  const role = el('dd');
  const upcoming = el('section', { 'data-feedback-id': 'food.inicio.eventos', 'data-feedback-label': 'Próximos eventos', id: 'upcoming' });
  const houseHost = el('section', { 'data-feedback-id': 'food.inicio.casa', 'data-feedback-label': 'Hoy en casa', id: 'houseToday' });
  // Consumo por confirmar (R5c): solo con inventario (sitios de cocina en Recursos) y para quien puede confirmarlo.
  const consumeHost = el('section', { 'data-feedback-id': 'food.inicio.consumo', 'data-feedback-label': 'Consumo por confirmar', id: 'consumeDue' });
  let house: HouseToday = { exists: false, lines: [] };
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let menus: Mirror<Menu>[] = [];
  let totals = new Map<string, { total: number; missing: number; stale: number }>();
  const euros = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
  let lists: Mirror<ShoppingList>[] = [];
  let buyItems: Mirror<ShoppingListItem>[] = [];
  let steps: Mirror<PreparationItem>[] = [];

  function paint(status: SyncStatus): void {
    network.textContent = status.network === 'online' ? 'En línea' : status.network === 'offline' ? 'Sin conexión' : status.network === 'syncing' ? 'Sincronizando…' : 'Error';
    pending.textContent = String(status.pendingCommands + status.pendingBlobs);
    lastPull.textContent = formatDate(status.lastPullAt);
    const boot = client.bootstrap();
    role.textContent = boot ? { owner: 'Propietario', editor: 'Cocina', reader: 'Solo lectura', outsider: 'Outsider' }[boot.membership.role] : '—';
  }

  async function count(): Promise<void> {
    const recipes = (await client.list(T.recipes)) as Mirror<Recipe>[];
    const equipment = (await client.list(T.equipment)) as Mirror<Equipment>[];
    recipeCount.textContent = String(recipes.filter((r) => r.status !== 'archivada').length);
    recipeTrial.textContent = String(recipes.filter((r) => r.status === 'en_prueba').length);
    equipmentCount.textContent = String(equipment.length);
    equipmentDown.textContent = String(equipment.filter((e) => e.status === 'averiado' || e.status === 'fuera_de_servicio').length);
  }

  function paintUpcoming(): void {
    const today = todayKey();
    const events = snapshot.events.filter((e) => e.end_date >= today && (needsMenu(e) || menus.some((m) => m.event_id === e.event_id && !m.deleted_at))).slice(0, 6);
    replace(upcoming,
      el('div', { class: 'sectionlabel' }, 'Próximos eventos'),
      events.length === 0
        ? el('div', { class: 'empty plain' }, snapshot.fetchedAt ? 'No hay eventos próximos con comidas.' : 'Los eventos aparecerán aquí en cuanto haya conexión.')
        : el('div', { class: 'cardgrid' }, ...events.map((event) => {
            const menu = menus.find((m) => m.event_id === event.event_id && !m.deleted_at);
            const stale = !!menu && isMenuStale(menu, event);
            const restrictions = event.dietary_restrictions?.length ?? 0;
            const target = menu ? `#/menus/${menu.id}` : '#/eventos';
            const list = menu ? lists.find((l) => l.menu_id === menu.id) : undefined;
            const toBuy = list ? buyItems.filter((i) => i.shopping_list_id === list.id && i.status === 'pendiente' && Number(i.purchase_quantity) > 0).length : 0;
            const ofMenu = menu ? steps.filter((s) => s.menu_id === menu.id) : [];
            const allergies = allergyCount(event.dietary_restrictions);
            const menuReady = !!menu && !stale && (menu.status === 'validado' || menu.status === 'cerrado');
            const buyReady = !!list && (list.status === 'cerrada' || toBuy === 0);
            const prepDone = ofMenu.filter((s) => s.done).length;
            // Lo que está listo lleva su marca; lo demás es lo que queda por hacer (canon §14).
            const line = (label: string, value: string, state: 'ok' | 'warn' | 'todo') =>
              [el('dt', null, label), el('dd', { class: state === 'warn' ? 'warnline' : state === 'ok' ? 'doneline' : '' }, state === 'ok' ? `${value} ✓` : value)];
            return el('a', { 'data-feedback-id': 'food.inicio.eventos.tarjeta', 'data-feedback-label': 'Tarjeta de evento', class: 'card cardlink eventcard', href: target, onclick: (e: Event) => { e.preventDefault(); navigate(target); } },
              el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
              // Título y huéspedes del retiro vienen de Booking: fuera del reporte.
              el('h3', { 'data-feedback-ignore': '' }, `${dateRange(event)} · ${event.title}`),
              el('p', { 'data-feedback-ignore': '' }, `${whenLabel(event)} · ${guestsLabel(event)} · ${mealPlanLabel(event.meal_plan)}`),
              el('dl', { class: 'kv' },
                ...line('Menú', !menu ? 'pendiente' : stale ? '⚠ desactualizado' : MENU_STATUS_LABELS[menu.status].toLowerCase(), stale ? 'warn' : menuReady ? 'ok' : 'todo'),
                ...line('Restricciones', allergies ? `${restrictions} · ${allergies} con alergia o intolerancia` : String(restrictions), allergies ? 'warn' : 'todo'),
                ...line('Compra', !list ? 'pendiente' : list.status === 'cerrada' ? 'cerrada' : toBuy === 0 ? 'todo comprado' : `${toBuy} por comprar`, buyReady ? 'ok' : 'todo'),
                ...(menu && totals.get(menu.id) && totals.get(menu.id)!.total > 0
                  ? line('Coste estimado', `${euros(totals.get(menu.id)!.total)}${event.guest_count ? ` · ${euros(totals.get(menu.id)!.total / event.guest_count)} por persona` : ''}${totals.get(menu.id)!.missing ? ' · faltan precios' : ''}${totals.get(menu.id)!.stale ? ' · precios de más de 3 meses' : ''}`, totals.get(menu.id)!.missing || totals.get(menu.id)!.stale ? 'warn' : 'todo')
                  : []),
                ...line('Preparación', ofMenu.length === 0 ? 'pendiente' : `${prepDone} de ${ofMenu.length}`, ofMenu.length > 0 && prepDone === ofMenu.length ? 'ok' : 'todo')));
          })));
  }

  /** «Hoy en casa» (O3a): lo que hay hoy en el menú de casa, que se abre con un toque. */
  function paintHouse(): void {
    replace(houseHost, el('a', { 'data-feedback-id': 'food.inicio.casa.abrir', 'data-feedback-label': 'Abrir el menú de casa', class: 'card cardlink housecard', href: HOUSE_MENU_HASH, onclick: (e: Event) => { e.preventDefault(); navigate(HOUSE_MENU_HASH); } },
      el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      el('h3', null, 'Hoy en casa'),
      house.lines.length ? el('ul', { class: 'plainlist' }, ...house.lines.map((line) => el('li', null, line)))
        : el('p', null, house.exists ? 'Nada previsto hoy en el menú de casa.' : 'El menú de casa: lo que se come en casa, día a día.')));
  }

  // Enlaces de la Despensa: llevan a la pantalla con el filtro puesto.
  const go = (id: string, label: string, hash: string, text: string) =>
    el('a', { 'data-feedback-id': id, 'data-feedback-label': label, href: hash, onclick: (e: Event) => { e.preventDefault(); navigate(hash); } }, text);

  /** Despensa: ingredientes bajo mínimo en la cocina y lotes que caducan en los próximos 7 días. */
  async function loadPantry(): Promise<void> {
    const inventory = await loadInventory(client).catch(() => null);
    if (!inventory?.kitchen.size) { replace(pantryHost); return; }
    const today = todayKey();
    const week = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const low = inventory.items.filter((i) => !i.deleted_at && i.active && ['ingrediente', 'bebida'].includes(i.kind) && Number(i.min_quantity) > 0
      && (kitchenStock(i.id, inventory.movements, inventory.lots, inventory.kitchen, today) ?? 0) < Number(i.min_quantity));
    const soon = inventory.lots.filter((l) => l.expires_on && l.expires_on >= today && l.expires_on <= week
      && inventory.movements.filter((m) => !m.deleted_at && m.lot_id === l.id && inventory.kitchen.has(m.space_id)).reduce((sum, m) => sum + Number(m.quantity), 0) > 0);
    replace(pantryHost, el('article', { 'data-feedback-id': 'food.inicio.despensa', 'data-feedback-label': 'Despensa', class: 'card', id: 'pantry' },
      el('h3', null, 'Despensa'),
      el('p', null, low.length ? `Bajo mínimo: ${low.map((i) => i.name).slice(0, 5).join(', ')}${low.length > 5 ? '…' : ''}.` : 'Stock de la cocina, sus despensas y cámaras.'),
      el('dl', { class: 'kv' },
        el('dt', null, 'Bajo mínimo'), el('dd', null, go('food.inicio.despensa.bajo_minimo', 'Ver lo que está bajo mínimo', '#/despensa?filtro=bajo_minimo', String(low.length))),
        el('dt', null, 'Caducan en 7 días'), el('dd', null, go('food.inicio.despensa.caduca', 'Ver lo que caduca pronto', '#/despensa?filtro=caduca', String(soon.length)))),
      el('p', { style: 'margin-top:8px' }, go('food.inicio.despensa.abrir', 'Abrir la despensa', '#/despensa', 'Abrir la despensa'))));
  }

  async function loadConsumption(): Promise<void> {
    const role = client.bootstrap()?.membership.role;
    const inventory = role === 'editor' || role === 'owner' ? await loadInventory(client).catch(() => null) : null;
    if (!inventory?.kitchen.size) { replace(consumeHost); return; }
    const { graph, services, consumptions } = await loadConsumptionGraph(client);
    const now = new Date();
    const due = services.filter((s) => { const state = serviceConsumption(s, graph, consumptions, inventory.movements, now).state; return state === 'por_confirmar'; })
      .sort((a, b) => a.service_date.localeCompare(b.service_date));
    if (!due.length) { replace(consumeHost); return; }
    const titleOf = (menuId: string) => {
      if (menuId === HOUSE_MENU_ID) return 'Menú de casa';
      const eventId = menus.find((m) => m.id === menuId)?.event_id;
      return snapshot.events.find((e) => e.event_id === eventId)?.title ?? 'Retiro';
    };
    replace(consumeHost, el('article', { class: 'card consumecard' },
      el('h3', null, 'Consumo por confirmar'),
      el('p', null, 'Corrige lo que se gastó o confírmalo; si no, se descuenta solo a las 24 h.'),
      el('ul', { class: 'plainlist' }, ...due.map((s) => {
        const hash = s.menu_id === HOUSE_MENU_ID ? HOUSE_MENU_HASH : `#/menus/${s.menu_id}`;
        return el('li', null, el('a', { 'data-feedback-id': 'food.inicio.consumo.servicio', 'data-feedback-label': 'Abrir el servicio', href: hash, onclick: (e: Event) => { e.preventDefault(); navigate(hash); } },
          `${SERVICE_LABELS[s.service_type]} del ${longDay(s.service_date)}`), el('span', { class: 'muted' }, ` · ${titleOf(s.menu_id)}`));
      }))));
  }

  const link = (mark: Record<'data-feedback-id' | 'data-feedback-label', string>, hash: string, title: string, text: string, ...kv: HTMLElement[]) =>
    el('a', { ...mark, class: 'card cardlink', href: hash, onclick: (e: Event) => { e.preventDefault(); navigate(hash); } },
      el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'), el('h3', null, title), el('p', null, text), el('dl', { class: 'kv' }, ...kv));

  const name = client.bootstrap()?.profile.displayName;
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', { 'data-feedback-ignore': '' }, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Qué retiros vienen y qué falta preparar.'))),
    houseHost,
    consumeHost,
    upcoming,
    el('div', { class: 'sectionlabel' }, 'Cocina'),
    el('div', { class: 'cardgrid' },
      link({ 'data-feedback-id': 'food.inicio.cocina.recetario', 'data-feedback-label': 'Ir al recetario' }, '#/recetario', 'Recetario', 'Recetas con foto, ingredientes, alérgenos y maquinaria.',
        el('dt', null, 'Recetas'), recipeCount, el('dt', null, 'En prueba'), recipeTrial),
      link({ 'data-feedback-id': 'food.inicio.cocina.maquinaria', 'data-feedback-label': 'Ir a maquinaria' }, '#/maquinaria', 'Maquinaria', 'Qué hay en la cocina y en qué estado está.',
        el('dt', null, 'Equipos'), equipmentCount, el('dt', null, 'Averiados o fuera de servicio'), equipmentDown),
      pantryHost,
      el('article', { 'data-feedback-id': 'food.inicio.sincronizacion', 'data-feedback-label': 'Sincronización', class: 'card' },
        el('h3', null, 'Sincronización'),
        el('p', null, 'Estado del espejo local en este dispositivo.'),
        el('dl', { class: 'kv' }, el('dt', null, 'Red'), network, el('dt', null, 'Pendientes'), pending, el('dt', null, 'Último pull'), lastPull, el('dt', null, 'Rol'), role),
      ),
      el('article', { 'data-feedback-id': 'food.inicio.instalar', 'data-feedback-label': 'Instalar en este dispositivo', class: 'card' },
        el('h3', null, 'Instalar en este dispositivo'),
        el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión en la cocina.'),
        deferredInstall
          ? el('p', null, el('button', { 'data-feedback-id': 'food.inicio.instalar.boton', 'data-feedback-label': 'Instalar Ikisai Food', class: 'ghost', type: 'button', style: 'margin-top:10px', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; } }, 'Instalar Ikisai Food'))
          : el('p', { style: 'margin-top:8px' }, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».'),
      ),
      el('article', { 'data-feedback-id': 'food.inicio.cuenta', 'data-feedback-label': 'Cuenta', class: 'card' },
        el('h3', null, 'Cuenta'),
        el('p', { 'data-feedback-ignore': '' }, name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.'),
        el('p', { style: 'margin-top:10px' }, el('button', { 'data-feedback-id': 'food.inicio.cuenta.cerrar_sesion', 'data-feedback-label': 'Cerrar sesión', class: 'ghost', type: 'button', id: 'logoutHome', onclick: () => void logout() }, 'Cerrar sesión')),
      ),
    ),
  );

  paint(client.status());
  void count();
  paintUpcoming();
  const loadMenus = async () => {
    [menus, lists, buyItems, steps] = await Promise.all([
      client.list(T.menus) as Promise<Mirror<Menu>[]>, client.list(T.shoppingLists) as Promise<Mirror<ShoppingList>[]>,
      client.list(T.shoppingItems) as Promise<Mirror<ShoppingListItem>[]>, client.list(T.preparation) as Promise<Mirror<PreparationItem>[]>,
    ]);
    const [graphs, purchases] = await Promise.all([loadAllMenuGraphs(client), loadPurchases(client)]);
    totals = purchases.fetchedAt ? menuTotals(graphs, purchases.prices) : new Map();
    paintUpcoming();
  };
  const loadHouse = async () => { house = await loadHouseToday(client); paintHouse(); };
  paintHouse();
  void loadHouse();
  const offHouse = [T.menus, T.menuServices, T.menuItems, T.recipes].map((table) => client.onTable(table, () => void loadHouse()));
  void loadConsumption();
  void loadPantry();
  // El espejo de Recursos llega después que el de Food: la despensa y el consumo se repintan cuando cambia.
  let resourceTimer: ReturnType<typeof setTimeout> | null = null;
  const onResources = () => { if (resourceTimer) clearTimeout(resourceTimer); resourceTimer = setTimeout(() => { void loadPantry(); void loadConsumption(); }, 300); };
  const offResources = (() => { try { const r = resourcesClient(client); const offs = [R.spaces, R.items, R.movements, R.lots].map((t) => r.onTable(t, onResources)); return () => offs.forEach((off) => off()); } catch { return () => undefined; } })();
  const offConsumption = [T.menuServices, T.menuItems, T.consumptions].map((table) => client.onTable(table, () => void loadConsumption()));
  void loadMenus();
  const offEvents = watchEvents(client, (next) => { snapshot = next; paintUpcoming(); });
  const offPlanning = [T.menus, T.shoppingLists, T.shoppingItems, T.preparation].map((table) => client.onTable(table, () => void loadMenus()));
  const offMenus = () => offPlanning.forEach((off) => off());
  const offStatus = client.onStatus((status) => { paint(status); void refreshEvents(client); });
  const offRecipes = client.onTable(T.recipes, () => void count());
  const offEquipment = client.onTable(T.equipment, () => void count());
  return () => {
    offStatus();
    offRecipes();
    offEquipment();
    offEvents();
    offMenus();
    offHouse.forEach((off) => off());
    offConsumption.forEach((off) => off());
    offResources();
    if (resourceTimer) clearTimeout(resourceTimer);
  };
};
