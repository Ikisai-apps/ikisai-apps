/**
 * Tasks · «Proyectos y producción», 7.5: unidades repetidas (opción A de VG, vg-37; migración 0360, docs/tasks/API.md §55),
 * de extremo a extremo contra el núcleo y los hooks reales: `unit_count` en la madre, una marca por unidad y paso con
 * `POST tasks/unit-step`, la tarea hecha con todas sus unidades (y deshecha al desmarcar una), repetir no cambia nada, las
 * unidades solo las escribe su acción, siguen a su tarea al moverla y van a la papelera con ella. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, emptyDataset, moveTaskOps, TABLES, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OBRA = uuid(), OTRA = uuid(), MADRE = uuid(), PASO = uuid(), SUELTA = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`)).data.tables[0].rows as any[];
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `units-${++seq}`, operations } });
const code = async (operations: Operation[]) => { const r = await commit(operations); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
const step = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/tasks/unit-step', { token, body });
const ins = (table: string, fields: Record<string, unknown>, id = uuid()): Operation => ({ op: 'insert', table, id, fields: { tab_id: TAB, ...fields } });
const data = async () => { const d: any = emptyDataset(); for (const t of TABLES) d[t] = await rows(t); return d; };
const units = async (taskId: string) => (await rows('tasks.task_units')).filter((u) => u.task_id === taskId).map((u) => u.unit).sort();

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Taller', position: 1024 }))).status, 200);
  const out = await commit([
    ins('tasks.projects', { title: 'Marcos acústicos', position: 2048 }, OBRA),
    ins('tasks.projects', { title: 'Otra obra', position: 4096 }, OTRA),
    ins('tasks.tasks', { project_id: OBRA, title: 'Montar bastidor', position: 1024, unit_count: 3 }, MADRE),
    ins('tasks.tasks', { project_id: OBRA, title: 'Grapar', position: 1024, parent_id: MADRE }, PASO),
    ins('tasks.tasks', { project_id: OBRA, title: 'Barrer', position: 2048 }, SUELTA),
  ]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
});
test.after(async () => { await app.close(); });

test('unit_count: solo en la madre, de 1 a 100', async () => {
  assert.equal(await code([ins('tasks.tasks', { project_id: OBRA, title: 'X', position: 9, parent_id: MADRE, unit_count: 2 })]), '422 INVALID_UNITS');
  assert.equal(await code([ins('tasks.tasks', { project_id: OBRA, title: 'X', position: 9, unit_count: 0 })]), '422 INVALID_UNITS');
  assert.equal(await code([ins('tasks.tasks', { project_id: OBRA, title: 'X', position: 9, unit_count: 2.5 })]), '422 INVALID_UNITS');
});

test('una marca por unidad: «2 de 3»; con las tres, el paso queda hecho; desmarcar una lo deshace; repetir no cambia', async () => {
  let out = await step({ taskId: PASO, unit: 1 }, app.tokens.editor);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual([out.data.unitsDone, out.data.units, out.data.taskDone], [1, 3, false]);
  assert.equal((await step({ taskId: PASO, unit: 1 })).data.unitsDone, 1, 'repetir no duplica');
  out = await step({ taskId: PASO, unit: 2 });
  assert.equal(out.data.unitsDone, 2);
  assert.equal((await row('tasks.tasks', PASO)).done, false);
  out = await step({ taskId: PASO, unit: 3 });
  assert.deepEqual([out.data.unitsDone, out.data.taskDone], [3, true]);
  assert.equal((await row('tasks.tasks', PASO)).done, true);
  assert.deepEqual(await units(PASO), [1, 2, 3]);
  out = await step({ taskId: PASO, unit: 2, done: false });
  assert.deepEqual([out.data.unitsDone, out.data.taskDone], [2, false]);
  assert.equal((await row('tasks.tasks', PASO)).done, false);
});

test('lo que no vale: unidad fuera de rango, tarea sin unidades, un contenedor, quien solo lee, y escribir unidades a mano', async () => {
  assert.equal((await step({ taskId: PASO, unit: 4 })).status, 422);
  assert.equal((await step({ taskId: SUELTA, unit: 1 })).status, 422, 'sin unidades: tasks/complete');
  assert.equal((await step({ taskId: MADRE, unit: 1 })).status, 422, 'se marcan sus pasos');
  assert.equal((await step({ taskId: uuid(), unit: 1 })).status, 404);
  assert.equal((await step({ taskId: PASO, unit: 1 }, app.tokens.reader)).status, 403);
  assert.equal((await step({ taskId: PASO, unit: 1, color: 'rojo' })).status, 422);
  assert.equal(await code([ins('tasks.task_units', { project_id: OBRA, task_id: PASO, unit: 3 })]), '422 INVALID_UNITS');
});

test('las unidades siguen a su tarea al moverla y van a la papelera con ella', async () => {
  for (const batch of [moveTaskOps(await data(), MADRE, { project_id: OTRA })]) assert.equal(await code(batch), '200 OK');
  assert.ok((await rows('tasks.task_units')).filter((u) => u.task_id === PASO).every((u) => u.project_id === OTRA));
  assert.equal(await code([{ op: 'delete', table: 'tasks.projects', id: OTRA, expectedRevision: (await row('tasks.projects', OTRA)).revision }]), '200 OK');
  const emptied = await app.call('/api/v1/trash/empty', { body: { requestId: `units-trash-${++seq}` } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.deepEqual(await units(PASO), []);
});
