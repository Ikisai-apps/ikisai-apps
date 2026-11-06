/**
 * Tasks · «Cambiar clasificación» en la petición misma (V-03 b, VG 06-11), contra el núcleo y los hooks reales: una petición
 * ya clasificada cambia de proyecto dentro de su área con su paso, su responsable y su oficio; a otra área no; y «aplicar
 * también a las próximas» crea la regla de su tipo en el mismo lote. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { classifyRequestOps, createTabOps, emptyDataset, reclassifyRequestOps, saveRouteOps, TABLES, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid(), OBRA = uuid(), JARDIN = uuid(), OTRA = uuid(), OTRA_INBOX = uuid(), FONTANERIA = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `reclass-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const r = await commit(operations); assert.equal(r.status, 200, JSON.stringify(r.data)); };
const ask = (body: Record<string, unknown>) => app.call('/api/v1/requests/task', { body });
const data = async () => { const d: any = emptyDataset(); for (const t of TABLES) d[t] = await rows(t); return d; };
const taskOf = async (id: string) => (await rows('tasks.tasks')).find((t) => t.id === id);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await app.t.db.query(`insert into central.trades (id, name) values ($1, 'Fontanería Prueba')`, [FONTANERIA]);
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024, inboxId: INBOX }));
  await ok(createTabOps({ id: OTRA, name: 'Eventos', position: 2048, inboxId: OTRA_INBOX }));
  await ok([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Reparaciones', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: JARDIN, fields: { tab_id: TAB, title: 'Jardín', position: 3072 } },
  ]);
});
test.after(async () => { await app.close(); });

test('ya clasificada: cambia de proyecto en su área, con su paso, el responsable y el oficio; a otra área no', async () => {
  assert.equal((await ask({ source: 'central', external_ref: 'RC-1', title: 'Gotera en el baño' })).status, 200);
  const request = (await rows('tasks.requests')).find((r) => r.external_ref === 'central:RC-1');
  await ok(classifyRequestOps(await data(), request.id, { project_id: OBRA }));
  const paso = uuid();
  await ok([{ op: 'insert', table: 'tasks.tasks', id: paso, fields: { tab_id: TAB, project_id: OBRA, parent_id: request.id, title: 'Cerrar la llave', position: 1024 } }]);
  await assert.rejects(async () => reclassifyRequestOps(await data(), request.id, { project_id: OTRA_INBOX }), /otra área/);
  await ok(reclassifyRequestOps(await data(), request.id, { project_id: JARDIN, owner_house_level: 'staff', trade_id: FONTANERIA }));
  const task = await taskOf(request.id);
  assert.deepEqual([task.project_id, task.owner_house_level, (await taskOf(paso)).project_id], [JARDIN, 'staff', JARDIN]);
  assert.deepEqual((await rows('tasks.task_trades')).filter((r) => r.task_id === request.id).map((r) => [r.trade_id, r.project_id]), [[FONTANERIA, JARDIN]]);
  assert.equal((await rows('tasks.requests')).find((r) => r.id === request.id).status, 'routed', 'sigue clasificada');
  // Repetirlo igual no cambia nada.
  assert.deepEqual(reclassifyRequestOps(await data(), request.id, { project_id: JARDIN, owner_house_level: 'staff', trade_id: FONTANERIA }), []);
});

test('«aplicar también a las próximas»: la regla de su tipo entra en el mismo lote y la siguiente va sola', async () => {
  assert.equal((await ask({ source: 'central', external_ref: 'RC-2', title: 'Grifo que gotea' })).status, 200);
  const request = (await rows('tasks.requests')).find((r) => r.external_ref === 'central:RC-2');
  const d = await data();
  await ok([...classifyRequestOps(d, request.id, { project_id: OBRA, trade_id: FONTANERIA }),
    ...saveRouteOps(d, { kind: request.kind, tab_id: TAB, project_id: OBRA, trade_id: FONTANERIA })]);
  const route = (await rows('tasks.request_routes')).find((r) => r.kind === request.kind);
  assert.deepEqual([route.tab_id, route.project_id, route.trade_id], [TAB, OBRA, FONTANERIA]);
  assert.equal((await ask({ source: 'central', external_ref: 'RC-3', title: 'Cisterna' })).status, 200);
  const next = (await rows('tasks.requests')).find((r) => r.external_ref === 'central:RC-3');
  assert.equal(next.status, 'routed', 'la siguiente de su tipo va con la regla');
  assert.equal((await taskOf(next.id)).project_id, OBRA);
});
