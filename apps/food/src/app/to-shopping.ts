/**
 * «A la compra» (Despensa e Inicio; Bloque 2, MUELA-077 §1, decisión de VG): una línea a mano en la lista de esta
 * semana del menú de casa, con lo que falta hasta el mínimo. La genera si no existe (con red), no duplica una línea
 * pendiente y, si Food aún no usa el artículo, crea el ingrediente enlazado con él. Sale de `pantry.ts` sin cambios.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, HOUSE_MENU_ID, foodUnitFromBase, kitchenSpaceIds, kitchenStock, weekDays,
  type Ingredient, type LotLike, type MovementLike, type ShoppingList, type ShoppingListItem, type SpaceLike,
} from '@ikisai/domain-food';
import { toast } from '@ikisai/ui-kit';
import { runCall } from './calls.ts';
import { T, describeError, type Mirror } from './client.ts';
import { todayKey } from './events.ts';
import { R, resourcesClient } from './resources.ts';
import { usage } from './usage.ts';
import { periodLabel } from '../ui/house-period.ts';

/** Lo que hace falta del artículo (la forma de `ItemRow` del kit). */
export interface ShoppingArticle { id: string; name: string; baseUnit: string; minQuantity: number | null; reorderQuantity?: number | null }

export async function toShopping(client: SyncClient, item: ShoppingArticle): Promise<void> {
  const r = resourcesClient(client);
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
