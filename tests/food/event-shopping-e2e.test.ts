/**
 * Food · la lista de la compra del evento, de punta a punta con la Tasks de verdad (1117; Tasks #874, API §39.6): compra
 * pedida desde Food → recibida en Tasks → entrada en Recursos (una, la de Tasks, con la unidad del artículo) → Despensa de
 * Food y lista del evento cuadran. Food y Tasks comparten la base (PGlite) y la sesión de la persona.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';
import { receiptEntryOperation, receivePurchaseOps } from '../../supabase/functions/_domain/tasks/purchases.ts';
import { emptyDataset } from '../../supabase/functions/_domain/tasks/types.ts';
import { eventSnapshot, type EventShopping, type FoodEvent } from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const TASKS_BASE = 'https://tasks.example.invalid';
let app: TestApp;
let tasks: (request: Request) => Promise<Response>;
let counter = 0;

/** Lo que Food manda a Tasks llega a la Edge de Tasks de verdad, sobre la misma base. */
const tasksFetch: typeof fetch = async (input, init) => {
  const url = String(input).replace(TASKS_BASE, `${app.supabase.url}/functions/v1/tasks-api`);
  const headers = new Headers(init?.headers);
  headers.set('Origin', TASKS_ORIGINS[0]!);
  return tasks(new Request(url, { ...init, headers }));
};
async function tasksCall(path: string, body?: unknown) {
  const res = await tasks(new Request(`${app.supabase.url}/functions/v1/tasks-api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: TASKS_ORIGINS[0]!, 'Content-Type': 'application/json', Authorization: 'Bearer ' + app.tokens.owner },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, data: await res.json() as any };
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
async function ok(path: 'commands' | 'resources/commands', operations: unknown[]) {
  const res = await app.call(`/api/v1/${path}`, { body: { requestId: `e2e-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const shopping = async (): Promise<EventShopping> => (await app.call('/api/v1/read/food.event_shopping', { body: { event_id: event } })).data;

const ARROZ = uuid(), SAL = uuid(), KITCHEN = uuid(), TAB = uuid(), PROJECT = uuid();
const rice = uuid(), salt = uuid(), recipe = uuid(), menu = uuid(), service = uuid();
let event = '';

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => {
      tasks = createTasksApp({ ...config, origins: [TASKS_ORIGINS[0]!], workerKey: WORKER_KEY });
      return createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }, { tasksApiBase: TASKS_BASE, tasksFetch, workerKey: WORKER_KEY });
    },
  });
  // La misma persona también está en Tasks.
  await q(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'owner') on conflict do nothing`, [app.users.owner]);
  const tab = await tasksCall('/api/v1/commands', { requestId: 'e2e-tab', operations: createTabOps({ id: TAB, name: 'Eventos', position: 1024 }) });
  assert.equal(tab.status, 200, JSON.stringify(tab.data));
  const project = await tasksCall('/api/v1/commands', { requestId: 'e2e-project', operations: [insert('tasks.projects', PROJECT, { tab_id: TAB, title: 'Retiro con barra', position: 2048 })] });
  assert.equal(project.status, 200, JSON.stringify(project.data));

  // Recursos: arroz y sal en kg, y la cocina (donde Food cuenta su Despensa).
  await ok('resources/commands', [
    insert('resources.items', ARROZ, { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg' }),
    insert('resources.items', SAL, { name: 'Sal', kind: 'ingrediente', base_unit: 'kg' }),
    insert('resources.spaces', KITCHEN, { kind: 'cocina', name: 'Cocina' }),
  ]);
  event = await seedBookingEvent(app, { title: 'Retiro con barra', start: day(20), end: day(21) });
  const snapshot = (await app.call(`/api/v1/events/${event}`)).data.event as FoodEvent;
  // 20 raciones × (1 kg de arroz y 50 g de sal) ÷ 10 = 2 kg de arroz y 100 g de sal.
  await ok('commands', [
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg', item_id: ARROZ, preferred_supplier: 'Makro' }),
    insert('food.ingredients', salt, { name: 'Sal', preferred_unit: 'g', item_id: SAL, preferred_supplier: 'Makro' }),
    insert('food.recipes', recipe, { name: 'Arroz con sal', category: 'principal', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: salt, quantity: 50, unit: 'g' }),
    insert('food.menus', menu, { event_id: event, source_event_revision: snapshot.event_revision, source_event_snapshot: eventSnapshot(snapshot) }),
    insert('food.menu_services', service, { menu_id: menu, service_date: day(20), service_type: 'cena', service_time: '20:30', position: 1 }),
    insert('food.menu_items', uuid(), { service_id: service, recipe_id: recipe, servings: 20, position: 1 }),
  ]);
  await ok('commands', [{ op: 'call', procedure: 'food.regenerate_shopping', args: { menu_id: menu, list_id: uuid() } }]);
});
test.after(async () => { await app.close(); });

test('punta a punta · pedida en Food, recibida en Tasks, una sola entrada en Recursos, y la Despensa y la lista cuadran', async () => {
  const before = await shopping();
  const rows = Object.fromEntries(before.rows.map((r) => [r.name, r]));
  assert.deepEqual([Number(rows.Arroz!.pending), rows.Arroz!.unit, rows.Arroz!.item_id], [2, 'kg', ARROZ]);
  assert.deepEqual([Number(rows.Sal!.pending), rows.Sal!.unit, rows.Sal!.item_id], [100, 'g', SAL]);

  // 1. Food pide a Tasks las dos filas, con el artículo de cada una.
  const asked = await app.call(`/api/v1/events/${event}/shopping/request`, { body: { projectId: PROJECT, keys: [rows.Arroz!.key, rows.Sal!.key] } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.equal(asked.data.requested.length, 2);
  const purchases = (await q(`select id, item_id, quantity::float8 as quantity, unit, status, source_app from tasks.purchase_requests where project_id = $1 order by title`, [PROJECT]));
  assert.deepEqual(purchases.map((p) => [p.item_id, p.quantity, p.unit, p.status, p.source_app]), [[ARROZ, 2, 'kg', 'requested', 'food'], [SAL, 100, 'g', 'requested', 'food']]);
  assert.equal((await shopping()).rows.every((r) => r.status === 'pedida'), true);

  // 2. Tasks las recibe como cualquier compra suya: la entrada en Recursos (con la unidad del artículo) y la solicitud.
  for (const p of purchases) {
    const row = (await q(`select * from tasks.purchase_requests where id = $1`, [p.id]))[0];
    const entry = receiptEntryOperation(row, { id: uuid(), spaceId: KITCHEN, item: { base_unit: 'kg' }, units: [] });
    assert.ok(entry, 'con artículo hay entrada');
    await ok('resources/commands', [entry]);
    const dataset = { ...emptyDataset(), 'tasks.purchase_requests': [row] } as never;
    const received = await tasksCall('/api/v1/commands', { requestId: `e2e-recibir-${p.id}`, operations: receivePurchaseOps(dataset, p.id) });
    assert.equal(received.status, 200, JSON.stringify(received.data));
  }

  // 3. Food pregunta a Tasks y marca lo recibido.
  const refreshed = await app.call(`/api/v1/events/${event}/shopping/refresh`, { body: {} });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.deepEqual([refreshed.data.checked, refreshed.data.marked], [2, 2]);

  // 4. Una sola entrada por artículo, la de Tasks, en kg; ninguna de Food (no se cuenta dos veces).
  const moves = await q(`select item_id, quantity::float8 as quantity, source_app from resources.movements where item_id = any($1) and deleted_at is null order by item_id`, [[ARROZ, SAL]]);
  assert.deepEqual(moves.map((m) => [m.item_id, m.quantity, m.source_app]).sort(), [[ARROZ, 2, 'tasks'], [SAL, 0.1, 'tasks']].sort());
  assert.equal((await q(`select count(*)::int n from resources.movements where source_ref like 'shopping_item:%'`))[0].n, 0);

  // 5. La Despensa de Food (stock de cocina) y la lista del evento cuadran con eso.
  const stock = async (item: string) => Number((await q(`select food.kitchen_stock($1, current_date) as s`, [item]))[0].s);
  assert.deepEqual([await stock(ARROZ), await stock(SAL)], [2, 0.1]);
  const after = await shopping();
  assert.deepEqual(after.rows.map((r) => [r.name, r.status, Number(r.pending), Number(r.bought)]).sort(), [['Arroz', 'comprado', 0, 2], ['Sal', 'comprado', 0, 100]]);
  assert.deepEqual((await q(`select distinct status from food.shopping_list_items where ingredient_id = any($1) and deleted_at is null`, [[rice, salt]])).map((r) => r.status), ['recibido']);

  // Volver a preguntar no cambia nada.
  const again = await app.call(`/api/v1/events/${event}/shopping/refresh`, { body: {} });
  assert.deepEqual([again.data.checked, again.data.marked], [0, 0]);
});
