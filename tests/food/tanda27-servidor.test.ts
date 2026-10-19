/**
 * Food · tanda 27 (rediseño de La Muela, 19-10-2026): datos y servidor, contra PGlite.
 * - Votos a las sugerencias (1103): vota también quien solo lee; cada cual su voto y solo el suyo.
 * - Sugerencia de plato (1102): «Usar “receta parecida”» con `recipe_id` y sin días que ya pasaron.
 * - Recorrido de las máquinas (1104): `status_since` y el aviso a Tasks anotado en Food.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  HOUSE_DISH_SUGGESTION_KIND, equipmentJourney, houseDishSuggestionOperations, houseDishWithRecipe, invalidCallArgument, voteRequest, voteTally,
  type EquipmentNotice, type HouseDishSuggestion, type SuggestionVote,
} from '../../supabase/functions/_domain/food/mod.ts';
import { day } from './helpers.ts';

let app: TestApp;
let counter = 0;
let outsider: string;
const uuid = () => crypto.randomUUID();
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const tasksFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  return Response.json({ created: true, routed: 'pending', task: { id: `task-${body.external_ref}`, title: body.title } });
};

function commit(operations: unknown[], token = app.tokens.editor) {
  return app.call('/api/v1/commands', { token, body: { requestId: `t27-${++counter}`, operations } });
}
async function rows(table: string) {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows as any[];
}
async function suggest(input: HouseDishSuggestion) {
  const res = await q(`select core.suggest('food', $1, $2, $3, $4, null, $5) as s`,
    [outsider, `t27s-${++counter}`, HOUSE_DISH_SUGGESTION_KIND, input.name, JSON.stringify(houseDishSuggestionOperations(input))]);
  return res[0].s as { id: string; status: string; operations: unknown };
}
const approve = (id: string, body: Record<string, unknown> = {}) => app.call(`/api/v1/suggestions/${id}/approve`, { token: app.tokens.editor, body });

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }, { tasksApiBase: 'https://tasks.example.invalid', tasksFetch }),
  });
  outsider = await app.t.createUser();
  await q(`select core.apply_house_level($1, 'outsider')`, [outsider]);
});
test.after(async () => { await app.close(); });

test('votos · por la ruta de votos; el servidor pone quién vota; uno por persona; nadie toca el voto de otro', async () => {
  const suggestion = uuid();
  const vote = (v: 'keep' | 'drop' | null, token = app.tokens.editor, id = suggestion) =>
    app.call('/api/v1/suggestion-votes', { token, body: voteRequest(id, v, `r${++counter}`) });
  const live = async () => (await rows('food.suggestion_votes')) as unknown as Array<SuggestionVote & { revision: number }>;

  const first = await vote('keep');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal((await vote('drop', app.tokens.owner)).status, 200);
  let votes = await live();
  assert.deepEqual(votes.map((v) => [v.voter_id, v.vote]).sort(), [[app.users.editor, 'keep'], [app.users.owner, 'drop']].sort());
  const tally = voteTally(votes, suggestion, app.users.editor);
  assert.deepEqual([tally.keep, tally.drop, tally.mine?.vote], [1, 1, 'keep']);

  // Votar otra vez cambia el voto propio; no crea otro. El mismo voto no cambia nada. null lo quita.
  assert.equal((await vote('drop')).status, 200);
  votes = await live();
  const mine = votes.find((v) => v.voter_id === app.users.editor)!;
  assert.deepEqual(votes.filter((v) => v.voter_id === app.users.editor).map((v) => v.vote), ['drop']);
  assert.equal((await vote('drop')).status, 200);
  assert.equal((await live()).find((v) => v.voter_id === app.users.editor)!.revision, mine.revision);

  // Nadie cambia ni quita el voto de otra persona, ni firma por ella, ni tiene dos votos vivos.
  const other = await commit([{ op: 'update', table: 'food.suggestion_votes', id: mine.id, expectedRevision: mine.revision, fields: { vote: 'keep' } }], app.tokens.owner);
  assert.equal(other.status, 403, JSON.stringify(other.data));
  assert.equal((await commit([{ op: 'delete', table: 'food.suggestion_votes', id: mine.id, expectedRevision: mine.revision }], app.tokens.owner)).status, 403);
  const forged = await commit([{ op: 'insert', table: 'food.suggestion_votes', id: uuid(), fields: { suggestion_id: uuid(), vote: 'keep', voter_id: app.users.owner } }]);
  assert.equal(forged.status, 422, JSON.stringify(forged.data));
  const twice = await commit([{ op: 'insert', table: 'food.suggestion_votes', id: uuid(), fields: { suggestion_id: suggestion, vote: 'keep' } }]);
  assert.equal(twice.status, 422, JSON.stringify(twice.data));

  assert.equal((await vote(null)).status, 200);
  const after = voteTally(await live(), suggestion, app.users.editor);
  assert.deepEqual([after.keep, after.drop, after.mine], [0, 1, null]);
  // Entradas inválidas.
  assert.equal((await app.call('/api/v1/suggestion-votes', { token: app.tokens.editor, body: { requestId: 'x1', suggestionId: suggestion, vote: 'quizas' } })).status, 422);
  assert.equal((await app.call('/api/v1/suggestion-votes', { token: app.tokens.editor, body: { requestId: 'x2', suggestionId: 'no', vote: 'keep' } })).status, 422);
});

// Decisión de VG: vota también quien solo lee (núcleo 0099, #608; Food 1105 abre `food.vote_suggestion` al lector).
test('votos · quien solo lee también vota, solo con su propio voto', async () => {
  const suggestion = uuid();
  const res = await app.call('/api/v1/suggestion-votes', { token: app.tokens.reader, body: voteRequest(suggestion, 'keep', `r${++counter}`) });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const votes = ((await rows('food.suggestion_votes')) as any[]).filter((v) => v.suggestion_id === suggestion);
  assert.deepEqual(votes.map((v) => [v.voter_id, v.vote]), [[app.users.reader, 'keep']]);
  // Desde 0099 el lector escribe en las tablas que lo admiten, también por la ruta de comandos; el trigger sigue
  // poniendo quién vota, y el voto de otra persona no se toca.
  const editorVote = await app.call('/api/v1/suggestion-votes', { token: app.tokens.editor, body: voteRequest(suggestion, 'drop', `r${++counter}`) });
  assert.equal(editorVote.status, 200);
  const theirs = ((await rows('food.suggestion_votes')) as any[]).find((v) => v.suggestion_id === suggestion && v.voter_id === app.users.editor);
  assert.equal((await commit([{ op: 'update', table: 'food.suggestion_votes', id: theirs.id, expectedRevision: theirs.revision, fields: { vote: 'keep' } }], app.tokens.reader)).status, 403);
});

test('votos · el lector sigue sin escribir nada más de Food', async () => {
  const res = await commit([{ op: 'insert', table: 'food.ingredients', id: uuid(), fields: { name: 'Sal', preferred_unit: 'kg' } }], app.tokens.reader);
  assert.equal(res.status, 403, JSON.stringify(res.data));
});

test('sugerencia · «Usar “receta parecida”»: el lote corregido con recipe_id usa esa receta y no crea otra', async () => {
  const recipe = uuid();
  assert.equal((await commit([{ op: 'insert', table: 'food.recipes', id: recipe, fields: { name: 'Crema de calabaza y jengibre', category: 'principal', base_servings: 4 } }])).status, 200);
  const s = await suggest({ name: 'Crema de calabaza', date: day(3), service: 'cena' });
  const corrected = houseDishWithRecipe(s.operations, recipe);
  assert.ok(corrected);
  assert.equal(invalidCallArgument('food.house_dish_from_suggestion', corrected[0]!.args as Record<string, unknown>), null);
  const res = await approve(s.id, { operations: corrected });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const out = res.data.result[0].result;
  assert.deepEqual([out.recipe_id, out.created_recipe], [recipe, false]);
  assert.equal((await rows('food.recipes')).filter((r) => r.name === 'Crema de calabaza').length, 0);

  // Una receta que no existe, o con un id inválido: la sugerencia sigue pendiente.
  const s2 = await suggest({ name: 'Sopa', date: day(3), service: 'cena' });
  const missing = await approve(s2.id, { operations: houseDishWithRecipe(s2.operations, uuid()) });
  assert.deepEqual([missing.status, missing.data.error?.details?.argument, missing.data.error?.details?.reason], [422, 'recipe_id', 'not_found']);
  assert.equal(invalidCallArgument('food.house_dish_from_suggestion', { name: 'Sopa', date: day(3), service: 'cena', recipe_id: 'no' }), 'recipe_id');
  assert.equal((await q(`select status from core.suggestions where id = $1`, [s2.id]))[0].status, 'pending');
});

test('sugerencia · «Ya pasó»: un día anterior a hoy (Madrid) se rechaza al aprobar; hoy, no', async () => {
  const past = await suggest({ name: 'Gazpacho', date: day(-1), service: 'comida' });
  const res = await approve(past.id);
  assert.deepEqual([res.status, res.data.error?.details?.argument, res.data.error?.details?.reason], [422, 'date', 'past'], JSON.stringify(res.data));
  assert.equal((await q(`select status from core.suggestions where id = $1`, [past.id]))[0].status, 'pending');
  const today = await suggest({ name: 'Gazpacho', date: day(0), service: 'cena' });
  assert.equal((await approve(today.id)).status, 200);
});

test('maquinaria · status_since cambia solo con el estado; el aviso a Tasks queda anotado y el recorrido lo usa', async () => {
  const oven = uuid();
  assert.equal((await commit([{ op: 'insert', table: 'food.equipment', id: oven, fields: { name: 'Horno grande', status: 'operativo' } }])).status, 200);
  const first = (await rows('food.equipment')).find((e) => e.id === oven)!;
  assert.ok(first.status_since);
  // Editar otra cosa no lo mueve; tampoco se escribe a mano.
  assert.equal((await commit([{ op: 'update', table: 'food.equipment', id: oven, expectedRevision: first.revision, fields: { notes: 'Junto a la ventana' } }])).status, 200);
  const edited = (await rows('food.equipment')).find((e) => e.id === oven)!;
  assert.equal(edited.status_since, first.status_since);
  assert.equal((await commit([{ op: 'update', table: 'food.equipment', id: oven, expectedRevision: edited.revision, fields: { status_since: '2020-01-01T00:00:00Z' } }])).status, 422);
  assert.equal(equipmentJourney(edited, []).stage, 'funciona');

  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await commit([{ op: 'update', table: 'food.equipment', id: oven, expectedRevision: edited.revision, fields: { status: 'averiado' } }])).status, 200);
  const broken = (await rows('food.equipment')).find((e) => e.id === oven)!;
  assert.ok(Date.parse(broken.status_since) > Date.parse(first.status_since));
  assert.deepEqual([equipmentJourney(broken, []).stage, equipmentJourney(broken, []).status], ['falla', 'averiado']);

  // Avisar a Tasks lo anota en Food; repetirlo el mismo día no duplica.
  const fault = (token = app.tokens.editor) => app.call(`/api/v1/equipment/${oven}/fault`, { token, body: { name: 'Horno grande', status: 'averiado' } });
  const res = await fault();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.recorded, true);
  assert.equal((await fault()).data.recorded, true);
  const notices = (await rows('food.equipment_notices')) as unknown as EquipmentNotice[];
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0]!.equipment_id, notices[0]!.equipment_status, notices[0]!.task_id], [oven, 'averiado', notices[0]!.task_id]);
  assert.match(notices[0]!.task_id, /^task-equipment_fault:/);
  assert.equal(equipmentJourney(broken, notices).stage, 'avisado');
  // «En reparación» solo con el estado real de Tasks.
  assert.equal(equipmentJourney(broken, notices, () => 'pending').stage, 'avisado');
  assert.equal(equipmentJourney(broken, notices, () => 'open').stage, 'en_reparacion');

  // Arreglada y vuelta a fallar: el aviso de antes ya no cuenta.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await commit([{ op: 'update', table: 'food.equipment', id: oven, expectedRevision: broken.revision, fields: { status: 'operativo' } }])).status, 200);
  const fixed = (await rows('food.equipment')).find((e) => e.id === oven)!;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await commit([{ op: 'update', table: 'food.equipment', id: oven, expectedRevision: fixed.revision, fields: { status: 'limitado' } }])).status, 200);
  const again = (await rows('food.equipment')).find((e) => e.id === oven)!;
  assert.deepEqual([equipmentJourney(again, notices).stage, equipmentJourney(again, notices).status], ['falla', 'limitado']);

  // Una máquina que no está en Food: el aviso sale, pero no se anota.
  const ghost = await app.call(`/api/v1/equipment/${uuid()}/fault`, { body: { name: 'Batidora', status: 'limitado' } });
  assert.deepEqual([ghost.status, ghost.data.recorded], [200, false]);
  // Un aviso no se escribe con datos inválidos.
  assert.equal((await commit([{ op: 'insert', table: 'food.equipment_notices', id: uuid(), fields: { equipment_id: oven, notified_on: day(0), equipment_status: 'operativo', task_id: 't' } }])).status, 422);
});
