/** Food · estados del menú, revisión de cambios del evento y avisos de restricciones contra PGlite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { allergensForSubject, eventSnapshot, menuWarnings, normalizeTerm, type FoodEvent, type MenuGraph } from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent, setFinalGuests } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { body: { requestId: `proc-${++counter}`, operations }, ...(token ? { token } : {}) });
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
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
  return (snap.data.tables[0].rows as Array<Record<string, any>>).find((r) => r.id === id)!;
}
async function currentEvent(id: string) {
  return (await app.call(`/api/v1/events/${id}`)).data.event as FoodEvent;
}

let event1: string; let event2: string;
let rev: number; // revisión del evento 1 que ve cocina al empezar
const curry = uuid(); const pesto = uuid(); const tortilla = uuid();
const menu = uuid(); const dinner = uuid(); const breakfast = uuid();
const curryItem = uuid(); const pestoItem = uuid(); const tortillaItem = uuid();
const RESTRICTIONS = [{ type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1 }, { type: 'vegano', servings: 2 }, { type: 'preferencia', subject: 'sin picante', servings: 3 }];

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  event1 = await seedBookingEvent(app, { title: 'Retiro Test', start: day(10), end: day(12), restrictions: RESTRICTIONS });
  event2 = await seedBookingEvent(app, { title: 'Retiro vacío', start: day(10), end: day(12) });
  rev = (await currentEvent(event1)).event_revision;
  const egg = uuid();
  await ok([
    insert('food.ingredients', egg, { name: 'Huevo', preferred_unit: 'unidad' }),
    insert('food.recipes', curry, { name: 'Curry de verduras', category: 'principal', base_servings: 20, diet_tags: ['vegano', 'vegetariano'], allergens: [], allergens_checked: true, status: 'validada' }),
    insert('food.recipes', pesto, { name: 'Pasta al pesto', category: 'principal', base_servings: 20, diet_tags: ['vegetariano'], allergens: ['gluten', 'frutos_de_cascara', 'lacteos'], allergens_checked: true, status: 'validada' }),
    insert('food.recipes', tortilla, { name: 'Tortilla', category: 'desayuno', base_servings: 10, diet_tags: ['vegetariano'] }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: tortilla, ingredient_id: egg, quantity: 12, unit: 'unidad' }),
  ]);
  const event = await currentEvent(event1);
  await ok([
    insert('food.menus', menu, { event_id: event1, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) }),
    insert('food.menu_services', dinner, { menu_id: menu, service_date: day(10), service_type: 'cena', service_time: '20:30' }),
    insert('food.menu_services', breakfast, { menu_id: menu, service_date: day(11), service_type: 'desayuno', service_time: '09:00' }),
    insert('food.menu_items', curryItem, { service_id: dinner, recipe_id: curry, servings: 20 }),
    insert('food.menu_items', pestoItem, { service_id: dinner, recipe_id: pesto, servings: 2 }),
    insert('food.menu_items', tortillaItem, { service_id: breakfast, recipe_id: tortilla, servings: 22 }),
  ]);
});
test.after(async () => { await app.close(); });

test('avisos · texto libre de Booking → alérgenos; lo desconocido se revisa a mano', () => {
  assert.equal(normalizeTerm('  Pistachos '), 'pistacho');
  assert.deepEqual(allergensForSubject('Pistachos'), ['frutos_de_cascara']);
  assert.deepEqual(allergensForSubject('frutos secos'), ['frutos_de_cascara']);
  assert.deepEqual(allergensForSubject('Lácteos'), ['lacteos']);
  assert.deepEqual(allergensForSubject('gluten (celíaca)'), ['gluten']);
  assert.deepEqual(allergensForSubject('kiwi'), []);
  const graph: MenuGraph = { services: [], items: [], recipes: [], recipe_ingredients: [], ingredients: [] };
  const warnings = menuWarnings({ start_date: day(10), end_date: day(12), dietary_restrictions: [{ type: 'alergia', subject: 'kiwi', servings: 1 }] }, graph);
  assert.deepEqual(warnings.map((w) => [w.kind, w.requiresAck]), [['no_verificable', true]]);
});

test('estado · borrador ⇄ revisar; a validado solo con validate_menu; conflicto de versión es 409', async () => {
  await ok([call('set_menu_status', { menu_id: menu, expectedRevision: 1, status: 'revisar' })]);
  assert.equal((await row('food.menus', menu)).status, 'revisar');
  const bad = await rejected([call('set_menu_status', { menu_id: menu, expectedRevision: 2, status: 'validado' })], 'INVALID_TRANSITION');
  assert.deepEqual([bad.details.from, bad.details.to], ['revisar', 'validado']);
  const stale = await commit([call('set_menu_status', { menu_id: menu, expectedRevision: 1, status: 'borrador' })]);
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
  assert.equal((await rejected([call('set_menu_status', { menu_id: menu, expectedRevision: 2, status: 'listo' })], 'INVALID_OPERATION')).details.argument, 'status');
  await rejected([call('set_menu_status', { menu_id: uuid(), expectedRevision: 1, status: 'revisar' })], 'MENU_NOT_FOUND');
  assert.equal((await commit([call('set_menu_status', { menu_id: menu, expectedRevision: 2, status: 'borrador' })], app.tokens.reader)).status, 403);
});

test('validar · exige aceptar uno a uno los avisos de alergia, dieta y alérgenos sin revisar', async () => {
  const event = await currentEvent(event1);
  const args = { menu_id: menu, expectedRevision: 2, event_revision: event.event_revision, event_snapshot: eventSnapshot(event) };
  const error = await rejected([call('validate_menu', { ...args, acknowledged: [] })], 'MENU_WARNINGS_UNACKNOWLEDGED');
  assert.deepEqual([...error.details.missing].sort(), [
    `alergenos_sin_revisar|${tortilla}`,
    `alergia|alergia|pistacho|grave||${pestoItem}`,
    `dieta|vegano|${breakfast}`,
  ].sort());
  // La preferencia y la receta en prueba se muestran pero no bloquean.
  const kinds = error.details.warnings.map((w: any) => w.kind);
  assert.ok(kinds.includes('preferencia') && kinds.includes('receta_no_validada'));
  const required = error.details.warnings.filter((w: any) => w.requiresAck);
  await rejected([call('validate_menu', { ...args, acknowledged: required.slice(0, 2) })], 'MENU_WARNINGS_UNACKNOWLEDGED');

  const done = await ok([call('validate_menu', { ...args, acknowledged: required })]);
  assert.equal(done.results[0].result.status, 'validado');
  const saved = await row('food.menus', menu);
  assert.equal(saved.status, 'validado');
  assert.equal(saved.validated_by, app.users.owner);
  assert.ok(saved.validated_at);
  assert.equal(saved.validated_warnings.length, 3);
  // Validado: los platos quedan bloqueados.
  const item = await row('food.menu_items', curryItem);
  await rejected([update('food.menu_items', curryItem, item.revision, { servings: 25 })], 'MENU_LOCKED');
});

test('obsolescencia · el evento cambia: revalidar o reabrir, revisar y validar de nuevo', async () => {
  const before = await currentEvent(event1);
  await setFinalGuests(app, event1, 25);
  const after = await currentEvent(event1);
  assert.equal(after.event_revision, rev + 1);
  assert.equal(after.guest_count, 25);
  let current = await row('food.menus', menu);
  assert.equal(current.source_event_revision, rev); // el menú validado no se toca en silencio

  // Con la revisión o la foto antiguas no se puede revalidar.
  const old = await rejected([call('validate_menu', { menu_id: menu, expectedRevision: current.revision, event_revision: rev, event_snapshot: eventSnapshot(before), acknowledged: [] })], 'EVENT_CHANGED');
  assert.equal(old.details.currentRevision, rev + 1);
  assert.equal(old.details.event.guest_count, 25);
  await rejected([call('validate_menu', { menu_id: menu, expectedRevision: current.revision, event_revision: rev + 1, event_snapshot: eventSnapshot(before), acknowledged: [] })], 'EVENT_CHANGED');
  // En un menú validado no vale «he revisado los cambios»: hay que revalidar o reabrir.
  await rejected([call('acknowledge_event', { menu_id: menu, expectedRevision: current.revision, event_revision: rev + 1, event_snapshot: eventSnapshot(after) })], 'MENU_LOCKED');

  await ok([call('set_menu_status', { menu_id: menu, expectedRevision: current.revision, status: 'revisar' })]);
  const item = await row('food.menu_items', curryItem);
  await ok([update('food.menu_items', curryItem, item.revision, { servings: 23 })]);
  current = await row('food.menus', menu);
  await ok([call('acknowledge_event', { menu_id: menu, expectedRevision: current.revision, event_revision: rev + 1, event_snapshot: eventSnapshot(after) })]);
  current = await row('food.menus', menu);
  assert.equal(current.source_event_revision, rev + 1);
  assert.equal(current.source_event_snapshot.guest_count, 25);

  const probe = await rejected([call('validate_menu', { menu_id: menu, expectedRevision: current.revision, event_revision: rev + 1, event_snapshot: eventSnapshot(after), acknowledged: [] })], 'MENU_WARNINGS_UNACKNOWLEDGED');
  await ok([call('validate_menu', { menu_id: menu, expectedRevision: current.revision, event_revision: rev + 1, event_snapshot: eventSnapshot(after), acknowledged: probe.details.warnings.filter((w: any) => w.requiresAck) })]);
  current = await row('food.menus', menu);
  await ok([call('set_menu_status', { menu_id: menu, expectedRevision: current.revision, status: 'cerrado' })]);
  current = await row('food.menus', menu);
  await rejected([call('validate_menu', { menu_id: menu, expectedRevision: current.revision, event_revision: rev + 1, event_snapshot: eventSnapshot(after), acknowledged: [] })], 'MENU_WARNINGS_UNACKNOWLEDGED');
  await ok([call('set_menu_status', { menu_id: menu, expectedRevision: current.revision, status: 'validado' })]);
});

test('validar · un menú sin platos no se valida; un lote con procedimiento no se deshace', async () => {
  const empty = uuid(); const event = await currentEvent(event2);
  await ok([insert('food.menus', empty, { event_id: event2, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) })]);
  await rejected([call('validate_menu', { menu_id: empty, expectedRevision: 1, event_revision: event.event_revision, event_snapshot: eventSnapshot(event), acknowledged: [] })], 'MENU_EMPTY');
  const done = await ok([call('set_menu_status', { menu_id: empty, expectedRevision: 1, status: 'revisar' })]);
  const plan = await app.call(`/api/v1/history/${done.cursor}/undo-plan`, { body: {} });
  assert.equal(plan.status, 409); assert.equal(plan.data.error.code, 'UNDO_UNAVAILABLE');
});

test('agentes · solo regenerar la preparación es seguro sin aprobación', async () => {
  const rows = (await app.t.db.query<{ procedure: string; agent_confirmation: boolean }>(
    `select procedure, agent_confirmation from core.allowed_procedures where app = 'food' order by procedure`)).rows;
  assert.deepEqual(rows.filter((r) => !r.agent_confirmation).map((r) => r.procedure), ['food.regenerate_preparation']);
  assert.ok(rows.filter((r) => r.agent_confirmation).map((r) => r.procedure).includes('food.validate_menu'));
});
