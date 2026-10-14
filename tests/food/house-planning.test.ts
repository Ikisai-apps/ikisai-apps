/** Food · O3b: compra y preparación del menú de casa por un rango de fechas, contra PGlite (docs/food/API.md §2.6). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  HOUSE_MENU_ID, computeShopping, eventSnapshot, invalidCallArgument, shoppingSources, type FoodEvent, type Menu, type MenuGraph, type Period,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `hplan-${++counter}`, operations } });
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
async function graph(menuId: string): Promise<MenuGraph & { menu: Menu }> {
  const res = await app.call('/api/v1/read/food.menu_graph', { body: { menu_id: menuId } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

const week: Period = { start: day(0), end: day(6) };
const nextWeek: Period = { start: day(7), end: day(13) };
const period = (p: Period) => ({ period_start: p.start, period_end: p.end });
let retreat: string;

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  const rice = uuid(); const recipe = uuid(); const lunch1 = uuid(); const dinner3 = uuid(); const lunch10 = uuid();
  await ok([
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg' }),
    insert('food.recipes', recipe, { name: 'Arroz blanco', category: 'guarnicion', base_servings: 4, prep_minutes: 60 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: rice, quantity: 0.4, unit: 'kg' }),
    insert('food.menus', HOUSE_MENU_ID, { kind: 'casa', house_servings: 4 }),
    insert('food.menu_services', lunch1, { menu_id: HOUSE_MENU_ID, service_date: day(1), service_type: 'comida', service_time: '14:00', position: 1 }),
    insert('food.menu_services', dinner3, { menu_id: HOUSE_MENU_ID, service_date: day(3), service_type: 'cena', service_time: '20:30', position: 1 }),
    insert('food.menu_services', lunch10, { menu_id: HOUSE_MENU_ID, service_date: day(10), service_type: 'comida', service_time: '14:00', position: 1 }),
    insert('food.menu_items', uuid(), { service_id: lunch1, recipe_id: recipe, servings: 4 }),
    insert('food.menu_items', uuid(), { service_id: dinner3, recipe_id: recipe, servings: 6 }),
    insert('food.menu_items', uuid(), { service_id: lunch10, recipe_id: recipe, servings: 8 }),
  ]);
  const eventId = await seedBookingEvent(app, { title: 'Retiro Test', start: day(20), end: day(21) });
  const event = (await app.call(`/api/v1/events/${eventId}`)).data.event as FoodEvent;
  retreat = uuid();
  await ok([insert('food.menus', retreat, { event_id: eventId, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) })]);
});
test.after(async () => { await app.close(); });

test('compra de casa · por rango: solo los servicios de esos días, igual que el dominio; el mismo rango reutiliza la lista', async () => {
  // Sin rango en casa, o con rango en un retiro, no.
  assert.equal((await rejected([call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: uuid() })], 'INVALID_PERIOD')).details.reason, 'required');
  assert.equal((await rejected([call('regenerate_shopping', { menu_id: retreat, list_id: uuid(), ...period(week) })], 'INVALID_PERIOD')).details.reason, 'not_allowed');

  const list = uuid();
  const done = await ok([call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: list, ...period(week) })]);
  assert.equal(done.results[0].result.created, true);
  const saved = (await rows('food.shopping_lists')).find((l) => l.id === list)!;
  assert.deepEqual([saved.period_start, saved.period_end], [week.start, week.end]);
  const lines = (await rows('food.shopping_list_items')).filter((i) => i.shopping_list_id === list);
  assert.deepEqual(lines.map((l) => `${Number(l.required_quantity)} ${l.unit}`), ['1 kg']); // 0,4 kg + 0,6 kg; el día 10 no entra
  // Paridad con el dominio y revisiones de origen del rango.
  const g = await graph(HOUSE_MENU_ID);
  assert.deepEqual(computeShopping(g, week).map((r) => `${r.required_quantity} ${r.unit}`), ['1 kg']);
  assert.deepEqual(computeShopping(g).map((r) => `${r.required_quantity} ${r.unit}`), ['1.8 kg']);
  assert.deepEqual(saved.source_revisions, shoppingSources(g, week));

  const again = await ok([call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: uuid(), ...period(week) })]);
  assert.deepEqual([again.results[0].result.list_id, again.results[0].result.created], [list, false]);
});

test('compra de casa · las listas no se solapan; otro rango, otra lista; el rango no se edita a mano', async () => {
  const overlap = await rejected([call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: uuid(), period_start: day(5), period_end: day(12) })], 'PERIOD_OVERLAP');
  assert.deepEqual([overlap.details.period_start, overlap.details.period_end], [week.start, week.end]);
  const next = uuid();
  await ok([call('regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: next, ...period(nextWeek) })]);
  const lines = (await rows('food.shopping_list_items')).filter((i) => i.shopping_list_id === next);
  assert.deepEqual(lines.map((l) => `${Number(l.required_quantity)} ${l.unit}`), ['0.8 kg']);
  const saved = (await rows('food.shopping_lists')).find((l) => l.id === next)!;
  assert.equal((await rejected([{ op: 'update', table: 'food.shopping_lists', id: next, expectedRevision: saved.revision, fields: { period_end: day(20) } }], 'INVALID_FIELDS')).details.field, 'period_end');
  // Argumentos: los dos días o ninguno, en orden y como mucho 63 días.
  assert.equal(invalidCallArgument('food.regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: next, period_start: day(0) }), 'period_end');
  assert.equal(invalidCallArgument('food.regenerate_shopping', { menu_id: HOUSE_MENU_ID, list_id: next, period_start: day(3), period_end: day(1) }), 'period_end');
  assert.equal(invalidCallArgument('food.regenerate_preparation', { menu_id: HOUSE_MENU_ID, period_start: day(0), period_end: day(63) }), 'period_end');
  assert.equal(invalidCallArgument('food.regenerate_preparation', { menu_id: HOUSE_MENU_ID, period_start: day(0), period_end: day(62) }), null);
});

test('preparación de casa · por rango: solo esos días; sin rango no; la marca de obsolescencia es de los retiros', async () => {
  assert.equal((await rejected([call('regenerate_preparation', { menu_id: HOUSE_MENU_ID })], 'INVALID_PERIOD')).details.reason, 'required');
  const done = await ok([call('regenerate_preparation', { menu_id: HOUSE_MENU_ID, ...period(week) })]);
  assert.deepEqual(done.results[0].result, { inserted: 2, updated: 0, deleted: 0, kept: 0 });
  const prep = (await rows('food.preparation_items')).filter((p) => p.menu_id === HOUSE_MENU_ID);
  // 14:00 y 20:30 menos la hora de antelación de la receta.
  assert.deepEqual(prep.map((p) => `${p.scheduled_date} ${p.scheduled_time}`).sort(), [`${day(1)} 13:00:00`, `${day(3)} 19:30:00`]);
  const house = (await rows('food.menus')).find((m) => m.id === HOUSE_MENU_ID)!;
  assert.equal(house.preparation_generated_at, null);
  // La semana siguiente añade solo lo suyo y no toca lo de esta.
  const next = await ok([call('regenerate_preparation', { menu_id: HOUSE_MENU_ID, ...period(nextWeek) })]);
  assert.deepEqual(next.results[0].result, { inserted: 1, updated: 0, deleted: 0, kept: 0 });
  // Un retiro sigue sin rango, como siempre.
  await ok([call('regenerate_preparation', { menu_id: retreat })]);
  assert.ok((await rows('food.menus')).find((m) => m.id === retreat)!.preparation_generated_at);
});
