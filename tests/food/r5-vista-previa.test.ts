/**
 * Food · R5: la vista previa de la migración de ingredientes y maquinaria a Recursos (`docs/food/r5/vista_previa.sql`)
 * funciona, no escribe nada y señala cada tipo de duda. La lanza Core contra producción; aquí, contra PGlite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(path.resolve(here, '../../docs/food/r5/vista_previa.sql'), 'utf8');
const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `r5p-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('R5 · vista previa: recuentos, propuesta por fila y dudas, sin escribir nada', async () => {
  const tomato = uuid(), tomatoes = uuid(), salt = uuid(), parsley = uuid(), old = uuid(), unused = uuid();
  const oven = uuid(), pot = uuid(), chiller = uuid(), broken = uuid();
  const recipe = uuid();
  await ok([
    insert('food.ingredients', tomato, { name: 'Tomate', preferred_unit: 'kg', preferred_supplier: 'Frutería' }),
    insert('food.ingredients', tomatoes, { name: 'Tomates', preferred_unit: 'unidad' }),
    insert('food.ingredients', salt, { name: 'Sal', preferred_unit: 'g' }),
    insert('food.ingredients', parsley, { name: 'Perejil', preferred_unit: 'manojo' }),
    insert('food.ingredients', old, { name: 'Azafrán', preferred_unit: 'g', active: false }),
    insert('food.ingredients', unused, { name: 'Horno', preferred_unit: 'g' }),
    insert('food.recipes', recipe, { name: 'Ensalada', category: 'entrante', base_servings: 4 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: tomato, quantity: 1, unit: 'kg' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: tomato, quantity: 3, unit: 'unidad' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: tomatoes, quantity: 2, unit: 'unidad' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: salt, quantity: 5, unit: 'g' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: parsley, quantity: 1, unit: 'manojo' }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: old, quantity: 1, unit: 'g' }),
    insert('food.equipment', oven, { name: 'Horno', category: 'Horno', quantity: 2, location: 'Cocina', status: 'operativo' }),
    insert('food.equipment', pot, { name: 'Olla grande', category: 'Olla', quantity: 3, location: 'Despensa del sótano' }),
    insert('food.equipment', chiller, { name: 'Abatidor', quantity: 1, status: 'averiado' }),
    insert('food.equipment', broken, { name: 'Freidora', quantity: 0 }),
    insert('food.recipe_equipment', uuid(), { recipe_id: recipe, equipment_id: oven, quantity_required: 1 }),
  ]);
  // En Recursos ya hay «Sal» (de otra app) y un espacio «Cocina».
  await q(`insert into resources.items (name, kind, base_unit) values ('Sal', 'ingrediente', 'kg')`);
  const altura = (await q(`select id from resources.spaces where kind = 'altura' and name = 'Altura 1' and deleted_at is null`))[0].id; // de la migración
  await q(`insert into resources.spaces (kind, name, parent_id) values ('edificio', 'Casa', $1)`, [altura]);
  const casa = (await q(`select id from resources.spaces where name = 'Casa'`))[0].id;
  await q(`insert into resources.spaces (kind, name, parent_id) values ('cocina', 'Cocina', $1)`, [casa]);
  const cocina = (await q(`select id from resources.spaces where name = 'Cocina'`))[0].id;

  const before = (await q(`select (select count(*) from food.ingredients) + (select count(*) from resources.items) + (select count(*) from core.changes) as n`))[0].n;
  const out = (await q(SQL))[0].vista_previa;
  const after = (await q(`select (select count(*) from food.ingredients) + (select count(*) from resources.items) + (select count(*) from core.changes) as n`))[0].n;
  assert.equal(after, before, 'no escribe nada');

  assert.deepEqual(out.recuentos.ingredientes, { vivos: 6, inactivos: 1, en_papelera: 0, sin_uso: 1 });
  assert.equal(out.recuentos.lineas_de_receta, 6);
  assert.deepEqual(out.recuentos.lineas_por_unidad, { g: 2, kg: 1, manojo: 1, unidad: 2 });
  assert.deepEqual(out.recuentos.maquinaria, { vivas: 4, unidades: 6, por_estado: { averiado: 1, operativo: 3 }, en_papelera: 0, con_ubicacion: 2 });
  assert.equal(out.recursos.articulos_por_tipo.ingrediente, 1);

  const ingredient = (name: string) => out.ingredientes.find((i: any) => i.nombre === name);
  assert.deepEqual(ingredient('Tomate').propuesta, { tipo: 'ingrediente', unidad_base: 'g', proveedor_texto: 'Frutería', activo: true, enlazar_con: null });
  assert.deepEqual(ingredient('Tomate').uso.unidades_en_recetas, { kg: 1, unidad: 1 });
  assert.deepEqual(ingredient('Tomate').dudas, ['parecido_a: Tomates', 'unidades_de_otra_familia: unidades']);
  assert.deepEqual(ingredient('Tomates').dudas, ['parecido_a: Tomate']);
  assert.deepEqual(ingredient('Sal').dudas, ['ya_existe_en_recursos']);
  assert.equal(ingredient('Sal').propuesta.enlazar_con.kind, 'ingrediente');
  assert.deepEqual(ingredient('Perejil').dudas, ['unidad_sin_medida']);
  assert.deepEqual(ingredient('Azafrán').dudas, ['inactivo']);
  assert.deepEqual(ingredient('Horno').dudas, ['sin_uso', 'nombre_compartido']);

  const machine = (name: string) => out.maquinaria.find((m: any) => m.nombre === name);
  assert.deepEqual(machine('Horno').propuesta.espacio, { id: cocina, name: 'Cocina' });
  assert.deepEqual(machine('Horno').dudas, []);
  assert.equal(machine('Horno').uso.recetas, 1);
  assert.deepEqual(machine('Olla grande').propuesta.tipo, 'menaje');
  assert.deepEqual(machine('Olla grande').dudas, ['ubicacion_sin_espacio', 'tipo_dudoso']);
  assert.deepEqual(machine('Abatidor').dudas, ['estado_no_operativo']);
  assert.deepEqual(machine('Abatidor').propuesta.atributos, { estado: 'averiado' });
  assert.deepEqual(machine('Freidora').dudas, ['cantidad_cero']);
  assert.deepEqual(out.recuentos.con_dudas, { ingredientes: 6, maquinaria: 3 });
});
