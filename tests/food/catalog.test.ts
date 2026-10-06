/** Food · catálogo contra PGlite: tablas, reglas de fila, fotos y proyecciones para Invoices. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

/** Envía un lote y devuelve la respuesta; cada llamada usa un requestId nuevo. */
function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { body: { requestId: `food-${++counter}`, operations }, ...(token ? { token } : {}) });
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const remove = (table: string, id: string, expectedRevision: number) => ({ op: 'delete', table, id, expectedRevision });

async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rejected(operations: unknown[], code: string) {
  const res = await commit(operations);
  assert.equal(res.status, 422, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}
async function rows(table: string) {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows as Array<Record<string, any>>;
}

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('catálogo · receta con ingrediente nuevo y maquinaria en un solo lote', async () => {
  const recipe = uuid(); const tomato = uuid(); const oven = uuid();
  await ok([
    insert('food.ingredients', tomato, { name: 'Tomate', preferred_unit: 'kg' }),
    insert('food.equipment', oven, { name: 'Horno 1', quantity: 2 }),
    insert('food.recipes', recipe, { name: 'Curry de verduras', category: 'principal', base_servings: 20, diet_tags: ['vegano', 'sin_gluten'], allergens: ['apio'], prep_minutes: 90 }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: tomato, quantity: 2.5, unit: 'kg' }),
    insert('food.recipe_equipment', uuid(), { recipe_id: recipe, equipment_id: oven }),
  ]);
  const saved = (await rows('food.recipes')).find((r) => r.id === recipe)!;
  assert.deepEqual(saved.diet_tags, ['vegano', 'sin_gluten']);
  assert.deepEqual(saved.allergens, ['apio']);
  assert.equal(saved.status, 'en_prueba');
  assert.equal(saved.allergens_checked, false);
  assert.equal(Number(saved.base_servings), 20);
  const line = (await rows('food.recipe_ingredients')).find((r) => r.recipe_id === recipe)!;
  assert.equal(Number(line.quantity), 2.5);
  assert.equal((await rows('food.recipe_equipment')).find((r) => r.recipe_id === recipe)!.quantity_required, 1);
});

test('catálogo · la validación de dominio rechaza con el campo; una FK rota llega como 422 y no como 503', async () => {
  const error = await rejected([insert('food.recipes', uuid(), { name: 'x', category: 'plato', base_servings: 4 })], 'INVALID_FIELDS');
  assert.equal(error.details.field, 'category');
  assert.equal((await rejected([insert('food.equipment', uuid(), { name: 'Olla', status: 'rota' })], 'INVALID_FIELDS')).details.field, 'status');
  const recipe = uuid();
  await ok([insert('food.recipes', recipe, { name: 'Arroz', category: 'guarnicion', base_servings: 10 })]);
  const broken = await rejected([insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: uuid(), quantity: 1, unit: 'kg' })], 'CONSTRAINT_VIOLATION');
  assert.equal(broken.details.sqlstate, '23503');
});

test('catálogo · una receta no pasa a validada sin revisar los alérgenos', async () => {
  const recipe = uuid();
  await rejected([insert('food.recipes', recipe, { name: 'Pesto', category: 'base', base_servings: 10, status: 'validada' })], 'ALLERGENS_UNCHECKED');
  await ok([insert('food.recipes', recipe, { name: 'Pesto', category: 'base', base_servings: 10 })]);
  // Solo viaja status: lo decide el trigger con la fila actual.
  await rejected([update('food.recipes', recipe, 1, { status: 'validada' })], 'ALLERGENS_UNCHECKED');
  await ok([update('food.recipes', recipe, 1, { allergens: ['frutos_de_cascara', 'lacteos'], allergens_checked: true, status: 'validada' })]);
  // Y no se puede desmarcar la revisión dejándola validada.
  await rejected([update('food.recipes', recipe, 2, { allergens_checked: false })], 'ALLERGENS_UNCHECKED');
  await ok([update('food.recipes', recipe, 2, { allergens_checked: false, status: 'en_prueba' })]);
});

