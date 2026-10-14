import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, SHOPPING_ITEM_STATUSES, defaultPurchase, ingredientKey, isStale, purchaseMovement, purchaseSpace, shoppingSources, sourceChanges, toItemBase, validateOperations,
  type MovementLike, type ResourceItem, type ShoppingItemStatus, type ShoppingList, type ShoppingListItem, type ShoppingListStatus, type SpaceLike, type Unit,
} from '@ikisai/domain-food';
import { el, formatDate, icon, openSheet, plural, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { T, UNITS, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import { MENU_TABLES, loadMenuData, type MenuData } from '../app/menu-data.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { usage } from '../app/usage.ts';
import { fb, type FbMark } from './feedback.ts';
import { housePeriod, periodBar, periodLabel, samePeriod, setHousePeriod } from './house-period.ts';

type ListRow = Mirror<ShoppingList>;
type ItemRow = Mirror<ShoppingListItem>;

const LIST_STATUS_LABELS: Record<ShoppingListStatus, string> = { borrador: 'Borrador', revisada: 'Revisada', cerrada: 'Cerrada' };
const ITEM_STATUS_LABELS: Record<ShoppingItemStatus, string> = { pendiente: 'Pendiente', comprado: 'Comprado', recibido: 'Recibido' };

interface RegenerateResult { list_id: string; created: boolean; inserted: number; updated: number; deleted: number; kept: number; status: string }

export interface TabContext {
  client: SyncClient;
  menuId: string;
  host: HTMLElement;
  canWrite(): boolean;
  /** Menú de casa (O3b): compra y preparación por un rango de días que se elige al generar. */
  house?: boolean;
}

/** Lista de compra del menú: generar y regenerar (con red), «en casa», «comprar», estado y líneas a mano (también sin red). */
export function mountShopping({ client, menuId, host, canWrite, house = false }: TabContext): () => void {
  let data: MenuData | null = null;
  let list: ListRow | null = null;
  let houseLists: ListRow[] = []; // en casa: las listas vivas del menú, cada una con sus días
  let items: ItemRow[] = [];
  let sheet: Sheet | null = null;
  let busy = false;

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

  /**
   * «Comprado» (o «recibido») entra al stock de Recursos en ese momento, sin coste; volver a «pendiente» lo saca
   * (decisión del usuario, 14-10-2026). Finance (R4) añade después el coste a esa entrada por su referencia
   * `shopping_item:<id>`. Si el ingrediente aún no tiene artículo o no hay ningún sitio de cocina, la lista sigue como
   * siempre; si la unidad no se puede pasar a la del artículo, se avisa.
   */
  async function recordPurchase(item: ItemRow, status: string): Promise<void> {
    const ingredient = data?.ingredients.find((i) => i.id === item.ingredient_id);
    if (!ingredient?.item_id) return;
    const r = resourcesClient(client);
    try {
      const [items, spaces, movements] = await Promise.all([
        r.list(R.items) as unknown as Promise<Array<ResourceItem & { default_space_id: string | null }>>,
        r.list(R.spaces) as unknown as Promise<SpaceLike[]>,
        r.list(R.movements) as unknown as Promise<MovementLike[]>,
      ]);
      const article = items.find((i) => i.id === ingredient.item_id);
      if (!article) return;
      const quantity = toItemBase(Number(item.purchase_quantity), item.unit, article.base_unit);
      const space = purchaseSpace(article, spaces);
      // Sin sitios de cocina en Recursos todavía no se lleva inventario: la lista funciona como siempre, sin avisos.
      if (!space) return;
      if (quantity === null) { toast(`No se ha dado entrada a ${ingredient.name} en el inventario: su unidad no se puede pasar a ${article.base_unit}.`); return; }
      const movement = purchaseMovement({ itemId: article.id, lineId: item.id, bought: status !== 'pendiente', quantityBase: quantity, spaceId: space, supplier: item.supplier, movements });
      if (movement) await r.commit([{ op: 'insert', table: R.movements, id: crypto.randomUUID(), fields: movement }]);
    } catch (error) {
      toast(`No se ha anotado en el inventario: ${describeError(error)}`);
    }
  }
  const setItemStatus = async (item: ItemRow, status: string) => {
    const ok = await update(item, { status });
    usage.track('food.compra.marcar', ok ? 'success' : 'error');
    if (ok && (status === 'pendiente') !== (item.status === 'pendiente')) await recordPurchase(item, status);
  };

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

  function itemRow(item: ItemRow, name: string, closed: boolean): HTMLElement {
    const disabled = closed || !canWrite();
    const required = Number(item.required_quantity);
    const stock = item.stock_quantity === null ? null : Number(item.stock_quantity);
    const min = item.min_quantity === null || item.min_quantity === undefined ? null : Number(item.min_quantity);
    const stockInput = quantityInput(item, stock, `En casa de ${name}`, (value) => {
      // «Comprar» sigue a «en casa» mientras nadie lo haya fijado a mano.
      void update(item, item.manual_override || item.manual ? { stock_quantity: value } : { stock_quantity: value, purchase_quantity: defaultPurchase(required, value, min) });
    }, disabled, { feedbackId: 'food.menu.compra.linea.en_casa', feedbackLabel: 'En casa' });
    const purchaseInput = quantityInput(item, Number(item.purchase_quantity), `Comprar de ${name}`, (value) => {
      void update(item, item.manual ? { purchase_quantity: value ?? 0 } : { purchase_quantity: value ?? 0, manual_override: true });
    }, disabled, { feedbackId: 'food.menu.compra.linea.comprar', feedbackLabel: 'Cantidad a comprar' });
    const bought = el('input', { 'data-feedback-id': 'food.menu.compra.linea.comprado', 'data-feedback-label': 'Comprado', type: 'checkbox', class: 'bigcheck', checked: item.status !== 'pendiente', disabled, 'aria-label': `${name} comprado`,
      onchange: () => void setItemStatus(item, bought.checked ? 'comprado' : 'pendiente') });
    const status = el('select', { 'data-feedback-id': 'food.menu.compra.linea.estado', 'data-feedback-label': 'Estado del producto', class: 'compact', 'aria-label': `Estado de ${name}`, disabled, onchange: () => void setItemStatus(item, status.value) },
      ...SHOPPING_ITEM_STATUSES.map((s) => el('option', { value: s, selected: item.status === s }, ITEM_STATUS_LABELS[s])));
    const chips = [
      item.manual ? el('span', { class: 'chip' }, 'A mano') : null,
      !item.manual && item.manual_override ? el('span', { class: 'chip' }, 'Compra fijada') : null,
      !item.manual && !item.restock && required === 0 ? el('span', { class: 'chip trash' }, 'Ya no hace falta') : null,
      item._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null,
    ];
    return el('li', { 'data-feedback-id': 'food.menu.compra.linea', 'data-feedback-label': 'Producto', class: 'buyrow', 'data-id': item.id, 'data-status': item.status, 'data-pending': String(item._pending === true) },
      bought,
      el('div', { class: 'buyname' }, el('strong', null, name),
        el('span', { class: 'recipemeta' }, item.manual ? 'Añadido a mano' : item.restock ? `Bajo mínimo: ${formatQuantity(min)} ${UNIT_LABELS[item.unit]}` : `Necesario: ${formatQuantity(required)} ${UNIT_LABELS[item.unit]}`, item.supplier ? ` · ${item.supplier}` : '',
          !item.restock && min ? ` · Mínimo ${formatQuantity(min)} ${UNIT_LABELS[item.unit]}` : ''),
        el('span', { class: 'chips' }, ...chips)),
      el('label', { class: 'buyfield' }, el('span', null, 'En casa'), stockInput),
      el('label', { class: 'buyfield' }, el('span', null, `Comprar (${UNIT_LABELS[item.unit]})`), purchaseInput),
      el('div', { class: 'buyactions' }, status,
        !disabled && !item.manual && item.manual_override
          ? el('button', { 'data-feedback-id': 'food.menu.compra.linea.recalcular', 'data-feedback-label': 'Recalcular', class: 'linkbtn', type: 'button', 'aria-label': `Volver a calcular la compra de ${name}`,
              onclick: () => void update(item, { manual_override: false, purchase_quantity: defaultPurchase(required, stock, min) }) }, 'Recalcular')
          : null,
        !disabled && item.manual
          ? el('button', { 'data-feedback-id': 'food.menu.compra.linea.quitar', 'data-feedback-label': 'Quitar producto', class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${name}`, onclick: () => void commitSafely([{ op: 'delete', table: T.shoppingItems, id: item.id, expectedRevision: item.revision }]) }, icon('close', 18))
          : null),
    );
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

  function paint(): void {
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
    const byName = (a: ItemRow, b: ItemRow) => (names.get(a.ingredient_id) ?? '').localeCompare(names.get(b.ingredient_id) ?? '', 'es');
    const sorted = items.filter((i) => !i.restock).sort((a, b) => Number(a.manual) - Number(b.manual) || byName(a, b));
    // «Reponer» (R5b): lo que está bajo mínimo en la cocina y ningún menú de la lista pide, aparte.
    const restock = items.filter((i) => i.restock).sort(byName);
    const setStatus = (status: ShoppingListStatus) => commitSafely([{ op: 'update', table: T.shoppingLists, id: list!.id, expectedRevision: list!.revision, fields: { status } }]);
    const button = (id: string, label: string, onclick: () => void, mark: FbMark) => fb(el('button', { class: 'ghost', type: 'button', id, onclick }, label), mark);
    const pendingBuy = items.filter((i) => i.status === 'pendiente' && Number(i.purchase_quantity) > 0).length;

    replace(host, houseHead,
      stale ? el('div', { 'data-feedback-id': 'food.menu.compra.aviso_cambios', 'data-feedback-label': 'Aviso de cambios', class: 'banner warn notice', id: 'shoppingStale', role: 'status' },
        el('div', null, el('strong', null, 'El menú o sus recetas han cambiado desde que se generó la lista.'),
          ` ${diff.added.length + diff.removed.length + diff.changed.length || 'Hay'} cambios${data.pending ? ' (algunos aún sin sincronizar)' : ''}. Regenerar conserva lo que hayas tocado a mano.`),
        writable && !closed ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.menu.compra.regenerar', 'data-feedback-label': 'Regenerar lista', class: 'ghost', type: 'button', id: 'regenerateShopping', disabled: busy, onclick: () => void regenerate() }, 'Regenerar lista')) : null) : null,
      el('div', { 'data-feedback-id': 'food.menu.compra.estado', 'data-feedback-label': 'Estado de la lista', class: 'tabhead' },
        el('div', { class: 'chips' },
          el('span', { class: list.status === 'borrador' ? 'chip' : 'chip ok', id: 'shoppingStatus' }, LIST_STATUS_LABELS[list.status]),
          el('span', { class: 'chip' }, pendingBuy === 0 ? 'Todo comprado' : `${pendingBuy} por comprar`)),
        el('p', { class: 'muted' }, `Generada el ${formatDate(list.generated_at)}.`),
        provisional),
      writable ? el('div', { 'data-feedback-id': 'food.menu.compra.acciones', 'data-feedback-label': 'Acciones de la lista', class: 'btnrow menuactions' },
        list.status === 'borrador' ? button('listReviewed', 'Marcar como revisada', () => void setStatus('revisada'), { feedbackId: 'food.menu.compra.marcar_revisada', feedbackLabel: 'Marcar como revisada' }) : null,
        list.status === 'revisada' ? button('listDraft', 'Volver a borrador', () => void setStatus('borrador'), { feedbackId: 'food.menu.compra.volver_borrador', feedbackLabel: 'Volver a borrador' }) : null,
        list.status === 'revisada' ? button('listClose', 'Cerrar lista', () => void setStatus('cerrada'), { feedbackId: 'food.menu.compra.cerrar_lista', feedbackLabel: 'Cerrar lista' }) : null,
        closed ? button('listReopen', 'Reabrir lista', () => void setStatus('borrador'), { feedbackId: 'food.menu.compra.reabrir_lista', feedbackLabel: 'Reabrir lista' }) : null,
        !closed && !stale ? el('button', { 'data-feedback-id': 'food.menu.compra.regenerar', 'data-feedback-label': 'Regenerar', class: 'linkbtn', type: 'button', id: 'regenerateShopping', disabled: busy, onclick: () => void regenerate() }, 'Regenerar') : null,
        !closed ? el('button', { 'data-feedback-id': 'food.menu.compra.anadir_linea', 'data-feedback-label': 'Añadir línea', class: 'linkbtn', type: 'button', id: 'addManual', onclick: addManual }, icon('plus', 18), 'Añadir línea') : null) : null,
      sorted.length
        ? el('ul', { 'data-feedback-id': 'food.menu.compra.lista', 'data-feedback-label': 'Lista de compra', class: 'buylist', id: 'shoppingList' }, ...sorted.map((item) => itemRow(item, names.get(item.ingredient_id) ?? 'Ingrediente retirado', closed)))
        : el('div', { class: 'empty plain' }, 'La lista está vacía: el menú no tiene platos con ingredientes.'),
      restock.length ? el('div', { 'data-feedback-id': 'food.menu.compra.reponer', 'data-feedback-label': 'Reponer', class: 'restock' },
        el('h3', { class: 'sectionlabel' }, 'Reponer', el('span', { class: 'count' }, String(restock.length))),
        el('p', { class: 'muted' }, 'Bajo mínimo en la cocina y sin menú que lo pida.'),
        el('ul', { class: 'buylist', id: 'restockList' }, ...restock.map((item) => itemRow(item, names.get(item.ingredient_id) ?? 'Ingrediente retirado', closed)))) : null,
    );
  }

  async function load(): Promise<void> {
    data = await loadMenuData(client, menuId);
    const lists = ((await client.list(T.shoppingLists)) as ListRow[]).filter((l) => l.menu_id === menuId && !l.deleted_at);
    houseLists = house ? lists.filter((l) => l.period_start).sort((a, b) => b.period_start!.localeCompare(a.period_start!)) : [];
    list = (house ? lists.find((l) => samePeriod(housePeriod(), l)) : lists.find((l) => !l.period_start)) ?? null;
    items = list ? ((await client.list(T.shoppingItems)) as ItemRow[]).filter((i) => i.shopping_list_id === list!.id) : [];
    paint();
  }

  void load();
  const offs = [...MENU_TABLES, T.shoppingLists, T.shoppingItems].map((table) => client.onTable(table, () => { if (!sheet && !busy) void load(); }));
  return () => {
    offs.forEach((off) => off());
    void sheet?.close(true);
  };
}
