/**
 * Tasks · «Revisión de apertura», 2: crear una revisión desde su plantilla (`POST reviews`, migración 0349,
 * docs/tasks/API.md §46.2), de extremo a extremo contra el núcleo y los hooks reales: el proyecto, una madre por zona y una
 * hija por ítem, con la copia de lo de la plantilla; repetir no duplica; solo con el área entera; la revisión y sus ítems
 * no se escriben a mano. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OTHER = uuid(), PROJECT = uuid();
let app: TestApp;
let seq = 0;
let house = '';

const rows = async (table: string, token?: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=5000`, { token })).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `rev-${++seq}`, operations } });
const create = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/reviews', { token, body });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  assert.equal((await commit(createTabOps({ id: OTHER, name: 'Eventos', position: 2048 }))).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.projects', id: PROJECT, fields: { tab_id: TAB, title: 'Obra', position: 4096 } }])).status, 200);
  house = (await rows('tasks.review_templates')).find((t) => t.name === 'Revisión de apertura').id;
});
test.after(async () => { await app.close(); });

test('crear: el proyecto, una madre por zona en el orden de la plantilla, una hija por ítem y la copia de cada ítem', async () => {
  const reviewId = uuid();
  const out = await create({ reviewId, templateId: house, tabId: TAB, title: 'Apertura · Retiro de prueba', eventRef: 'booking:RES2026-80', due: '2026-11-14' }, app.tokens.editor);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual([out.data.reviewId, out.data.created, out.data.items], [reviewId, true, 15]);
  const project = (await rows('tasks.projects')).find((p) => p.id === out.data.projectId);
  assert.deepEqual([project.tab_id, project.title, project.due], [TAB, 'Apertura · Retiro de prueba', '2026-11-14']);
  const tasks = (await rows('tasks.tasks')).filter((t) => t.project_id === project.id);
  const zones = tasks.filter((t) => !t.parent_id).sort((a, b) => a.position - b.position);
  assert.equal(zones.length, 14, 'una por zona (comunes lleva dos ítems)');
  assert.deepEqual(zones.slice(0, 4).map((z) => z.title), ['Habitaciones', 'Camas', 'Aseos', 'Duchas y agua caliente']);
  const children = tasks.filter((t) => t.parent_id);
  assert.equal(children.length, 15);
  assert.equal(children.filter((t) => t.parent_id === zones.find((z) => z.title === 'Zonas comunes').id).length, 2);
  const review = (await rows('tasks.reviews')).find((r) => r.id === reviewId);
  assert.deepEqual([review.project_id, review.template_id, review.event_ref, review.status], [project.id, house, 'booking:RES2026-80', 'open']);
  const items = (await rows('tasks.review_items')).filter((i) => i.review_id === reviewId);
  assert.equal(items.length, 15);
  assert.equal(items.filter((i) => i.critical).length, 7);
  for (const i of items) assert.ok(children.some((t) => t.id === i.task_id), 'cada ítem con su tarea');
  const acs = items.find((i) => i.zone === 'duchas_acs');
  assert.deepEqual([acs.state, acs.answer, acs.expected], ['pending', 'reading', { unit: '°C', min: 50 }]);
  assert.equal(children.find((t) => t.id === acs.task_id).priority, 'high', 'lo crítico, urgente');

  // Repetir con el mismo reviewId devuelve la que hay, sin duplicar.
  const again = await create({ reviewId, templateId: house, tabId: TAB }, app.tokens.editor);
  assert.deepEqual([again.status, again.data.created, again.data.projectId], [200, false, project.id]);
  assert.equal((await rows('tasks.review_items')).filter((i) => i.review_id === reviewId).length, 15);
});

test('quién y con qué: el área entera, editor u owner; la plantilla, viva y de la casa o del área; el evento, <app>:<ref>', async () => {
  assert.equal((await create({ templateId: house, tabId: TAB }, app.tokens.reader)).status, 403);
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [PROJECT] } }), app.users.editor]);
  try {
    assert.equal((await create({ templateId: house, tabId: TAB }, app.tokens.editor)).status, 403, 'con un solo proyecto, no');
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
  const mine = uuid();
  assert.equal((await commit([
    { op: 'insert', table: 'tasks.review_templates', id: mine, fields: { tab_id: OTHER, name: 'De Eventos', position: 1 } },
    { op: 'insert', table: 'tasks.review_template_items', id: uuid(), fields: { tab_id: OTHER, template_id: mine, zone: 'cocina', title: 'Campana', answer: 'check', position: 1 } },
  ])).status, 200);
  assert.equal((await create({ templateId: mine, tabId: TAB })).status, 404, 'la plantilla de otra área, no');
  assert.equal((await create({ templateId: mine, tabId: OTHER })).status, 200, 'en la suya, sí');
  assert.equal((await create({ templateId: uuid(), tabId: TAB })).status, 404);
  assert.equal((await create({ templateId: house, tabId: TAB, eventRef: 'RES2026-80' })).status, 422);
  assert.equal((await create({ templateId: 'apertura', tabId: TAB })).status, 422);
});

test('la revisión y sus ítems no se escriben a mano: ni por commands ni con un call', async () => {
  const item = (await rows('tasks.review_items'))[0];
  const set = await commit([{ op: 'update', table: 'tasks.review_items', id: item.id, expectedRevision: item.revision, fields: { state: 'verified' } }]);
  assert.deepEqual([set.status, set.data.error.code], [422, 'INVALID_REVIEW']);
  const del = await commit([{ op: 'delete', table: 'tasks.reviews', id: item.review_id, expectedRevision: 1 }]);
  assert.equal(del.status, 422, 'tampoco borrarla');
  const call = await commit([{ op: 'call', procedure: 'tasks.review_create', args: { reviewId: uuid(), templateId: house, tabId: TAB } } as Operation]);
  assert.equal(call.status, 422);
  assert.equal((await rows('tasks.review_items')).find((i) => i.id === item.id).state, 'pending');
});
