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
 * - Tanda 27 (Bloque 2, B «Baldosas», la misma pieza que el Inventario de Central): por defecto, una baldosa por
 *   artículo con su cifra y el relleno hasta el mínimo (`renderTile`); lo bajo mínimo primero y con «A la compra».
 *   La lista de siempre, con sus filtros y acciones, a un toque («Lista»); los enlaces con `?filtro=` llegan a la lista.
 */
import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, HOUSE_MENU_ID, foodUnitFromBase, kitchenSpaceIds, kitchenStock, weekDays,
  type Ingredient, type LotLike, type MovementLike, type MenuItem, type MenuService, type ShoppingList, type ShoppingListItem, type SpaceLike,
} from '@ikisai/domain-food';
import {
  createCountSession, createItemCatalog, renderTile, createItemSheet, createMovementForm, createSyncItemSource, createSyncSpaceSource, el, openSheet, replace, toast,
  type ItemCatalog, type ItemCatalogFilter, type ItemRow, type ItemSheet, type Sheet,
} from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { T, describeError, formatQuantity, type Mirror } from '../app/client.ts';
import { loadInventory } from '../app/consumption.ts';
import { longDay, todayKey } from '../app/events.ts';
import { HOUSE_MENU_HASH } from '../app/house.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { usage } from '../app/usage.ts';
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
  const tilesHost = el('div', { 'data-feedback-id': 'food.despensa.baldosas', 'data-feedback-label': 'Baldosas', class: 'fd-tiles', id: 'pantryTiles' });
  const viewButton = (value: 'baldosas' | 'lista', label: string) => el('button', { type: 'button', 'data-view': value, 'aria-pressed': 'false', onclick: () => setView(value, true) }, label);
  const viewBar = el('div', { 'data-feedback-id': 'food.despensa.vista', 'data-feedback-label': 'Vista de la despensa', class: 'segmented fd-viewbar', role: 'group', 'aria-label': 'Vista' },
    viewButton('baldosas', 'Baldosas'), viewButton('lista', 'Lista'));

  function setView(next: 'baldosas' | 'lista', remember = false): void {
    view = next;
    if (remember) { try { localStorage.setItem(VIEW_KEY, next); } catch { /* sin almacenamiento: solo esta visita */ } }
    for (const b of viewBar.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.view === next));
    if (catalog) catalog.element.hidden = next !== 'lista';
    tilesHost.hidden = next !== 'baldosas';
    if (next === 'baldosas') void paintTiles();
  }

  /** Una baldosa por artículo de cocina: cifra, relleno hasta el doble del mínimo (la raya, el mínimo) y su nivel escrito. */
  async function paintTiles(): Promise<void> {
    const inventory = await loadInventory(client).catch(() => null);
    if (!inventory?.kitchen.size || view !== 'baldosas') return;
    const today = todayKey();
    const rows = inventory.items.filter((i) => !i.deleted_at && i.active && ['ingrediente', 'bebida'].includes(i.kind)).map((i) => {
      const stock = kitchenStock(i.id, inventory.movements, inventory.lots, inventory.kitchen, today) ?? 0;
      const min = Number(i.min_quantity) || 0;
      const tone: 'alert' | 'warn' | 'ok' | null = !min ? null : stock < min ? 'alert' : stock < min * 1.5 ? 'warn' : 'ok';
      return { item: i, stock, min, tone };
    }).filter((x) => x.stock > 0 || x.min > 0)
      .sort((a, b) => (a.tone === 'alert' ? 0 : a.tone === 'warn' ? 1 : 2) - (b.tone === 'alert' ? 0 : b.tone === 'warn' ? 1 : 2) || a.item.name.localeCompare(b.item.name, 'es'));
    if (!rows.length) { replace(tilesHost, el('p', { class: 'muted' }, 'No hay nada en la despensa todavía. «Lista» para dar entrada.')); return; }
    const snapshot = await items.list();
    replace(tilesHost, ...rows.map(({ item, stock, min, tone }) => {
      const tile = renderTile({
        title: item.name,
        value: `${formatQuantity(stock)} ${item.base_unit}`,
        levelText: !min ? 'sin mínimo' : tone === 'alert' ? `bajo mínimo (${formatQuantity(min)})` : tone === 'warn' ? 'va justo' : 'bien',
        level: min ? { pct: Math.min(100, (stock / (min * 2)) * 100), min: 50, tone } : null,
        onClick: () => void openItem({ id: item.id, name: item.name }),
      });
      const row = snapshot.items.find((x) => x.id === item.id);
      return el('div', { class: 'fd-tile', 'data-item-id': item.id, 'data-tone': tone ?? '' }, tile,
        tone === 'alert' && canWrite() && row
          ? el('button', { 'data-feedback-id': 'food.despensa.baldosas.a_la_compra', 'data-feedback-label': 'A la compra', class: 'ghost fd-tile-buy', type: 'button', 'aria-label': `A la compra: ${item.name}`, onclick: () => void toShopping(row) }, 'A la compra')
          : null);
    }));
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

  /** «A la compra»: una línea a mano en la lista de esta semana del menú de casa, con lo que falta hasta el mínimo. */
  async function toShopping(item: ItemRow): Promise<void> {
    const days = weekDays(todayKey(), 0);
    const period = { start: days[0]!, end: days[6]! };
    try {
      let lists = (await client.list(T.shoppingLists)) as Array<Mirror<ShoppingList>>;
      let list = lists.find((l) => l.menu_id === HOUSE_MENU_ID && !l.deleted_at && l.period_start === period.start && l.period_end === period.end);
      if (!list) {
        if (!navigator.onLine) { toast(`Aún no hay lista para ${periodLabel(period)}: generarla necesita conexión.`); return; }
        if (!(await client.get(T.menus, HOUSE_MENU_ID))) await client.commit([{ op: 'insert', table: T.menus, id: HOUSE_MENU_ID, fields: { kind: 'casa' } }]);
        await runCall(client, FOOD_PROCEDURES.regenerateShopping, { menu_id: HOUSE_MENU_ID, list_id: crypto.randomUUID(), period_start: period.start, period_end: period.end });
        lists = (await client.list(T.shoppingLists)) as Array<Mirror<ShoppingList>>;
        list = lists.find((l) => l.menu_id === HOUSE_MENU_ID && !l.deleted_at && l.period_start === period.start);
      }
      if (!list) return;
      if (list.status === 'cerrada') { toast(`La lista de ${periodLabel(period)} está cerrada.`); return; }
      const ingredients = (await client.list(T.ingredients)) as Array<Mirror<Ingredient>>;
      const operations: RowOperation[] = [];
      let ingredient = ingredients.find((g) => g.item_id === item.id);
      const unit = foodUnitFromBase(item.baseUnit) ?? 'otro';
      if (!ingredient) {
        // Un artículo que Food aún no usa: el ingrediente nace enlazado con él.
        const id = crypto.randomUUID();
        operations.push({ op: 'insert', table: T.ingredients, id, fields: { name: item.name, preferred_unit: unit, item_id: item.id } });
        ingredient = { id } as Mirror<Ingredient>;
      }
      const lines = (await client.list(T.shoppingItems)) as Array<Mirror<ShoppingListItem>>;
      if (lines.some((l) => l.shopping_list_id === list!.id && l.ingredient_id === ingredient!.id && !l.deleted_at && l.status === 'pendiente')) {
        toast(`${item.name} ya está en la lista de ${periodLabel(period)}.`);
        return;
      }
      const [movements, lots, spaceRows] = await Promise.all([r.list(R.movements), r.list(R.lots), r.list(R.spaces)]);
      const stock = kitchenStock(item.id, movements as unknown as MovementLike[], lots as unknown as LotLike[], kitchenSpaceIds(spaceRows as unknown as SpaceLike[]), todayKey()) ?? 0;
      const quantity = item.reorderQuantity ?? (item.minQuantity !== null ? Math.max(item.minQuantity - stock, 0) : 0);
      operations.push({ op: 'insert', table: T.shoppingItems, id: crypto.randomUUID(),
        fields: { shopping_list_id: list.id, ingredient_id: ingredient.id, unit, purchase_quantity: quantity > 0 ? quantity : 1, manual: true } });
      await usage.run('food.despensa.a_la_compra', () => client.commit(operations));
      toast(`${item.name}: a la lista de ${periodLabel(period)}.`);
    } catch (error) {
      toast(describeError(error));
    }
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
    catalog = createItemCatalog({
      source: items, spaces, label: 'Despensa', kinds: ['ingrediente', 'bebida'], scope: [...kitchen], groupBy: 'space', spaceChips: chips,
      storageKey: 'food.despensa', feedbackId: CATALOG_MARK, canCreate: canWrite(),
      ...(canWrite() ? { actions: ['spend', 'entry', 'count'] as Array<'spend' | 'entry' | 'count'>, onAction: (action: 'spend' | 'entry' | 'count', item: ItemRow) => void act(action, item) } : {}),
      onOpen: (item) => void openItem(item),
      rowActions: (item) => (canWrite() ? [{ label: 'A la compra', feedbackId: TO_SHOPPING_MARK, primary: !!item.minQuantity, onClick: () => void toShopping(item) }] : []),
    });
    replace(host, viewBar, tilesHost, catalog.element);
    setView(view);
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const filter = params.get('filtro');
    // El filtro que llega por un enlace (Inicio) vale para esta visita: al salir vuelve el que tenía la persona.
    if (filter === 'bajo_minimo' || filter === 'caduca') {
      own ??= catalog.getFilter();
      catalog.setFilter({ ...own, low: filter === 'bajo_minimo', expiring: filter === 'caduca' });
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
  let tileTimer: ReturnType<typeof setTimeout> | null = null;
  const offTiles = [R.items, R.movements, R.lots].map((t) => r.onTable(t, () => { if (tileTimer) clearTimeout(tileTimer); tileTimer = setTimeout(() => { if (view === 'baldosas') void paintTiles(); }, 300); }));
  return () => {
    off();
    offNet();
    window.removeEventListener('online', paintOffline);
    window.removeEventListener('offline', paintOffline);
    offTiles.forEach((stop) => stop());
    if (tileTimer) clearTimeout(tileTimer);
    if (own) catalog?.setFilter(own);
    catalog?.destroy();
    sheet?.destroy();
    tool?.destroy();
    items.destroy();
    spaces.destroy();
  };
};
