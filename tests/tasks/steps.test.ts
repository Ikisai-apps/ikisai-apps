/**
 * Tasks · «Pasos en orden» (FB_2026_041, migración 0320; como aviso desde FB_2026_064, migración 0341), contra el núcleo y el
 * hook reales: con la casilla en la madre, la hija anterior pendiente sale como aviso («bloqueada» en `statuses`) pero ya no
 * impide completar; las dependencias manuales sí lo impiden. También el cálculo del dominio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, statuses, type Operation } from '../../packages/domain-tasks/src/index.ts';
import { completionBlockers } from '../../supabase/functions/_domain/tasks/graph.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), P = uuid(), MADRE = uuid(), A = uuid(), B = uuid(), C = uuid(), OTRA = uuid();
let app: TestApp;
let seq = 0;

const rows = async (t: string) => (await app.call(`/api/v1/snapshot?tables=${t}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const row = async (t: string, id: string) => (await rows(t)).find((r) => r.id === id);
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `s-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); };
const set = async (id: string, fields: Record<string, unknown>) => commit([{ op: 'update', table: 'tasks.tasks', id, expectedRevision: (await row('tasks.tasks', id)).revision, fields }]);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Obra', position: 1024 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Baño', position: 2048 } }]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: MADRE, fields: { tab_id: TAB, project_id: P, title: 'Alicatar', position: 1024, steps_in_order: true } },
    { op: 'insert', table: 'tasks.tasks', id: OTRA, fields: { tab_id: TAB, project_id: P, title: 'Comprar material', position: 9000 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: A, fields: { tab_id: TAB, project_id: P, parent_id: MADRE, title: 'Quitar azulejos', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: B, fields: { tab_id: TAB, project_id: P, parent_id: MADRE, title: 'Nivelar', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: C, fields: { tab_id: TAB, project_id: P, parent_id: MADRE, title: 'Poner azulejos', position: 3072 } },
  ]);
});
test.after(async () => { await app.close(); });

test('FB_2026_064: con «pasos en orden», un paso se marca aunque el anterior esté pendiente', async () => {
  const skipped = await set(B, { done: true });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.data));
  assert.equal((await row('tasks.tasks', B)).done, true);
  assert.equal((await row('tasks.tasks', A)).done, false, 'el anterior sigue pendiente');
  assert.equal((await set(B, { done: false })).status, 200);
});

test('las dependencias manuales siguen impidiendo completar; quitar la casilla no las toca', async () => {
  await ok([{ op: 'insert', table: 'tasks.task_dependencies', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: B, depends_on_id: OTRA, position: 1024 } }]);
  const blocked = await set(B, { done: true });
  assert.equal(blocked.status, 422, JSON.stringify(blocked.data));
  assert.equal(blocked.data.error.code, 'TASK_BLOCKED');
  assert.deepEqual(blocked.data.error.details.blockedBy, [OTRA], 'solo la manual, no el paso anterior');
  assert.equal((await set(OTRA, { done: true })).status, 200);
  assert.equal((await set(B, { done: true })).status, 200);
  assert.equal((await set(MADRE, { steps_in_order: false })).status, 200);
});

test('el dominio: la hija anterior pendiente sale como aviso en `statuses`, pero no en `completionBlockers`', () => {
  const base = { tab_id: TAB, project_id: P, note: '', priority: 'normal', due: null, owner_label_id: null, cost: null, done_at: null, revision: 1, deleted_at: null, created_at: '', updated_at: '', updated_by: null } as const;
  const tasks = [
    { ...base, id: MADRE, parent_id: null, title: 'M', done: false, position: 1, steps_in_order: true },
    { ...base, id: A, parent_id: MADRE, title: 'A', done: false, position: 1 },
    { ...base, id: B, parent_id: MADRE, title: 'B', done: false, position: 2 },
    { ...base, id: C, parent_id: MADRE, title: 'C', done: false, position: 3, step_free: true },
  ] as any[];
  const out = statuses({ tasks, projects: [], dependencies: [] });
  assert.deepEqual(out.get(B)!.blockedBy, [A]);
  assert.deepEqual(out.get(A)!.blockedBy, []);
  assert.deepEqual(out.get(C)!.blockedBy, [], 'suelta');
  assert.deepEqual(completionBlockers(B, { tasks, projects: [], dependencies: [] }), [], 'el paso anterior no impide completar');
});
