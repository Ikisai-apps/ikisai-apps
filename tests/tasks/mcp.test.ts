/**
 * Tasks · herramientas de dominio por MCP (`tasks-api/mcp.ts`), de extremo a extremo: un agente real por clave
 * habla JSON-RPC con `/api/v1/mcp`; los lotes pasan por la validación, el hook SQL y el riesgo de Tasks; lo que necesita
 * aprobación vuelve como propuesta preparada y se aplica tal cual cuando una persona la aprueba.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid(), OBRA = uuid(), PRIVADO = uuid(), SECRETA = uuid();
const LABELS = Array.from({ length: 10 }, () => uuid());
let app: TestApp;
let agent = '', limited = '';
let seq = 0;

async function rpc(method: string, params: unknown, token: string) {
  const res = await app.call('/api/v1/mcp', { token, body: { jsonrpc: '2.0', id: ++seq, method, params } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const call = async (name: string, args: Record<string, unknown>, token = agent) => (await rpc('tools/call', { name, arguments: args }, token)).result;
const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `seed-${++seq}`, operations } });
  const tabOps = createTabOps({ id: TAB, name: 'Obra', position: 1024, inboxId: INBOX });
  const phase = tabOps.find((o) => o.fields?.system_key === 'phase')!.id!;
  await commit(tabOps);
  await commit(LABELS.map((id, n) => ({ op: 'insert', table: 'tasks.labels', id, fields: { tab_id: TAB, family_id: phase, name: `Etiqueta ${n}` } })));
  await commit([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Reforma', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PRIVADO, fields: { tab_id: TAB, title: 'Privado', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: SECRETA, fields: { tab_id: TAB, project_id: PRIVADO, title: 'Secreta', position: 1024 } },
  ]);
  agent = (await app.call('/api/v1/agents', { body: { name: 'Asistente', role: 'editor' } })).data.token;
  limited = (await app.call('/api/v1/agents', { body: { name: 'Solo Reforma', role: 'editor', scopes: { tabs: [], projects: { [TAB]: [OBRA] } } } })).data.token;
});
test.after(async () => { await app.close(); });

test('mcp de Tasks · tools/list anuncia las herramientas de tareas con requestId y aviso de aprobación; un lector no las ve', async () => {
  const tools = (await rpc('tools/list', {}, agent)).result.tools as any[];
  const mine = tools.filter((t) => ['tasks_create_task', 'tasks_update_task', 'tasks_complete', 'tasks_move', 'tasks_delete', 'tasks_set_labels', 'tasks_set_dependencies'].includes(t.name));
  assert.equal(mine.length, 7);
  for (const tool of mine) {
    assert.ok(tool.inputSchema.properties.requestId, tool.name);
    assert.match(tool.description, /needsApproval/);
  }
  assert.equal(mine.find((t) => t.name === 'tasks_delete').annotations.destructiveHint, true);
  const asReader = (await rpc('tools/list', {}, app.tokens.reader)).result.tools.map((t: any) => t.name);
  assert.ok(!asReader.includes('tasks_create_task'));
});

test('mcp de Tasks · crear, completar y reintentar sin duplicar; error de entrada como isError', async () => {
  const created = await call('tasks_create_task', { project_id: OBRA, title: 'Pintar', requestId: 'crear-pintar' });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const id = created.structuredContent.changes.find((c: any) => c.table === 'tasks.tasks').id;
  const again = await call('tasks_create_task', { project_id: OBRA, title: 'Pintar', requestId: 'crear-pintar' });
  assert.equal(again.isError, undefined, JSON.stringify(again));
  assert.equal(again.structuredContent.alreadyUsed, true);
  assert.equal((await rows('tasks.tasks')).filter((t) => t.title === 'Pintar').length, 1, 'el reintento con el mismo requestId no duplica');
  // Antes de aplicarse, el mismo requestId construye el mismo lote (los ids nuevos salen del requestId): una tarea con
  // diez etiquetas toca 11 filas, necesita aprobación, y repetir la llamada devuelve la misma propuesta.
  const many = { project_id: OBRA, title: 'Repasar', label_ids: LABELS, requestId: 'repasar' };
  const first = await call('tasks_create_task', many), second = await call('tasks_create_task', many);
  assert.equal(first.structuredContent.needsApproval, true, JSON.stringify(first));
  assert.equal(second.structuredContent.proposal.id, first.structuredContent.proposal.id);

  const done = await call('tasks_complete', { task_id: id });
  assert.equal(done.isError, undefined, JSON.stringify(done));
  assert.equal((await rows('tasks.tasks')).find((t) => t.id === id).done, true);
  assert.equal((await call('tasks_complete', { task_id: id })).structuredContent.unchanged, true);

  const bad = await call('tasks_update_task', { task_id: id, priority: 'urgente' });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error.code, 'INVALID_INPUT');
});

test('mcp de Tasks · un agente limitado no ve ni toca lo que está fuera de sus ámbitos', async () => {
  const hidden = await call('tasks_complete', { task_id: SECRETA }, limited);
  assert.equal(hidden.isError, true);
  assert.equal(hidden.structuredContent.error.code, 'NOT_FOUND');
  const own = await call('tasks_create_task', { project_id: OBRA, title: 'Del limitado' }, limited);
  assert.equal(own.isError, undefined, JSON.stringify(own));
});

test('mcp de Tasks · borrar vuelve como propuesta preparada; aprobada, el agente la aplica con tasks_commit', async () => {
  const target = (await rows('tasks.tasks')).find((t) => t.title === 'Pintar');
  const asked = await call('tasks_delete', { task_id: target.id, requestId: 'borrar-pintar' });
  assert.equal(asked.isError, undefined, JSON.stringify(asked));
  assert.equal(asked.structuredContent.needsApproval, true);
  const proposal = asked.structuredContent.proposal;
  assert.equal(proposal.status, 'pending');
  assert.equal((await rows('tasks.tasks')).find((t) => t.id === target.id).deleted_at, null, 'aún no se ha borrado');

  const approved = await app.call(`/api/v1/proposals/${proposal.id}/approve`, { body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const applied = await call('tasks_commit', { requestId: proposal.requestId, operations: proposal.operations, confirmationId: proposal.id });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  assert.ok((await rows('tasks.tasks')).find((t) => t.id === target.id).deleted_at);
});

test('mcp de Compras · qué queda poco, pedir sin aprobación y preparar el plan con ella', async () => {
  const CLORO = uuid();
  const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `compras-${++seq}`, operations } });
  await commit([{ op: 'insert', table: 'tasks.supply_items', id: CLORO, fields: { tab_id: TAB, name: 'Cloro', unit: 'kg', min_quantity: 5, reorder_quantity: 10, supplier_name: 'Piscinas Norte', position: 1024 } }]);
  await commit([{ op: 'insert', table: 'tasks.supply_movements', id: uuid(), fields: { tab_id: TAB, supply_item_id: CLORO, kind: 'in', delta: 2 } }]);

  const tools = (await rpc('tools/list', {}, agent)).result.tools as any[];
  assert.equal(tools.find((t) => t.name === 'tasks_low_stock').annotations.readOnlyHint, true);
  const low = await call('tasks_low_stock', {});
  assert.equal(low.isError, undefined, JSON.stringify(low));
  assert.deepEqual(low.structuredContent.items.map((i: any) => [i.name, i.stock, i.openRequest]), [['Cloro', 2, null]]);
  // El almacén es del área entera: un agente con proyectos sueltos no lo ve ni pide para el área en general.
  assert.deepEqual((await call('tasks_low_stock', {}, limited)).structuredContent.items, []);
  const general = await call('tasks_request_purchase', { tab_id: TAB, title: 'Lejía' }, limited);
  assert.equal(general.structuredContent.error.code, 'FORBIDDEN', JSON.stringify(general));

  // Pedir es seguro: entra sin propuesta, «pedida», con lo que trae el suministro (y lo que el agente cambia).
  const asked = await call('tasks_request_purchase', { supply_item_id: CLORO, quantity: 12 });
  assert.equal(asked.isError, undefined, JSON.stringify(asked));
  assert.equal(asked.structuredContent.needsApproval, undefined);
  const request = (await rows('tasks.purchase_requests')).find((r) => r.supply_item_id === CLORO);
  assert.equal(request.status, 'requested');
  assert.equal(Number(request.quantity), 12);
  assert.equal(request.supplier_name, 'Piscinas Norte');
  assert.equal((await call('tasks_low_stock', {})).structuredContent.items[0].openRequest.id, request.id);
  // Un agente no aprueba: eso es del responsable de compras (aquí, la propietaria, porque el área no tiene).
  const self = await call('tasks_commit', { requestId: 'auto-aprobar', operations: [{ op: 'update', table: 'tasks.purchase_requests', id: request.id, expectedRevision: request.revision, fields: { status: 'approved' } }] });
  assert.equal(self.isError, true);
  assert.equal(self.structuredContent.error.code, 'FORBIDDEN');
  const approved = await commit([{ op: 'update', table: 'tasks.purchase_requests', id: request.id, expectedRevision: request.revision, fields: { status: 'approved' } }]);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));

  // Preparar el plan siempre pide aprobación; aprobada, el agente la aplica y la solicitud queda en su parada.
  const plan = await call('tasks_prepare_purchase_plan', { tab_id: TAB, title: 'Compra del lunes', requestId: 'plan-lunes' });
  assert.equal(plan.isError, undefined, JSON.stringify(plan));
  assert.equal(plan.structuredContent.needsApproval, true);
  const proposal = plan.structuredContent.proposal;
  assert.equal((await rows('tasks.purchase_plans')).length, 0, 'aún no hay plan');
  assert.equal((await app.call(`/api/v1/proposals/${proposal.id}/approve`, { body: {} })).status, 200);
  const applied = await call('tasks_commit', { requestId: proposal.requestId, operations: proposal.operations, confirmationId: proposal.id });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const stop = (await rows('tasks.purchase_plan_stops'))[0];
  assert.equal(stop.supplier_name, 'Piscinas Norte');
  assert.equal((await rows('tasks.purchase_requests')).find((r) => r.id === request.id).plan_stop_id, stop.id);
  // Sin nada aprobado pendiente, no hay plan que preparar.
  const empty = await call('tasks_prepare_purchase_plan', { tab_id: TAB });
  assert.equal(empty.structuredContent.error.code, 'INVALID_PURCHASE');
});
