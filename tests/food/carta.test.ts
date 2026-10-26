/** Food · la carta (1109): tipo de menú, líneas, proyección para Flow, ventas idempotentes y stock, contra PGlite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { cartaMargin, cartaStockOperations, cartaStockRef, validateOperation } from '../../supabase/functions/_domain/food/mod.ts';
import { seedBookingEvent } from './helpers.ts';

const CARTA = 'f00dca7a-0000-4000-8000-000000000001';
const LINE = (n: number) => `f00dca7a-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const SERRANO = LINE(1), DOBLADILLO = LINE(2), AGUA = LINE(9);
const ITEMS = {
  tomate: '3a3d080c-417e-4174-a87f-9f28fc62ec90', pan: '74545d77-5a6d-45c8-bced-3c23cabdb31f', jamon: '1adffdcf-2981-409e-9341-42f2f9a965b1',
  aceite: 'ff5b3629-2241-451d-a4d2-e3930b02a60b', agua: 'fbd86e16-3bef-4dc0-b9a8-a4c9f139b72a',
};
// Los que crea Core en 0811 (resources_barra_items): aquí, los que la semilla necesita para enlazar.
const BAR_ITEMS: Array<[string, string, string, string]> = [
  [ITEMS.tomate, 'Tomate', 'ingrediente', 'kg'], [ITEMS.pan, 'Pan de montadito', 'ingrediente', 'ud'], [ITEMS.jamon, 'Jamón serrano', 'ingrediente', 'kg'],
  [ITEMS.aceite, 'Aceite de oliva', 'ingrediente', 'l'], ['5520b406-e3d9-4fd3-aa9b-d8ead2dcc0b5', 'Atún preparado', 'ingrediente', 'kg'],
  ['3dfb175a-c610-4218-be00-a12faaf1490a', 'Mayonesa', 'ingrediente', 'kg'], ['4517133e-aa0f-44c6-abf0-e5cf90f51453', 'Hummus', 'ingrediente', 'kg'],
  ['014ad81f-fa01-4f85-b580-e402b1ab5d4d', 'Tomate seco en aceite', 'ingrediente', 'kg'], ['6866fc2f-c9fb-4481-a1a6-cf967a83fb9e', 'Rúcula', 'ingrediente', 'kg'],
  ['073894c4-5a8e-4315-8726-7efb86b0d07b', 'Queso crema', 'ingrediente', 'kg'], ['75db942c-7514-42a8-98fb-5bf3cc3f9959', 'Pesto', 'ingrediente', 'kg'],
  ['fbd2d944-9aec-4263-9bfc-bca1bdb8d8b8', 'Albahaca fresca', 'ingrediente', 'kg'], ['0bf532b6-eb3f-4a0e-bb86-84541e81a6d5', 'Paté de campaña', 'ingrediente', 'kg'],
  ['00656f8a-8d68-424c-8b94-efc2ac0c0320', 'Cebolla caramelizada', 'ingrediente', 'kg'], ['34d445e9-e9f2-4b0c-a126-d936d1e64642', 'Tomillo', 'ingrediente', 'kg'],
  ['1f4cabf9-29ed-4fee-a033-cdf2947443f8', 'Queso payoyo', 'ingrediente', 'kg'], ['b090e0e8-1195-40cf-af82-4e55b7f17eb1', 'Miel', 'ingrediente', 'kg'],
  ['8955a89a-e23c-4d4c-b493-0c441aaa9f66', 'Nueces troceadas', 'ingrediente', 'kg'], ['330baf65-1bc3-4d90-be95-b4517865e8c4', 'Queso de cabra', 'ingrediente', 'kg'],
  ['15c1535b-164c-4f8d-9d0d-90e74c058bbb', 'Mermelada de tomate', 'ingrediente', 'kg'], ['008b2489-7740-451b-ae2a-2ab54ed726f2', 'Salmón ahumado', 'ingrediente', 'kg'],
  ['039c4efc-49fb-4f9f-a157-486dc3828e3e', 'Eneldo', 'ingrediente', 'kg'], [ITEMS.agua, 'Agua, botella pequeña', 'bebida', 'ud'],
  ['426bcf0c-d1ae-4e4c-bc67-b7bf35be6776', 'Refresco, lata', 'bebida', 'ud'], ['9a49b68d-fbcd-4270-8043-9cfc2441dd34', 'Cerveza, lata', 'bebida', 'ud'],
  ['cf2b0ff7-21e1-4f61-8b93-a007fdb611c2', 'Café / infusión', 'bebida', 'ud'], ['2268636f-6764-40e6-a703-9ed13aad8ee4', 'Palomitas', 'consumible', 'ud'],
];

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
let kitchen = '';
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const send = (path: 'commands' | 'resources/commands', operations: unknown[], requestId = `carta-${++counter}`) =>
  app.call(`/api/v1/${path}`, { body: { requestId, operations } });
async function ok(path: 'commands' | 'resources/commands', operations: unknown[], requestId?: string) {
  const res = await send(path, operations, requestId);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rejected(operations: unknown[], code: string) {
  const res = await send('commands', operations);
  assert.notEqual(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}
const sales = (lines: Array<[string, number]>, day = '2026-10-31') =>
  ({ op: 'call', procedure: 'food.record_carta_sales', args: { menu_id: CARTA, day, lines: lines.map(([line_id, quantity]) => ({ line_id, quantity })) } });
const moved = async (day = '2026-10-31') => Object.fromEntries((await q(`select item_id, sum(quantity)::float8 as q from resources.movements
  where source_app = 'food' and source_ref = $1 and deleted_at is null group by item_id`, [cartaStockRef(CARTA, day)])).map((r) => [r.item_id, Math.round(r.q * 1e6) / 1e6]));

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  const altura = (await q(`select id from resources.spaces where kind = 'altura' and name = 'Altura 1' and deleted_at is null`))[0].id;
  const house = uuid();
  kitchen = uuid();
  const existing = new Set((await q(`select id from resources.items`)).map((r) => r.id));
  await ok('resources/commands', [
    insert('resources.spaces', house, { kind: 'edificio', name: 'Casa', parent_id: altura }),
    insert('resources.spaces', kitchen, { kind: 'cocina', name: 'Cocina', parent_id: house }),
    ...BAR_ITEMS.filter(([id]) => !existing.has(id)).map(([id, name, kind, base]) => insert('resources.items', id, { name, kind, base_unit: base })),
    // Coste medio: pan 0,30 €/ud; tomate 2 €/kg; jamón 20 €/kg; aceite 8 €/l; agua 0,25 €/ud.
    insert('resources.movements', uuid(), { item_id: ITEMS.pan, space_id: kitchen, quantity: 100, kind: 'entrada_manual', unit_cost: 0.3 }),
    insert('resources.movements', uuid(), { item_id: ITEMS.tomate, space_id: kitchen, quantity: 5, kind: 'entrada_manual', unit_cost: 2 }),
    insert('resources.movements', uuid(), { item_id: ITEMS.jamon, space_id: kitchen, quantity: 2, kind: 'entrada_manual', unit_cost: 20 }),
    insert('resources.movements', uuid(), { item_id: ITEMS.aceite, space_id: kitchen, quantity: 5, kind: 'entrada_manual', unit_cost: 8 }),
    insert('resources.movements', uuid(), { item_id: ITEMS.agua, space_id: kitchen, quantity: 48, kind: 'entrada_manual', unit_cost: 0.25 }),
  ]);
});
test.after(async () => { await app.close(); });

test('semilla · «Barra · Evento de octubre»: 8 montaditos con su receta, 4 bebidas y palomitas; una sola vez', async () => {
  assert.ok((await q(`select food.seed_carta_octubre() as n`))[0].n > 0);
  assert.equal((await q(`select food.seed_carta_octubre() as n`))[0].n, 0, 'repetirla no hace nada');
  const menu = (await q(`select kind, name, event_id, status from food.menus where id = $1`, [CARTA]))[0];
  assert.deepEqual(menu, { kind: 'carta', name: 'Barra · Evento de octubre', event_id: null, status: 'borrador' });
  const rows = await q(`select scope, code, name, sale_price_cents from food.carta_projection where menu_id = $1 order by position`, [CARTA]);
  assert.deepEqual(rows.map((r) => `${r.scope}:${r.code} ${r.name} ${r.sale_price_cents}`), [
    'clasico:A Serrano 250', 'clasico:B Dobladillo 250', 'clasico:C Mediterráneo 250', 'clasico:D Caprese 250',
    'gourmet:α Campero 300', 'gourmet:β Payoyo 300', 'gourmet:γ Cabra dulce 300', 'gourmet:δ Nórdico 300',
    'barra:A Agua, botella pequeña 100', 'barra:B Refresco, lata 200', 'barra:C Cerveza, lata 200', 'barra:D Café / infusión 150', 'barra:α Palomitas 150',
  ]);
  // Receta con pan, sus componentes y las estaciones como pasos; en prueba, sin alérgenos revisados.
  const recipe = (await q(`select r.name, r.status, r.allergens, r.allergens_checked, r.method_steps, r.public_description
    from food.recipes r join food.carta_lines l on l.recipe_id = r.id where l.id = $1`, [SERRANO]))[0];
  assert.equal(recipe.name, 'Montadito Serrano');
  assert.equal(recipe.status, 'en_prueba');
  assert.deepEqual([recipe.allergens, recipe.allergens_checked], [[], false]);
  assert.deepEqual(recipe.method_steps.map((s: any) => s.text), ['2 · Colocar: tomate fresco, jamón serrano', '3 · Dosificar: aceite de oliva']);
  assert.equal(recipe.public_description, 'Tomate fresco, jamón serrano, aceite de oliva');
  const ingredients = await q(`select g.name, ri.quantity::float8 as quantity, ri.unit, g.item_id from food.recipe_ingredients ri
    join food.ingredients g on g.id = ri.ingredient_id join food.carta_lines l on l.recipe_id = ri.recipe_id where l.id = $1 order by ri.position`, [SERRANO]);
  assert.deepEqual(ingredients.map((i) => [i.name, i.quantity, i.unit]), [['Pan de montadito', 1, 'unidad'], ['Tomate', 15, 'g'], ['Jamón serrano', 15, 'g'], ['Aceite de oliva', 3, 'ml']]);
  assert.ok(ingredients.every((i) => i.item_id), 'todos enlazados a su artículo de Recursos');
});

test('proyección · la lee Flow, con coste desde el inventario, alérgenos sin revisar e imagen', async () => {
  assert.deepEqual(await q(`select app, kind from core.allowed_reads where name = 'food.carta_projection' order by app`),
    [{ app: 'flow', kind: 'view' }, { app: 'food', kind: 'view' }]);
  const row = (name: string) => q(`select * from food.carta_projection where line_id = $1`, [name]).then((r) => r[0]);
  const serrano = await row(SERRANO);
  // 0,30 de pan + 15 g × 2 €/kg + 15 g × 20 €/kg + 3 ml × 8 €/l = 0,654 € → 65 céntimos.
  assert.equal(serrano.cost_cents, 65);
  assert.deepEqual([serrano.allergens, serrano.allergens_checked, serrano.image_key, serrano.menu_name], [[], false, 'montaditos/serrano', 'Barra · Evento de octubre']);
  assert.equal((await row(AGUA)).cost_cents, 25);
  assert.equal((await row(DOBLADILLO)).cost_cents, null, 'sin precio de algún ingrediente, sin coste');
  // Por la API de lecturas, con filtro, como la consulta Flow.
  const res = await app.call(`/api/v1/read/food.carta_projection?where[menu_id]=${CARTA}`, { method: 'GET' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.rows.length, 13);
  assert.deepEqual(cartaMargin(250, 65), { cents: 185, ratio: 0.74 });
  assert.equal(cartaMargin(250, null), null);
});

test('ventas · descuentan el stock; repetir el día sustituye; el mismo requestId devuelve el recibo', async () => {
  await ok('commands', [sales([[SERRANO, 10], [AGUA, 5]])], 'flow-cierre-1');
  assert.deepEqual((await q(`select line_id, quantity from food.carta_sales where menu_id = $1 and day = '2026-10-31' order by line_id`, [CARTA]))
    .map((r) => [r.line_id, r.quantity]), [[SERRANO, 10], [AGUA, 5]]);
  assert.deepEqual(await moved(), { [ITEMS.pan]: -10, [ITEMS.tomate]: -0.15, [ITEMS.jamon]: -0.15, [ITEMS.aceite]: -0.03, [ITEMS.agua]: -5 });

  // El mismo requestId: el recibo, sin tocar nada.
  const again = await send('commands', [sales([[SERRANO, 10], [AGUA, 5]])], 'flow-cierre-1');
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual((await moved())[ITEMS.pan], -10);

  // Otra llamada el mismo día sustituye: 4 serranos, el agua no llega (pasa a 0). La diferencia vuelve al stock.
  await ok('commands', [sales([[SERRANO, 4]])], 'flow-cierre-2');
  assert.deepEqual((await q(`select line_id, quantity from food.carta_sales where menu_id = $1 and day = '2026-10-31' order by line_id`, [CARTA]))
    .map((r) => [r.line_id, r.quantity]), [[SERRANO, 4], [AGUA, 0]]);
  assert.deepEqual(await moved(), { [ITEMS.pan]: -4, [ITEMS.tomate]: -0.06, [ITEMS.jamon]: -0.06, [ITEMS.aceite]: -0.012, [ITEMS.agua]: 0 });

  // Reintentar el stock a mano no cambia nada si ya cuadra.
  const retry = await app.call('/api/v1/carta/stock', { body: { menuId: CARTA, day: '2026-10-31' } });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.deepEqual([retry.data.consumed, retry.data.returned], [0, 0]);
  // Otro día va aparte.
  await ok('commands', [sales([[AGUA, 2]], '2026-11-01')]);
  assert.deepEqual(await moved('2026-11-01'), { [ITEMS.agua]: -2 });
});

test('ventas · errores: línea de otra carta, cantidad, día, línea repetida y escribir las ventas a mano', async () => {
  const other = uuid(), otherLine = uuid();
  await ok('commands', [insert('food.menus', other, { kind: 'carta', name: 'Otra carta' }),
    insert('food.carta_lines', otherLine, { menu_id: other, item_id: ITEMS.agua, scope: 'barra', code: 'A', sale_price_cents: 120 })]);
  assert.equal((await rejected([sales([[otherLine, 1]])], 'LINE_NOT_IN_CARTA')).details.line_id, otherLine);
  assert.equal((await rejected([sales([[SERRANO, -1]])], 'INVALID_OPERATION')).details.argument, 'quantity');
  assert.equal((await rejected([sales([[SERRANO, 1.5]])], 'INVALID_OPERATION')).details.argument, 'quantity');
  assert.equal((await rejected([sales([[SERRANO, 1]], '2026-02-30')], 'INVALID_OPERATION')).details.argument, 'day');
  assert.equal((await rejected([sales([[SERRANO, 1], [SERRANO, 2]])], 'INVALID_OPERATION')).details.argument, 'lines');
  await rejected([{ op: 'call', procedure: 'food.record_carta_sales', args: { menu_id: uuid(), day: '2026-10-31', lines: [] } }], 'CARTA_NOT_FOUND');
  await rejected([insert('food.carta_sales', uuid(), { menu_id: CARTA, line_id: SERRANO, day: '2026-10-30', quantity: 3 })], 'INVALID_FIELDS');
  // Aunque pasara la Edge, la base solo deja escribirlas al procedimiento.
  await assert.rejects(q(`insert into food.carta_sales (menu_id, line_id, day, quantity) values ($1, $2, '2026-10-30', 1)`, [CARTA, SERRANO]), /PROCEDURE_ONLY/);
});

test('carta · reglas: código único por ámbito, receta o artículo, sin servicios ni estados, y una por evento junto al menú cerrado', async () => {
  const dup = await rejected([insert('food.carta_lines', uuid(), { menu_id: CARTA, item_id: ITEMS.agua, scope: 'barra', code: 'A', sale_price_cents: 100 })], 'CONSTRAINT_VIOLATION');
  assert.ok(dup);
  // El mismo código en otro ámbito sí (A de clásicos y A de barra ya conviven en la semilla).
  await rejected([insert('food.carta_lines', uuid(), { menu_id: CARTA, scope: 'barra', code: 'β', sale_price_cents: 100 })], 'CONSTRAINT_VIOLATION');
  await rejected([insert('food.carta_lines', uuid(), { menu_id: CARTA, item_id: uuid(), scope: 'barra', code: 'β', sale_price_cents: 100 })], 'INVALID_ITEM');
  await rejected([insert('food.menu_services', uuid(), { menu_id: CARTA, service_date: '2026-10-31', service_type: 'comida', position: 1 })], 'CARTA_MENU');
  const rev = (await q(`select revision from food.menus where id = $1`, [CARTA]))[0].revision;
  await rejected([{ op: 'call', procedure: 'food.set_menu_status', args: { menu_id: CARTA, expectedRevision: Number(rev), status: 'revisar' } }], 'CARTA_MENU');
  await rejected([insert('food.menus', uuid(), { kind: 'carta' })], 'INVALID_FIELDS');

  // Cambiar el precio y desactivar: queda en el historial con su autor.
  const line = (await q(`select revision from food.carta_lines where id = $1`, [AGUA]))[0];
  await ok('commands', [{ op: 'update', table: 'food.carta_lines', id: AGUA, expectedRevision: Number(line.revision), fields: { sale_price_cents: 120, active: false } }]);
  const change = (await q(`select actor_id, before->>'sale_price_cents' as before, after->>'sale_price_cents' as after from core.changes
    where app = 'food' and table_name = 'carta_lines' and row_id = $1 and op = 'update' order by cursor desc limit 1`, [AGUA]))[0];
  assert.deepEqual([change.before, change.after, Boolean(change.actor_id)], ['100', '120', true]);
  assert.equal((await q(`select active from food.carta_projection where line_id = $1`, [AGUA]))[0].active, false);

  // Un evento admite su menú cerrado y una carta; una segunda carta, no.
  const event = await seedBookingEvent(app, { title: 'Retiro de prueba', start: '2026-10-30', end: '2026-11-01' });
  const revision = Number((await q(`select event_revision from booking.food_event_projection where event_id = $1`, [event]))[0].event_revision);
  await ok('commands', [insert('food.menus', uuid(), { event_id: event, source_event_revision: revision })]);
  const carta = uuid();
  await ok('commands', [insert('food.menus', carta, { kind: 'carta', name: 'Barra del retiro', event_id: event })]);
  assert.equal((await rejected([insert('food.menus', uuid(), { kind: 'carta', name: 'Otra', event_id: event })], 'MENU_EXISTS')).details.kind, 'carta');
  assert.equal((await q(`select event_id from food.carta_projection where menu_id = $1`, [carta])).length, 0, 'sin líneas no sale');
});

test('dominio · validación de la carta y operaciones de stock', () => {
  assert.equal(validateOperation({ op: 'insert', table: 'food.menus', fields: { kind: 'carta' } })?.details.field, 'name');
  assert.equal(validateOperation({ op: 'insert', table: 'food.menus', fields: { kind: 'carta', name: 'Barra', house_servings: 3 } })?.details.field, 'house_servings');
  assert.equal(validateOperation({ op: 'insert', table: 'food.carta_lines', fields: { menu_id: CARTA, scope: 'barra', code: 'E', sale_price_cents: 1 } })?.details.field, 'code');
  assert.equal(validateOperation({ op: 'update', table: 'food.carta_lines', fields: { recipe_id: SERRANO } })?.code, 'IMMUTABLE_FIELD');
  const plan = { menu_id: CARTA, day: '2026-10-31', source_ref: 'x', unconverted: [], kitchen: ['k'],
    items: [{ item_id: 'a', target: -3, current: -1, default_space_id: null }, { item_id: 'b', target: -1, current: -4, default_space_id: 's' },
      { item_id: 'c', target: -2, current: -2, default_space_id: null }] };
  assert.deepEqual(cartaStockOperations(plan).operations, [
    { kind: 'consume', itemId: 'a', quantity: 2 }, { kind: 'return', itemId: 'b', quantity: 3, spaceId: 's' }]);
});
