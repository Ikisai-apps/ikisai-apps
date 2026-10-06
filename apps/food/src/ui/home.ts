import type { SyncStatus } from '@ikisai/sync-client';
import { isMenuStale, type Equipment, type Menu, type PreparationItem, type Recipe, type ShoppingList, type ShoppingListItem } from '@ikisai/domain-food';
import { el, formatDate, replace } from './dom.ts';
import { T, type Mirror } from '../app/client.ts';
import { allergyCount, dateRange, guestsLabel, mealPlanLabel, needsMenu, refreshEvents, todayKey, watchEvents, whenLabel, type EventsSnapshot } from '../app/events.ts';
import { MENU_STATUS_LABELS } from './events.ts';
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
  const network = el('dd');
  const pending = el('dd');
  const lastPull = el('dd');
  const role = el('dd');
  const upcoming = el('section', { id: 'upcoming' });
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let menus: Mirror<Menu>[] = [];
  let lists: Mirror<ShoppingList>[] = [];
  let buyItems: Mirror<ShoppingListItem>[] = [];
  let steps: Mirror<PreparationItem>[] = [];

  function paint(status: SyncStatus): void {
    network.textContent = status.network === 'online' ? 'En línea' : status.network === 'offline' ? 'Sin conexión' : status.network === 'syncing' ? 'Sincronizando…' : 'Error';
    pending.textContent = String(status.pendingCommands + status.pendingBlobs);
    lastPull.textContent = formatDate(status.lastPullAt);
    const boot = client.bootstrap();
    role.textContent = boot ? { owner: 'Propietario', editor: 'Cocina', reader: 'Solo lectura' }[boot.membership.role] : '—';
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
    const events = snapshot.events.filter((e) => e.end_date >= today && needsMenu(e)).slice(0, 6);
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
            return el('a', { class: 'card cardlink eventcard', href: target, onclick: (e: Event) => { e.preventDefault(); navigate(target); } },
              el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
              el('h3', null, `${dateRange(event)} · ${event.title}`),
              el('p', null, `${whenLabel(event)} · ${guestsLabel(event)} · ${mealPlanLabel(event.meal_plan)}`),
              el('dl', { class: 'kv' },
                ...line('Menú', !menu ? 'pendiente' : stale ? '⚠ desactualizado' : MENU_STATUS_LABELS[menu.status].toLowerCase(), stale ? 'warn' : menuReady ? 'ok' : 'todo'),
                ...line('Restricciones', allergies ? `${restrictions} · ${allergies} con alergia o intolerancia` : String(restrictions), allergies ? 'warn' : 'todo'),
                ...line('Compra', !list ? 'pendiente' : list.status === 'cerrada' ? 'cerrada' : toBuy === 0 ? 'todo comprado' : `${toBuy} por comprar`, buyReady ? 'ok' : 'todo'),
                ...line('Preparación', ofMenu.length === 0 ? 'pendiente' : `${prepDone} de ${ofMenu.length}`, ofMenu.length > 0 && prepDone === ofMenu.length ? 'ok' : 'todo')));
          })));
  }

  const link = (hash: string, title: string, text: string, ...kv: HTMLElement[]) =>
    el('a', { class: 'card cardlink', href: hash, onclick: (e: Event) => { e.preventDefault(); navigate(hash); } },
      el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'), el('h3', null, title), el('p', null, text), el('dl', { class: 'kv' }, ...kv));

  const name = client.bootstrap()?.profile.displayName;
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Qué retiros vienen y qué falta preparar.'))),
    upcoming,
    el('div', { class: 'sectionlabel' }, 'Cocina'),
    el('div', { class: 'cardgrid' },
      link('#/recetario', 'Recetario', 'Recetas con foto, ingredientes, alérgenos y maquinaria.',
        el('dt', null, 'Recetas'), recipeCount, el('dt', null, 'En prueba'), recipeTrial),
      link('#/maquinaria', 'Maquinaria', 'Qué hay en la cocina y en qué estado está.',
        el('dt', null, 'Equipos'), equipmentCount, el('dt', null, 'Averiados o fuera de servicio'), equipmentDown),
      el('article', { class: 'card' },
        el('h3', null, 'Sincronización'),
        el('p', null, 'Estado del espejo local en este dispositivo.'),
        el('dl', { class: 'kv' }, el('dt', null, 'Red'), network, el('dt', null, 'Pendientes'), pending, el('dt', null, 'Último pull'), lastPull, el('dt', null, 'Rol'), role),
      ),
      el('article', { class: 'card' },
        el('h3', null, 'Instalar en este dispositivo'),
        el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión en la cocina.'),
        deferredInstall
          ? el('p', null, el('button', { class: 'ghost', type: 'button', style: 'margin-top:10px', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; } }, 'Instalar Ikisai Food'))
          : el('p', { style: 'margin-top:8px' }, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».'),
      ),
      el('article', { class: 'card' },
        el('h3', null, 'Cuenta'),
        el('p', null, name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.'),
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'logoutHome', onclick: () => void logout() }, 'Cerrar sesión')),
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
    paintUpcoming();
  };
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
  };
};
