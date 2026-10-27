/**
 * Tasks · sus capacidades en el catálogo del núcleo (migración 0345, contrato §8, docs/tasks/API.md §43): `GET capabilities`
 * las lista con `allowed` según el rol; `GET requests/projects` (tasks.projects_open) da los proyectos abiertos que se ven, y
 * `requests/task` (tasks.request_task) admite hijas también con el token de la persona. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid(), BARRA = uuid(), VIEJO = uuid();
let app: TestApp;
let seq = 0;
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `seed-${++seq}`, operations } });
const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await commit(createTabOps({ id: TAB, name: 'Eventos', position: 1024, inboxId: INBOX }));
  await commit([
    { op: 'insert', table: 'tasks.projects', id: BARRA, fields: { tab_id: TAB, title: 'Montaje de la barra', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: VIEJO, fields: { tab_id: TAB, title: 'Barra de 2025', position: 4096, status: 'archived' } },
  ]);
});
test.after(async () => { await app.close(); });

test('catálogo: las tres capacidades de pedir a Tasks, permitidas a editor y owner, no a quien solo lee', async () => {
  const ids = ['tasks.projects_open', 'tasks.request_purchase', 'tasks.request_task'];
  const mine = await app.call('/api/v1/capabilities');
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  const list = (mine.data.items ?? mine.data) as any[];
  // Las de pedir (0345); las de la revisión y «Trabajos de hoy» tienen sus propias pruebas.
  const ours = list.filter((c) => ids.includes(c.id));
  assert.deepEqual(ours.map((c) => c.id).sort(), ids);
  for (const c of ours) assert.deepEqual([c.allowed, c.risk, c.idempotent, c.roles], [true, 'low', true, ['editor', 'owner']]);
  assert.equal(ours.find((c) => c.id === 'tasks.request_task').route, 'POST requests/task');
  assert.equal(ours.find((c) => c.id === 'tasks.projects_open').kind, 'read');
  assert.ok(ours.find((c) => c.id === 'tasks.request_task').input.properties.children, 'con hijas');
  assert.ok(list.filter((c) => c.app === 'tasks').every((c) => Array.isArray(c.anchors) && c.anchors.length && c.anchors.every((a: string) => /^tasks(\.[a-z0-9_]+){1,4}$/.test(a))));
  const reader = await app.call('/api/v1/capabilities', { token: app.tokens.reader });
  const readerList = ((reader.data.items ?? reader.data) as any[]).filter((c) => ids.includes(c.id));
  assert.ok(readerList.length === 3 && readerList.every((c) => c.allowed === false));
});

test('tasks.projects_open: los proyectos abiertos que se ven, sin Entrada ni archivados', async () => {
  const res = await app.call('/api/v1/requests/projects');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.projects, [{ id: BARRA, title: 'Montaje de la barra', tabId: TAB, tabName: 'Eventos' }]);
});

test('tasks.request_task con hijas y el token de la persona: una vez cada una; las que dejan de venir, a la papelera', async () => {
  const ask = (children: unknown) => app.call('/api/v1/requests/task', { body: { source: 'flow', external_ref: 'montaje-1', title: 'Montar la barra', project_id: BARRA, children } });
  const first = await ask([{ external_ref: 'neveras', title: 'Enchufar las neveras' }, { external_ref: 'grifos', title: 'Probar los grifos' }]);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data.childrenCounts, { created: 2, updated: 0, retired: 0 });
  const parent = first.data.task.id;
  const second = await ask([{ external_ref: 'neveras', title: 'Enchufar las neveras' }]);
  assert.deepEqual(second.data.childrenCounts, { created: 0, updated: 0, retired: 1 });
  const kids = (await rows('tasks.tasks')).filter((t) => t.parent_id === parent);
  assert.deepEqual(kids.map((k) => [k.title, !!k.deleted_at]).sort(), [['Enchufar las neveras', false], ['Probar los grifos', true]]);
});
