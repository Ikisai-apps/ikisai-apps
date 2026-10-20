import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, SHOPPING_ITEM_STATUSES, defaultPurchase, ingredientKey, isStale, itemAverageCost, lastTicket, linePacks, linePerUnit, purchaseMovement, purchaseSpace,
  savePackOperations, shopColor, shoppingSources, sourceChanges, toItemBase, validateOperations,
  type CostMovement, type ItemConversion, type MovementCost, type MovementLike, type PackUnitRow, type ResourceItem, type ShoppingItemStatus, type ShoppingList,
  type ShoppingListItem, type ShoppingListStatus, type SpaceLike, type Unit,
} from '@ikisai/domain-food';
import {
  Envase, createShelves, el, formatDate, icon, openSheet, plural, renderTile, replace, toast, toastWithAction, type PackPlan, type ShelfRow, type Sheet, type TileAction,
} from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { T, UNITS, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import { MENU_TABLES, loadMenuData, type MenuData } from '../app/menu-data.ts';
import { loadPurchases, type PurchasesSnapshot } from '../app/purchases.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { usage } from '../app/usage.ts';
import { fb, type FbMark } from './feedback.ts';
import { housePeriod, periodBar, periodLabel, samePeriod, setHousePeriod } from './house-period.ts';
import { onlineBinder } from './online.ts';

type ListRow = Mirror<ShoppingList>;
type ItemRow = Mirror<ShoppingListItem>;
type Article = ResourceItem & { default_space_id: string | null };

const LIST_STATUS_LABELS: Record<ShoppingListStatus, string> = { borrador: 'Borrador', revisada: 'Revisada', cerrada: 'Cerrada' };
const ITEM_STATUS_LABELS: Record<ShoppingItemStatus, string> = { pendiente: 'Pendiente', comprado: 'Comprado', recibido: 'Recibido' };
const NO_SHOP = 'Sin tienda';
const euros = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

interface RegenerateResult { list_id: string; created: boolean; inserted: number; updated: number; deleted: number; kept: number; status: string }

export interface TabContext {
  client: SyncClient;
  menuId: string;
  host: HTMLElement;
  canWrite(): boolean;
  /** Menú de casa (O3b): compra y preparación por un rango de días que se elige al generar. */
  house?: boolean;
  /** Ir a otra pantalla (las comprobaciones del Organizador y del Cierre llevan a su arreglo). */
  navigate?: (hash: string) => void;
  /** Ir a los comentarios del organizador en la pestaña Menú, con su plegado abierto (el Cierre lo usa). */
  goToComments?: () => void;
}

/** Lo que dice y dibuja cada línea: el envase (`Envase.plan`), su coste y si el envase se puede tocar. */
interface LineView {
  item: ItemRow;
  name: string;
  article: Article | null;
  plan: PackPlan;
  /** Envases del artículo en la unidad de la línea, el habitual primero. */
  packs: ReturnType<typeof linePacks>;
  perUnit: number | null;
  bought: boolean;
  shop: string;
}

/**
 * Lista de compra del menú (tanda 40, MUELA-093 «Estantería»): una estantería por tienda, cada producto una baldosa con
 * su envase dibujado, el carrito y el «⋯»; arriba, el dinero y las tiendas. Generar y regenerar necesitan red; marcar,
 * el lote, «En casa», «Comprar», el envase y las líneas a mano, no.
 */
export function mountShopping({ client, menuId, host, canWrite, house = false }: TabContext): () => void {
  let data: MenuData | null = null;
  let list: ListRow | null = null;
  let houseLists: ListRow[] = []; // en casa: las listas vivas del menú, cada una con sus días
  let items: ItemRow[] = [];
  let sheet: Sheet | null = null;
  let busy = false;
  // Recursos (envases, artículos y costes) y las compras de Invoices, para el envase y el dinero.
  const r = resourcesClient(client);
  let articles: Article[] = [];
  let units: PackUnitRow[] = [];
  let movements: CostMovement[] = [];
  let costs: MovementCost[] = [];
  let purchases: PurchasesSnapshot = { purchases: [], prices: new Map(), fetchedAt: null };

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

  async function regenerate(): Promise<void> {
    if (busy) return;
    busy = true;
    paint();
    try {
      const result = await usage.run('food.compra.generar', () => runCall<RegenerateResult>(client, FOOD_PROCEDURES.regenerateShopping, {
        menu_id: menuId, list_id: list?.id ?? crypto.randomUUID(), ...(house ? { period_start: housePeriod().start, period_end: housePeriod().end } : {}) }));
      toast(result.created
        ? `Lista generada: ${plural(result.inserted, 'producto', 'productos')}.`
        : `Lista regenerada: ${plural(result.inserted, 'nuevo', 'nuevos')}, ${plural(result.updated, 'actualizado', 'actualizados')}, ${plural(result.deleted, 'retirado', 'retirados')}.`);
    } catch (error) {
      toast(describeError(error));
    } finally {
      busy = false;
      await load();
    }
  }

  const update = (item: ItemRow, fields: Record<string, unknown>) =>
    commitSafely([{ op: 'update', table: T.shoppingItems, id: item.id, expectedRevision: item.revision, fields }]);
  const fresh = (item: ItemRow) => items.find((i) => i.id === item.id) ?? null;

  /**
   * «Comprado» (o «recibido») entra al stock de Recursos en ese momento, sin coste; volver a «pendiente» lo saca
   * (decisión del usuario, 14-10-2026). Finance (R4) añade después el coste a esa entrada por su referencia
   * `shopping_item:<id>`. Si el ingrediente aún no tiene artículo o no hay ningún sitio de cocina, la lista sigue como
   * siempre; si la unidad no se puede pasar a la del artículo, se avisa. Cambiar «En casa» o «Comprar» en una línea ya
   * comprada (H-C5) también pasa por aquí: el movimiento es la diferencia con lo que ya entró por esa referencia.
   * Recursos se lee una sola vez para todo el lote.
   */
  async function recordPurchases(lines: ItemRow[]): Promise<void> {
    const linked = lines.map((line) => ({ line, ingredient: data?.ingredients.find((i) => i.id === line.ingredient_id) })).filter((x) => x.ingredient?.item_id);
    if (!linked.length) return;
    try {
      const [all, spaces, moves, conversions] = await Promise.all([
        r.list(R.items) as unknown as Promise<Article[]>,
        r.list(R.spaces) as unknown as Promise<SpaceLike[]>,
        r.list(R.movements) as unknown as Promise<MovementLike[]>,
        r.list(R.itemUnits) as unknown as Promise<ItemConversion[]>,
      ]);
      const operations: RowOperation[] = [];
      const unconvertible: string[] = [];
      for (const { line, ingredient } of linked) {
        const article = all.find((i) => i.id === ingredient!.item_id);
        if (!article) continue;
        const space = purchaseSpace(article, spaces);
        // Sin sitios de cocina en Recursos todavía no se lleva inventario: la lista funciona como siempre, sin avisos.
        if (!space) continue;
        const quantity = toItemBase(Number(line.purchase_quantity), line.unit, article.base_unit, article.id, conversions);
        if (quantity === null) { unconvertible.push(`${ingredient!.name} en el inventario: su unidad no se puede pasar a ${article.base_unit}`); continue; }
        const movement = purchaseMovement({ itemId: article.id, lineId: line.id, bought: line.status !== 'pendiente', quantityBase: quantity, spaceId: space, supplier: line.supplier, movements: moves });
        if (movement) operations.push({ op: 'insert', table: R.movements, id: crypto.randomUUID(), fields: movement });
      }
      if (unconvertible.length) toast(`No se ha dado entrada a ${unconvertible.join('; ')}.`);
      if (operations.length) await r.commit(operations);
    } catch (error) {
      toast(`No se ha anotado en el inventario: ${describeError(error)}`);
    }
  }

  /** Cambia el estado de varias líneas en un commit y apunta en la Despensa las que cruzan entre pendiente y no. */
  async function setStatuses(lines: ItemRow[], status: ShoppingItemStatus, event = 'food.compra.marcar'): Promise<boolean> {
    const changing = lines.filter((l) => l.status !== status);
    if (!changing.length) return true;
    const ok = await commitSafely(changing.map((l) => ({ op: 'update', table: T.shoppingItems, id: l.id, expectedRevision: l.revision, fields: { status } })));
    usage.track(event, ok ? 'success' : 'error');
    const crossing = changing.filter((l) => (status === 'pendiente') !== (l.status === 'pendiente')).map((l) => fresh(l) ?? l);
    if (ok && crossing.length) await recordPurchases(crossing);
    return ok;
  }

  /** «En casa» y «Comprar»; en una línea ya comprada, la Despensa se corrige con la diferencia (H-C5). */
  async function updateQuantities(item: ItemRow, fields: Record<string, unknown>): Promise<void> {
    const ok = await update(item, fields);
    const now = fresh(item);
    if (ok && now && now.status !== 'pendiente' && Number(now.purchase_quantity) !== Number(item.purchase_quantity)) await recordPurchases([now]);
  }

  /** El carrito: marcar o desmarcar, con «Deshacer». */
  async function toggleCart(view: LineView): Promise<void> {
    const before = view.item.status;
    const status: ShoppingItemStatus = view.bought ? 'pendiente' : 'comprado';
    if (!(await setStatuses([view.item], status))) return;
    const now = fresh(view.item);
    toastWithAction(status === 'pendiente' ? `${view.name}: fuera del carro.` : `${view.name}: en el carro.`, {
      label: 'Deshacer', onClick: () => { if (now) void setStatuses([now], before); },
    });
  }

  /** El lote: todo lo pendiente de una tienda, comprado de una vez (una escritura por línea, en un commit). */
  async function buyShop(shop: string, views: LineView[]): Promise<void> {
    const lines = views.filter((v) => !v.bought).map((v) => v.item);
    if (!lines.length) return;
    if (!(await setStatuses(lines, 'comprado', 'food.compra.lote'))) return;
    const done = lines.map((l) => fresh(l)).filter((l): l is ItemRow => !!l);
    toastWithAction(`Comprado lo de ${shop}: ${plural(done.length, 'producto', 'productos')}.`, {
      label: 'Deshacer', onClick: () => void setStatuses(done.map((l) => fresh(l) ?? l), 'pendiente', 'food.compra.lote_deshacer'),
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // El envase y el dinero de cada línea
  // -------------------------------------------------------------------------------------------------------------------

  /** Lo que hace falta antes de redondear: necesario + mínimo − en casa; con la cifra fijada a mano o comprada, esa. */
  const needOf = (item: ItemRow, bought: boolean) => bought || item.manual || item.manual_override
    ? Number(item.purchase_quantity)
    : defaultPurchase(Number(item.required_quantity), item.stock_quantity === null ? null : Number(item.stock_quantity), item.min_quantity === null || item.min_quantity === undefined ? null : Number(item.min_quantity));

  function viewOf(item: ItemRow, names: Map<string, string>): LineView {
    const name = names.get(item.ingredient_id) ?? 'Ingrediente retirado';
    const ingredient = data?.ingredients.find((i) => i.id === item.ingredient_id);
    const article = ingredient?.item_id ? articles.find((a) => a.id === ingredient.item_id && !a.deleted_at) ?? null : null;
    const packs = article ? linePacks(article.id, article.base_unit, item.unit, units) : [];
    const bought = item.status !== 'pendiente';
    const need = needOf(item, bought);
    const usual = packs.find((p) => p.usual) ?? null;
    // Una cifra fijada a mano que no es de envases enteros se enseña tal cual, sin redondear de nuevo.
    const fixed = bought || item.manual || item.manual_override;
    const wholePacks = usual && (!fixed || Math.abs(need / usual.size - Math.round(need / usual.size)) < 1e-6);
    const average = article ? itemAverageCost(article.id, movements, costs) : null;
    const perUnit = linePerUnit({ ingredientId: item.ingredient_id, unit: item.unit, itemId: article?.id, base: article?.base_unit, purchases: purchases.purchases, average });
    const plan = Envase.plan({ need, unit: item.unit, formats: wholePacks ? [{ label: usual.label, size: usual.size, price: usual.price, usual: true }] : [], perBase: perUnit });
    const shop = item.supplier?.trim() || NO_SHOP;
    return { item, name, article, plan, packs, perUnit, bought, shop };
  }

  const resourcesWritable = () => ['editor', 'owner'].includes(r.bootstrap()?.membership.role ?? client.bootstrap()?.membership.role ?? '');

  /** La hoja del envase (`Envase.formatSheet`): «Guardar en la Despensa» escribe en `item_units` y lo deja como habitual. */
  function openPack(view: LineView): void {
    if (!view.article || sheet) return;
    const article = view.article;
    const usual = view.packs.find((p) => p.usual);
    // Sin habitual es «la primera vez»: la hoja propone, pero no da por elegido ningún envase que ya exista.
    const r0 = Envase.plan({ need: view.plan.need, unit: view.item.unit, formats: usual ? view.packs.map((p) => ({ label: p.label, size: p.size, price: p.price, usual: p.usual })) : [], perBase: view.perUnit });
    const ticket = lastTicket({ ingredientId: view.item.ingredient_id, itemId: article.id, base: article.base_unit, unit: view.item.unit, rows: units, purchases: purchases.purchases });
    usage.track('food.compra.envase');
    sheet = Envase.formatSheet({
      name: view.name, r: r0, ticket, feedbackId: 'food.menu.compra.envase',
      returnFocus: () => host.querySelector<HTMLElement>(`.buyrow[data-id="${view.item.id}"] .tile-media`),
      onSave: (chosen) => { sheet = null; void savePack(view, chosen.label, chosen.size, chosen.price); },
    });
    // Cancelar o cerrar: la lista vuelve a repintarse con lo que haya llegado.
    const watch = window.setInterval(() => { if (sheet && !sheet.isOpen()) { window.clearInterval(watch); sheet = null; void load(); } else if (!sheet) window.clearInterval(watch); }, 400);
  }

  async function savePack(view: LineView, label: string, size: number, price: number | null): Promise<void> {
    const article = view.article!;
    const previous = units.filter((u) => !u.deleted_at && u.item_id === article.id && u.usual);
    const plan = savePackOperations({ itemId: article.id, base: article.base_unit, unit: view.item.unit, label, size, price, rows: units });
    if ('error' in plan) { toast(plan.error); await load(); return; }
    try {
      if (plan.ops.length) await r.commit(plan.ops as RowOperation[]);
    } catch (error) {
      toast(`No se ha guardado el envase: ${describeError(error)}`);
      return;
    }
    usage.track('food.compra.envase_guardar');
    await load();
    // La lista redondea al momento: las líneas pendientes de ese artículo sin cifra fijada a mano.
    const ingredientIds = new Set(data?.ingredients.filter((i) => i.item_id === article.id).map((i) => i.id));
    const ops: RowOperation[] = [];
    for (const line of items.filter((i) => ingredientIds.has(i.ingredient_id) && i.status === 'pendiente' && !i.manual && !i.manual_override)) {
      const pack = linePacks(article.id, article.base_unit, line.unit, units).find((p) => p.usual)?.size ?? null;
      const purchase = defaultPurchase(Number(line.required_quantity), line.stock_quantity === null ? null : Number(line.stock_quantity), line.min_quantity === null || line.min_quantity === undefined ? null : Number(line.min_quantity), pack);
      if (purchase !== Number(line.purchase_quantity)) ops.push({ op: 'update', table: T.shoppingItems, id: line.id, expectedRevision: line.revision, fields: { purchase_quantity: purchase } });
    }
    if (ops.length) await commitSafely(ops);
    toastWithAction(`Envase de ${view.name.toLowerCase()} guardado en la Despensa.`, {
      label: 'Deshacer', onClick: () => void undoPack(article.id, previous.map((p) => p.id)),
    });
  }

  /** Vuelve a dejar como habitual el envase de antes (la fila nueva se queda en la ficha, sin marcar). */
  async function undoPack(itemId: string, previousIds: string[]): Promise<void> {
    const rows = ((await r.list(R.itemUnits)) as unknown as PackUnitRow[]).filter((u) => !u.deleted_at && u.item_id === itemId);
    const ops: RowOperation[] = rows
      .filter((u) => (u.usual === true) !== previousIds.includes(u.id))
      .map((u) => ({ op: 'update', table: R.itemUnits, id: u.id, expectedRevision: u.revision ?? 1, fields: { usual: previousIds.includes(u.id) } }));
    try {
      if (ops.length) await r.commit(ops);
    } catch (error) {
      toast(describeError(error));
    }
    await load();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // La baldosa
  // -------------------------------------------------------------------------------------------------------------------

  function quantityInput(item: ItemRow, value: number | null, label: string, onValue: (value: number | null) => void, disabled: boolean, mark: FbMark): HTMLInputElement {
    const input = fb(el('input', { type: 'text', inputmode: 'decimal', class: 'qty compact', value: formatQuantity(value), 'aria-label': label, disabled,
      onchange: () => {
        const raw = input.value.trim();
        const parsed = raw === '' ? null : parseQuantity(raw);
        if (raw !== '' && (parsed === null || parsed < 0)) { toast('Escribe una cantidad válida.'); input.value = formatQuantity(value); return; }
        if (parsed !== (value === null ? null : Number(value))) onValue(parsed);
      } }), mark);
    input.dataset.item = item.id;
    return input;
  }

  /** «Usa 4,8 kg · sobra 200 g», «Sin envase: lo justo» o, comprado, «En el carro». */
  function levelText(view: LineView): string {
    if (view.item.status === 'recibido') return 'Recibido';
    if (view.bought) return 'En el carro';
    const p = view.plan;
    if (p.kind === 'sin' || p.kind === 'granel') return p.need > 0 ? 'Sin envase: lo justo' : 'No hace falta comprar';
    const extra = Envase.extraText(p);
    return `usa ${Envase.legible(p.need, p.unit)}${extra ? ` · sobra ${extra}` : ''}`;
  }

  function tile(view: LineView, closed: boolean): HTMLElement {
    const { item, name } = view;
    const disabled = closed || !canWrite();
    const required = Number(item.required_quantity);
    const stock = item.stock_quantity === null ? null : Number(item.stock_quantity);
    const min = item.min_quantity === null || item.min_quantity === undefined ? null : Number(item.min_quantity);
    const packSize = view.packs.find((p) => p.usual)?.size ?? null;
    const stockInput = quantityInput(item, stock, `En casa de ${name}`, (value) => {
      // «Comprar» sigue a «en casa» mientras nadie lo haya fijado a mano (en envases enteros del habitual).
      void updateQuantities(item, item.manual_override || item.manual ? { stock_quantity: value } : { stock_quantity: value, purchase_quantity: defaultPurchase(required, value, min, view.bought ? null : packSize) });
    }, disabled, { feedbackId: 'food.menu.compra.linea.en_casa', feedbackLabel: 'En casa' });
    const purchaseInput = quantityInput(item, Number(item.purchase_quantity), `Comprar de ${name}`, (value) => {
      void updateQuantities(item, item.manual ? { purchase_quantity: value ?? 0 } : { purchase_quantity: value ?? 0, manual_override: true });
    }, disabled, { feedbackId: 'food.menu.compra.linea.comprar', feedbackLabel: 'Cantidad a comprar' });
    const chips = [
      item.manual ? el('span', { class: 'chip' }, 'A mano') : null,
      !item.manual && item.manual_override ? el('span', { class: 'chip' }, 'Compra fijada') : null,
      !item.manual && !item.restock && required === 0 ? el('span', { class: 'chip trash' }, 'Ya no hace falta') : null,
      item._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null,
    ].filter(Boolean);
    const cost = view.plan.cost;
    const packEditable = !disabled && !view.bought && !!view.article && resourcesWritable();
    const actions: TileAction[] = [];
    if (packEditable) actions.push({ slot: 'media', label: view.plan.kind === 'envase' ? `Cambiar el envase de ${name}` : `¿Cómo se vende ${name}?`, onClick: () => openPack(view), feedbackId: 'food.menu.compra.linea.envase' });
    if (!disabled) {
      actions.push({ slot: 'more', label: `Más de ${name}`, onClick: () => openLine(view, closed), feedbackId: 'food.menu.compra.linea.mas' });
      actions.push({ slot: 'corner', label: view.bought ? `Quitar del carro: ${name}` : `Marcar comprado: ${name}`, icon: 'cart', pressed: view.bought,
        onClick: () => void toggleCart(view), feedbackId: 'food.menu.compra.linea.comprado' });
    }
    const node = renderTile({
      title: name, value: view.plan.need > 0 || view.bought ? Envase.buyText(view.plan) : '', levelText: levelText(view),
      level: view.bought ? { pct: 100, tone: 'ok' } : null,
      medal: { name }, media: Envase.draw(view.plan, { scale: 0.9 }), actions,
      ...(view.bought ? { onLongPress: actions.length ? () => openLine(view, closed) : null } : {}),
    });
    node.classList.add('buyrow', 'fd-buytile');
    if (view.plan.kind !== 'envase' && !view.bought && view.article && packEditable) node.classList.add('fd-nopack');
    node.dataset.id = item.id;
    node.dataset.status = item.status;
    node.dataset.pending = String(item._pending === true);
    node.dataset.feedbackId = 'food.menu.compra.linea';
    node.dataset.feedbackLabel = 'Producto';
    node.append(
      el('span', { class: 'recipemeta fd-buymeta' },
        item.manual ? 'Añadido a mano' : item.restock ? `Bajo mínimo: ${formatQuantity(min)} ${UNIT_LABELS[item.unit]}` : `Necesario: ${formatQuantity(required)} ${UNIT_LABELS[item.unit]}`,
        item.supplier ? ` · ${item.supplier}` : '',
        !item.restock && min ? ` · Mínimo ${formatQuantity(min)} ${UNIT_LABELS[item.unit]}` : '',
        ` · ${cost === null ? 'sin precio' : `≈ ${euros(cost)}`}`),
      chips.length ? el('span', { class: 'chips' }, ...chips) : '',
      el('div', { class: 'fd-buyfigs' },
        el('label', { class: 'buyfield' }, el('span', null, 'En casa'), stockInput),
        el('label', { class: 'buyfield' }, el('span', null, `Comprar (${UNIT_LABELS[item.unit]})`), purchaseInput)),
    );
    return node;
  }

  /** El «⋯» de la baldosa: el estado de siempre, «Recalcular» y «Quitar» (en las añadidas a mano). */
  function openLine(view: LineView, closed: boolean): void {
    if (sheet) return;
    const { item, name } = view;
    const disabled = closed || !canWrite();
    const status = el('select', { 'data-feedback-id': 'food.menu.compra.linea.estado', 'data-feedback-label': 'Estado del producto', 'aria-label': `Estado de ${name}`, disabled },
      ...SHOPPING_ITEM_STATUSES.map((s) => el('option', { value: s, selected: item.status === s }, ITEM_STATUS_LABELS[s])));
    const done = async (work: Promise<unknown>) => { await work; await sheet?.close(true); };
    const stock = item.stock_quantity === null ? null : Number(item.stock_quantity);
    const min = item.min_quantity === null || item.min_quantity === undefined ? null : Number(item.min_quantity);
    const packSize = view.packs.find((p) => p.usual)?.size ?? null;
    sheet = openSheet({
      title: name,
      body: el('div', { 'data-feedback-id': 'food.menu.compra.linea.hoja', 'data-feedback-label': 'Producto de la compra', class: 'fd-linesheet' },
        el('p', { class: 'muted' }, Envase.words(view.plan)),
        view.bought && view.plan.kind === 'envase' ? el('p', { class: 'hint' }, 'Ya está comprado: el envase se cambia con la línea pendiente. «En casa» y «Comprar» siguen en la baldosa y corrigen la Despensa.') : null,
        el('label', { class: 'field' }, el('span', null, 'Estado'), status),
        el('div', { class: 'btnrow' },
          !disabled && !item.manual && item.manual_override
            ? el('button', { 'data-feedback-id': 'food.menu.compra.linea.recalcular', 'data-feedback-label': 'Recalcular', class: 'ghost', type: 'button', 'aria-label': `Volver a calcular la compra de ${name}`,
                onclick: () => void done(updateQuantities(item, { manual_override: false, purchase_quantity: defaultPurchase(Number(item.required_quantity), stock, min, view.bought ? null : packSize) })) }, 'Recalcular')
            : null,
          !disabled && item.manual
            ? el('button', { 'data-feedback-id': 'food.menu.compra.linea.quitar', 'data-feedback-label': 'Quitar producto', class: 'ghost', type: 'button', 'aria-label': `Quitar ${name}`,
                onclick: () => void done(commitSafely([{ op: 'delete', table: T.shoppingItems, id: item.id, expectedRevision: item.revision }])) }, icon('close', 18), 'Quitar')
            : null)),
      foot: [el('button', { 'data-feedback-id': 'food.menu.compra.linea.cerrar', 'data-feedback-label': 'Cerrar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar')],
      initialFocus: status,
      onClose: () => { sheet = null; void load(); },
    });
    status.addEventListener('change', () => void done(setStatuses([item], status.value as ShoppingItemStatus)));
  }

  function addManual(): void {
    if (!list || !data) return;
    const known = data.ingredients.filter((i) => !i.deleted_at);
    const name = el('input', { 'data-feedback-id': 'food.menu.compra.nueva.producto', 'data-feedback-label': 'Producto', id: 'm-name', type: 'text', list: 'buyIngredients', maxlength: '120', placeholder: 'Producto' });
    const quantity = el('input', { 'data-feedback-id': 'food.menu.compra.nueva.cantidad', 'data-feedback-label': 'Cantidad a comprar', id: 'm-quantity', type: 'text', inputmode: 'decimal' });
    const unit = el('select', { 'data-feedback-id': 'food.menu.compra.nueva.unidad', 'data-feedback-label': 'Unidad', id: 'm-unit' }, ...UNITS.map((u) => el('option', { value: u, selected: u === 'unidad' }, UNIT_LABELS[u])));
    const supplier = el('input', { 'data-feedback-id': 'food.menu.compra.nueva.proveedor', 'data-feedback-label': 'Proveedor', id: 'm-supplier', type: 'text', maxlength: '120' });
    const error = el('p', { class: 'formerror', role: 'alert' });
    const field = (label: string, control: HTMLElement) => el('label', { class: 'field' }, el('span', null, label), control);
    sheet = openSheet({
      title: 'Añadir a la compra',
      body: el('div', { 'data-feedback-id': 'food.menu.compra.nueva', 'data-feedback-label': 'Añadir a la compra' }, el('datalist', { id: 'buyIngredients' }, ...known.map((i) => el('option', { value: i.name }))),
        field('Producto', name), field('Cantidad a comprar', quantity), field('Unidad', unit), field('Proveedor', supplier),
        el('span', { class: 'hint' }, 'Para lo que no sale del menú: servilletas, café, aceite para freír…'), error),
      foot: [el('button', { 'data-feedback-id': 'food.menu.compra.nueva.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'),
        el('button', { 'data-feedback-id': 'food.menu.compra.nueva.anadir', 'data-feedback-label': 'Añadir', class: 'primary', type: 'button', id: 'saveManual', onclick: async () => {
          const label = name.value.trim().replace(/\s+/g, ' ');
          const amount = parseQuantity(quantity.value);
          if (!label) { error.textContent = 'Escribe el producto.'; name.focus(); return; }
          if (amount === null || amount <= 0) { error.textContent = 'Indica cuánto hay que comprar.'; quantity.focus(); return; }
          const operations: RowOperation[] = [];
          let ingredientId = known.find((i) => ingredientKey(i.name) === ingredientKey(label))?.id;
          if (!ingredientId) {
            ingredientId = crypto.randomUUID();
            operations.push({ op: 'insert', table: T.ingredients, id: ingredientId, fields: { name: label, preferred_unit: unit.value as Unit } });
          }
          operations.push({ op: 'insert', table: T.shoppingItems, id: crypto.randomUUID(),
            fields: { shopping_list_id: list!.id, ingredient_id: ingredientId, unit: unit.value, purchase_quantity: amount, manual: true, supplier: supplier.value.trim() || null } });
          const added = await commitSafely(operations);
          usage.track('food.compra.anadir_linea', added ? 'success' : 'error');
          if (added) await sheet?.close(true);
        } }, 'Añadir')],
      initialFocus: name,
      onClose: () => { sheet = null; },
    });
  }

  // Generar y regenerar la lista necesitan red (MUELA-086): sin ella, desactivados con el motivo.
  const net = onlineBinder(client);
  function paint(): void {
    net.release();
    paintList();
    host.querySelectorAll<HTMLElement>('#generateShopping, #regenerateShopping').forEach((b) => net.bind(b, 'Generar la lista necesita conexión; marcar lo comprado, no.'));
  }

  /** Suma de lo que tiene precio y cuántos productos no lo tienen: nunca un 0 € por falta de precio. */
  function money(views: LineView[]): { total: number; menu: number; missing: number } {
    let total = 0;
    let menu = 0;
    let missing = 0;
    for (const v of views) {
      if (v.plan.cost === null) { missing += 1; continue; }
      total += v.plan.cost;
      const used = v.plan.buy > 0 ? Math.min(Number(v.item.required_quantity), v.plan.buy) / v.plan.buy : 0;
      menu += v.plan.cost * used;
    }
    return { total: Math.round(total * 100) / 100, menu: Math.round(menu * 100) / 100, missing };
  }
  const moneyText = (m: { total: number; missing: number }, count: number) => count === 0 ? ''
    : m.total > 0 ? `≈ ${euros(m.total)}${m.missing ? ` · faltan precios de ${plural(m.missing, 'producto', 'productos')}` : ''}`
      : purchases.fetchedAt || articles.length ? 'sin precio' : 'sin datos de compras';

  function paintList(): void {
    if (!data?.menu) { replace(host); return; }
    const writable = canWrite();
    const generate = (label: string, id: string) => el('button', { 'data-feedback-id': 'food.menu.compra.generar', 'data-feedback-label': 'Generar lista de compra', class: 'primary', type: 'button', id, disabled: busy, onclick: () => void regenerate() }, label);
    const provisional = house || data.menu.status === 'validado' || data.menu.status === 'cerrado' ? null
      : el('p', { class: 'muted' }, 'El menú todavía no está validado: la lista es provisional.');
    // En casa: los días de la lista y las otras listas, para saltar a ellas.
    const houseHead = house ? el('div', { class: 'househead' }, periodBar(() => void load()),
      houseLists.length ? el('div', { 'data-feedback-id': 'food.menu.casa.listas', 'data-feedback-label': 'Listas de casa', class: 'chips houselists' }, el('span', { class: 'muted' }, 'Listas:'),
        ...houseLists.map((l) => el('button', { 'data-feedback-id': 'food.menu.casa.listas.lista', 'data-feedback-label': 'Abrir lista', type: 'button', class: l.id === list?.id ? 'chip ok' : 'chip',
          onclick: () => { setHousePeriod({ start: l.period_start!, end: l.period_end! }); void load(); } }, `${periodLabel({ start: l.period_start!, end: l.period_end! })}${l.status === 'cerrada' ? ' · cerrada' : ''}`))) : null) : null;

    if (!list) {
      const overlap = house ? houseLists.find((l) => l.period_start! <= housePeriod().end && housePeriod().start <= l.period_end!) : undefined;
      replace(host, houseHead, el('div', { 'data-feedback-id': 'food.menu.compra.vacia', 'data-feedback-label': 'Sin lista de compra', class: 'empty', id: 'shoppingEmpty' },
        el('strong', null, house ? `Todavía no hay lista para ${periodLabel(housePeriod())}` : 'Todavía no hay lista de compra'),
        house ? 'Se calcula con los platos de esos días: raciones × cantidad de cada ingrediente ÷ raciones base de la receta.'
          : 'Se calcula a partir de los platos del menú: raciones × cantidad de cada ingrediente ÷ raciones base de la receta.',
        overlap ? el('p', { class: 'warnline', id: 'periodOverlap' }, `Se solapa con la lista de ${periodLabel({ start: overlap.period_start!, end: overlap.period_end! })}: elige otros días o abre esa lista.`) : null,
        provisional, writable && !overlap ? el('p', { style: 'margin-top:10px' }, generate(house ? `Generar la lista de ${periodLabel(housePeriod())}` : 'Generar lista de compra', 'generateShopping')) : null,
        el('span', { class: 'hint' }, 'Generar necesita conexión.')));
      return;
    }

    const closed = list.status === 'cerrada';
    const current = shoppingSources(data.graph, house ? housePeriod() : null);
    const diff = sourceChanges(list.source_revisions, current);
    const stale = data.pending || isStale(list.source_revisions, current);
    const names = new Map(data.ingredients.map((i) => [i.id, i.name]));
    const byName = (a: LineView, b: LineView) => a.name.localeCompare(b.name, 'es');
    const views = items.map((i) => viewOf(i, names));
    // «Ya hay en casa»: lo pendiente que no hace falta comprar (plegado, con su «⋯»). «Reponer» (R5b), aparte.
    const atHome = (v: LineView) => !v.bought && !v.item.manual && Number(v.item.purchase_quantity) === 0 && v.plan.need === 0;
    const toBuy = views.filter((v) => !v.item.restock && !atHome(v)).sort((a, b) => Number(a.item.manual) - Number(b.item.manual) || byName(a, b));
    const restock = views.filter((v) => v.item.restock && !atHome(v)).sort(byName);
    const home = views.filter(atHome).sort(byName);
    const setStatus = (status: ShoppingListStatus) => commitSafely([{ op: 'update', table: T.shoppingLists, id: list!.id, expectedRevision: list!.revision, fields: { status } }]);
    const button = (id: string, label: string, onclick: () => void, mark: FbMark) => fb(el('button', { class: 'ghost', type: 'button', id, onclick }, label), mark);
    const pendingBuy = items.filter((i) => i.status === 'pendiente' && Number(i.purchase_quantity) > 0).length;

    // Las tiendas: una estantería por proveedor, «Sin tienda» al final.
    const shops = new Map<string, LineView[]>();
    for (const v of [...toBuy, ...restock]) {
      const key = v.shop === NO_SHOP ? NO_SHOP : [...shops.keys()].find((k) => k.toLowerCase() === v.shop.toLowerCase()) ?? v.shop;
      shops.set(key, [...(shops.get(key) ?? []), v]);
    }
    const shopNames = [...shops.keys()].sort((a, b) => Number(a === NO_SHOP) - Number(b === NO_SHOP) || a.localeCompare(b, 'es'));
    const pendingOf = (vs: LineView[]) => vs.filter((v) => !v.bought);
    const shopSub = (vs: LineView[]) => {
      const left = pendingOf(vs);
      const m = money(left);
      return [`${left.length} de ${vs.length}`, moneyText(m, left.length)].filter(Boolean).join(' · ');
    };
    const shelfRows = (vs: Map<string, LineView[]>, keys: string[]): Array<ShelfRow<LineView>> => keys.map((shop) => ({
      key: shop, label: shop, sub: shopSub(vs.get(shop)!), medal: { name: shop, color: shop === NO_SHOP ? null : shopColor(shop) }, items: vs.get(shop)!,
    }));
    const shelves = (rows: Array<ShelfRow<LineView>>, label: string, feedbackId: string) => createShelves<LineView>({
      rows, key: (v) => v.item.id, name: (v) => v.name, tile: (v) => tile(v, closed), label, noun: 'tienda', feedbackId,
    });
    const main = shelves(shelfRows(new Map(shopNames.map((s) => [s, shops.get(s)!.filter((v) => !v.item.restock)])), shopNames.filter((s) => shops.get(s)!.some((v) => !v.item.restock))), 'Estanterías por tienda', 'food.menu.compra.tiendas');
    // Al pie de cada estantería, el lote: «Comprado lo de Mercadona · 18 · 153,35 €».
    for (const section of main.element.querySelectorAll<HTMLElement>('.shelf-row')) {
      const shop = section.dataset.shelfRow ?? '';
      const left = pendingOf((shops.get(shop) ?? []).filter((v) => !v.item.restock));
      if (!left.length || closed || !writable) continue;
      const m = money(left);
      section.append(el('div', { class: 'fd-shelffoot' }, el('button', { 'data-feedback-id': 'food.menu.compra.lote', 'data-feedback-label': 'Comprado lo de la tienda', class: 'ghost fd-lot', type: 'button',
        onclick: () => void buyShop(shop, left) }, icon('cart', 18), `${shop === NO_SHOP ? 'Comprado lo que no tiene tienda' : `Comprado lo de ${shop}`} · ${left.length}${m.total > 0 ? ` · ${euros(m.total)}` : ''}`)));
    }

    // Arriba, el dinero dibujado y las tiendas.
    const buying = pendingOf([...toBuy, ...restock]);
    const m = money(buying);
    const keep = Math.max(Math.round((m.total - m.menu) * 100) / 100, 0);
    const moneyHead = buying.length ? el('div', { 'data-feedback-id': 'food.menu.compra.dinero', 'data-feedback-label': 'Lo que cuesta la compra', class: 'fd-buymoney', id: 'shoppingMoney' },
      m.total > 0 ? el('strong', { class: 'fd-buytotal' }, `≈ ${euros(m.total)}`)
        : el('span', { class: 'fd-buymissing' }, purchases.fetchedAt || articles.length ? `Sin precio: faltan precios de ${plural(m.missing, 'producto', 'productos')}` : 'Sin datos de compras'),
      m.total > 0 && m.missing ? el('span', { class: 'fd-buymissing' }, `faltan precios de ${plural(m.missing, 'producto', 'productos')}`) : null,
      m.total > 0 ? el('div', { class: 'fd-buybar', role: 'img', 'aria-label': `El menú usa ${euros(m.menu)} y ${euros(keep)} van a la Despensa` },
        el('span', { class: 'fd-buyused', style: `width:${Math.round((m.menu / m.total) * 100)}%` }), el('span', { class: 'fd-buykeep' })) : null,
      m.total > 0 ? el('p', { class: 'muted' }, `el menú usa ${euros(m.menu)} · ${euros(keep)} a la Despensa`) : null) : null;
    const pills = shopNames.length > 1 ? el('div', { 'data-feedback-id': 'food.menu.compra.tiendas_resumen', 'data-feedback-label': 'Tiendas', class: 'fd-shoppills' },
      ...shopNames.map((shop) => el('button', { type: 'button', class: 'fd-shoppill', onclick: () => main.element.querySelector<HTMLElement>(`[data-shelf-row="${CSS.escape(shop)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        el('span', { class: 'fd-shopdot', style: shop === NO_SHOP ? '' : `background:${shopColor(shop)}`, 'aria-hidden': 'true' }), `${shop} · ${shopSub(shops.get(shop)!)}`))) : null;

    replace(host, houseHead,
      stale ? el('div', { 'data-feedback-id': 'food.menu.compra.aviso_cambios', 'data-feedback-label': 'Aviso de cambios', class: 'banner warn notice', id: 'shoppingStale', role: 'status' },
        el('div', null, el('strong', null, 'El menú o sus recetas han cambiado desde que se generó la lista.'),
          ` ${diff.added.length + diff.removed.length + diff.changed.length || 'Hay'} cambios${data.pending ? ' (algunos aún sin sincronizar)' : ''}. Regenerar conserva lo que hayas tocado a mano.`),
        writable && !closed ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.menu.compra.regenerar', 'data-feedback-label': 'Regenerar lista', class: 'ghost', type: 'button', id: 'regenerateShopping', disabled: busy, onclick: () => void regenerate() }, 'Regenerar lista')) : null) : null,
      el('div', { 'data-feedback-id': 'food.menu.compra.estado', 'data-feedback-label': 'Estado de la lista', class: 'tabhead' },
        moneyHead,
        el('div', { class: 'chips' },
          el('span', { class: list.status === 'borrador' ? 'chip' : 'chip ok', id: 'shoppingStatus' }, LIST_STATUS_LABELS[list.status]),
          el('span', { class: 'chip' }, pendingBuy === 0 ? 'Todo comprado' : `${pendingBuy} por comprar`)),
        el('p', { class: 'muted' }, `Generada el ${formatDate(list.generated_at)}.`),
        provisional),
      pills,
      writable ? el('div', { 'data-feedback-id': 'food.menu.compra.acciones', 'data-feedback-label': 'Acciones de la lista', class: 'btnrow menuactions' },
        list.status === 'borrador' ? button('listReviewed', 'Marcar como revisada', () => void setStatus('revisada'), { feedbackId: 'food.menu.compra.marcar_revisada', feedbackLabel: 'Marcar como revisada' }) : null,
        list.status === 'revisada' ? button('listDraft', 'Volver a borrador', () => void setStatus('borrador'), { feedbackId: 'food.menu.compra.volver_borrador', feedbackLabel: 'Volver a borrador' }) : null,
        list.status === 'revisada' ? button('listClose', 'Cerrar lista', () => void setStatus('cerrada'), { feedbackId: 'food.menu.compra.cerrar_lista', feedbackLabel: 'Cerrar lista' }) : null,
        closed ? button('listReopen', 'Reabrir lista', () => void setStatus('borrador'), { feedbackId: 'food.menu.compra.reabrir_lista', feedbackLabel: 'Reabrir lista' }) : null,
        !closed && !stale ? el('button', { 'data-feedback-id': 'food.menu.compra.regenerar', 'data-feedback-label': 'Regenerar', class: 'linkbtn', type: 'button', id: 'regenerateShopping', disabled: busy, onclick: () => void regenerate() }, 'Regenerar') : null,
        !closed ? el('button', { 'data-feedback-id': 'food.menu.compra.anadir_linea', 'data-feedback-label': 'Añadir línea', class: 'linkbtn', type: 'button', id: 'addManual', onclick: addManual }, icon('plus', 18), 'Añadir línea') : null) : null,
      toBuy.length || restock.length ? Envase.legend({ used: 'Lo usa el menú' }) : null,
      toBuy.length
        ? el('div', { 'data-feedback-id': 'food.menu.compra.lista', 'data-feedback-label': 'Lista de compra', class: 'buylist fd-shelves', id: 'shoppingList' }, main.element)
        : el('div', { class: 'empty plain' }, home.length ? 'Nada que comprar: todo lo que pide el menú ya está en casa.' : 'La lista está vacía: el menú no tiene platos con ingredientes.'),
      restock.length ? el('div', { 'data-feedback-id': 'food.menu.compra.reponer', 'data-feedback-label': 'Reponer', class: 'restock' },
        el('h3', { class: 'sectionlabel' }, 'Reponer', el('span', { class: 'count' }, String(restock.length))),
        el('p', { class: 'muted' }, 'Bajo mínimo en la cocina y sin menú que lo pida.'),
        el('div', { class: 'buylist fd-shelves', id: 'restockList' }, shelves([{ key: 'reponer', label: 'Reponer', items: restock }], 'Reponer', 'food.menu.compra.reponer.estanteria').element)) : null,
      home.length ? el('details', { 'data-feedback-id': 'food.menu.compra.en_casa', 'data-feedback-label': 'Ya hay en casa', class: 'fd-athome', id: 'atHomeFold' },
        el('summary', null, `Ya hay en casa · ${home.length}`),
        el('div', { class: 'buylist fd-shelves', id: 'atHomeList' }, shelves([{ key: 'casa', label: 'Ya hay en casa', items: home }], 'Ya hay en casa', 'food.menu.compra.en_casa.estanteria').element)) : null,
    );
  }

  async function load(): Promise<void> {
    data = await loadMenuData(client, menuId);
    const lists = ((await client.list(T.shoppingLists)) as ListRow[]).filter((l) => l.menu_id === menuId && !l.deleted_at);
    houseLists = house ? lists.filter((l) => l.period_start).sort((a, b) => b.period_start!.localeCompare(a.period_start!)) : [];
    list = (house ? lists.find((l) => samePeriod(housePeriod(), l)) : lists.find((l) => !l.period_start)) ?? null;
    items = list ? ((await client.list(T.shoppingItems)) as ItemRow[]).filter((i) => i.shopping_list_id === list!.id) : [];
    try {
      [articles, units, movements, costs] = await Promise.all([
        r.list(R.items) as unknown as Promise<Article[]>,
        r.list(R.itemUnits) as unknown as Promise<PackUnitRow[]>,
        r.list(R.movements) as unknown as Promise<CostMovement[]>,
        r.list(R.movementCosts) as unknown as Promise<MovementCost[]>,
      ]);
    } catch {
      // Sin Recursos en este dispositivo: la lista sigue, sin envases ni costes medios.
    }
    paint();
  }

  void load();
  void loadPurchases(client).then((snapshot) => { purchases = snapshot; if (!sheet && !busy) paint(); }).catch(() => undefined);
  const refresh = () => { if (!sheet && !busy) void load(); };
  const offs = [...[...MENU_TABLES, T.shoppingLists, T.shoppingItems].map((table) => client.onTable(table, refresh)),
    ...[R.itemUnits, R.items].map((table) => r.onTable(table, refresh))];
  return () => {
    net.release();
    offs.forEach((off) => off());
    void sheet?.close(true);
  };
}
