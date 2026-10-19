/**
 * Tasks · R6 PR 3: materiales y equipos de una tarea (migración 0334, docs/tasks/API.md §36) contra el núcleo, Recursos y
 * los hooks reales. Reglas del hook, el material sigue a su tarea (mover, convertir el área, vaciar la papelera), el kit
 * del oficio y «Confirmar consumo»: el gasto entra en Recursos una sola vez y lo gastado ya no cambia.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addKitOps, addMaterialOps, confirmConsumptionOps, consumeCall, kitSuggestions, moveTaskOps, pendingConsumption, removeMaterialOps, setMaterialQuantityOps,
  validateOperations, visibleRow,
} from '../../packages/domain-tasks/src/index.ts';
import { createTasksDb, insert, newId, rejects, update, type TasksDb } from './db.ts';

let db: TasksDb;
let seq = 0;
test.after(async () => { await db.close(); });

const resources = (operations: unknown[], requestId = `m-${++seq}`) =>
  db.t.rpc('core_commit', { p_app: 'resources', p_actor: db.owner, p_request_id: requestId, p_digest: requestId, p_expected_cursor: null, p_operations: operations }) as Promise<any>;
const stock = async (item: string) => Number((await db.t.db.query<{ q: string }>(`select coalesce(sum(quantity), 0) q from resources.movements where item_id = $1 and deleted_at is null`, [item])).rows[0]!.q);
const row = async (id: string) => ((await db.data())['tasks.task_materials'] as any[]).find((m) => m.id === id);
const consumable = (id: string) => id !== TALADRO;

const ALMACEN = newId(), LEJIA = newId(), PINTURA = newId(), TALADRO = newId();
let TAB: string, INBOX: string, TASK: string, OTHER: string;

test.before(async () => {
  db = await createTasksDb();
  const altura = (await db.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  await resources([{ op: 'insert', table: 'resources.spaces', id: ALMACEN, fields: { parent_id: altura, kind: 'edificio', name: 'Almacén', position: 1024 } }]);
  await resources([
    { op: 'insert', table: 'resources.items', id: LEJIA, fields: { name: 'Lejía', kind: 'limpieza', base_unit: 'l', default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: PINTURA, fields: { name: 'Pintura blanca', kind: 'material', base_unit: 'l', default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: TALADRO, fields: { name: 'Taladro', kind: 'herramienta', base_unit: 'ud' } },
  ]);
  await resources([{ op: 'insert', table: 'resources.movements', id: newId(), fields: { item_id: LEJIA, space_id: ALMACEN, quantity: 10, kind: 'entrada_manual' } }]);
  ({ tab: TAB, inbox: INBOX } = await db.area('Mantenimiento'));
  TASK = newId(); OTHER = newId();
  await db.commit([insert('tasks.projects', OTHER, { tab_id: TAB, title: 'Pintura', position: 2048 }), insert('tasks.tasks', TASK, { tab_id: TAB, project_id: INBOX, title: 'Limpiar baños', position: 1024 })]);
});

test('R6 · materiales: artículo vivo, tarea viva, uno por tarea; el equipo no se consume; lo gastado no cambia', async () => {
  let data = await db.data();
  const [lejia] = addMaterialOps(data, { taskId: TASK, itemId: LEJIA, quantity: 2 });
  await rejects(db.commit([{ ...lejia!, fields: { ...lejia!.fields, item_id: newId() } }]), 'INVALID_ITEM');
  await db.commit([lejia!]);
  data = await db.data();
  // Añadir el mismo artículo suma; un segundo alta directa del mismo, no.
  assert.deepEqual(addMaterialOps(data, { taskId: TASK, itemId: LEJIA, quantity: 1 }).map((o) => [o.op, o.fields?.quantity]), [['update', 3]]);
  await rejects(db.commit([insert('tasks.task_materials', newId(), { tab_id: TAB, project_id: INBOX, task_id: TASK, item_id: LEJIA })]), 'DUPLICATE_MATERIAL');
  const [taladro] = addMaterialOps(data, { taskId: TASK, itemId: TALADRO });
  await db.commit([taladro!]);
  data = await db.data();
  assert.deepEqual(pendingConsumption(data, TASK, consumable).map((m) => m.item_id), [LEJIA], 'el equipo solo «hace falta»');
  await rejects(db.commit([update('tasks.task_materials', taladro!.id!, 1, { consumed: 1 })]), 'INVALID_MATERIAL');
  // En una tarea en la papelera no se añade nada.
  const gone = newId();
  await db.commit([insert('tasks.tasks', gone, { tab_id: TAB, project_id: INBOX, title: 'Borrada', position: 9 })]);
  await db.commit([{ op: 'delete', table: 'tasks.tasks', id: gone, expectedRevision: 1 }]);
  await rejects(db.commit([insert('tasks.task_materials', newId(), { tab_id: TAB, project_id: INBOX, task_id: gone, item_id: PINTURA })]), 'TASK_UNAVAILABLE');
  // Visible como su tarea; la validación compartida lo admite con la forma de la tabla.
  assert.equal(visibleRow('tasks.task_materials', { tab_id: TAB, project_id: INBOX }, { tabs: [], projects: { [TAB]: [OTHER] } }), false);
  validateOperations(addMaterialOps(data, { taskId: TASK, itemId: PINTURA, quantity: 1 }), { role: 'editor', scopes: '*' });
  assert.throws(() => validateOperations([{ op: 'insert', table: 'tasks.task_materials', id: newId(), fields: { tab_id: TAB, project_id: INBOX, task_id: TASK, item_id: PINTURA, quantity: 0 } }], { role: 'editor', scopes: '*' }), /cantidad/);
});

test('R6 · confirmar consumo: Recursos gasta una sola vez y la tarea lo apunta; «No se usó» es 0', async () => {
  let data = await db.data();
  const [lejia] = pendingConsumption(data, TASK, consumable);
  const call = consumeCall(lejia!, 2.5, ALMACEN);
  assert.deepEqual(call.args, { item_id: LEJIA, quantity: 2.5, kind: 'consumo_tarea', source_app: 'tasks', source_ref: `task_material:${lejia!.id}`, once: true, default_space_id: ALMACEN });
  await resources([call], `tasks-consume-${lejia!.id}`);
  // Un reintento (otro requestId, la misma llamada) no gasta dos veces.
  const again = await resources([call]);
  assert.equal(again.results[0].result.skipped, 'already_consumed');
  assert.equal(await stock(LEJIA), 7.5);
  await db.commit(confirmConsumptionOps(data, [{ materialId: lejia!.id, consumed: 2.5 }]));
  const done = await row(lejia!.id);
  assert.equal(Number(done.consumed), 2.5);
  assert.ok(done.consumed_at);
  data = await db.data();
  assert.deepEqual(confirmConsumptionOps(data, [{ materialId: lejia!.id, consumed: 3 }]), [], 'lo ya apuntado no se vuelve a apuntar');
  await rejects(db.commit([update('tasks.task_materials', lejia!.id, done.revision, { consumed: 3 })]), 'MATERIAL_CONSUMED');
  assert.throws(() => setMaterialQuantityOps(data, lejia!.id, 4), /ya se gastó/);
  assert.throws(() => removeMaterialOps(data, lejia!.id), /ya se gastó/);
  // «No se usó»: 0, sin movimiento en Recursos.
  const [pintura] = addMaterialOps(data, { taskId: TASK, itemId: PINTURA, quantity: 1 });
  await db.commit([pintura!]);
  data = await db.data();
  await db.commit(confirmConsumptionOps(data, [{ materialId: pintura!.id!, consumed: 0 }]));
  assert.equal(Number((await row(pintura!.id!)).consumed), 0);
  assert.equal(await stock(PINTURA), 0);
});

test('R6 · el material sigue a su tarea: mover de proyecto, convertir el área y vaciar la papelera', async () => {
  let data = await db.data();
  await db.commit(moveTaskOps(data, TASK, { project_id: OTHER }));
  data = await db.data();
  assert.ok((data['tasks.task_materials'] as any[]).filter((m) => m.task_id === TASK && !m.deleted_at).every((m) => m.project_id === OTHER));
  // Convertir el área en proyecto de otra: los materiales pasan con su tarea.
  const { tab: dest } = await db.area('Casa');
  const project = newId();
  await db.commit([{ op: 'call', procedure: 'tasks.convert_tab_into_project', args: { sourceTabId: TAB, targetTabId: dest, projectId: project, title: 'Mantenimiento' } }]);
  data = await db.data();
  const moved = (data['tasks.task_materials'] as any[]).filter((m) => m.task_id === TASK && !m.deleted_at);
  assert.ok(moved.length >= 3 && moved.every((m) => m.tab_id === dest && m.project_id === project), JSON.stringify(moved.map((m) => [m.tab_id, m.project_id])));
  // La tarea a la papelera y vaciar: sus materiales se van con ella.
  const task = (data['tasks.tasks'] as any[]).find((t) => t.id === TASK);
  await db.commit([{ op: 'delete', table: 'tasks.tasks', id: TASK, expectedRevision: task.revision }]);
  await db.commit([{ op: 'call', procedure: 'tasks.empty_trash_prepare', args: {} }]);
  data = await db.data();
  assert.ok((data['tasks.task_materials'] as any[]).filter((m) => m.task_id === TASK).every((m) => m.deleted_at));
});

test('R6 · kit del oficio: lo que aún no está, sin repetir artículo y con la mayor cantidad', () => {
  const T = newId(), A = newId(), B = newId();
  const data: any = {
    'tasks.tasks': [{ id: T, tab_id: TAB, project_id: INBOX, deleted_at: null }],
    'tasks.task_trades': [{ task_id: T, trade_id: A, deleted_at: null }, { task_id: T, trade_id: B, deleted_at: null }],
    'tasks.task_materials': [{ id: newId(), task_id: T, item_id: LEJIA, deleted_at: null, position: 1, created_at: '' }],
  };
  const kit = [
    { trade_id: A, item_id: LEJIA, quantity: 1, note: null }, { trade_id: A, item_id: PINTURA, quantity: 2, note: null },
    { trade_id: B, item_id: PINTURA, quantity: 5, note: null }, { trade_id: B, item_id: TALADRO, quantity: null, note: null },
    { trade_id: newId(), item_id: newId(), quantity: 1, note: null },
  ];
  const out = kitSuggestions(data, T, kit, (id) => id !== TALADRO);
  assert.deepEqual(out.map((s) => [s.itemId, s.quantity, s.tradeIds.length]), [[PINTURA, 5, 2]]);
  assert.deepEqual(addKitOps(data, T, out).map((o) => [o.table, o.fields?.item_id, o.fields?.quantity]), [['tasks.task_materials', PINTURA, 5]]);
});
