/**
 * Tasks · P7 de Central: `tasks.blocked` y `tasks.reviews_open` en tasks.central_kpi_projection (migración 0354,
 * docs/tasks/API.md §49; contrato en docs/central/API.md §7.2). Solo agregados. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), P = uuid(), A = uuid(), B = uuid(), S = uuid(), S1 = uuid(), S2 = uuid();
let app: TestApp;
let seq = 0;

const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `kpi-${++seq}`, operations } });
const kpis = async () => Object.fromEntries((await app.t.db.query<{ kpi: string; value: string }>(`select kpi, value from tasks.central_kpi_projection`)).rows.map((r) => [r.kpi, Number(r.value)]));
const task = (id: string, title: string, fields: Record<string, unknown> = {}): Operation => ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: P, title, position: ++seq, ...fields } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Obra', position: 2048 } }])).status, 200);
});
test.after(async () => { await app.close(); });

test('bloqueadas: por una dependencia sin hacer o por el paso anterior; al hacerlas, dejan de contar', async () => {
  const before = await kpis();
  const out = await commit([
    task(A, 'Primero'), task(B, 'Espera a Primero'),
    task(S, 'Con pasos', { steps_in_order: true }), task(S1, 'Paso 1', { parent_id: S }), task(S2, 'Paso 2', { parent_id: S }),
    { op: 'insert', table: 'tasks.task_dependencies', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: B, depends_on_id: A, position: 1 } },
  ]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal((await kpis())['tasks.blocked']! - before['tasks.blocked']!, 2, 'B y el paso 2');
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: A, expectedRevision: 1, fields: { done: true } }])).status, 200);
  assert.equal((await kpis())['tasks.blocked']! - before['tasks.blocked']!, 1, 'solo el paso 2');
});

test('revisiones de apertura sin cerrar: cuentan hasta que se abren', async () => {
  const before = (await kpis())['tasks.reviews_open']!;
  const house = (await app.call('/api/v1/snapshot?tables=tasks.review_templates')).data.tables[0].rows.find((t: any) => t.name === 'Revisión de apertura').id;
  const made = await app.call('/api/v1/reviews', { body: { templateId: house, tabId: TAB } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await kpis())['tasks.reviews_open']! - before, 1);
  const opened = await app.call('/api/v1/reviews/open', { body: { reviewId: made.data.reviewId, override: true, note: 'Prueba' } });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.equal((await kpis())['tasks.reviews_open']! - before, 0);
  const row = (await app.t.db.query<Record<string, unknown>>(`select * from tasks.central_kpi_projection where kpi = 'tasks.reviews_open'`)).rows[0]!;
  assert.deepEqual([row.label, row.unit, row.period, row.direction], ['Revisiones de apertura sin cerrar', 'count', 'actual', 'down']);
});
