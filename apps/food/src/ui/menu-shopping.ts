import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, SHOPPING_ITEM_STATUSES, defaultPurchase, ingredientKey, isStale, shoppingSources, sourceChanges, validateOperations,
  type ShoppingItemStatus, type ShoppingList, type ShoppingListItem, type ShoppingListStatus, type Unit,
} from '@ikisai/domain-food';
import { el, formatDate, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { T, UNITS, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import { MENU_TABLES, loadMenuData, type MenuData } from '../app/menu-data.ts';
import { usage } from '../app/usage.ts';
import { fb, type FbMark } from './feedback.ts';

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
}

/** Lista de compra del menú: generar y regenerar (con red), «en casa», «comprar», estado y líneas a mano (también sin red). */
export function mountShopping({ client, menuId, host, canWrite }: TabContext): () => void {
  let data: MenuData | null = null;
  let list: ListRow | null = null;
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
      const result = await usage.run('food.compra.generar', () => runCall<RegenerateResult>(client, FOOD_PROCEDURES.regenerateShopping, { menu_id: menuId, list_id: list?.id ?? crypto.randomUUID() }));
      toast(result.created
        ? `Lista generada: ${result.inserted} productos.`
        : `Lista regenerada: ${result.inserted} nuevos, ${result.updated} actualizados, ${result.deleted} retirados.`);
    } catch (error) {
      toast(describeError(error));
    } finally {
      busy = false;
      await load();
    }
  }

  const update = (item: ItemRow, fields: Record<string, unknown>) =>
    commitSafely([{ op: 'update', table: T.shoppingItems, id: item.id, expectedRevision: item.revision, fields }]);

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
    const stockInput = quantityInput(item, stock, `En casa de ${name}`, (value) => {
      // «Comprar» sigue a «en casa» mientras nadie lo haya fijado a mano.
      void update(item, item.manual_override || item.manual ? { stock_quantity: value } : { stock_quantity: value, purchase_quantity: defaultPurchase(required, value) });
    }, disabled, { feedbackId: 'food.menu.compra.linea.en_casa', feedbackLabel: 'En casa' });
    const purchaseInput = quantityInput(item, Number(item.purchase_quantity), `Comprar de ${name}`, (value) => {
      void update(item, item.manual ? { purchase_quantity: value ?? 0 } : { purchase_quantity: value ?? 0, manual_override: true });
    }, disabled, { feedbackId: 'food.menu.compra.linea.comprar', feedbackLabel: 'Cantidad a comprar' });
    const bought = el('input', { 'data-feedback-id': 'food.menu.compra.linea.comprado', 'data-feedback-label': 'Comprado', type: 'checkbox', class: 'bigcheck', checked: item.status !== 'pendiente', disabled, 'aria-label': `${name} comprado`,
      onchange: () => void update(item, { status: bought.checked ? 'comprado' : 'pendiente' }).then((ok) => usage.track('food.compra.marcar', ok ? 'success' : 'error')) });
    const status = el('select', { 'data-feedback-id': 'food.menu.compra.linea.estado', 'data-feedback-label': 'Estado del producto', class: 'compact', 'aria-label': `Estado de ${name}`, disabled, onchange: () => void update(item, { status: status.value }).then((ok) => usage.track('food.compra.marcar', ok ? 'success' : 'error')) },
      ...SHOPPING_ITEM_STATUSES.map((s) => el('option', { value: s, selected: item.status === s }, ITEM_STATUS_LABELS[s])));
    const chips = [
      item.manual ? el('span', { class: 'chip' }, 'A mano') : null,
      !item.manual && item.manual_override ? el('span', { class: 'chip' }, 'Compra fijada') : null,
      !item.manual && required === 0 ? el('span', { class: 'chip trash' }, 'Ya no hace falta') : null,
      item._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null,
    ];
    return el('li', { 'data-feedback-id': 'food.menu.compra.linea', 'data-feedback-label': 'Producto', class: 'buyrow', 'data-id': item.id, 'data-status': item.status, 'data-pending': String(item._pending === true) },
      bought,
      el('div', { class: 'buyname' }, el('strong', null, name),
        el('span', { class: 'recipemeta' }, item.manual ? 'Añadido a mano' : `Necesario: ${formatQuantity(required)} ${UNIT_LABELS[item.unit]}`, item.supplier ? ` · ${item.supplier}` : ''),
        el('span', { class: 'chips' }, ...chips)),
      el('label', { class: 'buyfield' }, el('span', null, 'En casa'), stockInput),
      el('label', { class: 'buyfield' }, el('span', null, `Comprar (${UNIT_LABELS[item.unit]})`), purchaseInput),
      el('div', { class: 'buyactions' }, status,
        !disabled && !item.manual && item.manual_override
          ? el('button', { 'data-feedback-id': 'food.menu.compra.linea.recalcular', 'data-feedback-label': 'Recalcular', class: 'linkbtn', type: 'button', 'aria-label': `Volver a calcular la compra de ${name}`,
              onclick: () => void update(item, { manual_override: false, purchase_quantity: defaultPurchase(required, stock) }) }, 'Recalcular')
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
    const provisional = data.menu.status === 'validado' || data.menu.status === 'cerrado' ? null
      : el('p', { class: 'muted' }, 'El menú todavía no está validado: la lista es provisional.');

    if (!list) {
      replace(host, el('div', { 'data-feedback-id': 'food.menu.compra.vacia', 'data-feedback-label': 'Sin lista de compra', class: 'empty', id: 'shoppingEmpty' }, el('strong', null, 'Todavía no hay lista de compra'),
        'Se calcula a partir de los platos del menú: raciones × cantidad de cada ingrediente ÷ raciones base de la receta.',
        provisional, writable ? el('p', { style: 'margin-top:10px' }, generate('Generar lista de compra', 'generateShopping')) : null,
        el('span', { class: 'hint' }, 'Generar necesita conexión.')));
      return;
    }

    const closed = list.status === 'cerrada';
    const current = shoppingSources(data.graph);
    const diff = sourceChanges(list.source_revisions, current);
    const stale = data.pending || isStale(list.source_revisions, current);
    const names = new Map(data.ingredients.map((i) => [i.id, i.name]));
    const sorted = [...items].sort((a, b) => Number(a.manual) - Number(b.manual) || (names.get(a.ingredient_id) ?? '').localeCompare(names.get(b.ingredient_id) ?? '', 'es'));
    const setStatus = (status: ShoppingListStatus) => commitSafely([{ op: 'update', table: T.shoppingLists, id: list!.id, expectedRevision: list!.revision, fields: { status } }]);
    const button = (id: string, label: string, onclick: () => void, mark: FbMark) => fb(el('button', { class: 'ghost', type: 'button', id, onclick }, label), mark);
    const pendingBuy = sorted.filter((i) => i.status === 'pendiente' && Number(i.purchase_quantity) > 0).length;

    replace(host,
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
    );
  }

  async function load(): Promise<void> {
    data = await loadMenuData(client, menuId);
    const lists = (await client.list(T.shoppingLists)) as ListRow[];
    list = lists.find((l) => l.menu_id === menuId) ?? null;
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
