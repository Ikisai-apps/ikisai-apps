/** Food · R5a: enlace de ingredientes y maquinaria con artículos de Recursos, contra PGlite (docs/food/API.md §2.7). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { equipmentRef, ingredientRef, linkOperations, linkPlan, type ResourceItem } from '../../supabase/functions/_domain/food/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });

async function commit(path: 'commands' | 'resources/commands', operations: unknown[]) {
  return app.call(`/api/v1/${path}`, { body: { requestId: `rl-${++counter}`, operations } });
}
async function ok(path: 'commands' | 'resources/commands', operations: unknown[]) {
  const res = await commit(path, operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function rows(path: string, table: string) {
  const snap = await app.call(`/api/v1/${path}snapshot?tables=${table}`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows as Array<Record<string, any>>;
}
/** Lo que hace la app al abrirse: plan, lote de Recursos y lote de Food. */
async function link() {
  const [ingredients, equipment, items] = await Promise.all([rows('', 'food.ingredients'), rows('', 'food.equipment'), rows('resources/', 'resources.items')]);
  const steps = linkPlan(ingredients as never, equipment as never, items as unknown as ResourceItem[]);
  const ops = linkOperations(steps, {
    items: new Map(items.map((i) => [i.id, i.revision])), ingredients: new Map(ingredients.map((i) => [i.id, i.revision])), equipment: new Map(equipment.map((e) => [e.id, e.revision])),
  });
  if (ops.resources.length) await ok('resources/commands', ops.resources);
  if (ops.food.length) await ok('commands', ops.food);
  return steps;
}

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

const tomato = uuid(), salt = uuid(), pepper = uuid(), oven = uuid(), mixer = uuid();

test('enlace · crea los artículos que faltan, adopta los del mismo nombre y deja todo enlazado; repetir no hace nada', async () => {
  // En Recursos ya hay «Sal» (de otra app) y un «Horno» que es material de obra, no de cocina.
  const existingSalt = uuid(), brick = uuid();
  await ok('resources/commands', [
    insert('resources.items', existingSalt, { name: 'sal', kind: 'ingrediente', base_unit: 'kg' }),
    insert('resources.items', brick, { name: 'Horno', kind: 'material', base_unit: 'ud' }),
  ]);
  await ok('commands', [
    insert('food.ingredients', tomato, { name: 'Tomate', preferred_unit: 'kg' }),
    insert('food.ingredients', salt, { name: 'Sal', preferred_unit: 'g' }),
    insert('food.ingredients', pepper, { name: 'Pimiento', preferred_unit: 'unidad', active: false }),
    insert('food.equipment', oven, { name: 'Horno', category: 'Horno', capacity: '70 cm', status: 'averiado' }),
    insert('food.equipment', mixer, { name: 'Batidora', location: 'Despensa (cambiar)' }),
  ]);

  const steps = await link();
  assert.deepEqual(steps.map((s) => s.kind).sort(), ['adopt', 'create', 'create', 'create', 'create', 'link', 'link', 'link', 'link', 'link']);
  const items = await rows('resources/', 'resources.items');
  const ingredients = new Map((await rows('', 'food.ingredients')).map((i) => [i.id, i]));
  const equipment = new Map((await rows('', 'food.equipment')).map((e) => [e.id, e]));
  const itemOf = (id: string | undefined) => items.find((i) => i.id === id)!;

  assert.deepEqual(Object.fromEntries(['name', 'kind', 'base_unit', 'active', 'source_refs'].map((k) => [k, itemOf(ingredients.get(tomato)!.item_id)[k]])),
    { name: 'Tomate', kind: 'ingrediente', base_unit: 'kg', active: true, source_refs: [ingredientRef(tomato)] });
  assert.equal(itemOf(ingredients.get(pepper)!.item_id).base_unit, 'ud');
  assert.equal(itemOf(ingredients.get(pepper)!.item_id).active, false);
  // «Sal»: el artículo que ya existía, con la referencia de Food añadida.
  assert.equal(ingredients.get(salt)!.item_id, existingSalt);
  assert.deepEqual(itemOf(existingSalt).source_refs, [ingredientRef(salt)]);
  // «Horno»: el material de obra no sirve; el de cocina se crea aparte, con su estado y capacidad.
  const ovenItem = itemOf(equipment.get(oven)!.item_id);
  assert.deepEqual([ovenItem.name, ovenItem.kind, ovenItem.category, ovenItem.attributes], ['Horno (cocina)', 'maquina', 'Horno', { status: 'averiado', capacity: '70 cm' }]);
  assert.deepEqual(itemOf(equipment.get(mixer)!.item_id).source_refs, [equipmentRef(mixer)]);

  assert.deepEqual(await link(), [], 'repetir no hace nada');
});

