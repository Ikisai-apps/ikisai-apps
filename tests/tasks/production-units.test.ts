/**
 * Tasks · «Proyectos y producción», 7.5 (3): la producción y «hoy» con unidades y entregables (migración 0362, docs/tasks/
 * API.md §58), contra el núcleo real: la producción trae los entregables con sus madres hechas y, por tarea, su entregable
 * (heredado en los pasos) y sus unidades («1 de 2»); «hoy» trae las unidades. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const madrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const TODAY = madrid();
const TAB = uuid(), OBRA = uuid(), MARCOS = uuid(), MADRE = uuid(), PASO = uuid(), SUELTA = uuid();
let app: TestApp;

const ins = (table: string, fields: Record<string, unknown>, id = uuid()): Operation => ({ op: 'insert', table, id, fields: { tab_id: TAB, ...fields } });
const commit = (operations: Operation[], requestId: string) => app.call('/api/v1/commands', { body: { requestId, operations } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Taller', position: 1024 }), 'tab')).status, 200);
  const out = await commit([
    ins('tasks.projects', { title: 'Marcos acústicos', position: 2048 }, OBRA),
    ins('tasks.project_deliverables', { project_id: OBRA, name: '2 marcos', quantity: 2, position: 1024 }, MARCOS),
    ins('tasks.tasks', { project_id: OBRA, title: 'Montar bastidor', position: 1024, unit_count: 2, deliverable_id: MARCOS }, MADRE),
    ins('tasks.tasks', { project_id: OBRA, title: 'Grapar', position: 1024, parent_id: MADRE, due: TODAY }, PASO),
    ins('tasks.tasks', { project_id: OBRA, title: 'Barrer', position: 2048, due: TODAY }, SUELTA),
  ], 'seed');
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal((await app.call('/api/v1/tasks/unit-step', { body: { taskId: PASO, unit: 1 } })).status, 200);
});
test.after(async () => { await app.close(); });

test('la producción: entregables con sus madres, y por tarea su entregable y sus unidades', async () => {
  const out = (await app.call(`/api/v1/projects/production?projectId=${OBRA}`)).data;
  assert.deepEqual(out.deliverables.map((d: any) => [d.id, d.name, d.total, d.open, d.done, d.status]), [[MARCOS, '2 marcos', 1, 1, false, 'todo']]);
  const by = (id: string) => out.tasks.find((t: any) => t.id === id);
  assert.equal(by(MADRE).deliverableId, MARCOS);
  assert.equal(by(PASO).deliverableId, MARCOS, 'el paso hereda el de su madre');
  assert.deepEqual(by(PASO).units, { total: 2, done: 1 });
  assert.equal(by(MADRE).units, null, 'el contenedor no se marca por unidades');
  assert.equal(by(SUELTA).units, null);
});

test('«hoy» trae las unidades de la tarea de trabajo', async () => {
  const items = (await app.call(`/api/v1/today/projection?date=${TODAY}&projectId=${OBRA}`)).data.items;
  assert.deepEqual(items.find((i: any) => i.id === PASO).units, { total: 2, done: 1 });
  assert.equal(items.find((i: any) => i.id === SUELTA).units, null);
});
