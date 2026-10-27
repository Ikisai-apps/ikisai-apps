/**
 * Tasks · las revisiones de apertura del día (`GET reviews/day`, migración 0365, docs/tasks/API.md §59), para el recorrido de
 * Flow «Preparación y revisión de apertura»: tocan ese día las que vencen ese día y las que siguen sin abrir de antes; con su
 * plantilla, estado y totales; el recorrido entero (leer el día, leer sus ítems, marcar uno con incidencia) con las
 * capacidades del catálogo. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const TAB = crypto.randomUUID();
const madrid = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));
const TODAY = madrid(), YESTERDAY = madrid(-1), TOMORROW = madrid(1);
let app: TestApp;
let house = '';

const create = async (title: string, due: string) => {
  const out = await app.call('/api/v1/reviews', { body: { templateId: house, tabId: TAB, title, due } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  return out.data.reviewId as string;
};
const day = (query = '', token?: string) => app.call(`/api/v1/reviews/day${query}`, { token });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await app.call('/api/v1/commands', { body: { requestId: 'tab', operations: createTabOps({ id: TAB, name: 'Casa', position: 1024 }) } })).status, 200);
  house = (await app.call('/api/v1/snapshot?tables=tasks.review_templates')).data.tables[0].rows.find((t: any) => t.name === 'Revisión de apertura').id;
});
test.after(async () => { await app.close(); });

test('el día: la que vence hoy y la de ayer sin abrir, no la de mañana; con plantilla, estado y totales', async () => {
  const hoy = await create('Apertura de hoy', TODAY);
  const ayer = await create('Apertura de ayer', YESTERDAY);
  const manana = await create('Apertura de mañana', TOMORROW);
  const out = await day('', app.tokens.reader);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.date, TODAY);
  const ids = out.data.reviews.map((r: any) => r.reviewId);
  assert.ok(ids.includes(hoy) && ids.includes(ayer));
  assert.equal(ids.includes(manana), false);
  const r = out.data.reviews.find((x: any) => x.reviewId === hoy);
  assert.deepEqual([r.title, r.template.name, r.status, r.ready, r.overdue], ['Apertura de hoy', 'Revisión de apertura', 'open', false, false]);
  assert.deepEqual(r.totals, { items: 15, critical: 6, criticalDone: 0, done: 0, failed: 0, pending: 15 });
  assert.equal(out.data.reviews.find((x: any) => x.reviewId === ayer).overdue, true);
  // Otro día, por fecha.
  assert.deepEqual((await day(`?date=${TOMORROW}`)).data.reviews.map((x: any) => x.reviewId).filter((id: string) => id === manana), [manana]);
  assert.equal((await day('?date=mañana')).status, 422);
});

test('el recorrido de Flow: leer el día, leer los ítems y marcar uno con incidencia; el día lo cuenta', async () => {
  const id = (await day()).data.reviews.find((r: any) => r.title === 'Apertura de hoy').reviewId;
  const proj = (await app.call(`/api/v1/reviews/projection?reviewId=${id}`)).data;
  const item = proj.zones.flatMap((z: any) => z.items).find((i: any) => i.answer === 'check');
  const out = await app.call('/api/v1/reviews/result', { token: app.tokens.editor, body: { itemId: item.id, result: 'fail', text: 'La cerradura no cierra.' } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const r = (await day()).data.reviews.find((x: any) => x.reviewId === id);
  assert.equal(r.totals.failed, 1);
});

test('el ámbito: quien no ve el proyecto de la revisión no la recibe', async () => {
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: {} }), app.users.editor]);
  try {
    assert.deepEqual((await day('', app.tokens.editor)).data.reviews, []);
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
});
