/**
 * Food · la lista de la compra única por evento (1117, API.md §2.15) contra PGlite: suma las listas de los menús del evento
 * por ingrediente, unidad y tienda; la pide a Tasks (una Tasks falsa) una sola vez por referencia y marca lo comprado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  dayBefore, eventSnapshot, groupEventShopping, itemStatusFromPurchase, menusWithoutList, unrequestedQuantity, type EventShopping, type EventShoppingRow, type FoodEvent,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
const calls: Array<{ url: string; method: string; body: Record<string, any> }> = [];
const purchaseStatus = new Map<string, string>();
const seen = new Set<string>();
/** Como Tasks: la misma referencia devuelve la misma compra, con su estado, sin crear otra. */
const tasksFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url: String(input), method: init?.method ?? 'GET', body });
  if (String(input).endsWith('/requests/projects')) return Response.json({ projects: [{ id: PROJECT, title: 'Retiro con barra', tabId: uuid(), tabName: 'Compras' }] });
  const created = !seen.has(body.external_ref);
  seen.add(body.external_ref);
  return Response.json({ created, purchase: { kind: 'purchase_request', id: uuid(), status: purchaseStatus.get(body.external_ref) ?? 'requested', externalRef: body.external_ref } });
};

let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const send = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `evshop-${++counter}`, operations } });
async function ok(operations: unknown[]) {
  const res = await send(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const shopping = async (): Promise<EventShopping> => {
  const out = await app.call('/api/v1/read/food.event_shopping', { body: { event_id: event } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  return out.data;
};
const rowOf = (data: EventShopping, name: string): EventShoppingRow => data.rows.find((r) => r.name === name)!;

const PROJECT = uuid();
let event = '';
const menu = uuid(), carta = uuid(), curry = uuid(), rice = uuid(), salt = uuid(), service = uuid();

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }, { tasksApiBase: 'https://tasks.example.invalid', tasksFetch }),
  });
  event = await seedBookingEvent(app, { title: 'Retiro con barra', start: day(20), end: day(21) });
  const snapshot = (await app.call(`/api/v1/events/${event}`)).data.event as FoodEvent;
  // Menú: 20 raciones × 1 kg ÷ 10 = 2 kg de arroz; barra: 10 × 1 kg ÷ 10 = 1 kg más, y la sal solo en la barra.
  await ok([
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg', preferred_supplier: 'Makro' }),
    insert('food.ingredients', salt, { name: 'Sal', preferred_unit: 'g' }),
    insert('food.recipes', curry, { name: 'Curry', category: 'principal', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: curry, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.menus', menu, { event_id: event, source_event_revision: snapshot.event_revision, source_event_snapshot: eventSnapshot(snapshot) }),
    insert('food.menu_services', service, { menu_id: menu, service_date: day(20), service_type: 'cena', service_time: '20:30', position: 1 }),
    insert('food.menu_items', uuid(), { service_id: service, recipe_id: curry, servings: 20, position: 1 }),
    insert('food.menus', carta, { kind: 'carta', name: 'Barra del retiro', event_id: event }),
  ]);
  const barRecipe = uuid();
  await ok([
    insert('food.recipes', barRecipe, { name: 'Curry de barra', category: 'principal', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: barRecipe, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: barRecipe, ingredient_id: salt, quantity: 50, unit: 'g' }),
    insert('food.carta_lines', uuid(), { menu_id: carta, recipe_id: barRecipe, scope: 'clasico', code: 'A', sale_price_cents: 300, expected_units: 10 }),
  ]);
});
test.after(async () => { await app.close(); });

test('sin listas · la del evento dice qué menús no la tienen (no sale vacía en silencio)', async () => {
  const data = await shopping();
  assert.deepEqual(menusWithoutList(data).map((m) => m.name).sort(), ['Barra del retiro', 'Menú del evento']);
  assert.deepEqual(data.rows, []);
});

test('suma · las listas de los menús del evento, por ingrediente, unidad y tienda', async () => {
  for (const id of [menu, carta]) await ok([{ op: 'call', procedure: 'food.regenerate_shopping', args: { menu_id: id, list_id: uuid() } }]);
  const data = await shopping();
  assert.deepEqual(menusWithoutList(data), []);
  const arroz = rowOf(data, 'Arroz');
  assert.deepEqual([Number(arroz.pending), arroz.unit, arroz.supplier, arroz.status, arroz.lines.length], [3, 'kg', 'Makro', 'pendiente', 2]);
  assert.deepEqual([...arroz.menus].sort(), ['Barra del retiro', 'Menú del evento']);
  const sal = rowOf(data, 'Sal');
  assert.deepEqual([sal.supplier, sal.menus], [null, ['Barra del retiro']]);
  // Por tienda (sin tienda al final) y por pasillo.
  assert.deepEqual(groupEventShopping(data.rows).map((g) => g.shop), ['Makro', 'Sin tienda']);
});

