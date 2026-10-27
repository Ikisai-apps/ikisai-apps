/**
 * Tasks · «Proyectos y producción», 7.5: entregables del proyecto (migración 0361, docs/tasks/API.md §57), de extremo a
 * extremo contra el núcleo, Recursos y los hooks reales: el entregable es de su proyecto y solo de una madre; su espacio
 * existe; «hecho» se calcula con sus tareas y «entregado» e «instalado» se marcan a mano; no se borra con tareas vivas;
 * mover una tarea lo suelta; el modelo de la interfaz los lleva y los trae; vaciar la papelera los purga. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { TABLES, compose, createTabOps, decompose, emptyDataset, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OBRA = uuid(), OTRA = uuid(), MARCOS = uuid(), AJENO = uuid(), SALA = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`)).data.tables[0].rows as any[];
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `entregables-${++seq}`, operations } });
const code = async (operations: Operation[], token?: string) => { const r = await commit(operations, token); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
const data = async () => { const d: any = emptyDataset(); for (const t of TABLES) d[t] = await rows(t); return d; };
const deliverable = (id: string, project: string, name: string, extra: Record<string, unknown> = {}): Operation =>
  ({ op: 'insert', table: 'tasks.project_deliverables', id, fields: { tab_id: TAB, project_id: project, name, position: 1024, ...extra } });
const task = (id: string, project: string, extra: Record<string, unknown> = {}): Operation =>
  ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: project, title: 'Marco', position: 1024, ...extra } });
const update = async (table: string, id: string, fields: Record<string, unknown>): Promise<Operation> =>
  ({ op: 'update', table, id, expectedRevision: (await row(table, id)).revision, fields });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal(await code(createTabOps({ id: TAB, name: 'Taller', position: 1024 })), '200 OK');
  const altura = (await app.t.db.query(`select id from resources.spaces where name = 'Altura 3' and deleted_at is null`)).rows[0] as { id: string };
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $2, 'edificio', 'Sala grande Prueba', 1)`, [SALA, altura.id]);
  assert.equal(await code([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Marcos acústicos', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: OTRA, fields: { tab_id: TAB, title: 'Otra obra', position: 4096 } },
    deliverable(MARCOS, OBRA, '4 marcos acústicos', { quantity: 4, space_id: SALA }), deliverable(AJENO, OTRA, 'Barra'),
  ]), '200 OK');
});
test.after(async () => { await app.close(); });

test('un entregable: nombre, cantidad, estado y espacio válidos; lo ve quien ve el proyecto', async () => {
  const d = (await rows('tasks.project_deliverables')).find((x) => x.id === MARCOS);
  assert.deepEqual([d.name, Number(d.quantity), d.status, d.space_id], ['4 marcos acústicos', 4, 'todo', SALA]);
  assert.equal(await code([deliverable(uuid(), OBRA, '  ')]), '422 INVALID_DELIVERABLE');
  assert.equal(await code([deliverable(uuid(), OBRA, 'X', { status: 'hecho' })]), '422 INVALID_DELIVERABLE', '«hecho» se calcula');
  assert.equal(await code([deliverable(uuid(), OBRA, 'X', { quantity: 0 })]), '422 INVALID_DELIVERABLE');
  assert.equal(await code([deliverable(uuid(), OBRA, 'X', { space_id: uuid() })]), '422 INVALID_SPACE');
  assert.equal(await code([deliverable(uuid(), OBRA, 'X')], app.tokens.reader), '403 FORBIDDEN');
});

test('la tarea: un entregable vivo de su proyecto, solo en la madre; moverla lo suelta', async () => {
  const madre = uuid(), paso = uuid(), suelta = uuid();
  assert.equal(await code([task(uuid(), OBRA, { deliverable_id: AJENO })]), '422 INVALID_DELIVERABLE');
  assert.equal(await code([task(madre, OBRA, { deliverable_id: MARCOS })]), '200 OK');
  assert.equal(await code([task(paso, OBRA, { parent_id: madre, deliverable_id: MARCOS })]), '422 INVALID_DELIVERABLE');
  assert.equal(await code([task(suelta, OBRA, { deliverable_id: MARCOS })]), '200 OK');
  assert.equal(await code([await update('tasks.tasks', suelta, { project_id: OTRA })]), '200 OK');
  assert.equal((await row('tasks.tasks', suelta)).deliverable_id, null);
});

test('«hecho» con sus tareas; entregado e instalado a mano; no se borra con tareas vivas', async () => {
  const d = uuid(), a = uuid();
  assert.equal(await code([deliverable(d, OBRA, 'Plano de montaje', { position: 2048 }), task(a, OBRA, { deliverable_id: d })]), '200 OK');
  let model = compose(await data()).find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!;
  assert.deepEqual(['open', 'total', 'done'].map((k) => (model.deliverables!.find((x) => x.id === d) as any)[k]), [1, 1, false]);
  assert.equal(await code([await update('tasks.tasks', a, { done: true })]), '200 OK');
  model = compose(await data()).find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!;
  assert.equal(model.deliverables!.find((x) => x.id === d)!.done, true);
  assert.equal(await code([await update('tasks.project_deliverables', d, { status: 'delivered' })]), '200 OK');
  assert.equal(await code([await update('tasks.project_deliverables', d, { status: 'installed' })]), '200 OK');
  const del = async (): Promise<Operation> => ({ op: 'delete', table: 'tasks.project_deliverables', id: d, expectedRevision: (await row('tasks.project_deliverables', d)).revision });
  assert.equal(await code([await del()]), '422 DELIVERABLE_NOT_EMPTY');
  assert.equal(await code([await update('tasks.tasks', a, { deliverable_id: null }), await del()]), '200 OK');
});

test('el modelo de la interfaz: los pasos heredan el entregable y quitarlo del modelo suelta sus tareas', async () => {
  const d = uuid(), madre = uuid(), paso = uuid();
  assert.equal(await code([deliverable(d, OBRA, 'Muestra de tela', { position: 3072 }), task(madre, OBRA, { deliverable_id: d }), task(paso, OBRA, { parent_id: madre })]), '200 OK');
  let tabs = compose(await data());
  let obra = tabs.find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!;
  assert.equal(obra.tasks.find((t) => t.id === paso)!.deliverableId, d);
  const same = decompose(await data(), tabs).flat();
  assert.deepEqual(same.filter((o) => o.table === 'tasks.project_deliverables' || (o.fields && 'deliverable_id' in o.fields)), []);
  obra.deliverables = obra.deliverables!.filter((x) => x.id !== d);
  for (const batch of decompose(await data(), tabs)) assert.equal(await code(batch), '200 OK');
  assert.equal(await row('tasks.project_deliverables', d), undefined, 'en la papelera');
  assert.equal((await row('tasks.tasks', madre)).deliverable_id, null);
  tabs = compose(await data());
  obra = tabs.find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!;
  assert.equal(obra.tasks.find((t) => t.id === paso)!.deliverableId, undefined);
});

test('vaciar la papelera purga los entregables de un proyecto borrado', async () => {
  const proyecto = uuid(), d = uuid();
  assert.equal(await code([{ op: 'insert', table: 'tasks.projects', id: proyecto, fields: { tab_id: TAB, title: 'Prototipo', position: 8192 } }, deliverable(d, proyecto, 'Prototipo')]), '200 OK');
  assert.equal(await code([{ op: 'delete', table: 'tasks.projects', id: proyecto, expectedRevision: (await row('tasks.projects', proyecto)).revision }]), '200 OK');
  const emptied = await app.call('/api/v1/trash/empty', { body: { requestId: `entregables-trash-${++seq}` } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.equal(await row('tasks.project_deliverables', d), undefined);
});
