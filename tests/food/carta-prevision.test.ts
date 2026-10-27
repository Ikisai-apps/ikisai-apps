/** Food · previsión de la carta (1110): unidades esperadas, reparto, estaciones, lecturas para Flow y lista de la compra. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { cartaAttendance, cartaPrevisionEmpty, distributeUnits, perPersonFromUnits, prepSplitOf, prepSplitProblem, unitsFromPerPerson, validateOperation } from '../../supabase/functions/_domain/food/mod.ts';

const CARTA = 'f00dca7a-0000-4000-8000-000000000001';
const LINE = (n: number) => `f00dca7a-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const SERRANO = LINE(1), CAPRESE = LINE(4), AGUA = LINE(9);
const TOMATE = '3a3d080c-417e-4174-a87f-9f28fc62ec90', PAN = '74545d77-5a6d-45c8-bced-3c23cabdb31f', JAMON = '1adffdcf-2981-409e-9341-42f2f9a965b1';
const AGUA_ITEM = 'fbd86e16-3bef-4dc0-b9a8-a4c9f139b72a';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, revision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision: revision, fields });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
async function ok(path: 'commands' | 'resources/commands', operations: unknown[]) {
  const res = await app.call(`/api/v1/${path}`, { body: { requestId: `prev-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const rev = async (table: string, id: string) => Number((await q(`select revision from ${table} where id = $1`, [id]))[0].revision);
const round = (n: unknown) => (n === null ? null : Math.round(Number(n) * 1e6) / 1e6);

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  // Los artículos de la barra los siembra la 0811 de Recursos; el tomate existe solo en producción: aquí se crea.
  if (!(await q(`select 1 from resources.items where id = $1`, [TOMATE])).length) {
    await ok('resources/commands', [insert('resources.items', TOMATE, { name: 'Tomate', kind: 'ingrediente', base_unit: 'kg' })]);
  }
  assert.ok((await q(`select food.seed_carta_octubre() as n`))[0].n > 0);
});
test.after(async () => { await app.close(); });

test('estaciones · la semilla las pasa de la nota a la columna', async () => {
  assert.ok((await q(`select food.backfill_carta_stations() as n`))[0].n > 0);
  assert.equal((await q(`select food.backfill_carta_stations() as n`))[0].n, 0, 'una sola vez');
  const rows = await q(`select g.name, ri.station from food.recipe_ingredients ri join food.ingredients g on g.id = ri.ingredient_id
    join food.carta_lines l on l.recipe_id = ri.recipe_id where l.id = $1 order by ri.position`, [SERRANO]);
  assert.deepEqual(rows.map((r) => [r.name, r.station]), [['Pan de montadito', null], ['Tomate', 2], ['Jamón serrano', 2], ['Aceite de oliva', 3]]);
});

test('previsión · unidades esperadas y reparto: la lectura por línea y la de totales para Flow', async () => {
  await ok('commands', [
    update('food.carta_lines', SERRANO, await rev('food.carta_lines', SERRANO), { expected_units: 100, per_person: 0.5 }),
    update('food.carta_lines', CAPRESE, await rev('food.carta_lines', CAPRESE), { expected_units: 50 }),
    update('food.carta_lines', AGUA, await rev('food.carta_lines', AGUA), { expected_units: 60 }),
    update('food.menus', CARTA, await rev('food.menus', CARTA), { prep_split: { mesa: 30, nevera: 20, fresco: 50 }, expected_attendance: 200 }),
  ]);
  assert.deepEqual((await q(`select app from core.allowed_reads where name in ('food.carta_prep_projection', 'food.carta_prep_totals_projection') order by name, app`)).map((r) => r.app),
    ['flow', 'food', 'flow', 'food']);

  const serrano = await q(`select name, unit, per_unit, need_total, mesa, nevera, fresco, station, convertible, component_key, item_id
    from food.carta_prep_projection where line_id = $1 order by name`, [SERRANO]);
  const jamon = serrano.find((r) => r.name === 'Jamón serrano')!;
  assert.deepEqual([jamon.unit, round(jamon.per_unit), round(jamon.need_total), round(jamon.mesa), round(jamon.nevera), round(jamon.fresco), jamon.station, jamon.convertible, jamon.component_key],
    ['kg', 0.015, 1.5, 0.45, 0.3, 0.75, 2, true, JAMON]);
  const pan = serrano.find((r) => r.name === 'Pan de montadito')!;
  assert.deepEqual([pan.unit, round(pan.need_total)], ['ud', 100]);

  const agua = (await q(`select need_total, mesa, nevera, fresco, station, convertible, component_key from food.carta_prep_projection where line_id = $1`, [AGUA]))[0];
  assert.deepEqual([round(agua.need_total), agua.mesa, agua.nevera, agua.fresco, agua.station, agua.convertible, agua.component_key], [60, null, null, null, null, true, AGUA_ITEM]);

  // Totales: el tomate va en Serrano (100 × 15 g) y en Caprese (50 × 15 g) → 2,25 kg; el pan, 150 ud.
  const totals = Object.fromEntries((await q(`select component_key, need_total, mesa, convertible, station from food.carta_prep_totals_projection where menu_id = $1`, [CARTA]))
    .map((r) => [r.component_key, r]));
  assert.deepEqual([round(totals[TOMATE].need_total), round(totals[TOMATE].mesa), totals[TOMATE].convertible, totals[TOMATE].station], [2.25, 0.675, true, 2]);
  assert.equal(round(totals[PAN].need_total), 150);
  assert.equal(round(totals[AGUA_ITEM].need_total), 60);
});

test('previsión · rodajas: sin la conversión de la ficha no hay cantidad; con ella, sí', async () => {
  const recipe = uuid(), tomatoIngredient = (await q(`select id from food.ingredients where item_id = $1`, [TOMATE]))[0].id, line = uuid();
  await ok('commands', [
    insert('food.recipes', recipe, { name: 'Montadito de tomate en rodajas', category: 'entrante', base_servings: 1 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: tomatoIngredient, quantity: 2, unit: 'unidad', notes: 'rodaja', station: 2 }),
  ]);
  // Gourmet está completo en la semilla (α–δ): va en barra, con un código libre.
  await ok('commands', [insert('food.carta_lines', line, { menu_id: CARTA, recipe_id: recipe, scope: 'barra', code: 'β', sale_price_cents: 200, expected_units: 10 })]);
  const before = (await q(`select per_unit, need_total, convertible from food.carta_prep_projection where line_id = $1`, [line]))[0];
  assert.deepEqual([before.per_unit, before.need_total, before.convertible], [null, null, false]);
  assert.equal((await q(`select convertible from food.carta_prep_totals_projection where component_key = $1`, [TOMATE]))[0].convertible, false, 'en totales, falso si alguna línea no se convierte');
  // La conversión «rodaja» en la ficha del tomate (sin proveedor): 1 rodaja = 0,02 kg. La de la pieza entera no vale para rodajas.
  await ok('resources/commands', [insert('resources.item_units', uuid(), { item_id: TOMATE, unit: 'ud', factor: 0.15 })]);
  assert.equal((await q(`select convertible from food.carta_prep_projection where line_id = $1`, [line]))[0].convertible, false);
  await ok('resources/commands', [insert('resources.item_units', uuid(), { item_id: TOMATE, unit: 'rodaja', factor: 0.02 })]);
  const after = (await q(`select per_unit, need_total, convertible from food.carta_prep_projection where line_id = $1`, [line]))[0];
  assert.deepEqual([round(after.per_unit), round(after.need_total), after.convertible], [0.04, 0.4, true]);
});

test('compra · la lista de una carta: unidades esperadas × lo que gasta cada una; las bebidas entran por su ingrediente', async () => {
  const list = uuid();
  await ok('commands', [{ op: 'call', procedure: 'food.regenerate_shopping', args: { menu_id: CARTA, list_id: list } }]);
  const items = Object.fromEntries((await q(`select g.name, i.required_quantity::float8 as q, i.unit from food.shopping_list_items i
    join food.ingredients g on g.id = i.ingredient_id where i.shopping_list_id = $1 and i.deleted_at is null and not i.restock`, [list])).map((r) => [r.name, [r.q, r.unit]]));
  assert.deepEqual(items['Pan de montadito'], [150, 'unidad'], '100 serranos y 50 capreses (el de rodajas no lleva pan)');
  assert.deepEqual(items['Jamón serrano'], [1.5, 'kg']);
  assert.deepEqual(items['Agua, botella pequeña'], [60, 'unidad'], 'la bebida, con su ingrediente creado y enlazado');
  assert.equal((await q(`select item_id from food.ingredients where name = 'Agua, botella pequeña'`))[0].item_id, AGUA_ITEM);
  // Regenerar no duplica el ingrediente de la bebida.
  await ok('commands', [{ op: 'call', procedure: 'food.regenerate_shopping', args: { menu_id: CARTA, list_id: list } }]);
  assert.equal((await q(`select count(*)::int as n from food.ingredients where item_id = $1 and deleted_at is null`, [AGUA_ITEM]))[0].n, 1);
});

test('dominio · el reparto', () => {
  assert.equal(prepSplitProblem({ mesa: 30, nevera: 20, fresco: 50 }), null);
  assert.equal(prepSplitProblem(null), null);
  assert.match(prepSplitProblem({ mesa: 30, nevera: 20, fresco: 40 })!, /100/);
  assert.match(prepSplitProblem({ mesa: 30, nevera: 20 })!, /porcentaje/);
  assert.deepEqual(prepSplitOf(null), { mesa: 30, nevera: 20, fresco: 50 });
  assert.equal(validateOperation({ op: 'update', table: 'food.menus', fields: { prep_split: { mesa: 50, nevera: 50, fresco: 50 } } })?.details.field, 'prep_split');
  assert.equal(validateOperation({ op: 'update', table: 'food.carta_lines', fields: { expected_units: -1 } })?.details.field, 'expected_units');
  assert.equal(validateOperation({ op: 'update', table: 'food.recipe_ingredients', fields: { station: 5 } })?.details.field, 'station');
  assert.equal(validateOperation({ op: 'update', table: 'food.carta_lines', fields: { per_person: -0.5 } })?.details.field, 'per_person');
  assert.equal(validateOperation({ op: 'update', table: 'food.menus', fields: { expected_attendance: 1.5 } })?.details.field, 'expected_attendance');
  // Máximos a cubrir: hacia arriba.
  assert.equal(unitsFromPerPerson(0.5, 199), 100);
  assert.equal(unitsFromPerPerson(0.3, 10), 3);
  assert.equal(perPersonFromUnits(100, 300), 0.333);
  assert.equal(perPersonFromUnits(100, 0), null);
  assert.equal(cartaAttendance({ expected_attendance: 250 }, 180), 250);
  assert.equal(cartaAttendance({ expected_attendance: null }, 180), 180);
});

test('relleno · repartir un total entre líneas y la previsión de partida de la carta de octubre', async () => {
  assert.deepEqual(distributeUnits(400, 8), [50, 50, 50, 50, 50, 50, 50, 50]);
  assert.deepEqual(distributeUnits(10, 3), [4, 3, 3], 'los restos, a las primeras');
  assert.deepEqual(distributeUnits(100, 3, [2, 1, 1]), [50, 25, 25], 'según la previsión que ya hay');
  assert.deepEqual(distributeUnits(9, 3, [0, 0, 0]), [3, 3, 3], 'sin pesos, a partes iguales');
  assert.equal(distributeUnits(7, 4).reduce((a, b) => a + b, 0), 7);
  // La de partida solo rellena las líneas que siguen a 0: el Serrano ya tenía 100 (prueba de arriba) y no se toca.
  assert.equal((await q(`select food.seed_carta_octubre_prevision() as n`))[0].n > 0, true);
  const units = Object.fromEntries((await q(`select id, expected_units from food.carta_lines where menu_id = $1 and deleted_at is null`, [CARTA])).map((r) => [r.id, r.expected_units]));
  assert.equal(units[SERRANO], 100);
  assert.equal(units[LINE(2)], 50);
  assert.equal(units[AGUA], 60, 'el agua ya tenía 60');
  assert.equal(units[LINE(10)], 100);
  assert.equal((await q(`select food.seed_carta_octubre_prevision() as n`))[0].n, 0, 'una sola vez');
  const lines = await q(`select menu_id, active, deleted_at, expected_units from food.carta_lines where menu_id = $1`, [CARTA]);
  assert.equal(cartaPrevisionEmpty(lines, CARTA), false);
  assert.equal(cartaPrevisionEmpty(lines.map((l) => ({ ...l, expected_units: 0 })), CARTA), true);
});
