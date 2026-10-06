import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, SHOPPING_ITEM_STATUSES, defaultPurchase, ingredientKey, isStale, shoppingSources, sourceChanges, validateOperations,
  type ShoppingItemStatus, type ShoppingList, type ShoppingListItem, type ShoppingListStatus, type Unit,
} from '@ikisai/domain-food';
import { el, formatDate, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { T, UNITS, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import { MENU_TABLES, loadMenuData, type MenuData } from '../app/menu-data.ts';

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
      const result = await runCall<RegenerateResult>(client, FOOD_PROCEDURES.regenerateShopping, { menu_id: menuId, list_id: list?.id ?? crypto.randomUUID() });
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

  function quantityInput(item: ItemRow, value: number | null, label: string, onValue: (value: number | null) => void, disabled: boolean): HTMLInputElement {
    const input = el('input', { type: 'text', inputmode: 'decimal', class: 'qty', value: formatQuantity(value), 'aria-label': label, disabled,
      onchange: () => {
        const raw = input.value.trim();
        const parsed = raw === '' ? null : parseQuantity(raw);
        if (raw !== '' && (parsed === null || parsed < 0)) { toast('Escribe una cantidad válida.'); input.value = formatQuantity(value); return; }
        if (parsed !== (value === null ? null : Number(value))) onValue(parsed);
      } });
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
    }, disabled);
    const purchaseInput = quantityInput(item, Number(item.purchase_quantity), `Comprar de ${name}`, (value) => {
      void update(item, item.manual ? { purchase_quantity: value ?? 0 } : { purchase_quantity: value ?? 0, manual_override: true });
    }, disabled);
    const bought = el('input', { type: 'checkbox', class: 'bigcheck', checked: item.status !== 'pendiente', disabled, 'aria-label': `${name} comprado`,
      onchange: () => void update(item, { status: bought.checked ? 'comprado' : 'pendiente' }) });
    const status = el('select', { 'aria-label': `Estado de ${name}`, disabled, onchange: () => void update(item, { status: status.value }) },
      ...SHOPPING_ITEM_STATUSES.map((s) => el('option', { value: s, selected: item.status === s }, ITEM_STATUS_LABELS[s])));
    const chips = [
      item.manual ? el('span', { class: 'chip' }, 'A mano') : null,
      !item.manual && item.manual_override ? el('span', { class: 'chip' }, 'Compra fijada') : null,
      !item.manual && required === 0 ? el('span', { class: 'chip trash' }, 'Ya no hace falta') : null,
      item._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null,
    ];
    return el('li', { class: 'buyrow', 'data-id': item.id, 'data-status': item.status, 'data-pending': String(item._pending === true) },
      bought,
      el('div', { class: 'buyname' }, el('strong', null, name),
        el('span', { class: 'recipemeta' }, item.manual ? 'Añadido a mano' : `Necesario: ${formatQuantity(required)} ${UNIT_LABELS[item.unit]}`, item.supplier ? ` · ${item.supplier}` : ''),
        el('span', { class: 'chips' }, ...chips)),
      el('label', { class: 'buyfield' }, el('span', null, 'En casa'), stockInput),
      el('label', { class: 'buyfield' }, el('span', null, `Comprar (${UNIT_LABELS[item.unit]})`), purchaseInput),
      el('div', { class: 'buyactions' }, status,
        !disabled && !item.manual && item.manual_override
          ? el('button', { class: 'linkbtn', type: 'button', 'aria-label': `Volver a calcular la compra de ${name}`,
              onclick: () => void update(item, { manual_override: false, purchase_quantity: defaultPurchase(required, stock) }) }, 'Recalcular')
          : null,
        !disabled && item.manual
          ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${name}`, onclick: () => void commitSafely([{ op: 'delete', table: T.shoppingItems, id: item.id, expectedRevision: item.revision }]) }, icon('close', 18))
          : null),
    );
  }

  function addManual(): void {
    if (!list || !data) return;
    const known = data.ingredients.filter((i) => !i.deleted_at);
    const name = el('input', { id: 'm-name', type: 'text', list: 'buyIngredients', maxlength: '120', placeholder: 'Producto' });
    const quantity = el('input', { id: 'm-quantity', type: 'text', inputmode: 'decimal' });
    const unit = el('select', { id: 'm-unit' }, ...UNITS.map((u) => el('option', { value: u, selected: u === 'unidad' }, UNIT_LABELS[u])));
    const supplier = el('input', { id: 'm-supplier', type: 'text', maxlength: '120' });
    const error = el('p', { class: 'formerror', role: 'alert' });
    const field = (label: string, control: HTMLElement) => el('label', { class: 'field' }, el('span', null, label), control);
    sheet = openSheet({
      title: 'Añadir a la compra',
      body: el('div', null, el('datalist', { id: 'buyIngredients' }, ...known.map((i) => el('option', { value: i.name }))),
        field('Producto', name), field('Cantidad a comprar', quantity), field('Unidad', unit), field('Proveedor', supplier),
        el('span', { class: 'hint' }, 'Para lo que no sale del menú: servilletas, café, aceite para freír…'), error),
      foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'),
        el('button', { class: 'primary', type: 'button', id: 'saveManual', onclick: async () => {
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
          if (await commitSafely(operations)) await sheet?.close(true);
        } }, 'Añadir')],
      initialFocus: name,
      onClose: () => { sheet = null; },
    });
  }

  function paint(): void {
    if (!data?.menu) { replace(host); return; }
    const writable = canWrite();
    const generate = (label: string, id: string) => el('button', { class: 'primary', type: 'button', id, disabled: busy, onclick: () => void regenerate() }, label);
    const provisional = data.menu.status === 'validado' || data.menu.status === 'cerrado' ? null
      : el('p', { class: 'muted' }, 'El menú todavía no está validado: la lista es provisional.');

    if (!list) {
      replace(host, el('div', { class: 'empty', id: 'shoppingEmpty' }, el('strong', null, 'Todavía no hay lista de compra'),
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
    const button = (id: string, label: string, onclick: () => void) => el('button', { class: 'ghost', type: 'button', id, onclick }, label);
    const pendingBuy = sorted.filter((i) => i.status === 'pendiente' && Number(i.purchase_quantity) > 0).length;

    replace(host,
      stale ? el('div', { class: 'banner warn notice', id: 'shoppingStale', role: 'status' },
        el('div', null, el('strong', null, 'El menú o sus recetas han cambiado desde que se generó la lista.'),
          ` ${diff.added.length + diff.removed.length + diff.changed.length || 'Hay'} cambios${data.pending ? ' (algunos aún sin sincronizar)' : ''}. Regenerar conserva lo que hayas tocado a mano.`),
        writable && !closed ? el('div', { class: 'btnrow' }, el('button', { class: 'ghost', type: 'button', id: 'regenerateShopping', disabled: busy, onclick: () => void regenerate() }, 'Regenerar lista')) : null) : null,
      el('div', { class: 'tabhead' },
        el('div', { class: 'chips' },
          el('span', { class: list.status === 'borrador' ? 'chip' : 'chip ok', id: 'shoppingStatus' }, LIST_STATUS_LABELS[list.status]),
          el('span', { class: 'chip' }, pendingBuy === 0 ? 'Todo comprado' : `${pendingBuy} por comprar`)),
        el('p', { class: 'muted' }, `Generada el ${formatDate(list.generated_at)}.`),
        provisional),
      writable ? el('div', { class: 'btnrow menuactions' },
        list.status === 'borrador' ? button('listReviewed', 'Marcar como revisada', () => void setStatus('revisada')) : null,
        list.status === 'revisada' ? button('listDraft', 'Volver a borrador', () => void setStatus('borrador')) : null,
        list.status === 'revisada' ? button('listClose', 'Cerrar lista', () => void setStatus('cerrada')) : null,
        closed ? button('listReopen', 'Reabrir lista', () => void setStatus('borrador')) : null,
        !closed && !stale ? el('button', { class: 'linkbtn', type: 'button', id: 'regenerateShopping', disabled: busy, onclick: () => void regenerate() }, 'Regenerar') : null,
        !closed ? el('button', { class: 'linkbtn', type: 'button', id: 'addManual', onclick: addManual }, icon('plus', 18), 'Añadir línea') : null) : null,
      sorted.length
        ? el('ul', { class: 'buylist', id: 'shoppingList' }, ...sorted.map((item) => itemRow(item, names.get(item.ingredient_id) ?? 'Ingrediente retirado', closed)))
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
