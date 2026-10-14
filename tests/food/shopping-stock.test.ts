/** Food · R5b: la lista de la compra con el stock de Recursos, contra PGlite (docs/food/API.md §2.3 y §3.2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { HOUSE_MENU_ID, defaultPurchase } from '../../supabase/functions/_domain/food/mod.ts';
import { day } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure: `food.${procedure}`, args });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;

async function ok(path: 'commands' | 'resources/commands', operations: unknown[]) {
  const res = await app.call(`/api/v1/${path}`, { body: { requestId: `ss-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function lines(listId: string) {
  const snap = await app.call('/api/v1/snapshot?tables=food.shopping_list_items');
  const names = new Map([[rice, 'Arroz'], [oil, 'Aceite'], [salt, 'Sal']]);
  return Object.fromEntries((snap.data.tables[0].rows as Array<Record<string, any>>).filter((l) => l.shopping_list_id === listId)
    .map((l) => [names.get(l.ingredient_id), { required: Number(l.required_quantity), unit: l.unit, stock: l.stock_quantity === null ? null : Number(l.stock_quantity),
      min: l.min_quantity === null || l.min_quantity === undefined ? null : Number(l.min_quantity), purchase: Number(l.purchase_quantity), restock: l.restock }]));
}

const rice = uuid(), oil = uuid(), salt = uuid(), riceItem = uuid(), oilItem = uuid(), saltItem = uuid();
let kitchen: string, pantry: string, workshop: string;
const week = { period_start: day(0), period_end: day(6) };
const nextWeek = { period_start: day(7), period_end: day(13) };

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  // Espacios: la cocina y su despensa cuentan; el taller no.
  const altura = (await q(`select id from resources.spaces where kind = 'altura' and name = 'Altura 1' and deleted_at is null`))[0].id;
  const house = uuid(); kitchen = uuid(); pantry = uuid(); workshop = uuid();
  await ok('resources/commands', [
    insert('resources.spaces', house, { kind: 'edificio', name: 'Casa', parent_id: altura }),
    insert('resources.spaces', kitchen, { kind: 'cocina', name: 'Cocina', parent_id: house }),
    insert('resources.spaces', pantry, { kind: 'almacen', name: 'Despensa', parent_id: house }),
    insert('resources.spaces', workshop, { kind: 'almacen', name: 'Taller', parent_id: house }),
    insert('resources.items', riceItem, { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg', min_quantity: 1 }),
    insert('resources.items', oilItem, { name: 'Aceite', kind: 'ingrediente', base_unit: 'l' }),
    insert('resources.items', saltItem, { name: 'Sal', kind: 'ingrediente', base_unit: 'g', min_quantity: 500 }),
  ]);
  const recipe = uuid(), lunch = uuid();
  await ok('commands', [
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg', item_id: riceItem }),
    insert('food.ingredients', oil, { name: 'Aceite', preferred_unit: 'l', item_id: oilItem }),
    insert('food.ingredients', salt, { name: 'Sal', preferred_unit: 'g', item_id: saltItem }),
    insert('food.recipes', recipe, { name: 'Arroz con aceite', category: 'principal', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: oil, quantity: 100, unit: 'ml' }),
    insert('food.menus', HOUSE_MENU_ID, { kind: 'casa', house_servings: 22 }),
    insert('food.menu_services', lunch, { menu_id: HOUSE_MENU_ID, service_date: day(1), service_type: 'comida', service_time: '14:00', position: 1 }),
    insert('food.menu_items', uuid(), { service_id: lunch, recipe_id: recipe, servings: 22 }),
  ]);
  // Arroz: 3 kg en la despensa, 5 kg en el taller (no cuenta) y 1 kg en la cocina de un lote ya caducado (no cuenta).
  // Sal: 100 g en la cocina, por debajo de su mínimo de 500 g, y ningún menú la pide.
  const expired = uuid();
  await ok('resources/commands', [
    insert('resources.lots', expired, { item_id: riceItem, code: 'L1', expires_on: day(-1) }),
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: pantry, quantity: 3, kind: 'entrada_manual' }),
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: workshop, quantity: 5, kind: 'entrada_manual' }),
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: kitchen, lot_id: expired, quantity: 1, kind: 'entrada_manual' }),
    insert('resources.movements', uuid(), { item_id: saltItem, space_id: kitchen, quantity: 100, kind: 'entrada_manual' }),
  ]);
});
test.after(async () => { await app.close(); });

test('compra con stock · «en casa» del inventario de cocina, mínimo sumado y «Reponer» aparte', async () => {
  const list = uuid();
  await ok('commands', [call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: list, ...week })]);
  assert.deepEqual(await lines(list), {
    // 1 kg × 22 / 10 = 2,2 kg; en casa 3 kg (despensa); mínimo 1 kg → 2,2 + 1 − 3 = 0,2 kg.
    Arroz: { required: 2.2, unit: 'kg', stock: 3, min: 1, purchase: 0.2, restock: false },
    // Sin movimientos: «en casa» vacío, como antes de R5.
    Aceite: { required: 0.22, unit: 'l', stock: null, min: null, purchase: 0.22, restock: false },
    // Bajo mínimo y sin menú que la pida: 500 − 100 = 400 g.
    Sal: { required: 0, unit: 'g', stock: 100, min: 500, purchase: 400, restock: true },
  });
  assert.equal(defaultPurchase(2.2, 3, 1), 0.2, 'el dominio calcula lo mismo');

  // Otra lista abierta (la semana que viene) no repite «Reponer» de la sal.
  const other = uuid();
  await ok('commands', [call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: other, ...nextWeek })]);
  assert.deepEqual(await lines(other), {});
});

test('compra con stock · regenerar trae el inventario nuevo, respeta «comprar» fijado y quita «Reponer» si ya no hace falta', async () => {
  const list = (await q(`select id from food.shopping_lists where period_start = $1`, [day(0)]))[0].id;
  const riceLine = (await q(`select id, revision from food.shopping_list_items where shopping_list_id = $1 and ingredient_id = $2`, [list, rice]))[0];
  await ok('commands', [{ op: 'update', table: 'food.shopping_list_items', id: riceLine.id, expectedRevision: Number(riceLine.revision), fields: { purchase_quantity: 5, manual_override: true } }]);
  await ok('resources/commands', [
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: kitchen, quantity: 1, kind: 'entrada_manual' }),
    insert('resources.movements', uuid(), { item_id: saltItem, space_id: kitchen, quantity: 600, kind: 'entrada_manual' }),
  ]);
  await ok('commands', [call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: uuid(), ...week })]);
  const out = await lines(list);
  assert.deepEqual(out.Arroz, { required: 2.2, unit: 'kg', stock: 4, min: 1, purchase: 5, restock: false });
  assert.equal(out.Sal, undefined, 'con 700 g ya no está bajo mínimo');
});