test('catálogo · nombre de ingrediente único sin distinguir mayúsculas ni espacios', async () => {
  const first = uuid(); const second = uuid();
  await ok([insert('food.ingredients', first, { name: 'Arroz basmati' })]);
  const error = await rejected([insert('food.ingredients', second, { name: '  arroz BASMATI ' })], 'DUPLICATE_NAME');
  assert.equal(error.details.existingId, first);
  await ok([insert('food.ingredients', second, { name: 'Arroz bomba' })]);
  assert.equal((await rejected([update('food.ingredients', second, 1, { name: 'ARROZ BASMATI' })], 'DUPLICATE_NAME')).details.existingId, first);
  // Borrado el primero, el nombre queda libre; restaurarlo después choca con el nuevo.
  await ok([remove('food.ingredients', first, 1)]);
  await ok([update('food.ingredients', second, 1, { name: 'Arroz basmati' })]);
  await rejected([{ op: 'restore', table: 'food.ingredients', id: first, expectedRevision: 2 }], 'DUPLICATE_NAME');
});

test('catálogo · no se borra un ingrediente ni una máquina en uso; sí cuando la línea desaparece', async () => {
  const recipe = uuid(); const onion = uuid(); const pan = uuid(); const line = uuid(); const need = uuid();
  await ok([
    insert('food.ingredients', onion, { name: 'Cebolla' }),
    insert('food.equipment', pan, { name: 'Paellera 70 cm' }),
    insert('food.recipes', recipe, { name: 'Sofrito', category: 'base', base_servings: 10 }),
    insert('food.recipe_ingredients', line, { recipe_id: recipe, ingredient_id: onion, quantity: 800, unit: 'g' }),
    insert('food.recipe_equipment', need, { recipe_id: recipe, equipment_id: pan, quantity_required: 1 }),
  ]);
  assert.equal((await rejected([remove('food.ingredients', onion, 1)], 'INGREDIENT_IN_USE')).details.uses, 1);
  await rejected([remove('food.equipment', pan, 1)], 'EQUIPMENT_IN_USE');
  // Desactivar o marcar fuera de servicio sí se puede.
  await ok([update('food.ingredients', onion, 1, { active: false }), update('food.equipment', pan, 1, { status: 'fuera_de_servicio' })]);
  await ok([remove('food.recipe_ingredients', line, 1), remove('food.recipe_equipment', need, 1)]);
  await ok([remove('food.ingredients', onion, 2), remove('food.equipment', pan, 2)]);
});

test('catálogo · líneas: recipe_id inmutable y nada cuelga de un padre borrado', async () => {
  const recipe = uuid(); const other = uuid(); const salt = uuid(); const gone = uuid(); const line = uuid();
  await ok([
    insert('food.ingredients', salt, { name: 'Sal' }),
    insert('food.ingredients', gone, { name: 'Azafrán' }),
    insert('food.recipes', recipe, { name: 'Caldo', category: 'base', base_servings: 10 }),
    insert('food.recipes', other, { name: 'Crema', category: 'entrante', base_servings: 10 }),
    insert('food.recipe_ingredients', line, { recipe_id: recipe, ingredient_id: salt, quantity: 20, unit: 'g' }),
  ]);
  await rejected([update('food.recipe_ingredients', line, 1, { recipe_id: other })], 'IMMUTABLE_FIELD');
  await ok([remove('food.ingredients', gone, 1)]);
  assert.equal((await rejected([update('food.recipe_ingredients', line, 1, { ingredient_id: gone })], 'PARENT_DELETED')).details.parent, 'ingredients');
  // Borrar la receta con sus líneas es un único lote; después no admite líneas nuevas ni restaurar las viejas.
  await ok([remove('food.recipe_ingredients', line, 1), remove('food.recipes', recipe, 1)]);
  assert.equal((await rejected([insert('food.recipe_ingredients', uuid(), { recipe_id: recipe, ingredient_id: salt, quantity: 1, unit: 'g' })], 'PARENT_DELETED')).details.parent, 'recipes');
  await rejected([{ op: 'restore', table: 'food.recipe_ingredients', id: line, expectedRevision: 2 }], 'PARENT_DELETED');
});

