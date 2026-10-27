/**
 * Tasks · limpieza de cama al salir un huésped (`worker/requests/task` con `booking.bed_cleaning`, #907 de Booking,
 * docs/tasks/API.md §48): entra por la identidad de servicio de Booking, sin `project_ref`, a donde diga la regla del usuario
 * para ese tipo (o «Por clasificar»), con su título y su fecha. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { requestTaskId } from '../../supabase/functions/tasks-api/requests.ts';
import { simulateServiceIdentity } from './fixtures.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const WORKER_KEY = 'clave-de-worker-de-prueba';
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), LIMPIEZA = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `limp-${++seq}`, operations } });
const worker = async (body: unknown) => {
  const res = await app.handler(new Request('http://localhost/api/v1/worker/requests/task', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as any };
};
const cleaning = (ref: string, extra: Record<string, unknown> = {}) => ({
  source: 'booking', kind: 'booking.bed_cleaning', external_ref: ref, title: 'Limpiar Habitación 3 · Cama 2', due: '2026-11-15', ...extra });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin], workerKey: WORKER_KEY }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.projects', id: LIMPIEZA, fields: { tab_id: TAB, title: 'Limpieza', position: 2048 } }])).status, 200);
  await simulateServiceIdentity(app.t.db, uuid(), 'booking');
});
test.after(async () => { await app.close(); });

test('sin regla, a «Por clasificar»; con la regla del tipo, al proyecto «Limpieza» con su título y su fecha; repetir no duplica', async () => {
  const waiting = await worker(cleaning('LIMP-asig-0001'));
  assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
  assert.deepEqual(waiting.body, { taskId: await requestTaskId('booking:LIMP-asig-0001'), status: 'pending' });
  const request = (await rows('tasks.requests')).find((r) => r.external_ref === 'booking:LIMP-asig-0001');
  assert.deepEqual([request.kind, request.kind_label], ['booking.bed_cleaning', 'Limpieza · Salida de huésped']);

  assert.equal((await commit([{ op: 'insert', table: 'tasks.request_routes', id: uuid(), fields: { kind: 'booking.bed_cleaning', tab_id: TAB, project_id: LIMPIEZA, position: 1024 } }])).status, 200);
  const routed = await worker(cleaning('LIMP-asig-0002'));
  assert.equal(routed.body.status, 'open', JSON.stringify(routed.body));
  const task = (await rows('tasks.tasks')).find((t) => t.id === routed.body.taskId);
  assert.deepEqual([task.project_id, task.title, task.due, task.external_kind], [LIMPIEZA, 'Limpiar Habitación 3 · Cama 2', '2026-11-15', 'booking.bed_cleaning']);
  assert.deepEqual((await worker(cleaning('LIMP-asig-0002'))).body, routed.body, 'repetir devuelve la misma');
  assert.equal((await rows('tasks.tasks')).filter((t) => t.external_ref === 'booking:LIMP-asig-0002').length, 1);
});

test('lo que no vale: otra referencia, project_ref, o pedirla por la ruta de personas', async () => {
  assert.equal((await worker(cleaning('asig-0003'))).status, 422, 'la referencia es LIMP-<asignación>');
  assert.equal((await worker(cleaning('LIMP-asig-0003', { project_ref: 'RES2026-80' }))).status, 422, 'sin project_ref');
  const person = await app.call('/api/v1/requests/task', { body: cleaning('LIMP-asig-0004', { tab_id: TAB }) });
  assert.equal(person.status, 422, 'Booking pide por worker/');
});
