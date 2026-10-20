/**
 * Tasks · tanda 31 (MUELA-057, 064 y 073, hallazgo 8), contra el núcleo y el hook reales:
 * - el espacio de una petición (`space_id`, 0336): se guarda y la tarea lo lleva, con regla o al clasificar;
 * - deshacer una clasificación (`unrouteRequestOps`): la petición vuelve a pendiente o pasa a descartada y su tarea va a la
 *   papelera en el mismo lote; volver a clasificarla trae la tarea de la papelera al proyecto nuevo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { classifyRequestOps, createTabOps, emptyDataset, unrouteRequestOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const WORKER_KEY = 'clave-de-worker-de-prueba';
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid(), OBRA = uuid(), JARDIN = uuid();
let app: TestApp;
let SPACE = '', OTHER_SPACE = '';
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `undo-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const r = await commit(operations); assert.equal(r.status, 200, JSON.stringify(r.data)); };
const ask = (body: Record<string, unknown>) => app.call('/api/v1/requests/task', { body });
const worker = (body: unknown) => app.handler(new Request('http://localhost/api/v1/worker/requests/task', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: JSON.stringify(body) }));
const data = async () => {
  const out: any = {};
  for (const table of ['tasks.tabs', 'tasks.projects', 'tasks.tasks', 'tasks.project_labels', 'tasks.project_spaces', 'tasks.task_spaces', 'tasks.task_labels', 'tasks.requests', 'tasks.request_routes']) out[table] = await rows(table);
  return { ...emptyDataset(), ...out };
};
const spacesOf = async (taskId: string) => (await rows('tasks.task_spaces')).filter((r) => r.task_id === taskId && !r.deleted_at).map((r) => r.space_id);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin], workerKey: WORKER_KEY }) });
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024, inboxId: INBOX }));
  await ok([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Reparaciones', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: JARDIN, fields: { tab_id: TAB, title: 'Jardín', position: 3072 } },
  ]);
  const spaces = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where deleted_at is null and active order by name limit 2`)).rows;
  SPACE = spaces[0]!.id; OTHER_SPACE = spaces[1]!.id;
});
test.after(async () => { await app.close(); });

test('espacio de la petición: se guarda; al clasificar la tarea lo lleva; uno que no existe se ignora', async () => {
  const first = await ask({ source: 'central', external_ref: 'SP-1', title: 'Gotera', space_id: SPACE });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const request = (await rows('tasks.requests')).find((r) => r.external_ref === 'central:SP-1');
  assert.deepEqual([request.status, request.space_id], ['pending', SPACE]);
  await ok(classifyRequestOps(await data(), request.id, { project_id: OBRA }));
  assert.deepEqual(await spacesOf(request.id), [SPACE]);

  const ghost = await ask({ source: 'central', external_ref: 'SP-2', title: 'Sin sitio', space_id: uuid() });
  assert.equal(ghost.status, 200, JSON.stringify(ghost.data));
  assert.equal((await rows('tasks.requests')).find((r) => r.external_ref === 'central:SP-2').space_id, null, 'un espacio que no existe no se guarda');
  assert.equal((await ask({ source: 'central', external_ref: 'SP-3', title: 'Mal', space_id: 'no' })).status, 422);
  // Nadie lo cambia después: solo cambia el estado de una petición.
  const again = (await rows('tasks.requests')).find((r) => r.external_ref === 'central:SP-2');
  assert.equal((await commit([{ op: 'update', table: 'tasks.requests', id: again.id, expectedRevision: again.revision, fields: { space_id: SPACE } }])).status, 422);
});

test('espacio de la petición: con regla, la tarea lo lleva junto al del proyecto, sin repetirlo', async () => {
  await ok([{ op: 'insert', table: 'tasks.project_spaces', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, space_id: OTHER_SPACE } }]);
  await ok([{ op: 'insert', table: 'tasks.request_routes', id: uuid(), fields: { kind: 'feedback.space.damage', tab_id: TAB, project_id: OBRA, position: 1024 } }]);
  const { simulateServiceIdentity } = await import('./fixtures.ts');
  await simulateServiceIdentity(app.t.db, uuid());
  const report = (code: string, space: string) => ({ source: 'feedback', kind: 'feedback.space.damage', external_ref: code, title: 'Ducha rota', space_id: space,
    on_behalf_of: { kind: 'guest', report_code: code }, external_url: `https://tasks.ikisai.com/#/feedback/${code}` });
  const routed = await (await worker(report('FB_2026_000901', SPACE))).json() as any;
  assert.equal(routed.status, 'open', JSON.stringify(routed));
  assert.deepEqual((await spacesOf(routed.taskId)).sort(), [SPACE, OTHER_SPACE].sort());
  const same = await (await worker(report('FB_2026_000902', OTHER_SPACE))).json() as any;
  assert.deepEqual(await spacesOf(same.taskId), [OTHER_SPACE], 'el del proyecto y el del aviso, una sola vez');
  const bad = await worker({ ...report('FB_2026_000903', SPACE), space_id: 'x' });
  assert.equal(bad.status, 422);
});

test('deshacer la clasificación: pendiente otra vez, su tarea a la papelera; clasificar de nuevo la trae al proyecto nuevo', async () => {
  await ask({ source: 'central', external_ref: 'UN-1', title: 'Revisar caldera', space_id: SPACE });
  const request = (await rows('tasks.requests')).find((r) => r.external_ref === 'central:UN-1');
  await ok(classifyRequestOps(await data(), request.id, { project_id: OBRA }));
  await ok(unrouteRequestOps(await data(), request.id));
  const back = (await rows('tasks.requests')).find((r) => r.id === request.id);
  assert.deepEqual([back.status, back.routed_by], ['pending', null]);
  assert.ok((await rows('tasks.tasks')).find((t) => t.id === request.id).deleted_at, 'la tarea, en la papelera');
  // Otra vez, a otro proyecto de la misma área: vuelve la misma tarea, con sus filas, en el proyecto nuevo.
  await ok(classifyRequestOps(await data(), request.id, { project_id: JARDIN }));
  const task = (await rows('tasks.tasks')).find((t) => t.id === request.id);
  assert.deepEqual([task.deleted_at, task.project_id, task.external_ref], [null, JARDIN, 'central:UN-1']);
  assert.equal((await rows('tasks.task_spaces')).find((r) => r.task_id === request.id && !r.deleted_at).project_id, JARDIN);
  assert.equal((await rows('tasks.requests')).find((r) => r.id === request.id).status, 'routed');
  // De una tarea a «Descartado» (064): la petición, descartada; la tarea, en la papelera.
  await ok(unrouteRequestOps(await data(), request.id, 'dismissed'));
  assert.equal((await rows('tasks.requests')).find((r) => r.id === request.id).status, 'dismissed');
  assert.ok((await rows('tasks.tasks')).find((t) => t.id === request.id).deleted_at);
  // Solo una enrutada con su tarea viva.
  assert.throws(() => unrouteRequestOps(emptyDataset(), uuid()));
});

test('el hook no deja quitar la tarea sin devolver la petición, ni al revés', async () => {
  await ask({ source: 'central', external_ref: 'UN-2', title: 'Pintar banco' });
  const request = (await rows('tasks.requests')).find((r) => r.external_ref === 'central:UN-2');
  await ok(classifyRequestOps(await data(), request.id, { project_id: OBRA }));
  const ops = unrouteRequestOps(await data(), request.id);
  assert.equal((await commit(ops.slice(0, 1))).status, 422, 'pendiente con la tarea viva');
  const after = await data();
  const fresh = after['tasks.requests'].find((r: any) => r.id === request.id);
  assert.equal(fresh.status, 'routed');
});
