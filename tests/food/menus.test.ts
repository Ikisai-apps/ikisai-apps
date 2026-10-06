/** Food · eventos leídos por proyección y menú por evento contra PGlite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { eventChanges, eventSnapshot, isMenuStale, proposeServices, type FoodEvent } from '../../supabase/functions/_domain/food/mod.ts';

const uuid = () => crypto.randomUUID();
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
let app: TestApp;
let counter = 0;

function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { body: { requestId: `menu-${++counter}`, operations }, ...(token ? { token } : {}) });
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const remove = (table: string, id: string, expectedRevision: number) => ({ op: 'delete', table, id, expectedRevision });

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

/** Crea en Booking una reserva confirmada con su evento (datos sintéticos) y devuelve el id del evento. */
async function bookingEvent(title: string, start: string, end: string): Promise<string> {
  const reservation = uuid(); const event = uuid();
  await app.t.db.query(
    `insert into booking.reservations (id, title, status, start_date, end_date, expected_guests, requires_meals, meal_plan_requested)
     values ($1, $2, 'confirmada', $3, $4, 20, true, 'pension_completa')`, [reservation, title, start, end]);
  await app.t.db.query(`insert into booking.events (id, reservation_id, final_guests, arrival_time, departure_time) values ($1, $2, 22, '17:00', '12:00')`, [event, reservation]);
  return event;
}

const RESTRICTIONS = [{ type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1 }, { type: 'vegano', servings: 2 }];
let retreat: string; // evento próximo, viernes a domingo
let past: string;
let recipe: string;

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  retreat = await bookingEvent('Retiro Test', day(10), day(12));
  past = await bookingEvent('Retiro antiguo', day(-60), day(-58));
  recipe = uuid();
  await ok([insert('food.recipes', recipe, { name: 'Curry de verduras', category: 'principal', base_servings: 20 })]);
});
test.after(async () => { await app.close(); });

test('eventos · la proyección de pruebas la siembra solo el owner y la leen todos los roles', async () => {
  const stub = (id: string, title: string, start: string, end: string) => insert('food.stub_events', id, {
    title, start_date: start, end_date: end, arrival_time: '17:00', departure_time: '12:00', guest_count: 22, guest_count_is_final: true,
    meal_plan: 'pension_completa', menu_style: 'vegetariano', dietary_restrictions: RESTRICTIONS, event_revision: 8, reservation_status: 'confirmada',
  });
  assert.equal((await commit([stub(retreat, 'Retiro Test', day(10), day(12))], app.tokens.editor)).status, 403);
  await ok([stub(retreat, 'Retiro Test', day(10), day(12)), stub(past, 'Retiro antiguo', day(-60), day(-58))]);

  for (const token of [app.tokens.owner, app.tokens.editor, app.tokens.reader]) {
    const upcoming = await app.call('/api/v1/events', { token });
    assert.equal(upcoming.status, 200, JSON.stringify(upcoming.data));
    assert.deepEqual(upcoming.data.events.map((e: FoodEvent) => e.title), ['Retiro Test']);
  }
  const event = (await app.call(`/api/v1/events/${retreat}`)).data.event as FoodEvent;
  assert.equal(event.guest_count, 22);
  assert.equal(event.event_revision, 8);
  assert.deepEqual(event.dietary_restrictions, RESTRICTIONS);
  // Ninguna columna de huésped ni de contacto llega a cocina.
  assert.deepEqual(Object.keys(event).sort(), [
    'arrival_time', 'departure_time', 'dietary_restrictions', 'end_date', 'event_code', 'event_id', 'event_revision', 'event_type',
    'guest_count', 'guest_count_is_final', 'meal_notes', 'meal_plan', 'menu_style', 'minors_count', 'requires_meals', 'reservation_code',
    'reservation_status', 'start_date', 'title']);
  const all = await app.call('/api/v1/events?scope=all');
  assert.deepEqual(all.data.events.map((e: FoodEvent) => e.title), ['Retiro antiguo', 'Retiro Test']);
  assert.equal((await app.call(`/api/v1/events?scope=all&to=${day(-50)}`)).data.events.length, 1);
  assert.equal((await app.call(`/api/v1/events/${uuid()}`)).status, 404);
  assert.equal((await app.call('/api/v1/events?scope=raro')).status, 422);
  // La tabla de pruebas no entra en el espejo de editores ni lectores.
  assert.equal((await app.call('/api/v1/snapshot?tables=food.stub_events', { token: app.tokens.editor })).status, 403);
});

