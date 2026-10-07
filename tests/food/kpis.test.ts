/** Food · indicadores para el panel de Dirección de Central (docs/food/API.md §7.4) contra PGlite. */
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

test('indicadores para Central: eventos sin menú en 30 días y listas de la compra abiertas, solo agregados', async () => {
  const before = await kpis();
  assert.deepEqual(Object.keys(before).sort(), ['food.events_without_menu_30d', 'food.shopping_lists_open']);

  const soon = await seedBookingEvent(app, { title: 'Retiro cercano', start: day(5), end: day(7) });
  const today = await seedBookingEvent(app, { title: 'Empieza hoy', start: day(0), end: day(2) });
  await seedBookingEvent(app, { title: 'Retiro lejano', start: day(45), end: day(47) });
  const cancelled = await seedBookingEvent(app, { title: 'Cancelado', start: day(10), end: day(11) });
  await app.t.db.query(`update booking.reservations set status = 'cancelada' where id = (select reservation_id from booking.events where id = $1)`, [cancelled]);
  const noMeals = await seedBookingEvent(app, { title: 'Sin comidas', start: day(12), end: day(13) });
  await app.t.db.query(`update booking.reservations set requires_meals = false where id = (select reservation_id from booking.events where id = $1)`, [noMeals]);

  // Cuentan el cercano y el que empieza hoy; ni el lejano, ni el cancelado, ni el que no lleva comidas.
  assert.equal((await kpis())['food.events_without_menu_30d'], before['food.events_without_menu_30d']! + 2);

  const menu = await createMenu(soon);
  assert.equal((await kpis())['food.events_without_menu_30d'], before['food.events_without_menu_30d']! + 1);
  await createMenu(today);
  assert.equal((await kpis())['food.events_without_menu_30d'], before['food.events_without_menu_30d']);

  // La lista de la compra cuenta mientras no esté cerrada, ni su menú cerrado, ni el evento terminado.
  await ok([{ op: 'call', procedure: 'food.regenerate_shopping', args: { menu_id: menu, list_id: uuid() } }]);
  assert.equal((await kpis())['food.shopping_lists_open'], before['food.shopping_lists_open']! + 1);
  await app.t.db.query(`update food.shopping_lists set status = 'cerrada' where menu_id = $1`, [menu]);
  assert.equal((await kpis())['food.shopping_lists_open'], before['food.shopping_lists_open']);

  const row = (await app.t.db.query<Record<string, unknown>>(`select * from food.central_kpi_projection where kpi = 'food.events_without_menu_30d'`)).rows[0]!;
  assert.equal(row.unit, 'count');
  assert.equal(row.period, 'actual');
  assert.equal(row.direction, 'down');
  assert.equal(row.link, 'https://food.ikisai.com/#/eventos');
  assert.equal(Number((await app.t.db.query<{ n: number }>(
    `select count(*) n from core.allowed_reads where app = 'central' and name = 'food.central_kpi_projection' and kind = 'view'`)).rows[0]!.n), 1);
});
