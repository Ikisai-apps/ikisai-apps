/** Food · lo que publica para Core y Central contra PGlite: indicadores del panel de Dirección (API.md §7.4) y campos de archivo (§8). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { eventSnapshot, type FoodEvent } from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `kpi-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function kpis(): Promise<Record<string, number>> {
  const { rows } = await app.t.db.query<{ kpi: string; value: string }>(`select kpi, value from food.central_kpi_projection`);
  return Object.fromEntries(rows.map((r) => [r.kpi, Number(r.value)]));
}
async function createMenu(eventId: string): Promise<string> {
  const event = (await app.call(`/api/v1/events/${eventId}`)).data.event as FoodEvent;
  const id = uuid();
  await ok([{ op: 'insert', table: 'food.menus', id, fields: { event_id: eventId, source_event_revision: event.event_revision, source_event_snapshot: eventSnapshot(event) } }]);
  return id;
}

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
});

test('indicadores para Central: menús sin validar en 30 días y listas de la compra abiertas, solo agregados', async () => {
  const before = await kpis();
  assert.deepEqual(Object.keys(before).sort(), ['food.carta_sales_yesterday', 'food.equipment_notices_open', 'food.events_without_menu_30d',
    'food.menus_unvalidated_30d', 'food.recipes_allergens_unchecked_30d', 'food.shopping_lists_open']);
  const unvalidated = () => kpis().then((k) => k['food.menus_unvalidated_30d']! - before['food.menus_unvalidated_30d']!);
  const openLists = () => kpis().then((k) => k['food.shopping_lists_open']! - before['food.shopping_lists_open']!);

  const soon = await createMenu(await seedBookingEvent(app, { title: 'Retiro cercano', start: day(5), end: day(7) }));
  const today = await createMenu(await seedBookingEvent(app, { title: 'Empieza hoy', start: day(0), end: day(2) }));
  await createMenu(await seedBookingEvent(app, { title: 'Retiro lejano', start: day(45), end: day(47) }));
  const past = await createMenu(await seedBookingEvent(app, { title: 'Retiro de la semana pasada', start: day(7), end: day(9) }));
  // Lo que la cocina tenía delante: este evento ya pasó.
  await app.t.db.query(`update food.menus set source_event_snapshot = jsonb_set(jsonb_set(source_event_snapshot, '{start_date}', to_jsonb($2::text)), '{end_date}', to_jsonb($3::text)) where id = $1`, [past, day(-9), day(-7)]);

  // Cuentan el cercano y el que empieza hoy; ni el lejano ni el pasado.
  assert.equal(await unvalidated(), 2);
  await app.t.db.query(`update food.menus set status = 'validado', validated_at = now() where id = $1`, [today]);
  assert.equal(await unvalidated(), 1);

  // La lista de la compra cuenta mientras no esté cerrada, ni su menú cerrado, ni el evento terminado.
  for (const menu of [soon, past]) await ok([{ op: 'call', procedure: 'food.regenerate_shopping', args: { menu_id: menu, list_id: uuid() } }]);
  assert.equal(await openLists(), 1);
  await app.t.db.query(`update food.shopping_lists set status = 'cerrada' where menu_id = $1`, [soon]);
  assert.equal(await openLists(), 0);

  const row = (await app.t.db.query<Record<string, unknown>>(`select * from food.central_kpi_projection where kpi = 'food.menus_unvalidated_30d'`)).rows[0]!;
  assert.equal(row.unit, 'count');
  assert.equal(row.period, 'actual');
  assert.equal(row.direction, 'down');
  assert.equal(row.link, 'https://food.ikisai.com/#/menus');
  assert.equal(Number((await app.t.db.query<{ n: number }>(
    `select count(*) n from core.allowed_reads where app = 'central' and name = 'food.central_kpi_projection' and kind = 'view'`)).rows[0]!.n), 1);
});

test('indicadores para Central: eventos sin menú en los próximos 30 días, con la regla de «pide menú» de la app', async () => {
  const base = (await kpis())['food.events_without_menu_30d']!;
  const without = async () => (await kpis())['food.events_without_menu_30d']! - base;
  const reservation = (event: string) => `(select reservation_id from booking.events where id = '${event}')`;

  const soon = await seedBookingEvent(app, { title: 'Retiro sin menú', start: day(3), end: day(5) });
  const today = await seedBookingEvent(app, { title: 'Empieza hoy sin menú', start: day(0), end: day(1) });
  await seedBookingEvent(app, { title: 'Retiro lejano sin menú', start: day(40), end: day(42) });
  const cancelled = await seedBookingEvent(app, { title: 'Cancelado', start: day(8), end: day(9) });
  await app.t.db.query(`update booking.reservations set status = 'cancelada' where id = ${reservation(cancelled)}`);
  const noMeals = await seedBookingEvent(app, { title: 'Sin comidas', start: day(9), end: day(10) });
  await app.t.db.query(`update booking.reservations set requires_meals = false where id = ${reservation(noMeals)}`);

  // Cuentan el cercano y el que empieza hoy; ni el lejano, ni el cancelado, ni el que no lleva comidas.
  assert.equal(await without(), 2);
  await createMenu(soon);
  assert.equal(await without(), 1);
  await createMenu(today);
  assert.equal(await without(), 0);
  const row = (await app.t.db.query<Record<string, unknown>>(`select * from food.central_kpi_projection where kpi = 'food.events_without_menu_30d'`)).rows[0]!;
  assert.equal(row.link, 'https://food.ikisai.com/#/eventos');
  assert.equal(row.direction, 'down');
});

test('campos de archivo (§3.9): foto y miniatura de la receta operativas; recogida de huérfanos activada', async () => {
  const q = await app.t.db.query<{ t: string; retention: string }>(`select table_name || '.' || column_name t, retention from core.file_fields where schema_name = 'food' order by 1`);
  assert.deepEqual(q.rows.map((r) => `${r.t}:${r.retention}`), ['recipes.photo_file_id:operational', 'recipes.photo_thumb_file_id:operational']);
  assert.equal((await app.t.db.query(`select 1 from core.file_gc_apps where app = 'food'`)).rows.length, 1);
});

test('indicadores P7: ventas de la carta de ayer, platos sin alérgenos revisados en 30 días y avisos de equipos abiertos', async () => {
  const base = await kpis();
  const delta = async (kpi: string) => (await kpis())[kpi]! - base[kpi]!;

  // Ventas de ayer: unidades por el precio de cada línea; las de hoy no cuentan.
  const carta = uuid(), recipe = uuid(), lineA = uuid(), lineB = uuid();
  await ok([
    { op: 'insert', table: 'food.recipes', id: recipe, fields: { name: 'Montadito de prueba', category: 'entrante', base_servings: 1 } },
    { op: 'insert', table: 'food.menus', id: carta, fields: { kind: 'carta', name: 'Barra de prueba' } },
    { op: 'insert', table: 'food.carta_lines', id: lineA, fields: { menu_id: carta, recipe_id: recipe, scope: 'clasico', code: 'A', sale_price_cents: 250 } },
    { op: 'insert', table: 'food.carta_lines', id: lineB, fields: { menu_id: carta, recipe_id: recipe, scope: 'clasico', code: 'B', sale_price_cents: 400 } },
  ]);
  const sales = (d: string, a: number, b: number) => ({ op: 'call', procedure: 'food.record_carta_sales', args: { menu_id: carta, day: d, lines: [{ line_id: lineA, quantity: a }, { line_id: lineB, quantity: b }] } });
  await ok([sales(day(-1), 10, 3)]);
  await ok([sales(day(0), 50, 50)]);
  assert.equal(await delta('food.carta_sales_yesterday'), 37); // 10 × 2,50 + 3 × 4,00
  const money = (await app.t.db.query<Record<string, unknown>>(`select * from food.central_kpi_projection where kpi = 'food.carta_sales_yesterday'`)).rows[0]!;
  assert.deepEqual([money.unit, money.period, money.direction], ['eur', 'actual', 'up']);
  assert.equal(String((money.period_start as Date).toISOString?.() ?? money.period_start).slice(0, 10), day(-1));

  // Platos sin alérgenos revisados en servicios de los próximos 30 días: uno por receta, aunque salga dos veces.
  const menu = await createMenu(await seedBookingEvent(app, { title: 'Retiro con dudas', start: day(4), end: day(6) }));
  const unchecked = uuid(), checked = uuid(), soon = uuid(), far = uuid();
  await ok([
    { op: 'insert', table: 'food.recipes', id: unchecked, fields: { name: 'Sin revisar', category: 'principal', base_servings: 10, allergens_checked: false } },
    { op: 'insert', table: 'food.recipes', id: checked, fields: { name: 'Revisada', category: 'principal', base_servings: 10, allergens_checked: true } },
    { op: 'insert', table: 'food.menu_services', id: soon, fields: { menu_id: menu, service_date: day(4), service_type: 'comida', position: 1 } },
    { op: 'insert', table: 'food.menu_services', id: far, fields: { menu_id: menu, service_date: day(40), service_type: 'cena', position: 2 } },
    { op: 'insert', table: 'food.menu_items', id: uuid(), fields: { service_id: soon, recipe_id: unchecked, servings: 10, position: 1 } },
    { op: 'insert', table: 'food.menu_items', id: uuid(), fields: { service_id: soon, recipe_id: checked, servings: 10, position: 2 } },
    { op: 'insert', table: 'food.menu_items', id: uuid(), fields: { service_id: far, recipe_id: unchecked, servings: 10, position: 1 } },
  ]);
  assert.equal(await delta('food.recipes_allergens_unchecked_30d'), 1);

  // Avisos de equipos: el abierto cuenta; el borrado y el de una máquina en la papelera, no.
  const oven = uuid(), gone = uuid();
  await ok([
    { op: 'insert', table: 'food.equipment', id: oven, fields: { name: 'Horno de prueba', quantity: 1, status: 'averiado' } },
    { op: 'insert', table: 'food.equipment', id: gone, fields: { name: 'Freidora vieja', quantity: 1, status: 'averiado' } },
  ]);
  // Los avisos los escribe el servidor al avisar a Tasks (1119); aquí se siembran directamente.
  const notice = (equipment: string) => app.t.db.query(
    `insert into food.equipment_notices (equipment_id, notified_on, equipment_status, task_id) values ($1, $2, 'averiado', 't-1')`, [equipment, day(0)]);
  await notice(oven);
  await app.t.db.query(`insert into food.equipment_notices (equipment_id, notified_on, equipment_status, task_id, deleted_at) values ($1, $2, 'averiado', 't-2', now())`, [oven, day(-1)]);
  await notice(gone);
  await app.t.db.query(`update food.equipment set deleted_at = now() where id = $1`, [gone]);
  assert.equal(await delta('food.equipment_notices_open'), 1);
  const links = (await app.t.db.query<{ kpi: string; link: string }>(`select kpi, link from food.central_kpi_projection where kpi in ('food.equipment_notices_open', 'food.recipes_allergens_unchecked_30d') order by kpi`)).rows;
  assert.deepEqual(links.map((r) => r.link), ['https://food.ikisai.com/#/maquinaria', 'https://food.ikisai.com/#/recetario']);
});
