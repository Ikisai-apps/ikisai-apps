/**
 * Tasks · «Trabajos de hoy» para Flow (`GET today/projection`, `POST tasks/complete`, migración 0352, docs/tasks/API.md
 * §47), de extremo a extremo contra el núcleo real: lo que vence hoy o antes y sigue abierto, más lo hecho hoy; bloqueos
 * por dependencia y por pasos en orden; el ámbito de quien lee; marcar hecha, idempotente. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const madrid = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000));
const TODAY = madrid(), YESTERDAY = madrid(-1), TOMORROW = madrid(1);
const TAB = uuid(), P1 = uuid(), P2 = uuid();
const A = uuid(), B = uuid(), C = uuid(), D = uuid(), E = uuid(), S = uuid(), S1 = uuid(), S2 = uuid(), OTHER = uuid();
let app: TestApp;
let seq = 0;

const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `hoy-${++seq}`, operations } });
const task = (id: string, project: string, title: string, fields: Record<string, unknown> = {}): Operation => ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: project, title, position: ++seq * 1024, ...fields } });
const today = (query = '', token?: string) => app.call(`/api/v1/today/projection${query}`, { token });
const complete = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/tasks/complete', { token, body });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  assert.equal((await commit([
    { op: 'insert', table: 'tasks.projects', id: P1, fields: { tab_id: TAB, title: 'Montaje', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: P2, fields: { tab_id: TAB, title: 'Cocina', position: 3072 } },
  ])).status, 200);
  const out = await commit([
    task(A, P1, 'Colocar mesas', { due: TODAY, priority: 'high' }),
    task(B, P1, 'Revisar luces', { due: YESTERDAY }),
    task(C, P1, 'Flores', { due: TOMORROW }),
    task(E, P1, 'Manteles', { due: TODAY }),
    task(S, P1, 'Barra', { due: TODAY, steps_in_order: true }),
    task(S1, P1, 'Montar la barra', { parent_id: S, due: TODAY }),
    task(S2, P1, 'Poner los grifos', { parent_id: S, due: TODAY }),
    task(OTHER, P2, 'Limpiar la cámara', { due: TODAY }),
    { op: 'insert', table: 'tasks.task_dependencies', id: uuid(), fields: { tab_id: TAB, project_id: P1, task_id: E, depends_on_id: A, position: 1024 } },
  ]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal((await commit([task(D, P1, 'Barrer', { due: TODAY })])).status, 200);
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: D, expectedRevision: 1, fields: { done: true } }])).status, 200);
});
test.after(async () => { await app.close(); });

test('lo de hoy: vence hoy o antes y sigue abierto, más lo hecho hoy; urgente primero; bloqueos por dependencia y por pasos', async () => {
  const out = await today(`?date=${TODAY}`, app.tokens.reader);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.date, TODAY);
  const ids = out.data.items.map((i: any) => i.id);
  for (const id of [A, B, D, E, S, S1, S2, OTHER]) assert.ok(ids.includes(id), id);
  assert.equal(ids.includes(C), false, 'lo de mañana, no');
  assert.equal(out.data.items[0].id, A, 'lo urgente primero');
  const by = (id: string) => out.data.items.find((i: any) => i.id === id);
  assert.deepEqual([by(A).status, by(A).project, by(A).priority, by(A).blocked], ['open', 'Montaje', 'high', false]);
  assert.equal(by(B).overdue, true);
  assert.equal(by(D).status, 'done');
  assert.equal(by(E).blocked, true, 'espera a «Colocar mesas»');
  assert.deepEqual([by(S1).blocked, by(S2).blocked, by(S2).parentId], [false, true, S], 'el paso 2 espera al 1');
  assert.deepEqual([by(A).people, by(A).trades, by(A).spaces], [[], [], []]);
  // Por proyecto, y con el día por defecto (hoy en Madrid).
  assert.deepEqual((await today(`?projectId=${P2}`)).data.items.map((i: any) => i.id), [OTHER]);
  assert.equal((await today('?date=27-10-2026')).status, 422);
});

test('el ámbito de quien lee: con un proyecto, solo ese; un outsider sin nada abierto, nada', async () => {
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [P2] } }), app.users.editor]);
  try {
    assert.deepEqual((await today(`?date=${TODAY}`, app.tokens.editor)).data.items.map((i: any) => i.id), [OTHER]);
    assert.equal((await complete({ taskId: A }, app.tokens.editor)).status, 404, 'no marca lo que no ve');
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
  const outsider = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'outsider', '"*"'::jsonb)`, [outsider]);
  const seen = await today(`?date=${TODAY}`, app.supabase.tokenFor(outsider));
  assert.deepEqual([seen.status, seen.data.items], [200, []]);
});

test('marcar hecha: editor u owner, idempotente; la lista lo refleja', async () => {
  const first = await complete({ taskId: A, requestId: 'flow-hoy-1' }, app.tokens.editor);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual([first.data.taskId, first.data.done, first.data.changed], [A, true, true]);
  const again = await complete({ taskId: A, requestId: 'flow-hoy-1' }, app.tokens.editor);
  assert.deepEqual([again.data.done, again.data.changed], [true, false]);
  const after = (await today(`?date=${TODAY}`)).data.items;
  assert.equal(after.find((i: any) => i.id === A).status, 'done');
  assert.equal(after.find((i: any) => i.id === E).blocked, false, 'lo que esperaba, ya no espera');
  assert.equal((await complete({ taskId: B }, app.tokens.reader)).status, 403);
  assert.equal((await complete({ taskId: uuid() })).status, 404);
  assert.equal((await complete({ taskId: B, done: false })).status, 422);
});

test('las capacidades tasks.today_projection y tasks.complete están en el catálogo', async () => {
  const items = (await app.call('/api/v1/capabilities')).data.items;
  const read = items.find((c: any) => c.id === 'tasks.today_projection'), done = items.find((c: any) => c.id === 'tasks.complete');
  assert.deepEqual([read.route, read.kind, read.roles], ['GET today/projection', 'read', ['reader', 'editor', 'owner', 'outsider']]);
  assert.deepEqual([done.route, done.kind, done.roles, done.idempotent], ['POST tasks/complete', 'execute', ['editor', 'owner'], true]);
});
