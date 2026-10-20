/**
 * Food · Despensa (aprobada por el usuario el 18-10-2026; docs/food/API.md §9): el inventario de la cocina, sus
 * despensas y sus cámaras con las piezas del kit (`createItemCatalog` y `createItemSheet`, 0.37), sobre el espejo de
 * Recursos, también sin red.
 *
 * - Ámbito: los sitios de cocina (`kitchenSpaceIds`, las mismas reglas que la compra), ingredientes y bebidas.
 * - «A la compra»: una línea a mano en la lista de esta semana del menú de casa (la genera si no existe, con red).
 * - La ficha enlaza el origen de cada movimiento: el servicio que lo consumió o la lista que lo compró.
 * - `#/despensa?filtro=bajo_minimo|caduca` llega con el filtro puesto (Inicio); `#/despensa?articulo=<id>` abre su ficha.
 * - Kit 0.38: «Gastar», «Entrada» y «Mover» (`createMovementForm`) y «Contar» a ciegas (`createCountSession`), en una
 *   hoja; también «Contar» por sitio desde la cabecera.
 * - Bloque 2 (B «Baldosas», MUELA-077 §3): la vista del kit (`createItemCatalog` con `layout: 'baldosas'`, kit 0.50),
 *   la misma pieza que el Inventario de Central, con sus filtros, sus acciones y «A la compra». La lista de siempre, a un
 *   toque («Lista»); los enlaces con `?filtro=` llegan a la lista. Dentro de «Casa» (`#/casa`), con Maquinaria.
 */
import type { SyncedRow } from '@ikisai/sync-client';
import {
  HOUSE_MENU_ID, kitchenSpaceIds,
  type MenuItem, type MenuService, type ShoppingList, type ShoppingListItem, type SpaceLike,
} from '@ikisai/domain-food';
import {
  createCountSession, createItemCatalog, createItemSheet, createMovementForm, createSyncItemSource, createSyncSpaceSource, el, openSheet, replace,
  type ItemCatalog, type ItemCatalogFilter, type ItemRow, type ItemSheet, type Sheet,
} from '@ikisai/ui-kit';
import { T, type Mirror } from '../app/client.ts';
import { longDay } from '../app/events.ts';
import { HOUSE_MENU_HASH } from '../app/house.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { toShopping } from '../app/to-shopping.ts';
import { SERVICE_LABELS } from './events.ts';
import { periodLabel } from './house-period.ts';
import type { ViewMount } from './shell.ts';

/** Marcas de las piezas del kit; el kit pone las etiquetas de sus partes (`ITEM_CATALOG_MARKS`, `ITEM_SHEET_MARKS`). */
const CATALOG_MARK = 'food.despensa.catalogo';
const SHEET_MARK = 'food.despensa.ficha';
const TO_SHOPPING_MARK = 'food.despensa.a_la_compra';

export const PANTRY_HASH = '#/despensa';

