/** Food · O3a: menú de casa y plato rápido con su salvaguarda, contra PGlite (docs/food/API.md §2.6). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  HOUSE_MENU_ID, eventSnapshot, isQuickPending, quickDishOperations, quickRecipeCategory, weekDays, type FoodEvent,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `house-${++counter}`, operations } });
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
async function row(table: string, id: string) {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return (snap.data.tables[0].rows as Array<Record<string, any>>).find((r) => r.id === id)!;
}

let retreatService: string;
const houseLunch = uuid();

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  const eventId = await seedBookingEvent(app, { title: 'Retiro Test', start: day(10), end: day(12) });
  const event = (await app.call(`/api/v1/events/${eventId}`)).data.event as FoodEvent;
  const menu = uuid(); retreatService = uuid();
  await ok([
    insert('food.menus', menu, { event_id: eventId, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) }),
    insert('food.menu_services', retreatService, { menu_id: menu, service_date: day(10), service_type: 'cena', position: 1 }),
  ]);
});
test.after(async () => { await app.close(); });

test('menú de casa · sin evento, uno solo, con personas en casa; no se borra ni cambia de estado', async () => {
  await ok([insert('food.menus', HOUSE_MENU_ID, { kind: 'casa', house_servings: 4 }),
    insert('food.menu_services', houseLunch, { menu_id: HOUSE_MENU_ID, service_date: day(1), service_type: 'comida', position: 1 })]);
  const house = await row('food.menus', HOUSE_MENU_ID);
  assert.deepEqual([house.kind, house.event_id, house.source_event_revision, house.status, Number(house.house_servings)], ['casa', null, null, 'borrador', 4]);
  // Uno solo, sin nada del evento; las personas en casa solo en el de casa.
  assert.equal((await rejected([insert('food.menus', uuid(), { kind: 'casa' })], 'MENU_EXISTS')).details.menuId, HOUSE_MENU_ID);
  assert.equal((await rejected([insert('food.menus', uuid(), { kind: 'casa', event_id: uuid() })], 'INVALID_FIELDS')).details.field, 'event_id');
  assert.equal((await rejected([insert('food.menus', uuid(), { kind: 'casa', source_event_revision: 1 })], 'INVALID_FIELDS')).details.field, 'source_event_revision');
  assert.equal((await rejected([insert('food.menus', uuid(), { kind: 'fiesta' })], 'INVALID_FIELDS')).details.field, 'kind');
  assert.equal((await rejected([update('food.menus', HOUSE_MENU_ID, house.revision, { kind: 'retiro' })], 'IMMUTABLE_FIELD')).details.field, 'kind');
  // Se cambian las personas; no se borra, no se revisa ni se valida.
  await ok([update('food.menus', HOUSE_MENU_ID, house.revision, { house_servings: 6 })]);
  const now = await row('food.menus', HOUSE_MENU_ID);
  assert.equal((await rejected([remove('food.menus', HOUSE_MENU_ID, now.revision)], 'HOUSE_MENU')).details.action, 'delete');
  assert.equal((await rejected([call('set_menu_status', { menu_id: HOUSE_MENU_ID, expectedRevision: now.revision, status: 'revisar' })], 'HOUSE_MENU')).details.action, 'status');
  await rejected([call('validate_menu', { menu_id: HOUSE_MENU_ID, expectedRevision: now.revision, event_revision: 1, event_snapshot: {}, acknowledged: [] })], 'HOUSE_MENU');
});

test('plato rápido · solo el nombre; en casa entra; en un retiro no hasta tener alérgenos revisados y un ingrediente', async () => {
  const recipe = uuid();
  await ok(quickDishOperations({ recipeId: recipe, itemId: uuid(), name: '  Gazpacho ', serviceId: houseLunch, serviceType: 'comida', servings: 6, position: 1 }));
  const saved = await row('food.recipes', recipe);
  assert.deepEqual([saved.name, saved.category, Number(saved.base_servings), saved.quick, saved.status, saved.allergens_checked], ['Gazpacho', 'principal', 6, true, 'en_prueba', false]);
  const into = () => insert('food.menu_items', uuid(), { service_id: retreatService, recipe_id: recipe, servings: 22, position: 1 });
  assert.equal((await rejected([into()], 'QUICK_RECIPE_IN_RETREAT')).details.recipe_id, recipe);
  // Solo los alérgenos no bastan.
  await ok([update('food.recipes', recipe, saved.revision, { allergens_checked: true })]);
  await rejected([into()], 'QUICK_RECIPE_IN_RETREAT');
  // Con un ingrediente ya está completa: entra en el retiro. La marca de origen no cambia nunca.
  const tomato = uuid();
  await ok([insert('food.ingredients', tomato, { name: 'Tomate', preferred_unit: 'kg' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: tomato, quantity: 1, unit: 'kg' })]);
  await ok([into()]);
  const done = await row('food.recipes', recipe);
  assert.equal(done.quick, true);
  assert.equal((await rejected([update('food.recipes', recipe, done.revision, { quick: false })], 'IMMUTABLE_FIELD')).details.field, 'quick');
  // Una receta normal en prueba y sin alérgenos revisados sigue entrando en un retiro, como siempre.
  const normal = uuid();
  await ok([insert('food.recipes', normal, { name: 'Lentejas', category: 'principal', base_servings: 4 }),
    insert('food.menu_items', uuid(), { service_id: retreatService, recipe_id: normal, servings: 22, position: 2 })]);
});

test('indicadores · el menú de casa no cuenta como menú sin validar ni sus listas como abiertas', async () => {
  const kpis = (await app.t.db.query<{ kpi: string; value: string }>(`select kpi, value from food.central_kpi_projection order by kpi`)).rows;
  assert.deepEqual(kpis.map((k) => `${k.kpi}=${Number(k.value)}`), ['food.events_without_menu_30d=0', 'food.menus_unvalidated_30d=1', 'food.shopping_lists_open=0']);
});

test('dominio · por completar, categoría deducida y semanas de lunes a domingo', () => {
  const line = (recipe_id: string, deleted_at: string | null = null) => ({ recipe_id, deleted_at });
  assert.equal(isQuickPending({ id: 'r', quick: false, allergens_checked: false }, []), false);
  assert.equal(isQuickPending({ id: 'r', quick: true, allergens_checked: true }, []), true);
  assert.equal(isQuickPending({ id: 'r', quick: true, allergens_checked: false }, [line('r')]), true);
  assert.equal(isQuickPending({ id: 'r', quick: true, allergens_checked: true }, [line('r', '2026-10-13T00:00:00Z')]), true);
  assert.equal(isQuickPending({ id: 'r', quick: true, allergens_checked: true }, [line('x'), line('r')]), false);
  assert.deepEqual(['desayuno', 'comida', 'cena', 'merienda', 'picnic', 'otro'].map((s) => quickRecipeCategory(s as never)),
    ['desayuno', 'principal', 'principal', 'merienda', 'picnic', 'principal']);
  assert.deepEqual(weekDays('2026-10-15'), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(weekDays('2026-10-18', 1)[0], '2026-10-19'); // domingo: su semana empieza el lunes anterior
  assert.deepEqual(weekDays('2026-10-12', -1)[6], '2026-10-11');
});
