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
      name: input.name.trim(), category: quickRecipeCategory(input.serviceType), base_servings: input.servings, quick: true,
      // Explícitos, como los pondría la base de datos: el espejo local pinta la fila antes de que llegue la del servidor.
      status: 'en_prueba', diet_tags: [], allergens: [], allergens_checked: false } },
    { op: 'insert', table: 'food.menu_items', id: input.itemId, fields: {
      service_id: input.serviceId, recipe_id: input.recipeId, servings: input.servings, position: input.position } },
  ];
}

/** Palabras que no cuentan al comparar nombres de platos. */
const NAME_STOPWORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'con', 'sin', 'y', 'e', 'a', 'al', 'en', 'para', 'por', 'un', 'una']);
const nameWords = (name: string): Set<string> => new Set(name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/[^a-z0-9ñ]+/).filter((w) => w.length > 1 && !NAME_STOPWORDS.has(w)));

/**
 * Las recetas más parecidas a un plato sugerido (hallazgo F-SUG-3): las que comparten alguna palabra del nombre (sin
 * acentos ni palabras vacías), primero las que más comparten; a igualdad, la de la categoría del servicio y luego por
 * nombre. Sin palabras en común no se propone nada: la categoría sola no basta.
 */
export function similarRecipes<T extends { id: string; name: string; category: RecipeCategory }>(name: string, service: ServiceType, recipes: T[], limit = 5): T[] {
  const words = nameWords(name);
  if (!words.size) return [];
  const category = quickRecipeCategory(service);
  return recipes
    .map((recipe) => ({ recipe, shared: [...nameWords(recipe.name)].filter((w) => words.has(w)).length, same: recipe.category === category ? 1 : 0 }))
    .filter((x) => x.shared > 0)
    .sort((x, y) => y.shared - x.shared || y.same - x.same || x.recipe.name.localeCompare(y.recipe.name, 'es'))
    .slice(0, limit)
    .map((x) => x.recipe);
}

/** Tipo de sugerencia del núcleo para proponer un plato del menú de casa desde Guests (O3c; contrato §3.10). */
export const HOUSE_DISH_SUGGESTION_KIND = 'plato_casa';

export interface HouseDishSuggestion {
  name: string;
  /** `YYYY-MM-DD`. */
  date: string;
  service: ServiceType;
}

/**
 * Lote de una sugerencia `plato_casa`: una sola llamada que, al aprobarla, usa la receta del mismo nombre (o crea una
 * rápida), el servicio de ese día (o lo crea) y añade el plato. Se aplica como quien aprueba.
 */
export function houseDishSuggestionOperations(input: HouseDishSuggestion): Array<{ op: 'call'; procedure: string; args: Record<string, unknown> }> {
  return [{ op: 'call', procedure: 'food.house_dish_from_suggestion', args: { name: input.name.trim(), date: input.date, service: input.service } }];
}

/**
 * «Usar “receta parecida”» (tanda 27): el mismo lote con la receta elegida. Se manda al aprobar como lote corregido
 * (`core.suggestion_decide` con `p_operations`); el resto de la llamada no cambia.
 */
export function houseDishWithRecipe(operations: unknown, recipeId: string): Array<Record<string, unknown>> | null {
  if (!Array.isArray(operations) || operations.length !== 1) return null;
  const op = operations[0] as { op?: unknown; procedure?: unknown; args?: Record<string, unknown> };
  if (op?.op !== 'call' || op.procedure !== 'food.house_dish_from_suggestion' || !op.args || typeof op.args !== 'object') return null;
  return [{ ...op, args: { ...op.args, recipe_id: recipeId } }];
}

/** Los siete días (lunes a domingo, `YYYY-MM-DD`) de la semana de `date`, desplazada `offset` semanas. */
export function weekDays(date: string, offset = 0): string[] {
  const base = Date.parse(`${date}T00:00:00Z`);
  const monday = base - ((new Date(base).getUTCDay() + 6) % 7) * 86400000 + offset * 7 * 86400000;
  return Array.from({ length: 7 }, (_, i) => new Date(monday + i * 86400000).toISOString().slice(0, 10));
}

/** Voto a una sugerencia de plato (tanda 27, `food.suggestion_votes`, 1103): orienta, no decide. */
export interface SuggestionVote {
  id: string;
  suggestion_id: string;
  voter_id: string;
  vote: 'keep' | 'drop';
  deleted_at: string | null;
}

/** Recuento de una sugerencia y el voto propio: «4 aprobar · 2 descartar», «Tu voto». */
export function voteTally(votes: SuggestionVote[], suggestionId: string, me: string | null): { keep: number; drop: number; mine: SuggestionVote | null } {
  const live = votes.filter((v) => !v.deleted_at && v.suggestion_id === suggestionId);
  return {
    keep: live.filter((v) => v.vote === 'keep').length,
    drop: live.filter((v) => v.vote === 'drop').length,
    mine: (me && live.find((v) => v.voter_id === me)) || null,
  };
}

/** Cuerpo de `POST /api/v1/suggestion-votes` (tanda 27): votar, cambiar el voto o quitarlo (`null`). Quien vota lo pone el servidor. */
export function voteRequest(suggestionId: string, vote: 'keep' | 'drop' | null, requestId: string): { requestId: string; suggestionId: string; vote: 'keep' | 'drop' | null } {
  return { requestId, suggestionId, vote };
}
