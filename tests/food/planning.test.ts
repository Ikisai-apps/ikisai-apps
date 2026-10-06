/** Food · lista de compra y preparación contra PGlite, con paridad entre el procedimiento SQL y el dominio TypeScript. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  computeShopping, defaultPurchase, eventSnapshot, isStale, preparationSources, scaledIngredients, shoppingSources, sourceChanges,
  type FoodEvent, type Menu, type MenuGraph,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { body: { requestId: `plan-${++counter}`, operations }, ...(token ? { token } : {}) });
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const remove = (table: string, id: string, expectedRevision: number) => ({ op: 'delete', table, id, expectedRevision });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure: `food.${procedure}`, args });

async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rejected(operations: unknown[], code: string) {
  const res = await commit(operations);
  assert.equal(res.status, 422, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}
async function rows(table: string) {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows as Array<Record<string, any>>;
}
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id)!;
async function graph(): Promise<MenuGraph & { menu: Menu }> {
  const res = await app.call('/api/v1/read/food.menu_graph', { body: { menu_id: menu } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
/** Líneas vivas de la lista, indexadas por ingrediente. */
async function shopping() {
  const items = (await rows('food.shopping_list_items')).filter((i) => i.shopping_list_id === list);
  return new Map(items.map((i) => [i.ingredient_id as string, i]));
}

const menu = uuid(); const list = uuid();
const dinner = uuid(); const lunch = uuid();
const curry = uuid(); const rice = uuid(); const salad = uuid();
const tomato = uuid(); const riceGrain = uuid(); const oil = uuid(); const lettuce = uuid(); const coconut = uuid(); const napkins = uuid();
const curryItem = uuid(); const riceItem = uuid(); const saladItem = uuid();

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  const eventId = await seedBookingEvent(app, { title: 'Retiro Test', start: day(10), end: day(12) });
  const event = (await app.call(`/api/v1/events/${eventId}`)).data.event as FoodEvent;
  await ok([
    insert('food.ingredients', tomato, { name: 'Tomate', preferred_unit: 'kg', preferred_supplier: 'Frutería' }),
    insert('food.ingredients', riceGrain, { name: 'Arroz', preferred_unit: 'kg' }),
    insert('food.ingredients', oil, { name: 'Aceite', preferred_unit: 'unidad' }), // unidad preferida ajena al volumen
    insert('food.ingredients', lettuce, { name: 'Lechuga', preferred_unit: 'unidad' }),
    insert('food.ingredients', coconut, { name: 'Leche de coco', preferred_unit: 'ml' }),
    insert('food.ingredients', napkins, { name: 'Servilletas', preferred_unit: 'paquete' }),
    insert('food.recipes', curry, { name: 'Curry de verduras', category: 'principal', base_servings: 20, prep_minutes: 90 }),
    insert('food.recipes', rice, { name: 'Arroz especiado', category: 'guarnicion', base_servings: 10 }),
    insert('food.recipes', salad, { name: 'Ensalada', category: 'entrante', base_servings: 4 }),
    // Curry (20 raciones): 800 g + 1,5 kg de tomate en dos líneas, 400 ml de coco, 0,2 l de aceite.
    insert('food.recipe_ingredients', uuid(), { recipe_id: curry, ingredient_id: tomato, quantity: 800, unit: 'g', position: 1 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: curry, ingredient_id: tomato, quantity: 1.5, unit: 'kg', position: 2 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: curry, ingredient_id: coconut, quantity: 400, unit: 'ml', position: 3 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: curry, ingredient_id: oil, quantity: 0.2, unit: 'l', position: 4 }),
    // Arroz (10 raciones): 1 kg de arroz y 50 ml de aceite.
    insert('food.recipe_ingredients', uuid(), { recipe_id: rice, ingredient_id: riceGrain, quantity: 1, unit: 'kg' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: rice, ingredient_id: oil, quantity: 50, unit: 'ml' }),
    // Ensalada (4 raciones): 1 lechuga y 2 tomates contados por unidades.
    insert('food.recipe_ingredients', uuid(), { recipe_id: salad, ingredient_id: lettuce, quantity: 1, unit: 'unidad' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: salad, ingredient_id: tomato, quantity: 2, unit: 'unidad' }),
  ]);
  await ok([
    insert('food.menus', menu, { event_id: eventId, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) }),
    insert('food.menu_services', dinner, { menu_id: menu, service_date: day(10), service_type: 'cena', service_time: '20:30', position: 1 }),
    insert('food.menu_services', lunch, { menu_id: menu, service_date: day(11), service_type: 'comida', position: 2 }),
    insert('food.menu_items', curryItem, { service_id: dinner, recipe_id: curry, servings: 20, position: 1 }),
    insert('food.menu_items', riceItem, { service_id: dinner, recipe_id: rice, servings: 22, position: 2 }),
    insert('food.menu_items', saladItem, { service_id: lunch, recipe_id: salad, servings: 22, position: 1 }),
  ]);
});
test.after(async () => { await app.close(); });

