/**
 * Food · un ingrediente nombra un alérgeno que la receta no declara (decisión de Core del 20-10-2026): lo detecta
 * `undeclaredAllergens`, una vez por alérgeno; lo declarado no avisa.
 *
 * Cómo correrlo:   npx tsx --test tests/food/alergeno-sin-declarar.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossContext, undeclaredAllergens } from '../../supabase/functions/_domain/food/warnings.ts';

const ingredients = [
  { id: 'i-almendra', name: 'Almendra molida' }, { id: 'i-nuez', name: 'Nueces' }, { id: 'i-leche', name: 'Leche entera' }, { id: 'i-arroz', name: 'Arroz' },
];
const line = (recipe_id: string, ingredient_id: string) => ({ recipe_id, ingredient_id, deleted_at: null });
const context = crossContext({
  ingredients: ingredients as never,
  recipe_ingredients: [line('curry', 'i-almendra'), line('curry', 'i-nuez'), line('curry', 'i-arroz'), line('flan', 'i-leche'), line('flan', 'i-almendra')] as never,
});

test('el curry con almendra molida y nueces: frutos de cáscara sin declarar, una sola vez', () => {
  assert.deepEqual(undeclaredAllergens({ id: 'curry', allergens: [] }, context), [{ allergen: 'frutos_de_cascara', ingredient: 'almendra molida' }]);
});

test('lo declarado no avisa; lo que falta, sí', () => {
  assert.deepEqual(undeclaredAllergens({ id: 'flan', allergens: ['lacteos'] }, context).map((x) => x.allergen), ['frutos_de_cascara']);
  assert.deepEqual(undeclaredAllergens({ id: 'flan', allergens: ['lacteos', 'frutos_de_cascara'] }, context), []);
  assert.deepEqual(undeclaredAllergens({ id: 'sin-lineas', allergens: [] }, context), []);
});
