/**
 * Food · caracterización antes de O3 (menú de casa y plato rápido; `coordinacion/ampliacion/RECURSOS.md` §15.3 y §17).
 * Fija lo que hoy hacen menús, recetas y planificación en el servidor, para que O3 lo deje igual en los menús de retiro:
 * estas pruebas tienen que seguir en verde, sin tocarlas, después de O3. Lo que O3 cambia a propósito solo se añade
 * (un tipo de menú nuevo y una receta marcada «rápida»); nada de lo de aquí deja de valer para un menú de retiro.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { eventSnapshot, menuWarnings, requiredAcknowledgements, type FoodEvent, type MenuGraph } from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `car-${++counter}`, operations } });
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
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

let eventId: string;
let event: FoodEvent;

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  eventId = await seedBookingEvent(app, { title: 'Retiro Test', start: day(10), end: day(12), restrictions: [{ type: 'alergia', subject: 'Pistacho', severity: 'grave', servings: 1 }] });
  event = (await app.call(`/api/v1/events/${eventId}`)).data.event as FoodEvent;
});
test.after(async () => { await app.close(); });

test('caracterización · un menú nace siempre de un evento: sin event_id se rechaza con el campo', async () => {
  const error = await rejected([insert('food.menus', uuid(), { source_event_revision: 1 })], 'INVALID_FIELDS');
  assert.equal(error.details.field, 'event_id');
  // Tampoco sin la revisión del evento.
  assert.equal((await rejected([insert('food.menus', uuid(), { event_id: eventId })], 'INVALID_FIELDS')).details.field, 'source_event_revision');
});

test('caracterización · un plato exige una receta; la receta más corta exige nombre, categoría y raciones base', async () => {
  const menu = uuid(); const service = uuid();
  await ok([
    insert('food.menus', menu, { event_id: eventId, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) }),
    insert('food.menu_services', service, { menu_id: menu, service_date: day(10), service_type: 'cena', position: 1 }),
  ]);
  assert.equal((await rejected([insert('food.menu_items', uuid(), { service_id: service, servings: 4 })], 'INVALID_FIELDS')).details.field, 'recipe_id');
  for (const [fields, missing] of [
    [{ category: 'principal', base_servings: 4 }, 'name'],
    [{ name: 'Lentejas', base_servings: 4 }, 'category'],
    [{ name: 'Lentejas', category: 'principal' }, 'base_servings'],
  ] as const) {
    assert.equal((await rejected([insert('food.recipes', uuid(), fields)], 'INVALID_FIELDS')).details.field, missing);
  }
  // Con esos tres campos nace en prueba, sin alérgenos revisados ni elaboración, y ya se puede poner en un menú.
  const recipe = uuid();
  await ok([insert('food.recipes', recipe, { name: 'Lentejas', category: 'principal', base_servings: 4 }),
    insert('food.menu_items', uuid(), { service_id: service, recipe_id: recipe, servings: 22, position: 1 })]);
  const saved = (await rows('food.recipes')).find((r) => r.id === recipe)!;
  assert.equal(saved.status, 'en_prueba');
  assert.equal(saved.allergens_checked, false);
  assert.deepEqual([saved.allergens, saved.diet_tags, saved.method, saved.method_steps, saved.prep_minutes], [[], [], null, null, null]);
});

test('caracterización · receta en prueba sin alérgenos revisados en un retiro: se puede validar aceptando el aviso', () => {
  const service = { id: 's1', menu_id: 'm', service_date: day(10), service_type: 'cena', service_time: null, position: 1, notes: null, deleted_at: null };
  const recipe = { id: 'r1', name: 'Lentejas', status: 'en_prueba', allergens: [], allergens_checked: false, diet_tags: [] };
  const graph = {
    services: [service], items: [{ id: 'i1', service_id: 's1', recipe_id: 'r1', servings: 22, position: 1, deleted_at: null }],
    recipes: [recipe], recipe_ingredients: [], ingredients: [],
  } as unknown as MenuGraph;
  const withAllergy = menuWarnings(event, graph);
  // Con alergias en el grupo: «alérgenos sin revisar» obliga a aceptarlo; «en prueba» solo informa.
  assert.deepEqual(withAllergy.map((w) => [w.kind, w.requiresAck]), [['alergenos_sin_revisar', true], ['receta_no_validada', false]]);
  assert.deepEqual(requiredAcknowledgements(withAllergy), ['alergenos_sin_revisar|r1']);
  // Sin alergias, nada que aceptar: el menú se valida directamente.
  const without = menuWarnings({ ...event, dietary_restrictions: [] }, graph);
  assert.deepEqual(without.map((w) => [w.kind, w.requiresAck]), [['receta_no_validada', false]]);
});

test('caracterización · compra por menú: una lista viva por menú, con todos sus servicios', async () => {
  const other = await seedBookingEvent(app, { title: 'Otro retiro', start: day(20), end: day(21) });
  const ev = (await app.call(`/api/v1/events/${other}`)).data.event as FoodEvent;
  const menu = uuid(); const first = uuid(); const second = uuid(); const recipe = uuid(); const rice = uuid();
  await ok([
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg' }),
    insert('food.recipes', recipe, { name: 'Arroz blanco', category: 'guarnicion', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.menus', menu, { event_id: other, source_event_revision: ev.event_revision, source_event_snapshot: eventSnapshot(ev) }),
    insert('food.menu_services', first, { menu_id: menu, service_date: day(20), service_type: 'cena', position: 1 }),
    insert('food.menu_services', second, { menu_id: menu, service_date: day(21), service_type: 'comida', position: 2 }),
    insert('food.menu_items', uuid(), { service_id: first, recipe_id: recipe, servings: 10, position: 1 }),
    insert('food.menu_items', uuid(), { service_id: second, recipe_id: recipe, servings: 20, position: 1 }),
  ]);
  const list = uuid();
  const done = await ok([call('regenerate_shopping', { menu_id: menu, list_id: list })]);
  assert.equal(done.results[0].result.created, true);
  const lines = (await rows('food.shopping_list_items')).filter((i) => i.shopping_list_id === list);
  assert.deepEqual(lines.map((l) => `${Number(l.required_quantity)} ${l.unit}`), ['3 kg']); // 1 kg + 2 kg, los dos servicios
  // Regenerar con otro id reutiliza la lista viva del menú: nunca hay dos.
  const again = await ok([call('regenerate_shopping', { menu_id: menu, list_id: uuid() })]);
  assert.equal(again.results[0].result.list_id, list);
  assert.equal(again.results[0].result.created, false);
  assert.equal((await rows('food.shopping_lists')).filter((l) => l.menu_id === menu && !l.deleted_at).length, 1);
});

test('caracterización · indicadores de Central: las tres claves y sus valores con los menús de retiro de arriba', async () => {
  const kpis = (await app.t.db.query<{ kpi: string; value: string }>(`select kpi, value from food.central_kpi_projection order by kpi`)).rows;
  // Dos menús en borrador de eventos en los próximos 30 días, una lista abierta y ningún evento sin menú.
  assert.deepEqual(kpis.map((k) => `${k.kpi}=${Number(k.value)}`), ['food.events_without_menu_30d=0', 'food.menus_unvalidated_30d=2', 'food.shopping_lists_open=1']);
});
