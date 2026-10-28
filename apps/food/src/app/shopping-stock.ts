/**
 * Lo comprado en una lista de la compra, a la Despensa (Recursos). Lo usan la lista de un menú y la del evento (1117).
 *
 * «Comprado» (o «recibido») entra al stock de Recursos en ese momento, sin coste; volver a «pendiente» lo saca
 * (decisión del usuario, 14-10-2026). Finance (R4) añade después el coste a esa entrada por su referencia
 * `shopping_item:<id>`. Si el ingrediente aún no tiene artículo o no hay ningún sitio de cocina, la lista sigue como
 * siempre; si la unidad no se puede pasar a la del artículo, se avisa. Cambiar «En casa» o «Comprar» en una línea ya
 * comprada (H-C5) también pasa por aquí: el movimiento es la diferencia con lo que ya entró por esa referencia.
 * Lo pedido a Tasks (`purchase_ref`, 1117) no se apunta aquí: el stock entra por Recursos al recibirlo en Tasks.
 * Recursos se lee una sola vez para todo el lote.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  purchaseMovement, purchaseSpace, toItemBase,
  type Ingredient, type ItemConversion, type MovementLike, type ResourceItem, type ShoppingListItem, type SpaceLike,
} from '@ikisai/domain-food';
import { toast } from '@ikisai/ui-kit';
import { describeError } from './client.ts';
import { R, commitFoodStock, resourcesClient } from './resources.ts';

type Article = ResourceItem & { default_space_id: string | null };
export type StockLine = Pick<ShoppingListItem, 'id' | 'ingredient_id' | 'purchase_quantity' | 'unit' | 'status' | 'supplier' | 'purchase_ref'>;

export async function recordShoppingPurchases(client: SyncClient, lines: StockLine[], ingredients: Array<Pick<Ingredient, 'id' | 'name' | 'item_id'>>): Promise<void> {
  const linked = lines.filter((line) => !line.purchase_ref)
    .map((line) => ({ line, ingredient: ingredients.find((i) => i.id === line.ingredient_id) })).filter((x) => x.ingredient?.item_id);
  if (!linked.length) return;
  const r = resourcesClient(client);
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
    // Con origen Food, por el servidor (FO4): Finance le pone el coste buscando ese origen.
    if (operations.length) await commitFoodStock(client, operations);
  } catch (error) {
    toast(`No se ha anotado en el inventario: ${describeError(error)}`);
  }
}
