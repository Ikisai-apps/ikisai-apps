/**
 * Ikisai Food · lista de compra y preparación derivadas del menú (docs/food/API.md §2.3, §2.4, §3.2).
 * `computeShopping` es el mismo cálculo que `food.regenerate_shopping`: sirve a la vista de cocinero y a la vista previa,
 * y las pruebas comprueban que ambos dan el mismo resultado.
 */
import type { SyncedColumns } from './catalog.ts';
import { outputUnit, round3, toBase, fromBase, unitFamily, type Unit, type UnitFamily } from './units.ts';
import type { MenuGraph } from './warnings.ts';

export const SHOPPING_LIST_STATUSES = ['borrador', 'revisada', 'cerrada'] as const;
export const SHOPPING_ITEM_STATUSES = ['pendiente', 'comprado', 'recibido'] as const;
export type ShoppingListStatus = (typeof SHOPPING_LIST_STATUSES)[number];
export type ShoppingItemStatus = (typeof SHOPPING_ITEM_STATUSES)[number];

/** Conjunto de revisiones con el que se generó un artefacto: `{ "<id de fila>": revisión }`. */
export type SourceRevisions = Record<string, number>;

export interface ShoppingList extends SyncedColumns {
  menu_id: string;
  status: ShoppingListStatus;
  generated_at: string;
  source_revisions: SourceRevisions;
  notes: string | null;
}

export interface ShoppingListItem extends SyncedColumns {
  shopping_list_id: string;
  ingredient_id: string;
  required_quantity: number;
  unit: Unit;
  stock_quantity: number | null;
  purchase_quantity: number;
  supplier: string | null;
  status: ShoppingItemStatus;
  manual_override: boolean;
  manual: boolean;
  notes: string | null;
}

export interface PreparationItem extends SyncedColumns {
  menu_id: string;
  menu_item_id: string | null;
  recipe_id: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  text: string;
  responsible: string | null;
  done: boolean;
  position: number;
  manual: boolean;
}

export interface ShoppingRequirement {
  ingredient_id: string;
  family: UnitFamily;
  unit: Unit;
  required_quantity: number;
}

function liveItems(graph: MenuGraph) {
  const services = new Set(graph.services.filter((s) => !s.deleted_at).map((s) => s.id));
  return graph.items.filter((i) => !i.deleted_at && services.has(i.service_id));
}

/** Raciones × cantidad ÷ raciones base, agrupado por ingrediente y familia de unidad. */
export function computeShopping(graph: MenuGraph): ShoppingRequirement[] {
  const recipes = new Map(graph.recipes.map((r) => [r.id, r]));
  const ingredients = new Map(graph.ingredients.map((g) => [g.id, g]));
  const totals = new Map<string, { ingredient_id: string; family: UnitFamily; base: number }>();
  for (const item of liveItems(graph)) {
    const recipe = recipes.get(item.recipe_id);
    if (!recipe) continue;
    const factor = Number(item.servings) / Number(recipe.base_servings);
    for (const line of graph.recipe_ingredients) {
      if (line.deleted_at || line.recipe_id !== recipe.id) continue;
      const family = unitFamily(line.unit);
      const key = `${line.ingredient_id}|${family}`;
      const entry = totals.get(key) ?? { ingredient_id: line.ingredient_id, family, base: 0 };
      entry.base += toBase(Number(line.quantity), line.unit) * factor;
      totals.set(key, entry);
    }
  }
  return [...totals.values()]
    .filter((t) => ingredients.has(t.ingredient_id))
    .map((t) => {
      const unit = outputUnit(t.family, t.base, ingredients.get(t.ingredient_id)!.preferred_unit);
      return { ingredient_id: t.ingredient_id, family: t.family, unit, required_quantity: round3(fromBase(t.base, unit)) };
    })
    .sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id) || a.family.localeCompare(b.family));
}

/** Lo que se compra mientras nadie lo fije a mano: lo necesario menos lo que ya hay en casa. */
export function defaultPurchase(required: number, stock: number | null): number {
  return round3(Math.max(required - (stock ?? 0), 0));
}

/** Ingredientes de un plato escalados a sus raciones, en la unidad de la receta (vista de cocinero). */
export function scaledIngredients(graph: MenuGraph, itemId: string): Array<{ ingredient_id: string; quantity: number; unit: Unit }> {
  const item = graph.items.find((i) => i.id === itemId);
  const recipe = item && graph.recipes.find((r) => r.id === item.recipe_id);
  if (!item || !recipe) return [];
  const factor = Number(item.servings) / Number(recipe.base_servings);
  return graph.recipe_ingredients
    .filter((l) => !l.deleted_at && l.recipe_id === recipe.id)
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((l) => ({ ingredient_id: l.ingredient_id, quantity: round3(Number(l.quantity) * factor), unit: l.unit }));
}

function revisions(rows: Array<{ id: string; revision: number }>): SourceRevisions {
  return Object.fromEntries(rows.map((r) => [r.id, Number(r.revision)]));
}

/** Filas de las que depende la lista de compra: platos vivos, sus recetas, las líneas vivas de esas recetas y sus ingredientes. */
export function shoppingSources(graph: MenuGraph): SourceRevisions {
  const items = liveItems(graph);
  const recipeIds = new Set(items.map((i) => i.recipe_id));
  const recipes = graph.recipes.filter((r) => recipeIds.has(r.id));
  const lines = graph.recipe_ingredients.filter((l) => !l.deleted_at && recipeIds.has(l.recipe_id));
  const ingredientIds = new Set(lines.map((l) => l.ingredient_id));
  return revisions([...items, ...recipes, ...lines, ...graph.ingredients.filter((g) => ingredientIds.has(g.id))]);
}

/** Filas de las que depende la preparación: servicios vivos, platos vivos y sus recetas. */
export function preparationSources(graph: MenuGraph): SourceRevisions {
  const items = liveItems(graph);
  const recipeIds = new Set(items.map((i) => i.recipe_id));
  return revisions([...graph.services.filter((s) => !s.deleted_at), ...items, ...graph.recipes.filter((r) => recipeIds.has(r.id))]);
}

/** Qué cambió entre el conjunto guardado y el actual. Vacío = el artefacto está al día. */
export function sourceChanges(saved: SourceRevisions | null | undefined, current: SourceRevisions): { added: string[]; removed: string[]; changed: string[] } {
  const before = saved ?? {};
  return {
    added: Object.keys(current).filter((id) => !(id in before)),
    removed: Object.keys(before).filter((id) => !(id in current)),
    changed: Object.keys(current).filter((id) => id in before && Number(before[id]) !== current[id]),
  };
}

/** Un artefacto derivado está desactualizado cuando el conjunto de revisiones de origen ya no coincide. */
export function isStale(saved: SourceRevisions | null | undefined, current: SourceRevisions): boolean {
  const diff = sourceChanges(saved, current);
  return diff.added.length + diff.removed.length + diff.changed.length > 0;
}