test('enlace · Food sigue mandando: renombrar, desactivar o cambiar el estado se copia al artículo', async () => {
  const ingredient = (await rows('', 'food.ingredients')).find((i) => i.id === tomato)!;
  const machine = (await rows('', 'food.equipment')).find((e) => e.id === oven)!;
  await ok('commands', [
    { op: 'update', table: 'food.ingredients', id: tomato, expectedRevision: ingredient.revision, fields: { name: 'Tomate pera', active: false } },
    { op: 'update', table: 'food.equipment', id: oven, expectedRevision: machine.revision, fields: { status: 'operativo', capacity: null } },
  ]);
  const steps = await link();
  assert.deepEqual(steps.map((s) => s.kind), ['sync', 'sync']);
  const items = await rows('resources/', 'resources.items');
  assert.deepEqual(items.filter((i) => i.id === ingredient.item_id).map((i) => [i.name, i.active]), [['Tomate pera', false]]);
  assert.deepEqual(items.find((i) => i.id === machine.item_id)!.attributes, { status: 'operativo' });
  assert.deepEqual(await link(), []);
});

test('enlace · el servidor comprueba el artículo: que exista, que sea del tipo adecuado y que no esté ya enlazado', async () => {
  const items = await rows('resources/', 'resources.items');
  const tomatoItem = (await rows('', 'food.ingredients')).find((i) => i.id === tomato)!.item_id;
  const ovenItem = (await rows('', 'food.equipment')).find((e) => e.id === oven)!.item_id;
  const reason = async (operations: unknown[]) => {
    const res = await commit('commands', operations);
    assert.equal(res.status, 422, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'INVALID_ITEM');
    return res.data.error.details.reason;
  };
  assert.equal(await reason([insert('food.ingredients', uuid(), { name: 'Ajo', item_id: uuid() })]), 'not_found');
  assert.equal(await reason([insert('food.ingredients', uuid(), { name: 'Ajo', item_id: ovenItem })]), 'kind');
  assert.equal(await reason([insert('food.equipment', uuid(), { name: 'Cazo', item_id: tomatoItem })]), 'kind');
  assert.equal(await reason([insert('food.ingredients', uuid(), { name: 'Tomate cherry', item_id: tomatoItem })]), 'linked');
  assert.ok(items.length >= 5);
});

test('enlace · un ingrediente que nace enlazado desde el recetario (artículo de otra app) recibe su referencia', async () => {
  const oil = uuid(), ingredient = uuid();
  await ok('resources/commands', [insert('resources.items', oil, { name: 'Aceite de oliva', kind: 'ingrediente', base_unit: 'l' })]);
  await ok('commands', [insert('food.ingredients', ingredient, { name: 'Aceite de oliva', preferred_unit: 'l', item_id: oil })]);
  assert.deepEqual((await link()).map((s) => [s.kind, 'fields' in s ? s.fields : null]), [['sync', { source_refs: [ingredientRef(ingredient)] }]]);
  assert.deepEqual(await link(), []);
});
