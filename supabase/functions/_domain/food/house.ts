/**
 * Ikisai Food · O3a: menú de casa y plato rápido (coordinacion/ampliacion/RECURSOS.md §15.3; docs/food/API.md §2.6).
 *
 * - **Menú de casa:** `menus.kind = 'casa'`, sin evento. Hay uno solo, con id fijo (`HOUSE_MENU_ID`) para que dos
 *   dispositivos no creen dos. No se valida, no se cierra ni se borra. `house_servings` son las personas en casa: las
 *   raciones por defecto de cada plato.
 * - **Plato rápido:** una receta mínima con `quick: true` (solo el nombre; categoría y raciones base se deducen) y el
 *   plato que la usa, en un solo lote. Está **por completar** mientras le falten los alérgenos revisados o algún
 *   ingrediente (decisión del usuario, 13-10-2026), y así no entra en un menú de retiro (`QUICK_RECIPE_IN_RETREAT`).
 */
import type { Recipe, RecipeCategory, RecipeIngredient } from './catalog.ts';
import type { Menu, ServiceType } from './menus.ts';

/** Id fijo del menú de casa. */
export const HOUSE_MENU_ID = 'f00dca5a-0000-4000-8000-000000000001';

export function isHouseMenu(menu: Pick<Menu, 'kind'> | null | undefined): boolean {
  return menu?.kind === 'casa';
}

/** La receta nació como plato rápido y aún le faltan los alérgenos revisados o algún ingrediente. */
export function isQuickPending(
  recipe: Pick<Recipe, 'id' | 'allergens_checked'> & { quick?: boolean },
  lines: Array<Pick<RecipeIngredient, 'recipe_id' | 'deleted_at'>>,
): boolean {
  if (!recipe.quick) return false;
  return !(recipe.allergens_checked && lines.some((l) => l.recipe_id === recipe.id && !l.deleted_at));
}

/** Categoría de una receta rápida según el servicio en que nace. */
export function quickRecipeCategory(service: ServiceType): RecipeCategory {
  return service === 'desayuno' || service === 'merienda' || service === 'picnic' ? service : 'principal';
}

export interface QuickDishInput {
  recipeId: string;
  itemId: string;
  name: string;
  serviceId: string;
  serviceType: ServiceType;
  servings: number;
  position: number;
}

/** Lote del plato rápido: la receta mínima y el plato. Raciones base = las del plato, así escalar no cambia nada. */
export function quickDishOperations(input: QuickDishInput): Array<{ op: 'insert'; table: string; id: string; fields: Record<string, unknown> }> {
  return [
    { op: 'insert', table: 'food.recipes', id: input.recipeId, fields: {
      name: input.name.trim(), category: quickRecipeCategory(input.serviceType), base_servings: input.servings, quick: true } },
    { op: 'insert', table: 'food.menu_items', id: input.itemId, fields: {
      service_id: input.serviceId, recipe_id: input.recipeId, servings: input.servings, position: input.position } },
  ];
}

/** Los siete días (lunes a domingo, `YYYY-MM-DD`) de la semana de `date`, desplazada `offset` semanas. */
export function weekDays(date: string, offset = 0): string[] {
  const base = Date.parse(`${date}T00:00:00Z`);
  const monday = base - ((new Date(base).getUTCDay() + 6) % 7) * 86400000 + offset * 7 * 86400000;
  return Array.from({ length: 7 }, (_, i) => new Date(monday + i * 86400000).toISOString().slice(0, 10));
}
