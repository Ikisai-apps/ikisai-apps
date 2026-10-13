/**
 * Tasks · «Pasos en orden» (FB_2026_041, migración 0320), contra el núcleo y el hook reales: con la casilla en la madre, una
 * hija no se completa mientras la anterior (por posición) esté pendiente; las hechas no bloquean; reordenar recalcula; una
 * hija soltada de la cadena ni bloquea ni espera; y convive con las dependencias manuales. También el cálculo del dominio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, statuses, type Operation } from '../../packages/domain-tasks/src/index.ts';

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

test('con «pasos en orden», una hija espera a la anterior; las hechas no bloquean', async () => {
  const blocked = await set(B, { done: true });
  assert.equal(blocked.status, 422, JSON.stringify(blocked.data));
  assert.equal(blocked.data.error.code, 'TASK_BLOCKED');
  assert.deepEqual(blocked.data.error.details.blockedBy, [A]);
  assert.equal((await set(A, { done: true })).status, 200);
  assert.equal((await set(B, { done: true })).status, 200, 'hecha la anterior, ya se puede');
});

test('reordenar recalcula la cadena; una hija suelta ni espera ni bloquea; convive con las dependencias manuales', async () => {
  // C pasa delante de B (que ya está hecha) y de A: queda la primera, sin paso anterior.
  assert.equal((await set(C, { position: 500 })).status, 200);
  assert.equal((await set(B, { done: false })).status, 200);
  assert.equal((await set(A, { done: false })).status, 200);
  // Orden ahora: C, A, B. A espera a C.
  assert.equal((await set(A, { done: true })).data.error?.code, 'TASK_BLOCKED');
  // Soltada de la cadena, A ya no espera a C; y B pasa a esperar directamente a C.
  assert.equal((await set(A, { step_free: true })).status, 200);
  assert.equal((await set(A, { done: true })).status, 200);
  const b = await set(B, { done: true });
  assert.deepEqual(b.data.error?.details?.blockedBy, [C]);
  // Una dependencia manual más: B también espera a «Comprar material».
  await ok([{ op: 'insert', table: 'tasks.task_dependencies', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: B, depends_on_id: OTRA, position: 1024 } }]);
  assert.equal((await set(C, { done: true })).status, 200);
  assert.deepEqual((await set(B, { done: true })).data.error?.details?.blockedBy, [OTRA]);
  // Sin la casilla en la madre, la cadena desaparece (la manual sigue).
  assert.equal((await set(MADRE, { steps_in_order: false })).status, 200);
});

test('el dominio calcula lo mismo: la hija anterior pendiente aparece entre lo que bloquea', () => {
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
});
