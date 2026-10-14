/** Food · O3c: sugerencias de plato del menú de casa (`plato_casa`), contra PGlite (contrato §3.10; docs/food/API.md §2.6). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  HOUSE_DISH_SUGGESTION_KIND, HOUSE_MENU_ID, houseDishSuggestionOperations, invalidCallArgument, isQuickPending, type HouseDishSuggestion,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day } from './helpers.ts';

let app: TestApp;
let counter = 0;
let outsider: string;
const uuid = () => crypto.randomUUID();
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;

async function rows(table: string) {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows as Array<Record<string, any>>;
}
/** Sugiere como lo hará Guests (el outsider no es miembro de Food): `core.suggest` con el lote de una llamada. */
async function suggest(user: string, input: HouseDishSuggestion) {
  const res = await q(`select core.suggest('food', $1, $2, $3, $4, null, $5) as s`,
    [user, `hsug-${++counter}`, HOUSE_DISH_SUGGESTION_KIND, input.name, JSON.stringify(houseDishSuggestionOperations(input))]);
  return res[0].s as { id: string; status: string };
}
const approve = (id: string, token = app.tokens.editor) => app.call(`/api/v1/suggestions/${id}/approve`, { token, body: {} });

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  outsider = await app.t.createUser();
  await q(`select core.apply_house_level($1, 'outsider')`, [outsider]);
});
test.after(async () => { await app.close(); });

test('plato_casa · registrado: lo sugiere un outsider desde Guests; un huésped sin ese nivel, no', async () => {
  const kind = (await q(`select * from core.suggestion_kinds where app = 'food' and kind = 'plato_casa'`))[0];
  assert.deepEqual([kind.procedures, kind.tables, kind.submit_roles, kind.submit_from, kind.house_level],
    [['food.house_dish_from_suggestion'], [], [], { guests: ['editor'] }, 'outsider']);
  const guest = await app.t.createUser();
  await q(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [guest]);
  await assert.rejects(suggest(guest, { name: 'Gazpacho', date: day(2), service: 'comida' }), /FORBIDDEN/);
  // Nadie lo llama a mano desde fuera: el outsider no es miembro de Food.
  assert.equal((await q(`select count(*)::int as n from core.memberships where app = 'food' and user_id = $1`, [outsider]))[0].n, 0);
});

test('plato_casa · al aprobar: crea el menú de casa, el servicio de ese día y la receta rápida, y añade el plato', async () => {
  const s = await suggest(outsider, { name: '  Gazpacho ', date: day(2), service: 'comida' });
  assert.equal(s.status, 'pending');
  assert.equal((await rows('food.menus')).filter((m) => m.kind === 'casa').length, 0, 'aún nadie ha abierto el menú de casa');

  const res = await approve(s.id);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'approved');
  const out = res.data.result[0].result;
  assert.deepEqual([out.menu_id, out.created_menu, out.created_service, out.created_recipe, out.created_item], [HOUSE_MENU_ID, true, true, true, true]);

  const service = (await rows('food.menu_services')).find((r) => r.id === out.service_id)!;
  assert.deepEqual([service.menu_id, service.service_date, service.service_type, service.service_time, Number(service.position)], [HOUSE_MENU_ID, day(2), 'comida', '14:00:00', 1]);
  const recipe = (await rows('food.recipes')).find((r) => r.id === out.recipe_id)!;
  assert.deepEqual([recipe.name, recipe.category, recipe.quick, recipe.status, recipe.allergens_checked], ['Gazpacho', 'principal', true, 'en_prueba', false]);
  assert.equal(isQuickPending(recipe as any, []), true, 'sale «por completar», como un plato rápido');
  const item = (await rows('food.menu_items')).find((r) => r.id === out.item_id)!;
  assert.deepEqual([item.service_id, item.recipe_id, Number(item.servings), Number(item.position)], [out.service_id, out.recipe_id, 1, 1]);
  // Lo aplica quien aprueba, con revisiones y cambios sincronizados para todos los dispositivos.
  assert.equal(item.updated_by, app.users.editor);
});

