/** Food · rendimiento del ingrediente (1112): 1 tomate = 8 rodajas, en la conversión, en la previsión para Flow y en la compra. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { prepMissingLabel, purchaseFromPrep, validateOperation } from '../../supabase/functions/_domain/food/mod.ts';

const TOMATE = '3a3d080c-417e-4174-a87f-9f28fc62ec90';
const CARTA = 'f00dca7a-0000-4000-8000-000000000001';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
async function ok(path: 'commands' | 'resources/commands', operations: unknown[]) {
  const res = await app.call(`/api/v1/${path}`, { body: { requestId: `yield-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const round = (n: unknown) => (n === null ? null : Math.round(Number(n) * 1e6) / 1e6);

let tomato = '', line = '';

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  if (!(await q(`select 1 from resources.items where id = $1`, [TOMATE])).length) {
    await ok('resources/commands', [insert('resources.items', TOMATE, { name: 'Tomate', kind: 'ingrediente', base_unit: 'kg' })]);
  }
  await q(`select food.seed_carta_octubre()`);
  tomato = (await q(`select id from food.ingredients where item_id = $1`, [TOMATE]))[0].id;
  // Una pieza de tomate pesa 0,16 kg (conversión «ud» del artículo, sin proveedor); ninguna «rodaja».
  await ok('resources/commands', [insert('resources.item_units', uuid(), { item_id: TOMATE, unit: 'ud', factor: 0.16 })]);
  // Montadito con 3 rodajas contadas como 'unidad' de tomate; 10 a cubrir.
  const recipe = uuid();
  line = uuid();
  await ok('commands', [
    insert('food.recipes', recipe, { name: 'Montadito de tomate', category: 'entrante', base_servings: 1 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: tomato, quantity: 3, unit: 'unidad', station: 2 }),
    insert('food.carta_lines', line, { menu_id: CARTA, recipe_id: recipe, scope: 'barra', code: 'β', sale_price_cents: 200, expected_units: 10 }),
  ]);
});
test.after(async () => { await app.close(); });

test('sin rendimiento · 3 «unidad» de tomate son 3 tomates enteros', async () => {
  const row = (await q(`select per_unit, prep_unit, prep_need_total, yield from food.carta_prep_projection where line_id = $1`, [line]))[0];
  assert.deepEqual([round(row.per_unit), row.prep_unit, round(row.prep_need_total), row.yield], [0.48, 'unidad', 30, null]);
  // Hay cantidad, pero se avisa (1115): si son rodajas, los recipientes de Flow y la compra salen mal.
  const why = (await q(`select missing, yield_missing, note from food.carta_prep_projection where line_id = $1`, [line]))[0];
  assert.deepEqual([why.missing, why.yield_missing], [null, true]);
  assert.match(why.note, /Tomate sin rendimiento: se cuentan piezas enteras/);
});

test('con rendimiento · 1 tomate = 8 rodajas: la cantidad, la previsión para Flow y la compra', async () => {
  const rev = Number((await q(`select revision from food.ingredients where id = $1`, [tomato]))[0].revision);
  await ok('commands', [{ op: 'update', table: 'food.ingredients', id: tomato, expectedRevision: rev, fields: { purchase_unit: 'unidad', prep_unit: 'rodaja', yield: 8 } }]);
  // Ahora las 3 «unidad» son 3 rodajas: 3 ÷ 8 tomates × 0,16 kg = 0,06 kg por montadito.
  const row = (await q(`select per_unit, need_total, prep_unit, prep_per_unit, prep_need_total, purchase_unit, yield, convertible
    from food.carta_prep_projection where line_id = $1`, [line]))[0];
  // El rendimiento cuenta antes que la conversión de la pieza: la receta cuenta rodajas.
  assert.deepEqual([row.prep_unit, round(row.prep_per_unit), round(row.prep_need_total), row.purchase_unit, round(row.yield), row.convertible],
    ['rodaja', 3, 30, 'unidad', 8, true]);
  assert.equal(round(row.per_unit), 0.06);
  assert.equal(round(row.need_total), 0.6);
  assert.equal(purchaseFromPrep(row.prep_need_total, row.yield), 4, '30 rodajas ÷ 8 = 4 tomates (hacia arriba)');
  const total = (await q(`select prep_unit, prep_need_total, purchase_unit, yield from food.carta_prep_totals_projection where component_key = $1`, [TOMATE]))[0];
  assert.equal(total.purchase_unit, 'unidad');
  assert.equal(round(total.yield), 8);
  const why = (await q(`select missing, yield_missing, note from food.carta_prep_totals_projection where component_key = $1`, [TOMATE]))[0];
  assert.deepEqual([why.missing, why.yield_missing, why.note], [null, false, null], 'con rendimiento no falta nada');
});

test('avisos · qué falta y dónde se pone: artículo, rendimiento o conversión (1115)', async () => {
  const PEPINO = uuid(), pepino = uuid(), suelto = uuid(), recipe = uuid(), menu = uuid(), l1 = uuid();
  // Pepino: artículo en kg sin conversión de la pieza; «Sal suelta»: sin artículo del inventario.
  await ok('resources/commands', [insert('resources.items', PEPINO, { name: 'Pepino', kind: 'ingrediente', base_unit: 'kg' })]);
  await ok('commands', [
    insert('food.ingredients', pepino, { name: 'Pepino', preferred_unit: 'kg', item_id: PEPINO }),
    insert('food.ingredients', suelto, { name: 'Sal suelta', preferred_unit: 'g' }),
    insert('food.recipes', recipe, { name: 'Montadito de pepino', category: 'entrante', base_servings: 1 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: pepino, quantity: 2, unit: 'unidad', station: 2 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: suelto, quantity: 1, unit: 'g', station: 4 }),
    insert('food.menus', menu, { kind: 'carta', name: 'Carta de avisos' }),
    insert('food.carta_lines', l1, { menu_id: menu, recipe_id: recipe, scope: 'clasico', code: 'A', sale_price_cents: 200, expected_units: 20 }),
  ]);
  const why = async (key: string) => (await q(`select convertible, missing, yield_missing, note from food.carta_prep_totals_projection where menu_id = $1 and component_key = $2`, [menu, key]))[0];
  // Cuenta piezas de pepino sin rendimiento y sin conversión: lo que falta es el rendimiento (se pone en la Previsión).
  let p = await why(PEPINO);
  assert.deepEqual([p.convertible, p.missing, p.yield_missing], [false, 'rendimiento', true]);
  assert.match(p.note, /Falta el rendimiento de Pepino: en Food, Previsión de la carta/);
  assert.equal(prepMissingLabel(p), 'falta el rendimiento');
  const s = await why(suelto);
  assert.deepEqual([s.convertible, s.missing], [false, 'articulo']);
  assert.match(s.note, /Sal suelta no tiene artículo del inventario/);
  // Con rendimiento (1 pepino = 10 rodajas) falta aún pasar la pieza a kg: ahora es la conversión.
  const rev = Number((await q(`select revision from food.ingredients where id = $1`, [pepino]))[0].revision);
  await ok('commands', [{ op: 'update', table: 'food.ingredients', id: pepino, expectedRevision: rev, fields: { purchase_unit: 'unidad', prep_unit: 'rodaja', yield: 10 } }]);
  p = await why(PEPINO);
  assert.deepEqual([p.convertible, p.missing, p.yield_missing], [false, 'conversion', false]);
  assert.match(p.note, /Falta la conversión de Pepino: en Food, Despensa/);
  // Por línea, lo mismo; y en el total manda el más grave.
  const rows = await q(`select component_key, missing from food.carta_prep_projection where line_id = $1 order by component_key`, [l1]);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.component_key, r.missing])), { [PEPINO]: 'conversion', [suelto]: 'articulo' });
});

test('dominio · el rendimiento va entero o no va', () => {
  assert.equal(validateOperation({ op: 'update', table: 'food.ingredients', fields: { prep_unit: 'rodaja' } })?.details.field, 'yield');
  assert.equal(validateOperation({ op: 'update', table: 'food.ingredients', fields: { prep_unit: 'rodaja', yield: 0 } })?.details.field, 'yield');
  assert.equal(validateOperation({ op: 'update', table: 'food.ingredients', fields: { prep_unit: 'rodaja', yield: 8, purchase_unit: 'unidad' } }), null);
  assert.equal(validateOperation({ op: 'update', table: 'food.ingredients', fields: { prep_unit: null, yield: null } }), null);
  assert.equal(purchaseFromPrep(24, 8), 3);
  assert.equal(purchaseFromPrep(24, null), null);
});