export const mountPantry: ViewMount = ({ main, client, navigate }) => {
  const r = resourcesClient(client);
  const items = createSyncItemSource(r);
  const spaces = createSyncSpaceSource(r);
  const canWrite = () => ['editor', 'owner'].includes(client.bootstrap()?.membership.role ?? '');
  const host = el('div', { id: 'pantryHost' });
  // Sin red (MUELA-086): la despensa sigue con lo de este dispositivo y lo dice; los movimientos se envían al volver.
  const offlineNow = () => client.status().network === 'offline' || !navigator.onLine;
  const offlineLine = el('div', { 'data-feedback-id': 'food.despensa.sin_red', 'data-feedback-label': 'Sin conexión', class: 'banner warn notice', id: 'pantryOffline', role: 'status', hidden: true },
    el('div', null, el('strong', null, 'Sin conexión.'), ' Ves lo que hay en este dispositivo; lo que anotes se enviará al volver la red. «A la compra» necesita conexión si aún no hay lista.'));
  const paintOffline = () => { offlineLine.hidden = !offlineNow(); };
  let catalog: ItemCatalog | null = null;
  let sheet: ItemSheet | null = null;
  let kitchenKey = '';
  let own: ItemCatalogFilter | null = null;
  let chips: string[] = [];
  let kitchenSet = new Set<string>();
  let names = new Map<string, string>();
  let tool: { element: HTMLElement; destroy(): void } | null = null;
  let toolSheet: Sheet | null = null;
  let sheetHandle: Sheet | null = null;
  const MOVE_MARK = 'food.despensa.movimiento';
  // Vista «Baldosas» (por defecto) o «Lista»; la elección se recuerda en este dispositivo.
  const VIEW_KEY = 'food.despensa.vista';
  const storedView = (() => { try { return localStorage.getItem(VIEW_KEY); } catch { return null; } })();
  const linked = /[?&](filtro|articulo)=/.test(location.hash);
  let view: 'baldosas' | 'lista' = linked ? 'lista' : storedView === 'lista' ? 'lista' : 'baldosas';
  const catalogHost = el('div', { id: 'pantryCatalog' });
  const viewButton = (value: 'baldosas' | 'lista', label: string) => el('button', { type: 'button', 'data-view': value, 'aria-pressed': 'false', onclick: () => setView(value, true) }, label);
  const viewBar = el('div', { 'data-feedback-id': 'food.despensa.vista', 'data-feedback-label': 'Vista de la despensa', class: 'segmented fd-viewbar', role: 'group', 'aria-label': 'Vista' },
    viewButton('baldosas', 'Baldosas'), viewButton('lista', 'Lista'));
  let build: ((layout: 'baldosas' | 'list') => ItemCatalog) | null = null;

  /** Las dos vistas son la misma pieza del kit con otro `layout`: se monta de nuevo con los filtros que tenía. */
  function setView(next: 'baldosas' | 'lista', remember = false): void {
    view = next;
    if (remember) { try { localStorage.setItem(VIEW_KEY, next); } catch { /* sin almacenamiento: solo esta visita */ } }
    for (const b of viewBar.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.view === next));
    if (!build) return;
    const filter = catalog?.getFilter() ?? null;
    catalog?.destroy();
    catalog = build(next === 'baldosas' ? 'baldosas' : 'list');
    if (filter) catalog.setFilter(filter);
    catalogHost.dataset.view = next;
    replace(catalogHost, catalog.element);
  }
  const COUNT_MARK = 'food.despensa.recuento';

  /** Una pieza del kit (formulario o recuento) en una hoja; al acabar, se cierra. */
  function inSheet(title: string, build: (done: () => void) => { element: HTMLElement; destroy(): void }): void {
    tool?.destroy();
    const done = () => { void toolSheet?.close(true); };
    tool = build(done);
    toolSheet = openSheet({ title, body: tool.element, onClose: () => { tool?.destroy(); tool = null; toolSheet = null; } });
  }
  const countSession = (title: string, options: { spaceId?: string; itemIds?: string[] }) =>
    inSheet(title, (done) => createCountSession({ source: items, spaces, feedbackId: COUNT_MARK, onClosed: done, onLeave: done, ...options }));

  /** De dónde sale o dónde entra: el sitio de cocina con stock del artículo si es uno solo; si no, su sitio habitual. */
  async function placeOf(item: Pick<ItemRow, 'id'> & { defaultSpaceId?: string | null }): Promise<string | null> {
    const movements = (await r.list(R.movements)) as SyncedRow[];
    const bySpace = new Map<string, number>();
    for (const m of movements) if (!m.deleted_at && m.item_id === item.id && kitchenSet.has(String(m.space_id))) bySpace.set(String(m.space_id), (bySpace.get(String(m.space_id)) ?? 0) + Number(m.quantity));
    const withStock = [...bySpace].filter(([, q]) => q > 0).map(([id]) => id);
    return withStock.length === 1 ? withStock[0]! : item.defaultSpaceId ?? null;
  }

  async function act(action: 'spend' | 'entry' | 'transfer' | 'count', item: Pick<ItemRow, 'id' | 'name'> & { defaultSpaceId?: string | null }): Promise<void> {
    void sheetHandle?.close(true);
    if (action === 'count') { countSession(`Contar ${item.name}`, { itemIds: [item.id] }); return; }
    const title = action === 'spend' ? `Gastar ${item.name}` : action === 'entry' ? `Entrada de ${item.name}` : `Mover ${item.name}`;
    const spaceId = await placeOf(item);
    inSheet(title, (done) => createMovementForm({
      source: items, spaces, itemId: item.id, quickSpaces: chips, ...(spaceId ? { spaceId } : {}), sourceApp: 'food', feedbackId: MOVE_MARK, onDone: done, onCancel: done,
      ...(action === 'spend' ? { modes: ['exit' as const], reason: 'uso' } : { mode: action === 'entry' ? 'entry' as const : 'transfer' as const }),
    }));
  }

  /** «Contar»: un sitio de cocina cada vez, a ciegas. */
  function countPlace(): void {
    if (chips.length === 1) { countSession(`Contar ${names.get(chips[0]!) ?? 'la despensa'}`, { spaceId: chips[0]! }); return; }
    const pick = openSheet({ title: 'Contar la despensa', body: el('div', { id: 'countPlaces' },
      el('p', { class: 'muted' }, 'Elige el sitio. Se cuenta a ciegas: no se enseña lo que dice el sistema hasta el final.'),
      el('div', { class: 'btnrow' }, ...chips.map((id) => el('button', { 'data-feedback-id': 'food.despensa.contar_sitio', 'data-feedback-label': 'Contar este sitio', class: 'ghost', type: 'button',
        onclick: () => { void pick.close(true); countSession(`Contar ${names.get(id) ?? 'el sitio'}`, { spaceId: id }); } }, names.get(id) ?? 'Sitio')))) });
  }

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Despensa'),
      el('p', null, 'Lo que hay en la cocina, sus despensas y sus cámaras: dónde está, qué falta y qué caduca.')),
      el('button', { 'data-feedback-id': 'food.despensa.contar', 'data-feedback-label': 'Contar la despensa', class: 'ghost', type: 'button', id: 'countPantry', hidden: true, onclick: () => countPlace() }, 'Contar')),
    offlineLine,
    host);

  /** Origen de un movimiento de Food, en palabras y con su enlace. */
  async function sourceLabel(ref: string): Promise<{ label: string; hash: string } | null> {
    const [kind, id] = ref.split(':');
    if (kind === 'menu_item' && id) {
      const item = (await client.get(T.menuItems, id)) as Mirror<MenuItem> | null;
      const service = item ? ((await client.get(T.menuServices, item.service_id)) as Mirror<MenuService> | null) : null;
      if (!service) return null;
      return { label: `${SERVICE_LABELS[service.service_type]} del ${longDay(service.service_date)}`, hash: service.menu_id === HOUSE_MENU_ID ? HOUSE_MENU_HASH : `#/menus/${service.menu_id}` };
    }
    if (kind === 'shopping_item' && id) {
      const line = (await client.get(T.shoppingItems, id)) as Mirror<ShoppingListItem> | null;
      const list = line ? ((await client.get(T.shoppingLists, line.shopping_list_id)) as Mirror<ShoppingList> | null) : null;
      if (!list) return null;
      return { label: list.period_start ? `Lista ${periodLabel({ start: list.period_start, end: list.period_end! })}` : 'Lista de compra', hash: `#/menus/${list.menu_id}/compra` };
    }
    return null;
  }

  async function openItem(item: Pick<ItemRow, 'id' | 'name'>): Promise<void> {
    sheet?.destroy();
    // Los orígenes de Food se resuelven antes (la ficha los pide de forma síncrona).
    const movements = (await r.list(R.movements)) as SyncedRow[];
    const refs = new Map<string, { label: string; hash: string } | null>();
    for (const m of movements) if (m.item_id === item.id && m.source_app === 'food' && typeof m.source_ref === 'string' && !refs.has(m.source_ref)) refs.set(m.source_ref, await sourceLabel(m.source_ref));
    sheet = createItemSheet({
      source: items, itemId: item.id, spaces, feedbackId: SHEET_MARK, permissions: { edit: canWrite() },
      ...(canWrite() ? { actions: ['spend', 'entry', 'transfer', 'count'] as Array<'spend' | 'entry' | 'transfer' | 'count'>, onAction: (action: 'spend' | 'entry' | 'transfer' | 'count', it: ItemRow) => void act(action, it) } : {}),
      sourceLink: (app, ref) => {
        const hit = app === 'food' ? refs.get(ref) : null;
        return hit ? { label: hit.label, onClick: () => { void handle.close(true); navigate(hit.hash); } } : null;
      },
    });
    const handle = openSheet({ title: item.name, body: sheet.element, onClose: () => { sheet?.destroy(); sheet = null; sheetHandle = null; } });
    sheetHandle = handle;
  }

  async function paint(): Promise<void> {
    paintOffline();
    let rows: SpaceLike[];
    try {
      rows = (await r.list(R.spaces)) as unknown as SpaceLike[];
    } catch {
      // Sin el espejo de Recursos en este dispositivo: lo dice, en vez de quedarse en blanco (MUELA-086).
      kitchenKey = ''; catalog?.destroy(); catalog = null;
      replace(host, el('div', { class: 'empty', id: 'pantryUnavailable' }, el('strong', null, 'La despensa no se puede leer en este dispositivo'),
        offlineNow() ? 'Sin conexión y sin una copia de Recursos aquí. Ábrela una vez con red y después funcionará también sin ella.' : 'Vuelve a intentarlo en un momento.'));
      return;
    }
    const kitchen = kitchenSpaceIds(rows);
    const key = [...kitchen].sort().join(',');
    if (key === kitchenKey && catalog) return;
    kitchenKey = key;
    catalog?.destroy();
    catalog = null;
    if (!kitchen.size && offlineNow() && !rows.length) {
      // Sin red y sin espacios en este dispositivo no se sabe si hay despensa: no se dice que no la hay.
      replace(host, el('div', { class: 'empty', id: 'pantryUnavailable' }, el('strong', null, 'La despensa aún no está en este dispositivo'),
        'Sin conexión. Ábrela una vez con red y después funcionará también sin ella.'));
      return;
    }
    if (!kitchen.size) {
      replace(host, el('div', { class: 'empty', id: 'pantryEmpty' }, el('strong', null, 'Todavía no se lleva la despensa'),
        'Para empezar, en Recursos tiene que estar la cocina y, dentro o al lado, sus despensas y cámaras (Central › Espacios). Food cuenta lo que hay en ellas.'));
      return;
    }
    // Chips a un toque: la cocina y las despensas y cámaras de primer nivel, por nombre.
    chips = rows.filter((s) => kitchen.has(s.id) && !(s.parent_id && kitchen.has(s.parent_id))).sort((a, b) => a.name.localeCompare(b.name, 'es')).map((s) => s.id);
    names = new Map(rows.map((s) => [s.id, s.name]));
    kitchenSet = kitchen;
    const countButton = main.querySelector<HTMLButtonElement>('#countPantry');
    if (countButton) countButton.hidden = !canWrite();
    build = (layout) => createItemCatalog({
      source: items, spaces, label: 'Despensa', kinds: ['ingrediente', 'bebida'], scope: [...kitchen], groupBy: 'space', spaceChips: chips,
      storageKey: 'food.despensa', feedbackId: CATALOG_MARK, canCreate: canWrite(), layout,
      ...(canWrite() ? { actions: ['spend', 'entry', 'count'] as Array<'spend' | 'entry' | 'count'>, onAction: (action: 'spend' | 'entry' | 'count', item: ItemRow) => void act(action, item) } : {}),
      onOpen: (item) => void openItem(item),
      // En las baldosas, «A la compra» solo en lo que lleva mínimo (lo demás, desde la ficha o la lista).
      rowActions: (item) => (canWrite() && (layout === 'list' || !!item.minQuantity) ? [{ label: 'A la compra', feedbackId: TO_SHOPPING_MARK, primary: !!item.minQuantity, onClick: () => void toShopping(client, item) }] : []),
    });
    replace(host, viewBar, catalogHost);
    setView(view);
    const live = catalog as ItemCatalog | null;
    if (!live) return;
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const filter = params.get('filtro');
    // El filtro que llega por un enlace (Inicio) vale para esta visita: al salir vuelve el que tenía la persona.
    if (filter === 'bajo_minimo' || filter === 'caduca') {
      own ??= live.getFilter();
      live.setFilter({ ...own, low: filter === 'bajo_minimo', expiring: filter === 'caduca' });
    }
    const wanted = params.get('articulo');
    if (wanted) {
      const snap = await items.list();
      const item = snap.items.find((i) => i.id === wanted);
      if (item) void openItem(item);
    }
  }

  void paint();
  const off = r.onTable(R.spaces, () => void paint());
  const offNet = client.onStatus(paintOffline);
  window.addEventListener('online', paintOffline);
  window.addEventListener('offline', paintOffline);
  return () => {
    off();
    offNet();
    window.removeEventListener('online', paintOffline);
    window.removeEventListener('offline', paintOffline);
    if (own) catalog?.setFilter(own);
    catalog?.destroy();
    sheet?.destroy();
    tool?.destroy();
    items.destroy();
    spaces.destroy();
  };
};
