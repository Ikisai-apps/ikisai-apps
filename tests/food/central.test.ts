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
  assert.deepEqual(Object.keys(before).sort(), ['food.menus_unvalidated_30d', 'food.shopping_lists_open']);
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

test('campos de archivo (§3.9): foto y miniatura de la receta operativas; recogida de huérfanos activada', async () => {
  const q = await app.t.db.query<{ t: string; retention: string }>(`select table_name || '.' || column_name t, retention from core.file_fields where schema_name = 'food' order by 1`);
  assert.deepEqual(q.rows.map((r) => `${r.t}:${r.retention}`), ['recipes.photo_file_id:operational', 'recipes.photo_thumb_file_id:operational']);
  assert.equal((await app.t.db.query(`select 1 from core.file_gc_apps where app = 'food'`)).rows.length, 1);
});