test('compra · generar: cantidades, agrupación y unidades; el cálculo SQL coincide con el del dominio', async () => {
  const done = await ok([call('regenerate_shopping', { menu_id: menu, list_id: list })]);
  assert.deepEqual(done.results[0].result, { list_id: list, created: true, inserted: 6, updated: 0, deleted: 0, kept: 0, status: 'borrador' });
  const items = await shopping();
  const tomatoLines = (await rows('food.shopping_list_items')).filter((i) => i.ingredient_id === tomato);
  // 800 g + 1,5 kg = 2,3 kg para 20 raciones; las unidades de tomate no se mezclan con la masa.
  assert.deepEqual(tomatoLines.map((i) => `${Number(i.required_quantity)} ${i.unit}`).sort(), ['11 unidad', '2.3 kg']);
  assert.equal(tomatoLines.find((i) => i.unit === 'kg')!.supplier, 'Frutería');
  assert.equal(`${Number(items.get(riceGrain)!.required_quantity)} ${items.get(riceGrain)!.unit}`, '2.2 kg');
  // Aceite: 200 ml + 110 ml = 310 ml; su unidad preferida no es de volumen, así que ml por debajo del litro.
  assert.equal(`${Number(items.get(oil)!.required_quantity)} ${items.get(oil)!.unit}`, '310 ml');
  assert.equal(`${Number(items.get(coconut)!.required_quantity)} ${items.get(coconut)!.unit}`, '400 ml');
  assert.equal(`${Number(items.get(lettuce)!.required_quantity)} ${items.get(lettuce)!.unit}`, '5.5 unidad');
  for (const item of items.values()) {
    assert.equal(Number(item.purchase_quantity), Number(item.required_quantity));
    assert.equal(item.status, 'pendiente'); assert.equal(item.manual, false);
  }

  // Paridad: la función del dominio da exactamente las mismas líneas.
  const g = await graph();
  const expected = computeShopping(g).map((r) => `${r.ingredient_id} ${r.required_quantity} ${r.unit}`).sort();
  const actual = (await rows('food.shopping_list_items')).map((i) => `${i.ingredient_id} ${Number(i.required_quantity)} ${i.unit}`).sort();
  assert.deepEqual(actual, expected);
  assert.deepEqual(scaledIngredients(g, riceItem).map((l) => `${l.quantity} ${l.unit}`).sort(), ['110 ml', '2.2 kg']);

  // Y el conjunto de revisiones guardado es el que el cliente calcula sobre su espejo: la lista está al día.
  const saved = await row('food.shopping_lists', list);
  assert.deepEqual(saved.source_revisions, shoppingSources(g));
  assert.equal(isStale(saved.source_revisions, shoppingSources(g)), false);
});

