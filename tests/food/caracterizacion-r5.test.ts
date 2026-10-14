/**
 * Food · caracterización antes de R5 (RECURSOS.md §6 «Food» y §17): lo que hoy depende de `food.ingredients` y
 * `food.equipment` y que en R5 pasará a leer artículos de Recursos. Estas pruebas no se tocan en R5: deben seguir en
 * verde después, con la misma conducta y otra fuente de datos.
 *
 * El resto ya está caracterizado: compra (`planning.test.ts`), costes (`domain.test.ts`), catálogo (`catalog.test.ts`)
 * y avisos a Tasks (`tasks.test.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { menuWarnings, scaledIngredients, type MenuGraph } from '../../supabase/functions/_domain/food/mod.ts';
import { day } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `r5-${++counter}`, operations } });
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
async function rejected(operations: unknown[], code: string) {
  const res = await commit(operations);
  assert.equal(res.status, 422, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('caracterización R5 · unidades: las ocho de hoy en ingredientes y líneas; ninguna otra', async () => {
  const recipe = uuid();
  const ok = await commit([insert('food.recipes', recipe, { name: 'Prueba de unidades', category: 'otro', base_servings: 4 })]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  for (const unit of ['g', 'kg', 'ml', 'l', 'unidad', 'paquete', 'manojo', 'otro']) {
    const ingredient = uuid();
    const res = await commit([insert('food.ingredients', ingredient, { name: `Ingrediente en ${unit}`, preferred_unit: unit }),
      insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: ingredient, quantity: 1, unit })]);
    assert.equal(res.status, 200, `${unit}: ${JSON.stringify(res.data)}`);
  }
  // «saco» no existe hoy: con R5 llegará por las conversiones del artículo.
  assert.equal((await rejected([insert('food.ingredients', uuid(), { name: 'Harina', preferred_unit: 'saco' })], 'INVALID_FIELDS')).details.field, 'preferred_unit');
  const flour = uuid();
  assert.equal((await commit([insert('food.ingredients', flour, { name: 'Harina', preferred_unit: 'kg' })])).status, 200);
  assert.equal((await rejected([insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: flour, quantity: 1, unit: 'saco' })], 'INVALID_FIELDS')).details.field, 'unit');
  assert.equal((await rejected([insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: flour, quantity: 0, unit: 'kg' })], 'INVALID_FIELDS')).details.field, 'quantity');
});

test('caracterización R5 · maquinaria: cantidad entera desde 0 y cuatro estados', async () => {
  for (const status of ['operativo', 'limitado', 'averiado', 'fuera_de_servicio']) {
    assert.equal((await commit([insert('food.equipment', uuid(), { name: `Horno ${status}`, quantity: 0, status })])).status, 200);
  }
  assert.equal((await rejected([insert('food.equipment', uuid(), { name: 'Freidora', status: 'en_revision' })], 'INVALID_FIELDS')).details.field, 'status');
  assert.equal((await rejected([insert('food.equipment', uuid(), { name: 'Freidora', quantity: 1.5 })], 'INVALID_FIELDS')).details.field, 'quantity');
  assert.equal((await rejected([insert('food.equipment', uuid(), { name: 'Freidora', quantity: -1 })], 'INVALID_FIELDS')).details.field, 'quantity');
});

test('caracterización R5 · alergias: también por el nombre de los ingredientes del plato (seguridad)', () => {
  const pistachio = { id: uuid(), name: 'Pistachos tostados', preferred_unit: 'g', preferred_supplier: null, active: true, deleted_at: null };
  const rice = { id: uuid(), name: 'Arroz', preferred_unit: 'kg', preferred_supplier: null, active: true, deleted_at: null };
  // Sin alérgenos declarados: el aviso sale solo por el ingrediente.
  const cake = { id: uuid(), name: 'Bizcocho', category: 'postre', base_servings: 10, allergens: [], diet_tags: [], allergens_checked: true, status: 'validada', deleted_at: null };
  const plain = { id: uuid(), name: 'Arroz blanco', category: 'guarnicion', base_servings: 10, allergens: [], diet_tags: [], allergens_checked: true, status: 'validada', deleted_at: null };
  const service = { id: uuid(), menu_id: uuid(), service_date: day(10), service_type: 'comida', service_time: '14:00', position: 1, deleted_at: null };
  const cakeItem = { id: uuid(), service_id: service.id, recipe_id: cake.id, servings: 20, position: 1, deleted_at: null };
  const graph = {
    services: [service],
    items: [cakeItem, { id: uuid(), service_id: service.id, recipe_id: plain.id, servings: 20, position: 2, deleted_at: null }],
    recipes: [cake, plain],
    recipe_ingredients: [
      { id: uuid(), recipe_id: cake.id, ingredient_id: pistachio.id, quantity: 200, unit: 'g', position: 1, deleted_at: null },
      { id: uuid(), recipe_id: plain.id, ingredient_id: rice.id, quantity: 1, unit: 'kg', position: 1, deleted_at: null },
    ],
    ingredients: [pistachio, rice],
  } as unknown as MenuGraph;
  const event = (subject: string) => ({ start_date: day(10), end_date: day(11), dietary_restrictions: [{ type: 'alergia' as const, subject, severity: 'grave' as const, servings: 1 }] });

  const byName = menuWarnings(event('pistacho'), graph).filter((w) => w.kind === 'alergia');
  assert.deepEqual(byName.map((w) => w.key.split('|').at(-1)), [cakeItem.id], 'solo el bizcocho, por su ingrediente');
  // Un ingrediente que no está en el recetario no se puede comprobar: hay que revisarlo a mano.
  assert.deepEqual(menuWarnings(event('kiwi'), graph).map((w) => [w.kind, w.requiresAck]), [['no_verificable', true]]);
  // Escalado de la vista de cocinero y de la compra: por las raciones del plato, en la unidad de la línea.
  assert.deepEqual(scaledIngredients(graph, cakeItem.id).map((l) => `${l.ingredient_id === pistachio.id ? 'pistacho' : '?'} ${l.quantity} ${l.unit}`), ['pistacho 400 g']);
});
