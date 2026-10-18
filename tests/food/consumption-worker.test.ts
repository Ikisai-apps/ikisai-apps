/** Food · R5c, P17: el worker del consumo a las 24 h, contra PGlite (docs/food/API.md §2.8; migración 1100). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { HOUSE_MENU_ID, menuItemRef } from '../../supabase/functions/_domain/food/mod.ts';

const WORKER_KEY = 'clave-de-prueba';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;

async function ok(path: 'commands' | 'resources/commands', operations: unknown[]) {
  const res = await app.call(`/api/v1/${path}`, { body: { requestId: `cw-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function tick() {
  const res = await app.handler(new Request(`${app.supabase.url}/functions/v1/food-api/api/v1/worker/consumption/tick`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}',
  }));
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data;
}
const moved = async (dish: string) => (await q(`select kind, quantity::float8 as quantity from resources.movements where source_ref = $1 order by quantity`, [menuItemRef(dish)]))
  .map((m) => [m.kind, m.quantity]);

const rice = uuid(), riceItem = uuid(), recipe = uuid(), late = uuid(), manual = uuid(), retried = uuid(), old = uuid();

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!], workerKey: WORKER_KEY }),
  });
  const altura = (await q(`select id from resources.spaces where kind = 'altura' and name = 'Altura 1' and deleted_at is null`))[0].id;
  const house = uuid(), kitchen = uuid(), pantry = uuid();
  await ok('resources/commands', [
    insert('resources.spaces', house, { kind: 'edificio', name: 'Casa', parent_id: altura }),
    insert('resources.spaces', kitchen, { kind: 'cocina', name: 'Cocina', parent_id: house }),
    insert('resources.spaces', pantry, { kind: 'almacen', name: 'Despensa', parent_id: house }),
    insert('resources.items', riceItem, { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg', default_space_id: pantry }),
    insert('resources.movements', uuid(), { item_id: riceItem, space_id: pantry, quantity: 10, kind: 'entrada_manual' }),
  ]);
  const service = (id: string, date: string) => insert('food.menu_services', id, { menu_id: HOUSE_MENU_ID, service_date: date, service_type: 'comida', service_time: '14:00', position: 1 });
  const s1 = uuid(), s2 = uuid(), s3 = uuid(), s4 = uuid();
  await ok('commands', [
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg', item_id: riceItem }),
    insert('food.recipes', recipe, { name: 'Arroz blanco', category: 'guarnicion', base_servings: 10 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.menus', HOUSE_MENU_ID, { kind: 'casa', house_servings: 20 }),
    // Del 16 de octubre a las 14:00: por confirmar a las 16:00; para el worker, desde las 16:00 del 17.
    service(s1, '2026-10-16'), insert('food.menu_items', late, { service_id: s1, recipe_id: recipe, servings: 20 }),
    service(s2, '2026-10-16'), insert('food.menu_items', manual, { service_id: s2, recipe_id: recipe, servings: 10 }),
    service(s3, '2026-10-16'), insert('food.menu_items', retried, { service_id: s3, recipe_id: recipe, servings: 5 }),
    // Anterior a R5c: no se descuenta nunca.
    service(s4, '2026-10-01'), insert('food.menu_items', old, { service_id: s4, recipe_id: recipe, servings: 10 }),
    // Uno lo confirmó la app (a mano) y otro quedó anotado como automático sin llegar a Recursos (un fallo a medias).
    insert('food.consumptions', uuid(), { menu_item_id: manual, status: 'omitido' }),
    insert('food.consumptions', uuid(), { menu_item_id: retried, status: 'confirmado', automatic: true }),
  ]);
});
test.after(async () => { await app.close(); });

test('worker · se programa cada 15 minutos y se despierta solo si hay trabajo', async () => {
  assert.equal((await q(`select food.consumption_has_work() as w`))[0].w, true);
  assert.equal((await q(`select food.consumption_has_work() as w`))[0].w, true, 'sin efectos al preguntar');
  assert.deepEqual((await q(`select route, probe from core.scheduled_ticks where app = 'food'`)), [{ route: 'consumption/tick', probe: 'food.consumption_has_work' }]);
});

test('worker · anota y descuenta lo vencido; reintenta lo que se quedó a medias; repetir no hace nada', async () => {
  // La primera vuelta crea la cuenta de servicio `food` (núcleo, 0096); las siguientes la reutilizan.
  assert.equal((await q(`select count(*)::int as n from core.profiles where service_name = 'food'`))[0].n, 0);
  const out = await tick();
  assert.equal((await q(`select count(*)::int as n from core.profiles where service_name = 'food'`))[0].n, 1);
  assert.deepEqual([out.noted, out.consumed, out.skipped, out.errors], [1, 2, 0, []]);
  // 1 kg para 10 raciones → 2 kg para 20 y 0,5 kg para 5 (el reintento, sin volver a anotarlo).
  assert.deepEqual(await moved(late), [['consumo_servicio', -2]]);
  assert.deepEqual(await moved(retried), [['consumo_servicio', -0.5]]);
  assert.deepEqual(await moved(manual), [], 'lo que confirmó la app no se toca');
  assert.deepEqual(await moved(old), [], 'lo anterior al 15-10-2026 no se descuenta');
  const notes = await q(`select c.status, c.automatic, c.updated_by = p.user_id as by_service from food.consumptions c, core.profiles p
    where c.menu_item_id = $1 and p.service_name = 'food'`, [late]);
  assert.deepEqual(notes, [{ status: 'confirmado', automatic: true, by_service: true }]);

  const again = await tick();
  assert.deepEqual([again.noted, again.consumed, again.skipped], [0, 0, 0]);
  assert.equal((await q(`select food.consumption_has_work() as w`))[0].w, false);
  assert.equal((await q(`select count(*)::int as n from core.profiles where service_name = 'food'`))[0].n, 1, 'la cuenta se reutiliza');

  // Un dispositivo sin red confirmó el mismo plato antes de las 24 h y sincroniza ahora: `once` no descuenta otra vez.
  const late2 = await app.call('/api/v1/resources/commands', { body: { requestId: `cw-${++counter}`, operations: [{ op: 'call', procedure: 'resources.consume',
    args: { item_id: riceItem, quantity: 2, kind: 'consumo_servicio', source_app: 'food', source_ref: menuItemRef(late), once: true } }] } });
  assert.equal(late2.status, 200, JSON.stringify(late2.data));
  assert.equal(late2.data.results[0].result.skipped, 'already_consumed');
  assert.deepEqual(await moved(late), [['consumo_servicio', -2]]);
});
