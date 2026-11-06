/**
 * Tasks · las familias de sistema salen de las etiquetas (migración 0369, docs/tasks/API.md §63), contra el núcleo real: sin
 * la conversión hecha no se tocan; con ella, «Persona», «Oficio», «Edificio» y «Espacio» quedan archivadas con sus etiquetas
 * (sin borrar nada, y cada etiqueta recuerda si ya lo estaba); las libres no cambian; repetirlo no hace nada. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), LIBRE = uuid(), URGENTE = uuid(), JUAN = uuid(), FONTA = uuid();
let app: TestApp;
let seq = 0;

const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `sysfam-${++seq}`, operations } });
const sql = async (q: string, v: unknown[] = []) => (await app.t.db.query(q, v)).rows as any[];
const run = async () => Number((await sql('select tasks.archive_converted_families() as n'))[0].n);
const fam = async (key: string) => (await sql(`select id, archived from tasks.families where tab_id = $1 and system_key = $2 and deleted_at is null`, [TAB, key]))[0];
const setSource = (key: string, value: string) => sql(`insert into tasks.settings (key, value) values ($1, to_jsonb($2::text))`, [key, value]);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  const person = (await fam('person')).id, trade = (await fam('trade')).id;
  const out = await commit([
    { op: 'insert', table: 'tasks.families', id: LIBRE, fields: { tab_id: TAB, name: 'Etiquetas', color: '#777777', position: 9000 } },
    { op: 'insert', table: 'tasks.labels', id: URGENTE, fields: { tab_id: TAB, family_id: LIBRE, name: 'urgente', position: 1 } },
    { op: 'insert', table: 'tasks.labels', id: JUAN, fields: { tab_id: TAB, family_id: person, name: 'Juan', position: 1 } },
    { op: 'insert', table: 'tasks.labels', id: FONTA, fields: { tab_id: TAB, family_id: trade, name: 'Fontanería', position: 1 } },
  ]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
});
test.after(async () => { await app.close(); });

test('sin la conversión hecha, nada cambia', async () => {
  assert.equal(await run(), 0);
  assert.deepEqual([(await fam('person')).archived, (await fam('trade')).archived, (await fam('space')).archived], [false, false, false]);
});

test('con personas y oficios ya en Central, sus familias de sistema y sus etiquetas se archivan; las libres no', async () => {
  const cursor = async () => Number((await sql(`select cursor from core.app_state where app = 'tasks'`))[0].cursor);
  await setSource('people_source', 'central');
  await setSource('trade_source', 'central');
  const before = await cursor();
  assert.ok(await run() >= 4, 'dos familias y sus dos etiquetas');
  assert.ok(await cursor() > before, 'en un lote del núcleo: se sincroniza');
  assert.deepEqual([(await fam('person')).archived, (await fam('trade')).archived], [true, true]);
  assert.equal((await fam('space')).archived, false, 'los espacios siguen en etiquetas: sin la ida de §30 no se tocan');
  const labels = await sql(`select id, archived, archived_before_family, deleted_at from tasks.labels where id = any($1)`, [[URGENTE, JUAN, FONTA]]);
  const by = (id: string) => labels.find((l) => l.id === id);
  assert.deepEqual([by(JUAN).archived, by(JUAN).archived_before_family, by(JUAN).deleted_at], [true, false, null], 'archivada, no borrada');
  assert.equal(by(FONTA).archived, true);
  assert.equal(by(URGENTE).archived, false, 'la etiqueta libre no se toca');
  assert.equal(await run(), 0, 'repetirlo no hace nada');
});
