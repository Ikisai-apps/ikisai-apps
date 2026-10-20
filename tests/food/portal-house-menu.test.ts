/**
 * Food · FD2: el menú de casa para Guests (`food.portal_house_menu`, API.md §7.6) contra PGlite. Solo Guests (outsider,
 * editor y owner); desde hoy y como mucho 60 días; alérgenos declarados siempre, con `allergens_checked` (regla de #597);
 * nada interno.
 *
 * Cómo correrlo:   npx tsx --test tests/food/portal-house-menu.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { HOUSE_MENU_ID } from '../../supabase/functions/_domain/food/mod.ts';
import { day } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `house-portal-${++counter}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const read = (portal: string, actor: string, args: unknown) => app.t.rpc('core_read', { p_app: portal, p_actor: actor, p_name: 'food.portal_house_menu', p_args: args }) as Promise<any>;
async function member(portal: string, role: string): Promise<string> {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, $3)`, [portal, user, role]);
  return user;
}

const curry = uuid(); const quick = uuid();

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  const service = (date: string, type: string, position: number) => {
    const id = uuid();
    return { id, op: insert('food.menu_services', id, { menu_id: HOUSE_MENU_ID, service_date: date, service_type: type, service_time: '14:00', position, notes: 'Nota interna' }) };
  };
  const yesterday = service(day(-1), 'comida', 1);
  const tomorrow = service(day(1), 'comida', 1);
  const far = service(day(60), 'cena', 2);
  const tooFar = service(day(61), 'comida', 1);
  await ok([
    insert('food.recipes', curry, { name: 'Curry interno', public_name: 'Curry de verduras', category: 'principal', base_servings: 10,
      method: 'Secreto de la casa', diet_tags: ['vegano'], allergens: ['frutos_de_cascara'], allergens_checked: true }),
    insert('food.recipes', quick, { name: 'Tortilla', category: 'principal', base_servings: 4, quick: true, allergens: ['huevos'], allergens_checked: false }),
    insert('food.menus', HOUSE_MENU_ID, { kind: 'casa', house_servings: 12 }),
    yesterday.op, tomorrow.op, far.op, tooFar.op,
    ...[yesterday, tomorrow, far, tooFar].map((s) => insert('food.menu_items', uuid(), { service_id: s.id, recipe_id: curry, servings: 12, position: 1, notes: 'Doble ración' })),
    insert('food.menu_items', uuid(), { service_id: tomorrow.id, recipe_id: quick, servings: 12, position: 2 }),
  ]);
});

test.after(async () => { await app?.close(); });

test('portal_house_menu · desde hoy y hasta 60 días, alérgenos declarados siempre, nada interno', async () => {
  const outsider = await member('guests', 'outsider');
  const out = await read('guests', outsider, {});
  assert.equal(out.from, day(0));
  assert.equal(out.to, day(60));
  assert.deepEqual(out.services.map((s: any) => [s.date, s.type]), [[day(1), 'comida'], [day(60), 'cena']]);
  assert.deepEqual(out.services[0].dishes, [
    { name: 'Curry de verduras', quick: false, allergens: ['frutos_de_cascara'], allergens_checked: true },
    // Sin revisar: los declarados van igual, y Guests dice «sin revisar por cocina».
    { name: 'Tortilla', quick: true, allergens: ['huevos'], allergens_checked: false },
  ]);
  assert.equal(out.services[0].time, '14:00:00');
  // Nada interno: ni notas, ni raciones, ni elaboración, ni nombres internos.
  const text = JSON.stringify(out);
  for (const word of ['Nota interna', 'Doble ración', 'Secreto', 'Curry interno', 'servings', 'cost']) assert.ok(!text.includes(word), word);
});

test('portal_house_menu · el rango se recorta a hoy y a 60 días; fechas inválidas, 422', async () => {
  const editor = await member('guests', 'editor');
  const out = await read('guests', editor, { from: day(-10), to: day(90) });
  assert.equal(out.from, day(0));
  assert.equal(out.to, day(60));
  assert.deepEqual((await read('guests', editor, { from: day(2), to: day(59) })).services, []);
  assert.deepEqual((await read('guests', editor, { from: day(1), to: day(1) })).services.map((s: any) => s.date), [day(1)]);
  await assert.rejects(read('guests', editor, { from: 'mañana' }), (e: any) => e.code === 'INVALID_FIELDS');
  await assert.rejects(read('guests', editor, { from: day(5), to: day(3) }), (e: any) => e.code === 'INVALID_FIELDS');
});

test('portal_house_menu · solo Guests, y no el lector', async () => {
  await assert.rejects(read('guests', await member('guests', 'reader'), {}), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(read('organizers', await member('organizers', 'editor'), {}), (e: any) => e.code === 'INVALID_OPERATION');
});
