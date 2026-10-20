/**
 * Food · tanda 40 (MUELA-093): la Compra con el envase. Contra PGlite, `food.regenerate_shopping` de 1108 (no toca lo
 * comprado y redondea al envase habitual); y el dominio de envases (guardar sin cambiar el factor de otra fila, precios).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  HOUSE_MENU_ID, defaultPurchase, linePacks, linePerUnit, packUnitLabel, purchaseMovement, roundToPack, savePackOperations, usualPackSize, type FoodPurchase, type PackUnitRow,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure: `food.${procedure}`, args });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;

async function ok(path: 'commands' | 'resources/commands', operations: unknown[]) {
  const res = await app.call(`/api/v1/${path}`, { body: { requestId: `ce-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const line = async (listId: string, ingredient: string) => (await q(
  `select id, revision, status, required_quantity::float8 as required, stock_quantity::float8 as stock, purchase_quantity::float8 as purchase, unit
     from food.shopping_list_items where shopping_list_id = $1 and ingredient_id = $2 and deleted_at is null`, [listId, ingredient]))[0];

const rice = uuid(), oil = uuid(), riceItem = uuid(), oilItem = uuid(), recipe = uuid(), lunch = uuid(), dish = uuid();
let pantry: string;
const week = { period_start: day(0), period_end: day(6) };

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  const altura = (await q(`select id from resources.spaces where kind = 'altura' and name = 'Altura 1' and deleted_at is null`))[0].id;
  const house = uuid(); pantry = uuid();
  await ok('resources/commands', [
    insert('resources.spaces', house, { kind: 'edificio', name: 'Casa', parent_id: altura }),
    insert('resources.spaces', pantry, { kind: 'almacen', name: 'Despensa', parent_id: house }),
    insert('resources.items', riceItem, { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg' }),
    insert('resources.items', oilItem, { name: 'Aceite', kind: 'ingrediente', base_unit: 'l' }),
    // El aceite se vende en garrafas de 5 l (habitual) y en botellas de 1 l.
    insert('resources.item_units', uuid(), { item_id: oilItem, unit: 'garrafa de 5 l', factor: 5, usual: true, price: 21.5 }),
    insert('resources.item_units', uuid(), { item_id: oilItem, unit: 'botella de 1 l', factor: 1 }),
  ]);
  await ok('commands', [
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg', item_id: riceItem }),
    insert('food.ingredients', oil, { name: 'Aceite', preferred_unit: 'l', item_id: oilItem }),
    insert('food.recipes', recipe, { name: 'Arroz con aceite', category: 'principal', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: oil, quantity: 100, unit: 'ml' }),
    insert('food.menus', HOUSE_MENU_ID, { kind: 'casa', house_servings: 22 }),
    insert('food.menu_services', lunch, { menu_id: HOUSE_MENU_ID, service_date: day(1), service_type: 'comida', service_time: '14:00', position: 1 }),
    insert('food.menu_items', dish, { service_id: lunch, recipe_id: recipe, servings: 22 }),
  ]);
});
test.after(async () => { await app.close(); });

test('S5 y H-C5 · envases enteros del habitual; regenerar no toca «En casa» ni «Comprar» de lo comprado', async () => {
  const list = uuid();
  await ok('commands', [call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: list, ...week })]);
  // S5. Aceite: 100 ml × 22 / 10 = 0,22 l → una garrafa de 5 l. Arroz, sin envase: lo justo, 2,2 kg.
  const oilLine = await line(list, oil);
  assert.deepEqual([oilLine.status, oilLine.required, oilLine.purchase, oilLine.unit], ['pendiente', 0.22, 5, 'l']);
  const bought = await line(list, rice);
  await ok('commands', [{ op: 'update', table: 'food.shopping_list_items', id: bought.id, expectedRevision: bought.revision, fields: { status: 'comprado' } }]);
  // Lo comprado entra en la Despensa (como hace la app) y el arroz pasa a tener envase habitual de 1 kg.
  await ok('resources/commands', [
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: pantry, quantity: 2.2, kind: 'entrada_manual', source_app: 'food', source_ref: `shopping_item:${bought.id}` }),
    insert('resources.item_units', uuid(), { item_id: riceItem, unit: 'paquete de 1 kg', factor: 1, usual: true }),
  ]);
  // Más raciones: el arroz comprado conserva lo que se compró; el aceite pendiente se recalcula.
  const servings = (await q(`select revision from food.menu_items where id = $1`, [dish]))[0].revision;
  await ok('commands', [{ op: 'update', table: 'food.menu_items', id: dish, expectedRevision: servings, fields: { servings: 30 } }]);
  await ok('commands', [call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: uuid(), ...week })]);
  const after = await line(list, rice);
  assert.equal(after.status, 'comprado');
  assert.equal(after.required, 3);
  assert.equal(after.stock, null, '«En casa» no se rellena con lo recién comprado');
  assert.equal(after.purchase, 2.2, '«Comprar» de lo comprado no cambia');
  assert.equal((await line(list, oil)).purchase, 5, 'aceite: 0,3 l → una garrafa de 5 l');

  // Ya no hace falta (sin el plato): lo comprado se queda con su compra y su necesidad pasa a 0.
  const dishRev = (await q(`select revision from food.menu_items where id = $1`, [dish]))[0].revision;
  await ok('commands', [{ op: 'delete', table: 'food.menu_items', id: dish, expectedRevision: dishRev }]);
  await ok('commands', [call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: uuid(), ...week })]);
  const gone = await line(list, rice);
  assert.equal(gone.required, 0);
  assert.equal(gone.purchase, 2.2);
  assert.equal(await line(list, oil), undefined, 'el aceite pendiente y sin tocar se retira');
});

test('dominio · redondeo, envases de la línea y «Recalcular» con el habitual', () => {
  assert.equal(roundToPack(1.1, 0.2), 1.2);
  assert.equal(roundToPack(1.2, 0.2), 1.2);
  assert.equal(roundToPack(0, 0.2), 0);
  assert.equal(roundToPack(1.1, null), 1.1);
  assert.equal(defaultPurchase(2.2, 0.5, null, 1), 2);
  const rows: PackUnitRow[] = [
    { id: 'a', item_id: 'i', unit: 'bolsa de 200 g', factor: 200, usual: true, price: '3.40' },
    { id: 'b', item_id: 'i', unit: 'cucharada', factor: 15 },
    { id: 'c', item_id: 'i', unit: 'viejo', factor: 50, deleted_at: '2026-01-01' },
  ];
  assert.equal(usualPackSize('i', 'g', 'kg', rows), 0.2);
  assert.equal(usualPackSize('i', 'g', 'unidad', rows), null, 'otra familia: no redondea');
  assert.deepEqual(linePacks('i', 'g', 'g', rows).map((p) => [p.label, p.size, p.price, p.usual]), [['bolsa de 200 g', 200, 3.4, true], ['cucharada', 15, null, false]]);
  assert.equal(packUnitLabel('bandeja de 30 unidades'), 'bandeja de 30 uds');
});

test('dominio · guardar el envase: fila nueva y habitual, sin cambiar el factor de otra', () => {
  const rows: PackUnitRow[] = [
    { id: 'old', item_id: 'i', unit: 'paquete', factor: 500, usual: true, revision: 3 },
    { id: 'sup', item_id: 'i', unit: 'caja', factor: 6000, supplier_id: 's', revision: 1 },
  ];
  const saved = savePackOperations({ itemId: 'i', base: 'g', unit: 'kg', label: 'bolsa de 200 g', size: 0.2, price: 3.4, rows, newId: () => 'new' });
  assert.ok('ops' in saved);
  assert.deepEqual(saved.ops, [
    { op: 'insert', table: 'resources.item_units', id: 'new', fields: { item_id: 'i', unit: 'bolsa de 200 g', factor: 200, usual: true, price: 3.4 } },
    { op: 'update', table: 'resources.item_units', id: 'old', expectedRevision: 3, fields: { usual: false } },
  ]);
  assert.ok(saved.ops.every((o) => !('factor' in o.fields) || o.op === 'insert'), 'ninguna fila existente cambia de factor');
  // El mismo envase que ya existe: se marca, no se duplica.
  const same = savePackOperations({ itemId: 'i', base: 'g', unit: 'g', label: 'paquete', size: 500, price: null, rows: [{ ...rows[0]!, usual: false }] });
  assert.deepEqual('ops' in same && same.ops, [{ op: 'update', table: 'resources.item_units', id: 'old', expectedRevision: 3, fields: { usual: true } }]);
  // Mismo nombre y otro tamaño: no se toca.
  assert.ok('error' in savePackOperations({ itemId: 'i', base: 'g', unit: 'g', label: 'paquete', size: 1000, price: null, rows }));
});

test('dominio · precio por unidad: última compra, si no el coste medio, y si no ninguno', () => {
  const purchases: FoodPurchase[] = [
    { allocation_id: 'x', target_kind: 'ingredient', target_id: 'g1', invoice_date: '2026-09-01', supplier_name: 'Mercadona', line_description: 'Arroz', allocated_quantity: 5, unit: 'kg', allocated_amount: 6 },
    { allocation_id: 'y', target_kind: 'ingredient', target_id: 'g1', invoice_date: '2026-10-03', supplier_name: 'Makro', line_description: 'Arroz', allocated_quantity: 2, unit: 'kg', allocated_amount: 3 },
  ];
  assert.equal(linePerUnit({ ingredientId: 'g1', unit: 'kg', purchases }), 1.5);
  assert.equal(linePerUnit({ ingredientId: 'g2', unit: 'kg', itemId: 'i', base: 'g', purchases, average: 0.002 }), 2);
  assert.equal(linePerUnit({ ingredientId: 'g2', unit: 'kg', purchases }), null);
});

test('dominio · H-C5: cambiar lo comprado deja la Despensa con la diferencia, con la misma referencia', () => {
  const first = purchaseMovement({ itemId: 'i', lineId: 'l', bought: true, quantityBase: 2, spaceId: 's', supplier: null, movements: [] });
  assert.equal(first?.quantity, 2);
  const movements = [{ item_id: 'i', space_id: 's', lot_id: null, quantity: 2, source_ref: 'shopping_item:l', deleted_at: null }];
  assert.equal(purchaseMovement({ itemId: 'i', lineId: 'l', bought: true, quantityBase: 3, spaceId: 's', supplier: null, movements })?.quantity, 1);
  assert.equal(purchaseMovement({ itemId: 'i', lineId: 'l', bought: true, quantityBase: 1.5, spaceId: 's', supplier: null, movements })?.quantity, -0.5);
});
