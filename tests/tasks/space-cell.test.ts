/**
 * Tasks · el cuadrante de 1 m² de cada espacio de una tarea (migración 0368, docs/tasks/API.md §62), contra el núcleo real:
 * se guarda `{cellX, cellY, scale: 1}` o nada; lo que no tiene esa forma no entra (dominio y base de datos); el modelo de la
 * interfaz lo trae en `spaceCells` y lo devuelve sin tocar lo que no cambia. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { TABLES, compose, createTabOps, decompose, emptyDataset, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OBRA = uuid(), TAREA = uuid(), COCINA = uuid(), PATIO = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `cell-${++seq}`, operations } });
const code = async (operations: Operation[]) => { const r = await commit(operations); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
const data = async () => { const d: any = emptyDataset(); for (const t of TABLES) d[t] = await rows(t); return d; };
const link = (space: string, cell: unknown): Operation =>
  ({ op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: TAREA, space_id: space, cell } });
const linkOf = async (space: string) => (await rows('tasks.task_spaces')).find((r) => r.task_id === TAREA && r.space_id === space);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const alt = ((await app.t.db.query(`select id from resources.spaces where name = 'Altura 3'`)).rows[0] as { id: string }).id;
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $2, 'edificio', 'Cocina Prueba', 1), ($3, $2, 'edificio', 'Patio Prueba', 2)`, [COCINA, alt, PATIO]);
  assert.equal(await code(createTabOps({ id: TAB, name: 'Casa', position: 1024 })), '200 OK');
  assert.equal(await code([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Obra', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: TAREA, fields: { tab_id: TAB, project_id: OBRA, title: 'Colgar la estantería', position: 1024 } },
  ]), '200 OK');
});
test.after(async () => { await app.close(); });

test('un cuadrante por espacio, o ninguno; lo que no tiene su forma no entra', async () => {
  for (const bad of [{ cellX: -1, cellY: 2, scale: 1 }, { cellX: 1.5, cellY: 2 }, { cellX: 1, cellY: 2, scale: 2 }, { cellX: 1, cellY: 2, z: 0 }, [1, 2], 'A1']) {
    assert.equal(await code([link(COCINA, bad)]), '422 INVALID_SPACE', JSON.stringify(bad));
  }
  assert.equal(await code([link(COCINA, { cellX: 3, cellY: 5, scale: 1 }), link(PATIO, null)]), '200 OK');
  assert.deepEqual((await linkOf(COCINA)).cell, { cellX: 3, cellY: 5, scale: 1 });
  assert.equal((await linkOf(PATIO)).cell, null);
  // La base de datos también lo comprueba (una escritura que no pasa por el dominio).
  await assert.rejects(app.t.db.query(`update tasks.task_spaces set cell = '{"cellX": "3", "cellY": 5}' where space_id = $1`, [PATIO]));
});

test('el modelo de la interfaz trae spaceCells y lo devuelve sin tocar lo que no cambia', async () => {
  let tabs = compose(await data());
  let task = tabs.find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!.tasks.find((t) => t.id === TAREA)!;
  assert.deepEqual(task.spaces?.slice().sort(), [COCINA, PATIO].sort());
  assert.deepEqual(task.spaceCells, { [COCINA]: { cellX: 3, cellY: 5, scale: 1 } });
  assert.deepEqual(decompose(await data(), tabs).flat().filter((o) => o.table === 'tasks.task_spaces'), [], 'guardar tal cual no toca nada');
  // Otro cuadrante en el patio y la cocina sin cuadrante.
  task.spaceCells = { [PATIO]: { cellX: 0, cellY: 1, scale: 1 } };
  for (const batch of decompose(await data(), tabs)) assert.equal(await code(batch), '200 OK');
  assert.deepEqual([(await linkOf(COCINA)).cell, (await linkOf(PATIO)).cell], [null, { cellX: 0, cellY: 1, scale: 1 }]);
  // Sin el campo, decompose no toca los cuadrantes.
  tabs = compose(await data());
  task = tabs.find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!.tasks.find((t) => t.id === TAREA)!;
  delete task.spaceCells;
  assert.deepEqual(decompose(await data(), tabs).flat().filter((o) => o.table === 'tasks.task_spaces'), []);
});