test('compra · a mano: «en casa», «comprar», estado y líneas manuales; las calculadas no se insertan ni se recalculan a mano', async () => {
  const items = await shopping();
  const riceLine = items.get(riceGrain)!; const coconutLine = items.get(coconut)!; const oilLine = items.get(oil)!;
  assert.equal(defaultPurchase(2.2, 0.5), 1.7);
  await ok([
    update('food.shopping_list_items', riceLine.id, riceLine.revision, { stock_quantity: 0.5, purchase_quantity: 1.7 }),
    update('food.shopping_list_items', coconutLine.id, coconutLine.revision, { purchase_quantity: 1000, manual_override: true, supplier: 'Makro' }),
    update('food.shopping_list_items', oilLine.id, oilLine.revision, { status: 'comprado' }),
    insert('food.shopping_list_items', uuid(), { shopping_list_id: list, ingredient_id: napkins, unit: 'paquete', purchase_quantity: 3, manual: true }),
  ]);
  assert.equal((await rejected([insert('food.shopping_list_items', uuid(), { shopping_list_id: list, ingredient_id: napkins, unit: 'paquete', purchase_quantity: 1, manual: false })], 'INVALID_FIELDS')).details.field, 'manual');
  assert.equal((await rejected([update('food.shopping_list_items', riceLine.id, riceLine.revision + 1, { required_quantity: 9 })], 'INVALID_FIELDS')).details.field, 'required_quantity');
  assert.equal((await rejected([insert('food.shopping_lists', uuid(), { menu_id: menu })], 'INVALID_FIELDS')).details.field, 'menu_id');
  const saved = await row('food.shopping_lists', list);
  await ok([update('food.shopping_lists', list, saved.revision, { status: 'revisada' })]);
});

test('compra · el menú cambia: la lista queda desactualizada y regenerar conserva lo tocado a mano', async () => {
  const before = await row('food.shopping_lists', list);
  const item = await row('food.menu_items', riceItem);
  const salads = await row('food.menu_items', saladItem);
  // 22 → 25 raciones de arroz y fuera la ensalada.
  await ok([update('food.menu_items', riceItem, item.revision, { servings: 25 }), remove('food.menu_items', saladItem, salads.revision)]);
  const g = await graph();
  const diff = sourceChanges(before.source_revisions, shoppingSources(g));
  assert.deepEqual(diff.changed, [riceItem]);
  assert.ok(diff.removed.includes(saladItem) && diff.removed.includes(salad) && diff.removed.includes(lettuce));
  assert.equal(isStale(before.source_revisions, shoppingSources(g)), true);

  const done = await ok([call('regenerate_shopping', { menu_id: menu, list_id: uuid() })]);
  const result = done.results[0].result;
  assert.equal(result.list_id, list); assert.equal(result.created, false);
  assert.equal(result.status, 'borrador'); // la revisión anterior ya no vale
  const items = await shopping();
  // Arroz: 2,5 kg necesarios; «en casa» 0,5 se respeta y «comprar» se recalcula.
  assert.deepEqual([Number(items.get(riceGrain)!.required_quantity), Number(items.get(riceGrain)!.stock_quantity), Number(items.get(riceGrain)!.purchase_quantity)], [2.5, 0.5, 2]);
  // Coco: «comprar» fijado a mano y proveedor cambiado, intactos.
  assert.deepEqual([Number(items.get(coconut)!.purchase_quantity), items.get(coconut)!.manual_override, items.get(coconut)!.supplier], [1000, true, 'Makro']);
  // Aceite: 200 + 125 = 325 ml y sigue comprado.
  assert.deepEqual([Number(items.get(oil)!.required_quantity), items.get(oil)!.status], [325, 'comprado']);
  // Lechuga y tomate por unidades, pendientes y sin tocar: desaparecen. La línea manual sigue.
  assert.equal(items.has(lettuce), false);
  assert.equal((await rows('food.shopping_list_items')).filter((i) => i.ingredient_id === tomato).length, 1);
  assert.equal(items.get(napkins)!.manual, true);
  const after = await row('food.shopping_lists', list);
  assert.equal(isStale(after.source_revisions, shoppingSources(g)), false);

  // Una receta que cambia también desactualiza la lista, aunque el menú no se toque.
  const recipeRow = await row('food.recipes', rice);
  await ok([update('food.recipes', rice, recipeRow.revision, { base_servings: 12 })]);
  assert.deepEqual(sourceChanges(after.source_revisions, shoppingSources(await graph())).changed, [rice]);
});

