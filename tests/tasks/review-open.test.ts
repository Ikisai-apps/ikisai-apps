/**
 * Tasks · «Revisión de apertura», 4: «lista para abrir» (`POST reviews/open`) y la proyección para Flow
 * (`GET reviews/projection`, capacidad `tasks.review_projection`), migración 0351, docs/tasks/API.md §46.4, de extremo a
 * extremo contra el núcleo real. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), PROJECT = uuid();
let app: TestApp;
let seq = 0;
let house = '';

const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `open-${++seq}`, operations } });
const create = async (eventRef: string) => {
  const out = await app.call('/api/v1/reviews', { body: { templateId: house, tabId: TAB, title: `Apertura ${eventRef}`, eventRef } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  return out.data.reviewId as string;
};
const projection = (query: string, token?: string) => app.call(`/api/v1/reviews/projection?${query}`, { token });
const open = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/reviews/open', { token, body });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.projects', id: PROJECT, fields: { tab_id: TAB, title: 'Otro', position: 4096 } }])).status, 200);
  house = (await app.call('/api/v1/snapshot?tables=tasks.review_templates')).data.tables[0].rows.find((t: any) => t.name === 'Revisión de apertura').id;
});
test.after(async () => { await app.close(); });

test('la proyección: por id o por evento, con zonas, ítems y totales; la ve quien solo lee, no quien no tiene el proyecto', async () => {
  const id = await create('booking:RES2026-90');
  const byId = await projection(`reviewId=${id}`, app.tokens.reader);
  assert.equal(byId.status, 200, JSON.stringify(byId.data));
  assert.deepEqual([byId.data.review.id, byId.data.review.status, byId.data.review.ready], [id, 'open', false]);
  assert.equal(byId.data.zones.length, 14);
  assert.deepEqual(byId.data.zones[3].label, 'Duchas y agua caliente');
  assert.deepEqual(byId.data.totals, { items: 15, critical: 6, criticalDone: 0, done: 0, failed: 0, pending: 15 });
  const item = byId.data.zones[3].items[0];
  assert.deepEqual([item.answer, item.expected, item.critical, item.state, item.corrective], ['reading', { unit: '°C', min: 50 }, true, 'pending', null]);
  const byEvent = await projection('eventRef=booking:RES2026-90');
  assert.equal(byEvent.data.review.id, id);
  // Tras un fallo, la correctiva y la comprobación salen en el ítem.
  assert.equal((await app.call('/api/v1/reviews/result', { body: { itemId: item.id, result: 'fail', value: 30 } })).status, 200);
  const after = (await projection(`reviewId=${id}`)).data;
  assert.deepEqual([after.zones[3].items[0].state, after.zones[3].items[0].corrective.done, after.zones[3].items[0].recheck.done, after.totals.failed], ['failed', false, false, 1]);
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [PROJECT] } }), app.users.editor]);
  try {
    assert.equal((await projection(`reviewId=${id}`, app.tokens.editor)).status, 404);
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
  assert.equal((await projection('eventRef=booking:RES-NINGUNA')).status, 404);
  assert.equal((await projection('')).status, 422);
});

test('abrir: lista, cualquiera que edita; con críticos pendientes, solo la owner, con nota, y queda lo que faltaba', async () => {
  const id = await create('booking:RES2026-91');
  const notReady = await open({ reviewId: id }, app.tokens.editor);
  assert.deepEqual([notReady.status, notReady.data.error.code, notReady.data.error.details.pending.length], [409, 'REVIEW_NOT_READY', 6]);
  assert.equal((await open({ reviewId: id, override: true, note: 'Abrimos igual' }, app.tokens.editor)).status, 403, 'una editora no abre con pendientes');
  assert.equal((await open({ reviewId: id, override: true })).status, 422, 'sin nota, no');
  const forced = await open({ reviewId: id, override: true, note: 'El técnico viene mañana; extintores revisados de palabra' });
  assert.equal(forced.status, 200, JSON.stringify(forced.data));
  assert.deepEqual([forced.data.status, forced.data.override, forced.data.openedBy, forced.data.pending.length], ['opened', true, app.users.owner, 6]);
  const shown = (await projection(`reviewId=${id}`)).data.review;
  assert.deepEqual([shown.status, shown.override, shown.openNote, shown.pendingAtOpen.length], ['opened', true, 'El técnico viene mañana; extintores revisados de palabra', 6]);
  assert.equal((await open({ reviewId: id })).data.status, 'opened', 'repetir devuelve lo que hay');

  // Con todos los críticos verificados, una editora abre sin más.
  const ready = await create('booking:RES2026-92');
  for (const zone of (await projection(`reviewId=${ready}`)).data.zones) {
    for (const i of zone.items.filter((x: any) => x.critical)) {
      const value = i.answer !== 'reading' ? undefined : i.expected.max !== undefined && i.expected.min === undefined ? i.expected.max - 1 : i.expected.min + (i.expected.max !== undefined ? 0 : 5);
      assert.equal((await app.call('/api/v1/reviews/result', { body: { itemId: i.id, result: 'ok', ...(value !== undefined ? { value } : {}) } })).status, 200, i.title);
    }
  }
  assert.equal((await projection(`reviewId=${ready}`)).data.review.status, 'ready');
  const opened = await open({ reviewId: ready }, app.tokens.editor);
  assert.deepEqual([opened.status, opened.data.override, opened.data.pending], [200, false, []]);
  assert.equal((await open({ reviewId: ready }, app.tokens.reader)).status, 403);
  assert.equal((await open({ reviewId: uuid() })).status, 404);
});

test('la capacidad tasks.review_projection está en el catálogo, también para quien solo lee', async () => {
  const cap = (await app.call('/api/v1/capabilities')).data.items.find((c: any) => c.id === 'tasks.review_projection');
  assert.deepEqual([cap.route, cap.kind, cap.roles], ['GET reviews/projection', 'read', ['reader', 'editor', 'owner']]);
});
