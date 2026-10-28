/** Food · R5c: consumo al acabar el servicio, contra PGlite (docs/food/API.md §2.8). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  CONSUMPTION_SINCE, HOUSE_MENU_ID, consumeCall, eventSnapshot, type FoodEvent, consumptionDue, consumptionLines, kitchenSpaceIds, menuItemRef, serviceConsumption,
  type MenuGraph, type ResourceItem,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;

async function commit(path: 'commands' | 'resources/commands' | 'stock/commands', operations: unknown[]) {
  return app.call(`/api/v1/${path}`, { body: { requestId: `co-${++counter}`, operations } });
}
async function ok(path: 'commands' | 'resources/commands' | 'stock/commands', operations: unknown[]) {
  const res = await commit(path, operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rows(path: string, table: string) {
  const snap = await app.call(`/api/v1/${path}snapshot?tables=${table}`);
  return snap.data.tables[0].rows as Array<Record<string, any>>;
}

const rice = uuid(), oil = uuid(), riceItem = uuid(), oilItem = uuid(), recipe = uuid(), lunch = uuid(), dish = uuid(), old = uuid(), oldDish = uuid();
let pantry: string, kitchen: string;
const date = day(1) >= CONSUMPTION_SINCE ? day(1) : CONSUMPTION_SINCE;

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  const altura = (await q(`select id from resources.spaces where kind = 'altura' and name = 'Altura 1' and deleted_at is null`))[0].id;
  const house = uuid(); kitchen = uuid(); pantry = uuid();
  const soon = uuid(), later = uuid();
  await ok('resources/commands', [
    insert('resources.spaces', house, { kind: 'edificio', name: 'Casa', parent_id: altura }),
    insert('resources.spaces', kitchen, { kind: 'cocina', name: 'Cocina', parent_id: house }),
    insert('resources.spaces', pantry, { kind: 'almacen', name: 'Despensa', parent_id: house }),
    insert('resources.items', riceItem, { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg' }),
    insert('resources.items', oilItem, { name: 'Aceite', kind: 'ingrediente', base_unit: 'paquete' }),
    insert('resources.lots', soon, { item_id: riceItem, code: 'A', expires_on: day(5) }),
    insert('resources.lots', later, { item_id: riceItem, code: 'B', expires_on: day(30) }),
    // 1 kg que caduca antes, en la cocina, y 5 kg que caducan después, en la despensa.
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: kitchen, lot_id: soon, quantity: 1, kind: 'entrada_manual' }),
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: pantry, lot_id: later, quantity: 5, kind: 'entrada_manual' }),
  ]);
  await ok('commands', [
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg', item_id: riceItem }),
    insert('food.ingredients', oil, { name: 'Aceite', preferred_unit: 'ml', item_id: oilItem }),
    insert('food.recipes', recipe, { name: 'Arroz blanco', category: 'guarnicion', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: rice, quantity: 800, unit: 'g' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: oil, quantity: 50, unit: 'ml' }),
    insert('food.menus', HOUSE_MENU_ID, { kind: 'casa', house_servings: 20 }),
    insert('food.menu_services', lunch, { menu_id: HOUSE_MENU_ID, service_date: date, service_type: 'comida', service_time: '14:00', position: 1 }),
    insert('food.menu_items', dish, { service_id: lunch, recipe_id: recipe, servings: 20 }),
    insert('food.menu_services', old, { menu_id: HOUSE_MENU_ID, service_date: '2026-10-01', service_type: 'cena', service_time: '20:30', position: 1 }),
    insert('food.menu_items', oldDish, { service_id: old, recipe_id: recipe, servings: 20 }),
  ]);
});
test.after(async () => { await app.close(); });

test('consumo · por confirmar a las 2 h, solo a las 24 h; lo anterior a R5c no cuenta', () => {
  const service = { id: lunch, service_date: date, service_time: '14:00:00', deleted_at: null };
  const graph = { items: [{ id: dish, service_id: lunch, deleted_at: null }] } as unknown as MenuGraph;
  const due = consumptionDue(service);
  assert.equal(due.getTime() - new Date(`${date}T14:00:00`).getTime(), 2 * 3_600_000);
  assert.equal(consumptionDue({ service_date: date, service_time: null }).getTime(), new Date(`${date}T23:59:00`).getTime());
  const at = (ms: number) => serviceConsumption(service, graph, [], [], new Date(due.getTime() + ms)).state;
  assert.deepEqual([at(-60_000), at(0), at(23 * 3_600_000), at(24 * 3_600_000)], ['antes', 'por_confirmar', 'por_confirmar', 'automatico']);
  assert.equal(serviceConsumption(service, graph, [{ menu_item_id: dish, deleted_at: null }], [], new Date(due.getTime() + 1)).state, 'hecho');
  assert.equal(serviceConsumption(service, graph, [], [{ source_ref: menuItemRef(dish), deleted_at: null }], new Date(due.getTime() + 1)).state, 'hecho', 'con movimientos ya cuenta como hecho');
  assert.equal(serviceConsumption({ ...service, id: old, service_date: '2026-10-01' }, { items: [{ id: oldDish, service_id: old, deleted_at: null }] } as unknown as MenuGraph, [], [], new Date()).state, 'no_aplica');
});

test('consumo · se descuenta en Recursos por lotes (primero lo que caduca antes) y se anota en Food', async () => {
  const [services, items, recipes, lines, ingredients, spaces, resourceItems] = await Promise.all([
    rows('', 'food.menu_services'), rows('', 'food.menu_items'), rows('', 'food.recipes'), rows('', 'food.recipe_ingredients'), rows('', 'food.ingredients'),
    rows('resources/', 'resources.spaces'), rows('resources/', 'resources.items'),
  ]);
  const graph = { services, items, recipes, recipe_ingredients: lines, ingredients } as unknown as MenuGraph;
  const consumption = consumptionLines(graph, dish, resourceItems as unknown as ResourceItem[]);
  // 800 g y 50 ml para 10 → 1,6 kg de arroz y 100 ml de aceite para 20; el aceite va en paquetes: no se descuenta.
  assert.deepEqual(consumption.map((l) => [l.name, l.quantity, l.unit, l.reason]).sort(), [['Aceite', 100, 'ml', 'sin_conversion'], ['Arroz', 1600, 'g', null]]);
  const kitchenIds = [...kitchenSpaceIds(spaces as never)];
  const calls = consumption.map((line) => consumeCall({ line, quantity: line.quantity, menuItemId: dish, spaceIds: kitchenIds, fallbackSpaceId: pantry, note: 'Arroz blanco · comida' })).filter(Boolean);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.quantity, 1.6, 'en la unidad base del artículo (kg)');
  // FO4: con origen Food, por el servidor (food-api `stock/commands`); el cliente ya no manda `source_app`.
  assert.equal('source_app' in calls[0]!.args, false);
  await ok('stock/commands', calls);
  await ok('commands', [insert('food.consumptions', uuid(), { menu_item_id: dish, status: 'confirmado' })]);

  const moved = (await rows('resources/', 'resources.movements')).filter((m) => m.source_ref === menuItemRef(dish));
  assert.deepEqual(moved.map((m) => [m.kind, Number(m.quantity), m.space_id, m.source_app]).sort((a, b) => Number(a[1]) - Number(b[1])),
    [['consumo_servicio', -1, kitchen, 'food'], ['consumo_servicio', -0.6, pantry, 'food']]);
});

test('consumo · un plato, un consumo; el plato tiene que existir; un menú validado puede anotarlo', async () => {
  const dup = await commit('commands', [insert('food.consumptions', uuid(), { menu_item_id: dish, status: 'omitido' })]);
  assert.equal(dup.status, 422, JSON.stringify(dup.data));
  const missing = await commit('commands', [insert('food.consumptions', uuid(), { menu_item_id: uuid(), status: 'omitido' })]);
  assert.equal(missing.status, 422);
  const bad = await commit('commands', [insert('food.consumptions', uuid(), { menu_item_id: oldDish, status: 'hecho' })]);
  assert.equal(bad.data.error.code, 'INVALID_FIELDS');
  // Un retiro validado: sus platos no se tocan (MENU_LOCKED), pero su consumo sí se anota (tabla aparte).
  const eventId = await seedBookingEvent(app, { title: 'Retiro Test', start: day(2), end: day(3) });
  const event = (await app.call(`/api/v1/events/${eventId}`)).data.event as FoodEvent;
  const retreat = uuid(), dinner = uuid(), retreatDish = uuid();
  await ok('commands', [
    insert('food.menus', retreat, { event_id: eventId, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) }),
    insert('food.menu_services', dinner, { menu_id: retreat, service_date: day(2), service_type: 'cena', service_time: '20:30', position: 1 }),
    insert('food.menu_items', retreatDish, { service_id: dinner, recipe_id: recipe, servings: 22 }),
  ]);
  await q(`update food.menus set status = 'validado' where id = $1`, [retreat]);
  const locked = await commit('commands', [{ op: 'update', table: 'food.menu_items', id: retreatDish, expectedRevision: 1, fields: { servings: 23 } }]);
  assert.equal(locked.data.error.code, 'MENU_LOCKED');
  await ok('commands', [insert('food.consumptions', uuid(), { menu_item_id: retreatDish, status: 'confirmado' })]);
});

test('FO4 · stock/commands solo admite lo comprado y el consumo de un plato, y los apunta como de Food', async () => {
  const bad = async (operations: unknown[], reason: string) => {
    const res = await commit('stock/commands', operations);
    assert.equal(res.status, 422, JSON.stringify(res.data));
    assert.equal(res.data.error.details.reason, reason, JSON.stringify(res.data));
  };
  const item = uuid();
  await bad([{ op: 'insert', table: 'resources.items', id: uuid(), fields: { name: 'X' } }], 'op');
  await bad([{ op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: item, quantity: 1, kind: 'entrada_manual', source_ref: 'otra:cosa' } }], 'source_ref');
  await bad([{ op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: item, quantity: 1, kind: 'recuento', source_ref: `shopping_item:${uuid()}` } }], 'kind');
  await bad([{ op: 'call', procedure: 'resources.consume', args: { item_id: item, quantity: 1, kind: 'consumo_servicio', source_ref: `menu_item:${uuid()}`, lot_id: uuid() } }], 'args');
});