test('catálogo · foto de receta: solo imágenes de Food ya verificadas', async () => {
  const bytes = new TextEncoder().encode('RIFF....WEBPVP8 prueba');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const pdf = await app.call('/api/v1/uploads', { body: { filename: 'menu.pdf', mime: 'application/pdf', size: 10, sha256: sha } });
  assert.equal(pdf.data.error.code, 'UNSUPPORTED_MEDIA');
  const big = await app.call('/api/v1/uploads', { body: { filename: 'foto.webp', mime: 'image/webp', size: 3 * 1024 * 1024, sha256: sha } });
  assert.equal(big.status, 413);
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'curry.webp', mime: 'image/webp', size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));

  const recipe = uuid();
  await ok([insert('food.recipes', recipe, { name: 'Curry con foto', category: 'principal', base_servings: 20 })]);
  // Todavía no se ha subido: la receta no puede apuntar a ese archivo.
  assert.equal((await rejected([update('food.recipes', recipe, 1, { photo_file_id: ticket.data.id })], 'INVALID_FILE')).details.field, 'photo_file_id');
  await rejected([update('food.recipes', recipe, 1, { photo_thumb_file_id: uuid() })], 'INVALID_FILE');
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} })).status, 200);
  await ok([update('food.recipes', recipe, 1, { photo_file_id: ticket.data.id, photo_thumb_file_id: ticket.data.id })]);
  assert.equal((await rows('food.recipes')).find((r) => r.id === recipe)!.photo_file_id, ticket.data.id);
  await ok([update('food.recipes', recipe, 2, { photo_file_id: null, photo_thumb_file_id: null })]);
});

test('catálogo · proyecciones para Invoices: solo filas vivas, sin columnas internas', async () => {
  const live = uuid(); const dead = uuid(); const machine = uuid();
  await ok([
    insert('food.ingredients', live, { name: 'Lenteja pardina', preferred_unit: 'kg' }),
    insert('food.ingredients', dead, { name: 'Ingrediente retirado' }),
    insert('food.equipment', machine, { name: 'Batidora', category: 'pequeño aparato' }),
  ]);
  await ok([remove('food.ingredients', dead, 1)]);
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'editor')`, [app.users.editor]);
  const ingredients = await app.t.rpc('core_read', { p_app: 'invoices', p_actor: app.users.editor, p_name: 'food.invoices_ingredient_projection', p_args: { where: { ingredient_id: live } } }) as any;
  assert.deepEqual(ingredients.rows, [{ ingredient_id: live, name: 'Lenteja pardina', preferred_unit: 'kg', active: true, ingredient_revision: 1 }]);
  const gone = await app.t.rpc('core_read', { p_app: 'invoices', p_actor: app.users.editor, p_name: 'food.invoices_ingredient_projection', p_args: { where: { ingredient_id: dead } } }) as any;
  assert.equal(gone.total, 0);
  const equipment = await app.t.rpc('core_read', { p_app: 'invoices', p_actor: app.users.editor, p_name: 'food.invoices_equipment_projection', p_args: { where: { equipment_id: machine } } }) as any;
  assert.deepEqual(Object.keys(equipment.rows[0]).sort(), ['category', 'equipment_id', 'equipment_revision', 'name', 'status']);
  // Food no puede leer con el nombre de otra app lo que no se le ha registrado.
  const own = await app.call('/api/v1/read/food.invoices_ingredient_projection');
  assert.equal(own.status, 422);
});
