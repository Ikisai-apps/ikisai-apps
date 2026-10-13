/** Food · elaboración en pasos y antelación con unidad (FB_2026_028): dominio y migración contra PGlite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import {
  formatMethodSteps, methodStepsFromText, methodStepsProblem, numberedSteps, prepFromParts, prepLabel, prepToParts, validateOperation,
  type MethodStep,
} from '../../supabase/functions/_domain/food/mod.ts';

let n = 0;
const id = () => `s${++n}`;

test('pasos · el texto libre pasa a pasos sin perder nada: una línea, un paso; 1.1, guiones y sangría son subpasos', () => {
  const steps = methodStepsFromText('1. Pochar la cebolla\n  - a fuego lento\n1.2 con sal\n\n2) Añadir el tomate\nTriturar', id);
  assert.deepEqual(steps.map((s) => [s.text, (s.steps ?? []).map((x) => x.text)]), [
    ['Pochar la cebolla', ['a fuego lento', 'con sal']], ['Añadir el tomate', []], ['Triturar', []]]);
  assert.deepEqual(methodStepsFromText('', id), []);
  assert.deepEqual(methodStepsFromText(null, id), []);
  // Un subpaso sin paso anterior se queda como paso.
  assert.deepEqual(methodStepsFromText('- suelto', id).map((s) => s.text), ['suelto']);
});

test('pasos · numeración 1, 1.1… y texto numerado para recipes.method', () => {
  const steps: MethodStep[] = [{ id: 'a', text: 'Pochar', steps: [{ id: 'b', text: 'lento' }, { id: 'c', text: 'con sal' }] }, { id: 'd', text: 'Servir' }];
  assert.deepEqual(numberedSteps(steps).map((s) => `${s.number} ${s.text}`), ['1 Pochar', '1.1 lento', '1.2 con sal', '2 Servir']);
  assert.equal(formatMethodSteps(steps), '1. Pochar\n   1.1. lento\n   1.2. con sal\n2. Servir');
  assert.equal(formatMethodSteps([]), null);
});

test('pasos · validación: dos niveles, textos y forma', () => {
  assert.equal(methodStepsProblem([{ id: 'a', text: 'x', steps: [{ id: 'b', text: 'y' }] }]), null);
  assert.equal(methodStepsProblem(null), null);
  assert.match(methodStepsProblem([{ id: 'a', text: 'x', steps: [{ id: 'b', text: 'y', steps: [{ id: 'c', text: 'z' }] }] }])!, /dos niveles/);
  assert.match(methodStepsProblem([{ id: 'a', text: '  ' }])!, /vacío/);
  assert.match(methodStepsProblem([{ id: 'a', text: 'x', extra: 1 }])!, /desconocido/);
  assert.match(methodStepsProblem({})!, /lista/);
  const issue = validateOperation({ op: 'update', table: 'food.recipes', id: 'r', fields: { method_steps: [{ id: 'a', text: '' }] } });
  assert.equal(issue?.details.field, 'method_steps');
});

test('antelación · número y unidad, «En el momento» y sin indicar', () => {
  assert.deepEqual(prepToParts(null), { mode: 'sin', amount: null, unit: 'horas' });
  assert.deepEqual(prepToParts(0), { mode: 'momento', amount: null, unit: 'horas' });
  assert.deepEqual(prepToParts(90), { mode: 'antes', amount: 90, unit: 'minutos' });
  assert.deepEqual(prepToParts(120), { mode: 'antes', amount: 2, unit: 'horas' });
  assert.deepEqual(prepToParts(2880), { mode: 'antes', amount: 2, unit: 'dias' });
  assert.equal(prepFromParts('1,5', 'horas'), 90);
  assert.equal(prepFromParts('7', 'dias'), 10080);
  assert.equal(prepFromParts('8', 'dias'), null);
  assert.equal(prepFromParts('0', 'minutos'), null);
  assert.equal(prepFromParts('abc', 'horas'), null);
  assert.deepEqual([prepLabel(null), prepLabel(0), prepLabel(1), prepLabel(60), prepLabel(1440), prepLabel(4320)],
    [null, 'En el momento', '1 minuto antes', '1 hora antes', '1 día antes', '3 días antes']);
});

let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
});

test('migración · lo escrito en method pasa a pasos; antelación hasta siete días; method_steps solo como lista', async () => {
  const insert = (fields: string, values: string) => app.t.db.query<{ id: string }>(`insert into food.recipes (name, category, base_servings${fields}) values ('R', 'principal', 4${values}) returning id`);
  const legacy = (await insert(', method', `, E'1. Pochar la cebolla\\n\\n2) Añadir el tomate\\n  Triturar'`)).rows[0]!.id;
  const empty = (await insert(', method', `, '   '`)).rows[0]!.id;
  // La conversión de la migración, aplicada a filas escritas como antes.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(path.resolve(here, '../../supabase/migrations/20261013_0193_food_method_steps.sql'), 'utf8');
  const update = /update food\.recipes r set method_steps[\s\S]*?;\n/.exec(sql)![0];
  await app.t.db.query(update);
  const row = async (rid: string) => (await app.t.db.query<Record<string, any>>(`select method, method_steps from food.recipes where id = $1`, [rid])).rows[0]!;
  const converted = await row(legacy);
  assert.deepEqual(converted.method_steps.map((s: any) => s.text), ['Pochar la cebolla', 'Añadir el tomate', 'Triturar']);
  assert.ok(converted.method_steps.every((s: any) => typeof s.id === 'string' && s.id.length > 10));
  assert.match(converted.method, /Pochar la cebolla/, 'el texto original se conserva');
  assert.equal((await row(empty)).method_steps, null);

  await app.t.db.query(`update food.recipes set prep_minutes = 10080 where id = $1`, [legacy]);
  await assert.rejects(app.t.db.query(`update food.recipes set prep_minutes = 10081 where id = $1`, [legacy]));
  await assert.rejects(app.t.db.query(`update food.recipes set method_steps = '{}'::jsonb where id = $1`, [legacy]));
  const writable = (await app.t.db.query<{ w: string[] }>(`select writable_columns w from core.synced_tables where schema_name = 'food' and table_name = 'recipes'`)).rows[0]!.w;
  assert.ok(writable.includes('method_steps'));
});