test('dominio · propuesta de servicios, foto del evento y obsolescencia', async () => {
  const event = (await app.call(`/api/v1/events/${retreat}`)).data.event as FoodEvent;
  const proposal = proposeServices(event);
  assert.deepEqual(proposal.map((s) => `${s.service_date} ${s.service_type}`), [
    `${day(10)} cena`, `${day(11)} desayuno`, `${day(11)} comida`, `${day(11)} cena`, `${day(12)} desayuno`]);
  assert.equal(proposeServices({ ...event, meal_plan: 'media_pension' }).length, 4);
  assert.equal(proposeServices({ ...event, meal_plan: 'segun_programa' }).length, 0);
  assert.equal(proposeServices({ ...event, arrival_time: '11:00', departure_time: '16:00' }).length, 7);
  const snapshot = eventSnapshot(event);
  assert.deepEqual(eventChanges(snapshot, event), []);
  const changed = { ...event, guest_count: 25, event_revision: 9, dietary_restrictions: [...RESTRICTIONS, { type: 'sin_gluten', servings: 1 }] };
  assert.deepEqual(eventChanges(snapshot, changed).map((c) => c.field), ['guest_count', 'restrictions']);
  assert.deepEqual(eventChanges(snapshot, changed)[0], { field: 'guest_count', before: 22, after: 25 });
  assert.equal(isMenuStale({ source_event_revision: 8 }, event), false);
  assert.equal(isMenuStale({ source_event_revision: 8 }, changed), true);
});

test('menú · se crea desde un evento con su propuesta de servicios y sus platos en un solo lote', async () => {
  const event = (await app.call(`/api/v1/events/${retreat}`)).data.event as FoodEvent;
  const menu = uuid();
  const services = proposeServices(event).map((s) => ({ id: uuid(), ...s }));
  await ok([
    insert('food.menus', menu, { event_id: retreat, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) }),
    ...services.map((s) => insert('food.menu_services', s.id, { menu_id: menu, service_date: s.service_date, service_type: s.service_type, service_time: s.service_time, position: s.position })),
    insert('food.menu_items', uuid(), { service_id: services[0]!.id, recipe_id: recipe, servings: event.guest_count }),
  ]);
  const saved = (await rows('food.menus')).find((m) => m.id === menu)!;
  assert.equal(saved.status, 'borrador');
  assert.equal(saved.source_event_revision, 8);
  assert.equal(saved.source_event_snapshot.guest_count, 22);
  assert.equal((await rows('food.menu_services')).filter((s) => s.menu_id === menu).length, 5);
  assert.equal(Number((await rows('food.menu_items')).find((i) => i.service_id === services[0]!.id)!.servings), 22);

  // Un segundo menú para el mismo evento se rechaza con el id del existente.
  const dup = await rejected([insert('food.menus', uuid(), { event_id: retreat, source_event_revision: 8 })], 'MENU_EXISTS');
  assert.equal(dup.details.menuId, menu);
  // El estado y la revisión del evento no se escriben a mano.
  assert.equal((await rejected([update('food.menus', menu, 1, { status: 'validado' })], 'INVALID_FIELDS')).details.field, 'status');
  await rejected([update('food.menus', menu, 1, { source_event_revision: 9 })], 'IMMUTABLE_FIELD');
  await ok([update('food.menus', menu, 1, { notes: 'Grupo madrugador' })]);
});

test('menú · no nace contra un evento desconocido ni contra una revisión futura', async () => {
  await rejected([insert('food.menus', uuid(), { event_id: uuid(), source_event_revision: 1 })], 'EVENT_NOT_FOUND');
  const error = await rejected([insert('food.menus', uuid(), { event_id: past, source_event_revision: 9 })], 'INVALID_FIELDS');
  assert.equal(error.details.field, 'source_event_revision');
  assert.equal(error.details.currentRevision, 8);
  assert.equal((await rejected([insert('food.menus', uuid(), { event_id: past })], 'INVALID_FIELDS')).details.field, 'source_event_revision');
});