test('compra · lo ya comprado no desaparece; una lista cerrada no se regenera ni se edita', async () => {
  const item = await row('food.menu_items', curryItem);
  await ok([remove('food.menu_items', curryItem, item.revision)]);
  await ok([call('regenerate_shopping', { menu_id: menu, list_id: uuid() })]);
  const items = await shopping();
  // El aceite estaba comprado: se conserva. Sin el curry solo quedan los 104,167 ml del arroz (50 ml × 25 ÷ 12).
  assert.deepEqual([Number(items.get(oil)!.required_quantity), items.get(oil)!.status], [104.167, 'comprado']);
  // El coco ya no hace falta, pero alguien fijó su compra a mano: queda con necesidad 0.
  assert.deepEqual([Number(items.get(coconut)!.required_quantity), Number(items.get(coconut)!.purchase_quantity)], [0, 1000]);
  assert.equal((await rows('food.shopping_list_items')).some((i) => i.ingredient_id === tomato), false);

  const saved = await row('food.shopping_lists', list);
  await ok([update('food.shopping_lists', list, saved.revision, { status: 'cerrada' })]);
  await rejected([call('regenerate_shopping', { menu_id: menu, list_id: uuid() })], 'LIST_CLOSED');
  await rejected([update('food.shopping_list_items', items.get(oil)!.id, items.get(oil)!.revision, { status: 'recibido' })], 'LIST_CLOSED');
  await ok([update('food.shopping_lists', list, saved.revision + 1, { status: 'borrador' })]);
  await ok([update('food.shopping_list_items', items.get(oil)!.id, items.get(oil)!.revision, { status: 'recibido' })]);
  await rejected([call('regenerate_shopping', { menu_id: uuid(), list_id: uuid() })], 'MENU_NOT_FOUND');
  assert.equal((await rejected([call('regenerate_shopping', { menu_id: menu })], 'INVALID_OPERATION')).details.argument, 'list_id');
});

