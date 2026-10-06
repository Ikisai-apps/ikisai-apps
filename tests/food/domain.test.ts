import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, ingredientKey, outputUnit, round3, toBase, unitFamily, validateOperation, validateOperations } from '../../supabase/functions/_domain/food/mod.ts';

const RECIPE = '11111111-1111-4111-8111-111111111111';
const INGREDIENT = '22222222-2222-4222-8222-222222222222';

test('unidades · solo se convierte dentro de masa y de volumen', () => {
  assert.equal(unitFamily('kg'), 'masa');
  assert.equal(unitFamily('l'), 'volumen');
  assert.equal(unitFamily('manojo'), 'manojo');
  assert.equal(toBase(1.5, 'kg') + toBase(800, 'g'), 2300);
  assert.equal(convert(2300, 'g', 'kg'), 2.3);
  assert.equal(convert(0.25, 'l', 'ml'), 250);
  assert.equal(convert(1, 'kg', 'l'), null);
  assert.equal(convert(1, 'unidad', 'paquete'), null);
});

test('unidades · unidad de salida: la preferida si es de la familia; si no, por magnitud', () => {
  assert.equal(outputUnit('masa', 2300, 'kg'), 'kg');
  assert.equal(outputUnit('masa', 2300, 'g'), 'g');
  assert.equal(outputUnit('masa', 2300, 'unidad'), 'kg');
  assert.equal(outputUnit('masa', 800, null), 'g');
  assert.equal(outputUnit('volumen', 1000, 'kg'), 'l');
  assert.equal(outputUnit('volumen', 999, null), 'ml');
  assert.equal(outputUnit('manojo', 3, 'kg'), 'manojo');
  assert.equal(round3(3.6000000001), 3.6);
  assert.equal(round3(1.0005), 1.001);
});

test('catálogo · clave de nombre de ingrediente', () => {
  assert.equal(ingredientKey('  Tomate   pera '), 'tomate pera');
  assert.equal(ingredientKey('TOMATE'), ingredientKey('tomate'));
});

test('validación · receta: tipos, enumerados, obligatorios y alérgenos revisados', () => {
  const insert = (fields: Record<string, unknown>) => validateOperation({ op: 'insert', table: 'food.recipes', id: RECIPE, fields });
  assert.equal(insert({ name: 'Curry de verduras', category: 'principal', base_servings: 20 }), null);
  assert.equal(insert({ name: 'Curry', category: 'principal', base_servings: 20, diet_tags: ['vegano'], allergens: ['apio'], allergens_checked: true, status: 'validada' }), null);
  assert.equal(insert({ category: 'principal', base_servings: 20 })?.details.field, 'name');
  assert.equal(insert({ name: '   ', category: 'principal', base_servings: 20 })?.details.field, 'name');
  assert.equal(insert({ name: 'x', category: 'plato', base_servings: 20 })?.details.field, 'category');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: 0 })?.details.field, 'base_servings');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: '20' })?.details.field, 'base_servings');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: 20, allergens: ['pistacho'] })?.details.field, 'allergens');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: 20, diet_tags: ['vegano', 'vegano'] })?.details.field, 'diet_tags');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: 20, prep_minutes: 1.5 })?.details.field, 'prep_minutes');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: 20, revision: 3 })?.code, 'INVALID_FIELDS');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: 20, photo_file_id: { $blob: 'a'.repeat(64) } })?.details.field, 'photo_file_id');
  assert.equal(insert({ name: 'x', category: 'principal', base_servings: 20, status: 'validada' })?.code, 'ALLERGENS_UNCHECKED');
  const update = (fields: Record<string, unknown>) => validateOperation({ op: 'update', table: 'food.recipes', id: RECIPE, fields });
  assert.equal(update({ status: 'validada' }), null); // lo decide el trigger con la fila actual
  assert.equal(update({ status: 'validada', allergens_checked: false })?.code, 'ALLERGENS_UNCHECKED');
  assert.equal(update({ public_name: null, photo_file_id: null }), null);
  assert.equal(update({ name: null })?.details.field, 'name');
});

test('validación · líneas de receta: recipe_id solo al insertar; lote con índice', () => {
  const line = { recipe_id: RECIPE, ingredient_id: INGREDIENT, quantity: 2, unit: 'kg' };
  assert.equal(validateOperation({ op: 'insert', table: 'food.recipe_ingredients', id: RECIPE, fields: line }), null);
  assert.equal(validateOperation({ op: 'insert', table: 'food.recipe_ingredients', id: RECIPE, fields: { ...line, unit: 'cucharada' } })?.details.field, 'unit');
  assert.equal(validateOperation({ op: 'insert', table: 'food.recipe_ingredients', id: RECIPE, fields: { ...line, quantity: -1 } })?.details.field, 'quantity');
  assert.equal(validateOperation({ op: 'update', table: 'food.recipe_ingredients', id: RECIPE, fields: { recipe_id: INGREDIENT } })?.code, 'IMMUTABLE_FIELD');
  assert.equal(validateOperation({ op: 'delete', table: 'food.recipe_ingredients', id: RECIPE }), null);
  assert.equal(validateOperation({ op: 'insert', table: 'invoices.suppliers', id: RECIPE, fields: { lo_que_sea: 1 } }), null);
  const found = validateOperations([
    { op: 'insert', table: 'food.ingredients', id: INGREDIENT, fields: { name: 'Tomate', preferred_unit: 'kg' } },
    { op: 'insert', table: 'food.recipe_ingredients', id: RECIPE, fields: { ...line, quantity: 0 } },
  ]);
  assert.equal(found?.details.index, 1);
  assert.equal(found?.details.field, 'quantity');
});