test('menú · servicios y platos: padres inmutables, nada bajo un padre borrado, receta en uso', async () => {
  const menu = uuid(); const dinner = uuid(); const lunch = uuid(); const item = uuid(); const gone = uuid();
  await ok([
    insert('food.menus', menu, { event_id: past, source_event_revision: 8 }),
    insert('food.menu_services', dinner, { menu_id: menu, service_date: day(-60), service_type: 'cena', service_time: '20:30' }),
    insert('food.menu_services', lunch, { menu_id: menu, service_date: day(-59), service_type: 'comida' }),
    insert('food.menu_items', item, { service_id: dinner, recipe_id: recipe, servings: 18 }),
    insert('food.recipes', gone, { name: 'Receta retirada', category: 'postre', base_servings: 10 }),
  ]);
  assert.equal((await rejected([insert('food.menu_services', uuid(), { menu_id: menu, service_date: '30/10/2026', service_type: 'cena' })], 'INVALID_FIELDS')).details.field, 'service_date');
  assert.equal((await rejected([insert('food.menu_items', uuid(), { service_id: lunch, recipe_id: recipe, servings: 0 })], 'INVALID_FIELDS')).details.field, 'servings');
  await rejected([update('food.menu_items', item, 1, { service_id: lunch })], 'IMMUTABLE_FIELD');
  // Una receta con platos vivos se archiva, no se borra.
  assert.equal((await rejected([remove('food.recipes', recipe, 1)], 'RECIPE_IN_USE')).details.uses >= 1, true);
  await ok([remove('food.recipes', gone, 1)]);
  assert.equal((await rejected([insert('food.menu_items', uuid(), { service_id: lunch, recipe_id: gone, servings: 4 })], 'PARENT_DELETED')).details.parent, 'recipes');
  // Borrar un servicio con sus platos es un lote; después no admite platos.
  await ok([remove('food.menu_items', item, 1), remove('food.menu_services', dinner, 1)]);
  assert.equal((await rejected([insert('food.menu_items', uuid(), { service_id: dinner, recipe_id: recipe, servings: 4 })], 'PARENT_DELETED')).details.parent, 'menu_services');
  // Un menú en borrador sí se puede borrar, y el evento queda libre para otro.
  await ok([remove('food.menu_services', lunch, 1), remove('food.menus', menu, 1)]);
  await ok([insert('food.menus', uuid(), { event_id: past, source_event_revision: 8 })]);
});

test('menú · validado o cerrado: ni servicios ni platos ni borrado; las notas siguen editables', async () => {
  const menu = (await rows('food.menus')).find((m) => m.event_id === retreat)!;
  const services = (await rows('food.menu_services')).filter((s) => s.menu_id === menu.id);
  const item = (await rows('food.menu_items')).find((i) => services.some((s) => s.id === i.service_id))!;
  const service = services.find((s) => s.id === item.service_id)!;
  // El cambio de estado llegará con los procedimientos; aquí se fuerza para probar el bloqueo.
  await app.t.db.query(`update food.menus set status = 'validado', validated_at = now() where id = $1`, [menu.id]);
  const locked = (await rows('food.menus')).find((m) => m.id === menu.id)!;
  assert.equal((await rejected([update('food.menu_items', item.id, item.revision, { servings: 25 })], 'MENU_LOCKED')).details.status, 'validado');
  await rejected([insert('food.menu_items', uuid(), { service_id: service.id, recipe_id: recipe, servings: 2 })], 'MENU_LOCKED');
  await rejected([update('food.menu_services', service.id, service.revision, { service_time: '21:00' })], 'MENU_LOCKED');
  await rejected([remove('food.menu_items', item.id, item.revision)], 'MENU_LOCKED');
  await rejected([remove('food.menus', menu.id, locked.revision)], 'MENU_LOCKED');
  await ok([update('food.menus', menu.id, locked.revision, { closing_notes: 'Sobraron 4 raciones de curry.' })]);
});
