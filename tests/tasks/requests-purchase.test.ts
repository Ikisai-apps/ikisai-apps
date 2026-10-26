/**
 * Tasks · compra pedida desde otra app (`POST requests/purchase`, docs/tasks/API.md §39; «Pedir a Tasks» de Flow), de
 * extremo a extremo contra el núcleo y el hook reales: se crea una vez por referencia en el proyecto pedido, nace «pedida»
 * con la procedencia en la nota, repetir la devuelve sin tocarla, y se respetan el alcance, el archivo y los roles.
 * También `requests/task` con `source: 'flow'` (la otra mitad de «Pedir a Tasks») y la lista de proyectos abiertos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { requestPurchaseId, requestTaskId } from '../../supabase/functions/tasks-api/requests.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), BARRA = uuid(), PRIVADO = uuid(), VIEJO = uuid();
let app: TestApp;
let seq = 0;

const ask = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/requests/purchase', { token, body });
const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `seed-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await commit(createTabOps({ id: TAB, name: 'Eventos', position: 1024 }));
  await commit([
    { op: 'insert', table: 'tasks.projects', id: BARRA, fields: { tab_id: TAB, title: 'Montaje de la barra', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PRIVADO, fields: { tab_id: TAB, title: 'Privado', position: 3072 } },
    { op: 'insert', table: 'tasks.projects', id: VIEJO, fields: { tab_id: TAB, title: 'Barra de 2025', position: 4096, status: 'archived' } },
  ]);
  // El editor solo ve el proyecto de la barra.
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [BARRA] } }), app.users.editor]);
});
test.after(async () => { await app.close(); });

test('pedir una compra: se crea una vez, pedida, en el proyecto y con la procedencia; repetir la devuelve sin tocarla', async () => {
  const body = { source: 'flow', external_ref: 'unit-123', title: 'Tomate rallado', quantity: 3, unit: 'kg', note: 'Para el turno de noche', project_id: BARRA };
  const first = await ask(body, app.tokens.editor);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.created, true);
  const p = first.data.purchase;
  assert.equal(p.id, await requestPurchaseId('flow:unit-123'));
  assert.deepEqual([p.kind, p.tabId, p.projectId, p.status, p.quantity, p.unit, p.externalRef], ['purchase_request', TAB, BARRA, 'requested', 3, 'kg', 'flow:unit-123']);
  const row = (await rows('tasks.purchase_requests')).find((r) => r.id === p.id);
  assert.equal(row.title, 'Tomate rallado');
  assert.equal(row.note, 'Pedida desde flow · unit-123\nPara el turno de noche');
  assert.equal(row.needs_invoice, true);

  const again = await ask({ ...body, title: 'Otro título', quantity: 9 }, app.tokens.editor);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.created, false);
  assert.equal(again.data.purchase.id, p.id);
  const same = (await rows('tasks.purchase_requests')).filter((r) => r.note.startsWith('Pedida desde flow · unit-123'));
  assert.equal(same.length, 1, 'una sola solicitud');
  assert.equal(same[0].title, 'Tomate rallado', 'repetir no la cambia');
});

test('dos peticiones a la vez con la misma referencia dejan una sola solicitud', async () => {
  const body = { source: 'flow', external_ref: 'unit-456', title: 'Hielo', project_id: BARRA };
  const [a, b] = await Promise.all([ask(body, app.tokens.editor), ask(body, app.tokens.editor)]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(a.data.purchase.id, b.data.purchase.id);
  assert.equal([a.data.created, b.data.created].filter(Boolean).length, 1);
  assert.equal((await rows('tasks.purchase_requests')).filter((r) => r.id === a.data.purchase.id).length, 1);
});

test('alcance, archivo, roles y entrada: lo que no vale no entra', async () => {
  const base = { source: 'flow', title: 'Servilletas' };
  // Un proyecto que el editor no ve: como si no existiera.
  assert.equal((await ask({ ...base, external_ref: 'x1', project_id: PRIVADO }, app.tokens.editor)).status, 404);
  // Archivado: no se piden compras ahí.
  const archived = await ask({ ...base, external_ref: 'x2', project_id: VIEJO });
  assert.equal(archived.status, 422);
  assert.equal(archived.data.error.code, 'PROJECT_ARCHIVED');
  // Quien solo lee no pide.
  assert.equal((await ask({ ...base, external_ref: 'x3', project_id: BARRA }, app.tokens.reader)).status, 403);
  // Entrada mala.
  for (const bad of [{ project_id: BARRA }, { ...base, external_ref: 'x4' }, { ...base, external_ref: 'x5', project_id: 'no' }, { ...base, external_ref: 'x6', project_id: BARRA, quantity: -1 }, { ...base, external_ref: 'x7', project_id: BARRA, source: 'Flow' }]) {
    const res = await ask(bad);
    assert.equal(res.status, 422, JSON.stringify(bad));
    assert.equal(res.data.error.code, 'INVALID_INPUT');
  }
  assert.equal((await rows('tasks.purchase_requests')).filter((r) => /Pedida desde flow · x\d/.test(r.note)).length, 0);
});

test('la otra mitad: una tarea con `requests/task` en el proyecto de la barra, y la lista de proyectos abiertos', async () => {
  const res = await app.call('/api/v1/requests/task', { token: app.tokens.editor, body: { source: 'flow', kind: 'flow.logistics', kind_label: 'Logística de la barra', external_ref: 'unit-789', title: 'Reponer vasos', project_id: BARRA } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.task.id, await requestTaskId('flow:unit-789'));
  assert.equal(res.data.task.projectId, BARRA);
  // Proyectos abiertos que ve el editor: solo la barra (sin el privado ni el archivado).
  const tree = await app.call('/api/v1/read/tasks.targets', { token: app.tokens.editor, body: { tabId: TAB } });
  assert.equal(tree.status, 200, JSON.stringify(tree.data));
  const projects = tree.data.tabs.flatMap((t: any) => t.projects).filter((p: any) => !p.system && p.status !== 'archived' && !p.deleted).map((p: any) => p.id);
  assert.deepEqual(projects, [BARRA]);
});
