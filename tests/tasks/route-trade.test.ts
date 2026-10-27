/**
 * Tasks · reglas de entrada con oficio (migración 0353, docs/tasks/API.md §48): la limpieza de una cama que pide Booking
 * entra por la regla de su tipo y lleva el oficio de la regla, sin repetirlo si el proyecto ya lo tiene; también al mover
 * las que esperaban. El oficio, vivo en Central; la regla, solo de la propietaria. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { simulateServiceIdentity } from './fixtures.ts';
import { createTabOps, emptyDataset, routeWaitingOps, saveRouteOps, TABLES, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const WORKER_KEY = 'clave-de-worker-de-prueba';
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), LIMPIEZA = uuid(), TRADE = uuid(), OLD_TRADE = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `ruta-${++seq}`, operations } });
const data = async () => { const d: any = emptyDataset(); for (const t of TABLES) d[t] = await rows(t); return d; };
const worker = async (ref: string) => {
  const res = await app.handler(new Request('http://localhost/api/v1/worker/requests/task', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY },
    body: JSON.stringify({ source: 'booking', kind: 'booking.bed_cleaning', external_ref: ref, title: 'Limpiar Habitación 5 · Cama 1', due: '2026-11-16' }) }));
  return await res.json() as { taskId: string; status: string };
};
const tradesOf = async (taskId: string) => (await rows('tasks.task_trades')).filter((t) => t.task_id === taskId && !t.deleted_at).map((t) => t.trade_id);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin], workerKey: WORKER_KEY }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.projects', id: LIMPIEZA, fields: { tab_id: TAB, title: 'Limpieza', position: 2048 } }])).status, 200);
  await app.t.db.query(`insert into central.trades (id, name, active) values ($1, 'Limpieza', true), ($2, 'Oficio retirado', false)`, [TRADE, OLD_TRADE]);
  await simulateServiceIdentity(app.t.db, uuid(), 'booking');
});
test.after(async () => { await app.close(); });

test('la regla con oficio: lo que entra por ella lo lleva; lo que esperaba, también al moverlo; sin repetir el del proyecto', async () => {
  const waiting = await worker('LIMP-asig-0101');
  assert.equal(waiting.status, 'pending');
  const saved = await commit(saveRouteOps(await data(), { kind: 'booking.bed_cleaning', tab_id: TAB, project_id: LIMPIEZA, trade_id: TRADE }));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await rows('tasks.request_routes')).find((r) => r.kind === 'booking.bed_cleaning').trade_id, TRADE);

  const routed = await worker('LIMP-asig-0102');
  assert.equal(routed.status, 'open');
  assert.deepEqual(await tradesOf(routed.taskId), [TRADE], 'cae en quien limpia');

  // «Mover también las que esperaban»: con el oficio de la regla.
  const moved = await commit(routeWaitingOps(await data(), 'booking.bed_cleaning'));
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.deepEqual(await tradesOf(waiting.taskId), [TRADE]);

  // Si el proyecto ya tiene ese oficio, una sola vez.
  assert.equal((await commit([{ op: 'insert', table: 'tasks.project_trades', id: uuid(), fields: { tab_id: TAB, project_id: LIMPIEZA, trade_id: TRADE } }])).status, 200);
  const again = await worker('LIMP-asig-0103');
  assert.deepEqual(await tradesOf(again.taskId), [TRADE]);
});

test('el oficio de una regla, vivo en Central; y la regla, solo de la propietaria', async () => {
  const route = (await rows('tasks.request_routes')).find((r) => r.kind === 'booking.bed_cleaning');
  const dead = await commit([{ op: 'update', table: 'tasks.request_routes', id: route.id, expectedRevision: route.revision, fields: { trade_id: OLD_TRADE } }]);
  assert.deepEqual([dead.status, dead.data.error.code], [422, 'INVALID_TRADE']);
  assert.equal((await commit([{ op: 'update', table: 'tasks.request_routes', id: route.id, expectedRevision: route.revision, fields: { trade_id: null } }], app.tokens.editor)).status, 403);
  assert.equal((await commit([{ op: 'update', table: 'tasks.request_routes', id: route.id, expectedRevision: route.revision, fields: { trade_id: 'limpieza' } }])).status, 422);
});