test('preparación · propuesta por plato; regenerar respeta lo manual y lo hecho', async () => {
  // Menú de partida para esta prueba: arroz en la cena (20:30) y ensalada de nuevo en la comida, sin hora.
  const newSalad = uuid(); const newCurry = uuid();
  await ok([
    insert('food.menu_items', newSalad, { service_id: lunch, recipe_id: salad, servings: 22 }),
    insert('food.menu_items', newCurry, { service_id: dinner, recipe_id: curry, servings: 20 }),
  ]);
  const first = await ok([call('regenerate_preparation', { menu_id: menu })]);
  assert.deepEqual(first.results[0].result, { inserted: 3, updated: 0, deleted: 0, kept: 0 });
  const prep = async () => (await rows('food.preparation_items')).filter((p) => p.menu_id === menu);
  let items = await prep();
  const byItem = (id: string) => items.find((p) => p.menu_item_id === id)!;
  // Curry: 20:30 menos 90 minutos. Arroz: sin antelación propia, 120 minutos. Ensalada: el servicio no tiene hora.
  assert.deepEqual([byItem(newCurry).text, byItem(newCurry).scheduled_date, byItem(newCurry).scheduled_time], ['Preparar Curry de verduras', day(10), '19:00:00']);
  assert.equal(byItem(riceItem).scheduled_time, '18:30:00');
  assert.deepEqual([byItem(newSalad).scheduled_date, byItem(newSalad).scheduled_time], [day(11), null]);
  let g = await graph();
  assert.deepEqual(g.menu.preparation_source_revisions, preparationSources(g));
  assert.ok(g.menu.preparation_generated_at);

  // El cocinero reescribe un paso (pasa a manual), marca otro como hecho y añade uno suyo.
  const own = uuid();
  await ok([
    update('food.preparation_items', byItem(newCurry).id, 1, { text: 'Sofrito del curry la víspera', scheduled_time: '17:00', manual: true }),
    update('food.preparation_items', byItem(riceItem).id, 1, { done: true, responsible: 'Marga' }),
    insert('food.preparation_items', own, { menu_id: menu, text: 'Sacar el pan del congelador', scheduled_date: day(10), scheduled_time: '08:00', manual: true }),
  ]);
  // Cambia la hora de la cena, la comida pasa a tener hora y la ensalada sale del menú.
  const dinnerRow = await row('food.menu_services', dinner); const lunchRow = await row('food.menu_services', lunch);
  await ok([update('food.menu_services', dinner, dinnerRow.revision, { service_time: '21:00' }), update('food.menu_services', lunch, lunchRow.revision, { service_time: '14:00' })]);
  g = await graph();
  assert.equal(isStale(g.menu.preparation_source_revisions, preparationSources(g)), true);
  const again = await ok([call('regenerate_preparation', { menu_id: menu })]);
  assert.deepEqual(again.results[0].result, { inserted: 0, updated: 1, deleted: 0, kept: 2 });
  items = await prep();
  assert.equal(byItem(newCurry).text, 'Sofrito del curry la víspera'); // manual: intacto
  assert.equal(byItem(riceItem).scheduled_time, '18:30:00'); // hecho: intacto
  assert.equal(byItem(newSalad).scheduled_time, '12:00:00'); // propuesta: se mueve con el servicio

  const saladRow = await row('food.menu_items', newSalad);
  await ok([remove('food.menu_items', newSalad, saladRow.revision)]);
  const last = await ok([call('regenerate_preparation', { menu_id: menu })]);
  assert.deepEqual(last.results[0].result, { inserted: 0, updated: 0, deleted: 1, kept: 2 });
  items = await prep();
  assert.deepEqual(items.map((p) => p.text).sort(), ['Preparar Arroz especiado', 'Sacar el pan del congelador', 'Sofrito del curry la víspera']);
  g = await graph();
  assert.equal(isStale(g.menu.preparation_source_revisions, preparationSources(g)), false);
  assert.equal((await commit([call('regenerate_preparation', { menu_id: menu })], app.tokens.reader)).status, 403);
});

test('preparación · en un día ordenado a mano los pasos nuevos van al final; en uno sin ordenar, por su hora', async () => {
  const steps = async () => (await rows('food.preparation_items')).filter((p) => p.menu_id === menu);
  // El cocinero ordena a mano los pasos del primer día: 1, 2, 3.
  const first = (await steps()).filter((p) => p.scheduled_date === day(10)).sort((a, b) => String(a.text).localeCompare(String(b.text)));
  assert.equal(first.length, 3);
  await ok(first.map((p, index) => update('food.preparation_items', p.id, p.revision, { position: index + 1 })));
  // Entra un plato en la cena (día ordenado) y otro en la comida del día siguiente (sin pasos ni orden).
  const dinnerSalad = uuid(); const lunchRice = uuid();
  await ok([
    insert('food.menu_items', dinnerSalad, { service_id: dinner, recipe_id: salad, servings: 10 }),
    insert('food.menu_items', lunchRice, { service_id: lunch, recipe_id: rice, servings: 10 }),
  ]);
  const done = await ok([call('regenerate_preparation', { menu_id: menu })]);
  assert.equal(done.results[0].result.inserted, 2);
  const after = await steps();
  assert.equal(Number(after.find((p) => p.menu_item_id === dinnerSalad)!.position), 4);
  assert.equal(Number(after.find((p) => p.menu_item_id === lunchRice)!.position), 0);
  // Lo ordenado a mano no se ha movido.
  assert.deepEqual(first.map((p) => Number(after.find((x) => x.id === p.id)!.position)), [1, 2, 3]);
});

