/**
 * Tasks · acciones de la revisión semanal de Dirección desde Central (`central.weekly_action`, decisión de VG en vg-41;
 * docs/tasks/API.md §20 y §56): entran por `POST requests/task` con el token de la persona, como los vencimientos
 * (`central.compliance_due`): sin área van a «Por clasificar»; una regla las lleva a su proyecto; repetir con la misma
 * referencia devuelve la misma; y el estado vuelve por `tasks.targets`, como hoy. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), DIRECCION = uuid();
let app: TestApp;
let seq = 0;

const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `semanal-${++seq}`, operations } });
const ask = (body: Record<string, unknown>) => app.call('/api/v1/requests/task', { body: { source: 'central', kind: 'central.weekly_action', ...body } });
const targets = (ids: string[]) => app.call('/api/v1/read/tasks.targets', { body: { kind: 'task', ids } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Gestión', position: 1024 }))).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.projects', id: DIRECCION, fields: { tab_id: TAB, title: 'Dirección', position: 2048 } }])).status, 200);
});
test.after(async () => { await app.close(); });

test('sin regla ni área, a «Por clasificar»; repetir devuelve la misma', async () => {
  const first = await ask({ external_ref: 'RS_2026_43_1', title: 'Llamar a la gestoría por el IVA', note: 'Acción de la revisión semanal.', external_url: 'https://central.ikisai.com/#/semanal/RS_2026_43' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.task.request, 'pending');
  const again = await ask({ external_ref: 'RS_2026_43_1', title: 'Llamar a la gestoría por el IVA' });
  assert.equal(again.data.task.id, first.data.task.id);
  const state = (await targets([first.data.task.id])).data.items[0];
  assert.equal(state.request, 'pending');
});

test('con una regla, a su proyecto; el estado vuelve por tasks.targets', async () => {
  assert.equal((await commit([{ op: 'insert', table: 'tasks.request_routes', id: uuid(), fields: { kind: 'central.weekly_action', kind_label: 'Revisión semanal', tab_id: TAB, project_id: DIRECCION, position: 1024 } }])).status, 200);
  const out = await ask({ external_ref: 'RS_2026_43_2', title: 'Revisar el presupuesto de la cocina', due: '2026-11-03' });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual([out.data.routed, out.data.task.projectId, out.data.task.externalKind, out.data.task.request], ['rule', DIRECCION, 'central.weekly_action', 'created']);
  const state = (await targets([out.data.task.id])).data.items[0];
  assert.deepEqual([state.projectId, state.done], [DIRECCION, false]);
});