test('Tasks · pedir crea una compra por fila con referencia, cantidad, unidad, plazo y enlace; repetir no pide otra vez', async () => {
  const projects = await app.call(`/api/v1/events/${event}/shopping/projects`, { method: 'GET' });
  assert.equal(projects.status, 200, JSON.stringify(projects.data));
  assert.equal(projects.data.projects[0].id, PROJECT);

  const key = rowOf(await shopping(), 'Arroz').key;
  const first = await app.call(`/api/v1/events/${event}/shopping/request`, { body: { projectId: PROJECT, keys: [key] } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const sent = calls.at(-1)!;
  assert.equal(sent.url, 'https://tasks.example.invalid/api/v1/requests/purchase');
  assert.equal(sent.body.source, 'food');
  assert.equal(sent.body.external_ref, `food:event:${event}:${key}`);
  assert.equal(sent.body.project_id, PROJECT);
  assert.deepEqual([sent.body.quantity, sent.body.unit], [3, 'kg']);
  assert.equal(sent.body.title, 'Arroz · 3 kg (Retiro con barra)');
  assert.equal(sent.body.due, dayBefore(day(20)));
  assert.equal(sent.body.external_url, `https://food.ikisai.com/#/eventos/${event}/compra`);
  assert.match(sent.body.note, /Proveedor: Makro/);

  const arroz = rowOf(await shopping(), 'Arroz');
  assert.equal(arroz.status, 'pedida');
  assert.equal(Number(arroz.requested), 3);
  assert.equal(unrequestedQuantity(arroz), 0);

  const before = calls.length;
  const again = await app.call(`/api/v1/events/${event}/shopping/request`, { body: { projectId: PROJECT, keys: [key] } });
  assert.deepEqual(again.data.requested, []);
  assert.equal(calls.length, before, 'nada más que pedir: no llama a Tasks');
});

test('Tasks · lo comprado allí se marca en Food al preguntar; sin entrar dos veces en la Despensa', async () => {
  const arroz = rowOf(await shopping(), 'Arroz');
  purchaseStatus.set(arroz.purchase_ref!, 'requested');
  let out = await app.call(`/api/v1/events/${event}/shopping/refresh`, { body: {} });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual([out.data.checked, out.data.marked], [1, 0]);

  purchaseStatus.set(arroz.purchase_ref!, 'purchased');
  out = await app.call(`/api/v1/events/${event}/shopping/refresh`, { body: {} });
  assert.deepEqual([out.data.checked, out.data.marked], [1, 2]);
  assert.equal(calls.at(-1)!.body.external_ref, arroz.purchase_ref, 'pregunta con la misma referencia');
  const now = rowOf(await shopping(), 'Arroz');
  assert.deepEqual([now.status, Number(now.pending), Number(now.bought)], ['comprado', 0, 3]);
  assert.equal((await q(`select count(*)::int n from resources.movements where source_ref like 'shopping_item:%'`))[0].n, 0);
});

test('reglas · quien lee no pide; el cliente no escribe lo pedido; fila o proyecto no válidos', async () => {
  const line = (await q(`select id, revision from food.shopping_list_items where ingredient_id = $1 limit 1`, [salt]))[0];
  const res = await send([{ op: 'update', table: 'food.shopping_list_items', id: line.id, expectedRevision: Number(line.revision), fields: { purchase_ref: 'x' } }]);
  assert.equal(res.data.error.code, 'INVALID_FIELDS');
  const bad = await app.call(`/api/v1/events/${event}/shopping/request`, { body: { projectId: 'no', keys: [] } });
  assert.equal(bad.data.error.code, 'INVALID_OPERATION');
  const unknown = await app.call(`/api/v1/events/${uuid()}/shopping/request`, { body: { projectId: PROJECT, keys: [] } });
  assert.equal(unknown.data.error.code, 'EVENT_NOT_FOUND');
  const reader = await app.call(`/api/v1/events/${event}/shopping/request`, { token: app.tokens.reader, body: { projectId: PROJECT, keys: [] } });
  assert.equal(reader.status, 403);
});

test('dominio · plazo, estados de Tasks y agrupación', () => {
  assert.equal(dayBefore('2026-11-01'), '2026-10-31');
  assert.equal(dayBefore('2026-03-01'), '2026-02-28');
  assert.deepEqual(['requested', 'approved', 'purchased', 'received', 'rejected'].map(itemStatusFromPurchase), [null, null, 'comprado', 'recibido', null]);
  const row = (name: string, supplier: string | null, aisle: string | null) => ({ name, supplier, aisle } as EventShoppingRow);
  const groups = groupEventShopping([row('Sal', null, null), row('Pan', 'Panadería', 'Panes'), row('Arroz', 'Makro', null), row('Aceite', 'Makro', 'Aceites')]);
  assert.deepEqual(groups.map((g) => [g.shop, g.aisles.map((a) => a.aisle)]), [['Makro', ['Aceites', 'Otros']], ['Panadería', ['Panes']], ['Sin tienda', ['Otros']]]);
});
