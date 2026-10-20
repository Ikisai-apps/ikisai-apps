/**
 * Food · alérgenos que el plato nombra y la receta no declara (decisión de Core Sevilla, 20-10-2026; MUELA-086, tanda 30):
 * `undeclaredAllergens` sale de `crossRestriction` y mira lo mismo que el resto del cruce: los ingredientes **y** el
 * texto del plato (nombre, nombre público y descripción). Un aviso por alérgeno; lo declarado no avisa.
 *
 * Cómo correrlo:   npx tsx --test tests/food/alergeno-sin-declarar.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossContext, undeclaredAllergens, undeclaredText } from '../../supabase/functions/_domain/food/warnings.ts';
import type { Recipe } from '../../supabase/functions/_domain/food/catalog.ts';

const ingredients = [
  { id: 'i-almendra', name: 'Almendra molida' }, { id: 'i-nuez', name: 'Nueces' }, { id: 'i-leche', name: 'Leche entera' }, { id: 'i-arroz', name: 'Arroz' },
];
const line = (recipe_id: string, ingredient_id: string) => ({ recipe_id, ingredient_id, deleted_at: null });
const context = crossContext({
  ingredients: ingredients as never,
  recipe_ingredients: [line('curry', 'i-almendra'), line('curry', 'i-nuez'), line('curry', 'i-arroz'), line('flan', 'i-leche'), line('flan', 'i-almendra'), line('tarta', 'i-arroz')] as never,
});
const recipe = (id: string, name: string, allergens: string[] = [], extra: Partial<Recipe> = {}) =>
  ({ id, name, public_name: null, public_description: null, allergens, allergens_checked: true, ...extra }) as unknown as Recipe;

test('el curry con almendra molida y nueces: frutos de cáscara sin declarar, una sola vez, con el ingrediente', () => {
  const found = undeclaredAllergens(recipe('curry', 'Curry de verduras'), context);
  assert.deepEqual(found, [{ allergen: 'frutos_de_cascara', ingredient: 'almendra molida', inText: false }]);
  assert.equal(undeclaredText(found[0]!), 'El ingrediente «almendra molida» nombra frutos de cáscara, que la receta no declara: revisa los alérgenos.');
});

test('una «Tarta de almendra» sin línea de almendra también avisa: lo nombra el plato', () => {
  const found = undeclaredAllergens(recipe('tarta', 'Tarta de almendra'), context);
  assert.deepEqual(found, [{ allergen: 'frutos_de_cascara', ingredient: null, inText: true }]);
  assert.equal(undeclaredText(found[0]!), 'El nombre o la descripción del plato nombran frutos de cáscara, que la receta no declara: revisa los alérgenos.');
  // También por la descripción pública.
  assert.deepEqual(undeclaredAllergens(recipe('tarta', 'Postre de la casa', [], { public_description: 'Bizcocho con nueces caramelizadas' }), context).map((u) => u.allergen), ['frutos_de_cascara']);
});

test('lo declarado no avisa; lo que falta, sí', () => {
  assert.deepEqual(undeclaredAllergens(recipe('flan', 'Flan', ['lacteos']), context).map((x) => x.allergen), ['frutos_de_cascara']);
  assert.deepEqual(undeclaredAllergens(recipe('flan', 'Flan', ['lacteos', 'frutos_de_cascara']), context), []);
  assert.deepEqual(undeclaredAllergens(recipe('sin-lineas', 'Arroz blanco'), context), []);
});
