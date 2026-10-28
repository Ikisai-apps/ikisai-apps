/**
 * Food · consumo al acabar el servicio (R5c; docs/food/API.md §2.8).
 *
 * Primero se descuenta en Recursos (`resources.consume`, un lote) y después se anota en `food.consumptions`. Si lo
 * segundo falla, los movimientos ya llevan `menu_item:<id>` y el plato cuenta como hecho: nada se descuenta dos veces.
 * Solo funciona si en Recursos hay sitios de cocina (si no, no se lleva inventario y no se enseña nada).
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  CONSUMPTION_FALLBACK_HOURS, consumeCall, consumptionLines, kitchenSpaceIds, purchaseSpace, serviceConsumption,
  type Consumption, type MenuGraph, type MenuItem, type MenuService, type MovementLike, type Recipe, type RecipeIngredient, type ResourceItem, type SpaceLike,
  type Ingredient, type ItemConversion, type LotLike,
} from '@ikisai/domain-food';
import { T, type Mirror } from './client.ts';
import { R, commitFoodStock, resourcesClient } from './resources.ts';

export interface InventoryData {
  items: Array<ResourceItem & { default_space_id?: string | null }>;
  spaces: SpaceLike[];
  movements: MovementLike[];
  lots: LotLike[];
  /** Conversiones de los artículos (`resources.item_units`). */
  conversions: ItemConversion[];
  kitchen: Set<string>;
}

export async function loadInventory(client: SyncClient): Promise<InventoryData> {
  const r = resourcesClient(client);
  const [items, spaces, movements, lots, conversions] = await Promise.all([
    r.list(R.items) as unknown as Promise<InventoryData['items']>,
    r.list(R.spaces) as unknown as Promise<SpaceLike[]>,
    r.list(R.movements) as unknown as Promise<MovementLike[]>,
    r.list(R.lots) as unknown as Promise<LotLike[]>,
    r.list(R.itemUnits) as unknown as Promise<ItemConversion[]>,
  ]);
  return { items, spaces, movements, lots, conversions, kitchen: kitchenSpaceIds(spaces) };
}

/** Lo que se decide de un plato: si se hizo y, si se corrigió, la cantidad de cada línea (en su unidad). */
export interface DishDecision { menuItemId: string; done: boolean; quantities?: number[] }

/** Descuenta los platos hechos y anota todos. `note` va en cada movimiento («Curry · comida del 14 oct»). */
export async function confirmConsumption(client: SyncClient, graph: MenuGraph, inventory: InventoryData, decisions: DishDecision[], options: { automatic?: boolean; noteOf: (menuItemId: string) => string }): Promise<void> {
  const calls: RowOperation[] = [];
  for (const decision of decisions.filter((d) => d.done)) {
    const lines = consumptionLines(graph, decision.menuItemId, inventory.items, inventory.conversions);
    lines.forEach((line, index) => {
      const article = inventory.items.find((i) => i.id === line.itemId);
      const call = consumeCall({
        line, quantity: decision.quantities?.[index] ?? line.quantity, menuItemId: decision.menuItemId,
        spaceIds: [...inventory.kitchen], fallbackSpaceId: article ? purchaseSpace(article, inventory.spaces) : null, note: options.noteOf(decision.menuItemId),
      });
      if (call) calls.push(call as unknown as RowOperation);
    });
  }
  // Con origen Food, por el servidor (FO4): `once` coincide con el del worker de las 24 h.
  if (calls.length) await commitFoodStock(client, calls);
  await client.commit(decisions.map((d) => ({
    op: 'insert', table: T.consumptions, id: crypto.randomUUID(),
    fields: { menu_item_id: d.menuItemId, status: d.done ? 'confirmado' : 'omitido', automatic: options.automatic === true },
  })) as RowOperation[]);
}

/** Todos los platos y recetas (de todos los menús) para calcular lo que gasta cada uno. */
export async function loadConsumptionGraph(client: SyncClient): Promise<{ graph: MenuGraph; services: Array<Mirror<MenuService>>; consumptions: Array<Mirror<Consumption>> }> {
  const [services, items, recipes, lines, ingredients, consumptions] = await Promise.all([
    client.list(T.menuServices) as Promise<Array<Mirror<MenuService>>>,
    client.list(T.menuItems) as Promise<Array<Mirror<MenuItem>>>,
    client.list(T.recipes, { includeDeleted: true }) as Promise<Array<Mirror<Recipe>>>,
    client.list(T.recipeIngredients) as Promise<Array<Mirror<RecipeIngredient>>>,
    client.list(T.ingredients, { includeDeleted: true }) as Promise<Array<Mirror<Ingredient>>>,
    client.list(T.consumptions) as Promise<Array<Mirror<Consumption>>>,
  ]);
  return { graph: { services, items, recipes, recipe_ingredients: lines, ingredients } as unknown as MenuGraph, services, consumptions };
}

/**
 * Respaldo del worker del servidor (P17): si a las 26 h un plato sigue sin descontar, lo descuenta la app de un editor al
 * abrirse o al volver la red, con lo previsto. Devuelve cuántos platos ha descontado.
 */
export async function autoConsume(client: SyncClient, now = new Date()): Promise<number> {
  const role = client.bootstrap()?.membership.role;
  if (!navigator.onLine || (role !== 'editor' && role !== 'owner')) return 0;
  const inventory = await loadInventory(client);
  if (!inventory.kitchen.size) return 0;
  const { graph, services, consumptions } = await loadConsumptionGraph(client);
  const due = services.flatMap((s) => {
    const state = serviceConsumption(s, graph, consumptions, inventory.movements, now);
    const late = now.getTime() >= state.due.getTime() + CONSUMPTION_FALLBACK_HOURS * 3_600_000;
    return state.state === 'automatico' && late ? state.pending.map((id) => ({ id, service: s })) : [];
  });
  if (!due.length) return 0;
  const names = new Map(graph.recipes.map((r) => [r.id, r.name]));
  const service = new Map(due.map((d) => [d.id, d.service]));
  await confirmConsumption(client, graph, inventory, due.map((d) => ({ menuItemId: d.id, done: true })), {
    automatic: true,
    noteOf: (id) => {
      const s = service.get(id)!;
      return `${names.get(graph.items.find((i) => i.id === id)?.recipe_id ?? '') ?? 'Plato'} · ${s.service_type} del ${s.service_date} · descontado solo a las 24 h`;
    },
  });
  return due.length;
}
