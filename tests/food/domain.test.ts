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

test('coste · precio medio por familia de unidad y coste de plato con huecos señalados', async () => {
  const { ingredientPrices, dishCost, serviceCosts, purchaseUnit } = await import('../../supabase/functions/_domain/food/mod.ts');
  assert.equal(purchaseUnit('Kg.'), 'kg');
  assert.equal(purchaseUnit('Litros'), 'l');
  assert.equal(purchaseUnit('ud'), 'unidad');
  assert.equal(purchaseUnit('caja'), null);
  const p = (id: string, quantity: number, unit: string, amount: number, date = '2026-10-01') =>
    ({ allocation_id: crypto.randomUUID(), target_kind: 'ingredient', target_id: id, invoice_date: date, supplier_name: null, line_description: null, allocated_quantity: quantity, unit, allocated_amount: amount });
  // Tomate: 10 kg por 20 € y 5000 g por 12,50 € → 32,50 € / 15 000 g. Arroz: en «cajas», no se reconoce.
  const TODAY = new Date('2026-10-06T12:00:00Z');
  const prices = ingredientPrices([p('tomate', 10, 'kg', 20), p('tomate', 5000, 'g', 12.5, '2026-10-05'), p('arroz', 3, 'caja', 9)], TODAY);
  const tomato = prices.get('tomate')![0]!;
  assert.equal(tomato.purchases, 2);
  assert.equal(tomato.lastDate, '2026-10-05');
  assert.ok(Math.abs(tomato.perBase - 32.5 / 15000) < 1e-12);
  assert.equal(prices.has('arroz'), false);
  const row = (id: string, extra: Record<string, unknown>) => ({ id, revision: 1, created_at: '', updated_at: '', updated_by: null, deleted_at: null, ...extra }) as any;
  const graph = {
    services: [row('s1', { menu_id: 'm', service_date: '2026-10-16', service_type: 'cena', service_time: null, position: 1 })],
    items: [row('i1', { service_id: 's1', recipe_id: 'r1', servings: 30, position: 1 })],
    recipes: [row('r1', { name: 'Curry', base_servings: 20 })],
    recipe_ingredients: [row('l1', { recipe_id: 'r1', ingredient_id: 'tomate', quantity: 2, unit: 'kg', position: 1 }), row('l2', { recipe_id: 'r1', ingredient_id: 'arroz', quantity: 1, unit: 'kg', position: 2 })],
    ingredients: [],
  };
  // 2 kg × 30 ÷ 20 = 3 kg = 3000 g × 32,50/15 000 = 6,50 €; el arroz no tiene precio.
  assert.deepEqual(dishCost(graph, 'i1', prices), { amount: 6.5, missing: ['arroz'], stale: [] });
  assert.deepEqual(serviceCosts(graph, prices), [{ service_id: 's1', amount: 6.5, servings: 30, missing: ['arroz'], stale: [] }]);
  // Una compra por unidades no sirve para una receta en gramos.
  assert.deepEqual(dishCost(graph, 'i1', ingredientPrices([p('tomate', 12, 'ud', 6)], TODAY)).missing.sort(), ['arroz', 'tomate']);
});

test('coste · manda la unidad normalizada de Invoices; el texto queda de respaldo', async () => {
  const { ingredientPrices, purchaseQuantity } = await import('../../supabase/functions/_domain/food/mod.ts');
  const base = { allocation_id: 'a', target_kind: 'ingredient', target_id: 'aceite', invoice_date: null, supplier_name: null, line_description: null, allocated_amount: 12 };
  // «Botella 75 cl» no se entiende como texto, pero Invoices la normaliza a 0,75 l.
  assert.deepEqual(purchaseQuantity({ ...base, allocated_quantity: 1, unit: 'botella 75cl', unit_normalized: 'l', quantity_normalized: 0.75 }), { unit: 'l', quantity: 0.75 });
  assert.deepEqual(purchaseQuantity({ ...base, allocated_quantity: 500, unit: 'gr', unit_normalized: null, quantity_normalized: null }), { unit: 'g', quantity: 500 });
  assert.deepEqual(purchaseQuantity({ ...base, allocated_quantity: 6, unit: 'pzas', unit_normalized: 'ud', quantity_normalized: '6' }), { unit: 'unidad', quantity: 6 });
  assert.equal(purchaseQuantity({ ...base, allocated_quantity: 2, unit: 'caja', unit_normalized: null }), null);
  const price = ingredientPrices([{ ...base, invoice_date: '2026-10-01', allocated_quantity: 1, unit: 'botella 75cl', unit_normalized: 'l', quantity_normalized: 0.75 }], new Date('2026-10-06T12:00:00Z')).get('aceite')![0]!;
  assert.equal(price.family, 'volumen');
  assert.ok(Math.abs(price.perBase - 12 / 750) < 1e-12); // 16 €/l
});

