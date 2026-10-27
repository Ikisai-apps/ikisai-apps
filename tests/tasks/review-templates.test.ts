/**
 * Tasks · «Revisión de apertura», 1: plantillas de revisión (migración 0348, docs/tasks/API.md §46), de extremo a extremo
 * contra el núcleo y el hook reales. La plantilla de la casa viene sembrada; las de la casa son de la owner; las de un área,
 * de quien tiene el área entera; lo esperado según el tipo de respuesta. Datos sintéticos.
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

const rows = async (table: string, token?: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`, { token })).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `review-${++seq}`, operations } });
const code = async (operations: Operation[], token?: string) => { const r = await commit(operations, token); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
const template = (id: string, tab: string | null, name = 'Revisión de cocina'): Operation => ({ op: 'insert', table: 'tasks.review_templates', id, fields: { tab_id: tab, name, position: 1024 } });
const item = (id: string, tpl: string, tab: string | null, extra: Record<string, unknown> = {}): Operation => ({
  op: 'insert', table: 'tasks.review_template_items', id, fields: { tab_id: tab, template_id: tpl, zone: 'cocina', title: 'Campana limpia', answer: 'check', position: 1024, ...extra } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal(await code(createTabOps({ id: TAB, name: 'Casa', position: 1024 })), '200 OK');
  assert.equal(await code(createTabOps({ id: OTHER, name: 'Eventos', position: 2048 })), '200 OK');
  assert.equal(await code([{ op: 'insert', table: 'tasks.projects', id: PROJECT, fields: { tab_id: TAB, title: 'Obra', position: 4096 } }]), '200 OK');
});
test.after(async () => { await app.close(); });

test('la plantilla de la casa «Revisión de apertura» viene sembrada, con sus zonas y sus críticos, y la ve quien solo lee', async () => {
  const [tpl] = (await rows('tasks.review_templates', app.tokens.reader)).filter((t) => t.name === 'Revisión de apertura');
  assert.ok(tpl, 'la ve quien solo lee');
  assert.equal(tpl.tab_id, null);
  const items = (await rows('tasks.review_template_items', app.tokens.reader)).filter((i) => i.template_id === tpl.id);
  assert.equal(items.length, 15);
  assert.equal(new Set(items.map((i) => i.zone)).size, 14, 'todas las zonas');
  assert.deepEqual(items.filter((i) => i.critical).map((i) => i.zone).sort(), ['accesos', 'agua', 'barandillas', 'duchas_acs', 'electricidad', 'extintores', 'maquinaria']);
  const acs = items.find((i) => i.zone === 'duchas_acs');
  assert.deepEqual([acs.answer, acs.expected], ['reading', { unit: '°C', min: 50 }]);
});

test('quién: las de la casa, solo la owner; las de un área, quien tiene el área entera; un acceso por proyecto, no', async () => {
  const house = uuid();
  assert.equal(await code([template(house, null, 'Revisión de salida'), item(uuid(), house, null)], app.tokens.editor), '403 FORBIDDEN', 'una editora no crea plantillas de la casa');
  assert.equal(await code([template(house, null, 'Revisión de salida'), item(uuid(), house, null)]), '200 OK', 'la owner, sí');
  assert.equal(await code([item(uuid(), house, null, { title: 'Otro' })], app.tokens.editor), '403 FORBIDDEN', 'ni sus ítems');

  const area = uuid();
  assert.equal(await code([template(area, TAB), item(uuid(), area, TAB)], app.tokens.editor), '200 OK', 'una editora con toda el área, sí');
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [PROJECT] } }), app.users.editor]);
  try {
    assert.equal(await code([template(uuid(), TAB)], app.tokens.editor), '403 FORBIDDEN', 'con un solo proyecto, no');
    assert.ok((await rows('tasks.review_templates', app.tokens.editor)).some((t) => t.id === area), 'pero la ve');
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
  assert.equal(await code([template(uuid(), TAB)], app.tokens.reader), '403 FORBIDDEN', 'quien solo lee, no');
});

test('los ítems: de una plantilla viva de su misma área, con zona y tipo conocidos y lo esperado según el tipo', async () => {
  const tpl = uuid();
  assert.equal(await code([template(tpl, TAB)]), '200 OK');
  assert.equal(await code([item(uuid(), tpl, TAB, { answer: 'reading', expected: { unit: 'ppm', min: 0.2, max: 1 }, critical: true })]), '200 OK');
  assert.equal(await code([item(uuid(), tpl, TAB, { answer: 'quantity', expected: { count: 24 } })]), '200 OK');
  for (const bad of [
    { answer: 'reading', expected: {} },
    { answer: 'reading', expected: { unit: '°C', min: 60, max: 50 } },
    { answer: 'quantity', expected: { unit: 'kg' } },
    { answer: 'quantity', expected: { count: 2.5 } },
    { answer: 'check', expected: { count: 1 } },
  ]) {
    // La forma la descarta ya la Edge (INVALID_REVIEW); el cruce con el tipo, el hook (INVALID_FIELDS).
    assert.match(await code([item(uuid(), tpl, TAB, bad)]), /^422 INVALID_(FIELDS|REVIEW)$/, JSON.stringify(bad));
  }
  // Lo que la Edge descarta antes: zona o tipo desconocidos, lo esperado mal formado.
  assert.equal(await code([item(uuid(), tpl, TAB, { zone: 'jardin' })]), '422 INVALID_REVIEW');
  assert.equal(await code([item(uuid(), tpl, TAB, { answer: 'firma' })]), '422 INVALID_REVIEW');
  assert.equal(await code([item(uuid(), tpl, TAB, { answer: 'reading', expected: { unit: '°C', otra: 1 } })]), '422 INVALID_REVIEW');
  // En otra área que su plantilla, o en una plantilla borrada: no.
  assert.equal(await code([item(uuid(), tpl, OTHER)]), '422 INVALID_FIELDS');
  const gone = (await rows('tasks.review_templates')).find((t) => t.id === tpl);
  assert.equal(await code([{ op: 'delete', table: 'tasks.review_templates', id: tpl, expectedRevision: gone.revision }]), '200 OK');
  assert.equal(await code([item(uuid(), tpl, TAB)]), '422 INVALID_FIELDS');
});