test('plato_casa · usa la receta del mismo nombre y el servicio que ya hay; no repite el plato; raciones = personas en casa', async () => {
  const house = (await rows('food.menus')).find((m) => m.id === HOUSE_MENU_ID)!;
  const set = await app.call('/api/v1/commands', { body: { requestId: `hsug-${++counter}`, operations: [
    { op: 'update', table: 'food.menus', id: HOUSE_MENU_ID, expectedRevision: house.revision, fields: { house_servings: 6 } }] } });
  assert.equal(set.status, 200, JSON.stringify(set.data));

  // «gazpacho» el mismo día: la misma receta y el mismo servicio, y el plato ya estaba.
  const again = (await approve((await suggest(outsider, { name: 'gazpacho', date: day(2), service: 'comida' })).id)).data.result[0].result;
  assert.deepEqual([again.created_service, again.created_recipe, again.created_item], [false, false, false]);
  assert.equal((await rows('food.recipes')).filter((r) => r.name.toLowerCase() === 'gazpacho').length, 1);

  // Una receta del recetario (la validada antes que una archivada del mismo nombre), en la cena de otro día.
  const lentils = uuid(); const old = uuid();
  const created = await app.call('/api/v1/commands', { body: { requestId: `hsug-${++counter}`, operations: [
    { op: 'insert', table: 'food.recipes', id: old, fields: { name: 'Lentejas', category: 'principal', base_servings: 4, status: 'archivada' } },
    { op: 'insert', table: 'food.recipes', id: lentils, fields: { name: 'Lentejas', category: 'principal', base_servings: 4, allergens_checked: true, status: 'validada' } },
  ] } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const dinner = (await approve((await suggest(outsider, { name: 'Lentejas', date: day(3), service: 'cena' })).id)).data.result[0].result;
  assert.deepEqual([dinner.recipe_id, dinner.created_service, dinner.created_recipe, dinner.created_item], [lentils, true, false, true]);
  const item = (await rows('food.menu_items')).find((r) => r.id === dinner.item_id)!;
  assert.equal(Number(item.servings), 6);
  assert.equal((await rows('food.menu_services')).find((r) => r.id === dinner.service_id)!.service_time, '20:30:00');

  // Otro plato en la misma comida: al final del servicio.
  const second = (await approve((await suggest(outsider, { name: 'Tortilla', date: day(2), service: 'comida' })).id)).data.result[0].result;
  assert.equal(second.service_id, again.service_id);
  assert.equal(Number((await rows('food.menu_items')).find((r) => r.id === second.item_id)!.position), 2);
});

test('plato_casa · argumentos inválidos: el servidor lo rechaza al aprobar y la sugerencia sigue pendiente', async () => {
  for (const [args, argument] of [
    [{ name: 'Sopa', date: day(1), service: 'brunch' }, 'service'],
    [{ name: 'Sopa', date: '2026-02-30', service: 'cena' }, 'date'],
    [{ name: ' ', date: day(1), service: 'cena' }, 'name'],
  ] as const) {
    const s = (await q(`select core.suggest('food', $1, $2, 'plato_casa', 'Sopa', null, $3) as s`,
      [outsider, `hsug-${++counter}`, JSON.stringify([{ op: 'call', procedure: 'food.house_dish_from_suggestion', args }])]))[0].s;
    const res = await approve(s.id);
    assert.equal(res.status, 422, JSON.stringify(res.data));
    assert.deepEqual([res.data.error.code, res.data.error.details.argument], ['INVALID_OPERATION', argument]);
    assert.equal((await q(`select status from core.suggestions where id = $1`, [s.id]))[0].status, 'pending');
    assert.equal(invalidCallArgument('food.house_dish_from_suggestion', args), argument, 'el dominio dice lo mismo');
  }
  assert.equal(invalidCallArgument('food.house_dish_from_suggestion', { name: 'Sopa', date: day(1), service: 'cena' }), null);
  // Un lector de Food no decide.
  const s = await suggest(outsider, { name: 'Crema', date: day(4), service: 'cena' });
  assert.equal((await approve(s.id, app.tokens.reader)).status, 403);
});