test('coste · media de los últimos 3 meses; si no hay, la última compra con aviso', async () => {
  const { ingredientPrices, priceWindowStart, dishCost, menuTotals } = await import('../../supabase/functions/_domain/food/mod.ts');
  const TODAY = new Date('2026-10-06T12:00:00Z');
  assert.equal(priceWindowStart(TODAY), '2026-07-06');
  const p = (id: string, quantity: number, amount: number, date: string | null) =>
    ({ allocation_id: crypto.randomUUID(), target_kind: 'ingredient', target_id: id, invoice_date: date, supplier_name: null, line_description: null, allocated_quantity: quantity, unit: 'kg', allocated_amount: amount });
  const prices = ingredientPrices([
    // Tomate: una compra vieja (3 €/kg) y dos dentro de la ventana (2 €/kg y 2,50 €/kg) → solo cuentan las recientes: 9 € / 4 kg.
    p('tomate', 10, 30, '2026-05-01'), p('tomate', 2, 4, '2026-07-06'), p('tomate', 2, 5, '2026-09-30'),
    // Arroz: nada en la ventana → la última compra (1,80 €/kg en junio), no la media con la de enero.
    p('arroz', 5, 5, '2026-01-10'), p('arroz', 10, 18, '2026-06-20'),
    // Sal: sin fecha → antigua.
    p('sal', 1, 0.5, null),
  ], TODAY);
  const tomato = prices.get('tomate')![0]!;
  assert.equal(tomato.stale, false);
  assert.equal(tomato.purchases, 2);
  assert.ok(Math.abs(tomato.perBase - 9 / 4000) < 1e-12);
  const rice = prices.get('arroz')![0]!;
  assert.deepEqual([rice.stale, rice.lastDate, rice.purchases], [true, '2026-06-20', 1]);
  assert.ok(Math.abs(rice.perBase - 18 / 10000) < 1e-12);
  assert.equal(prices.get('sal')![0]!.stale, true);

  const row = (id: string, extra: Record<string, unknown>) => ({ id, revision: 1, created_at: '', updated_at: '', updated_by: null, deleted_at: null, ...extra }) as any;
  const graph = {
    services: [row('s1', { menu_id: 'm', service_date: '2026-10-16', service_type: 'cena', service_time: null, position: 1 })],
    items: [row('i1', { service_id: 's1', recipe_id: 'r1', servings: 10, position: 1 })],
    recipes: [row('r1', { name: 'Arroz con tomate', base_servings: 10 })],
    recipe_ingredients: [row('l1', { recipe_id: 'r1', ingredient_id: 'tomate', quantity: 1, unit: 'kg' }), row('l2', { recipe_id: 'r1', ingredient_id: 'arroz', quantity: 1, unit: 'kg' })],
    ingredients: [],
  };
  // 1 kg de tomate a 2,25 € + 1 kg de arroz a 1,80 € (precio antiguo) = 4,05 €.
  assert.deepEqual(dishCost(graph, 'i1', prices), { amount: 4.05, missing: [], stale: ['arroz'] });
  assert.deepEqual(menuTotals(new Map([['m', graph]]), prices).get('m'), { total: 4.05, missing: 0, stale: 1 });
});

