/**
 * Tasks · compras no alimentarias (docs/tasks/API.md §18, migración 0305) sobre PGlite, a través de `core.commit`:
 * solicitudes con aprobación del responsable de compras, suministros con stock por movimientos, planes por proveedor
 * y lo que vaciar la papelera hace con ellos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOperations, visibleRow } from '../../packages/domain-tasks/src/index.ts';
import { createTasksDb, insert, newId, rejects, remove, update, type TasksDb } from './db.ts';

let db: TasksDb;
test.before(async () => { db = await createTasksDb(); });
test.after(async () => { await db.close(); });

const request = (tab: string, id: string, extra: Record<string, unknown> = {}) => insert('tasks.purchase_requests', id, { tab_id: tab, title: 'Cloro', position: 1024, ...extra });
const item = (tab: string, id: string, extra: Record<string, unknown> = {}) => insert('tasks.supply_items', id, { tab_id: tab, name: 'Cloro', unit: 'l', min_quantity: 10, ...extra });
const movement = (tab: string, id: string, supply: string, kind: string, delta: number, extra: Record<string, unknown> = {}) =>
  insert('tasks.supply_movements', id, { tab_id: tab, supply_item_id: supply, kind, delta, ...extra });
const row = async (table: string, id: string) => ((await db.data()) as any)[table].find((r: any) => r.id === id);

test('compras · aprobar es del responsable de compras del área; sin él, de la propietaria; y se fechan los pasos', async () => {
  const { tab } = await db.area('Compras');
  const editor = await db.member('editor', { tabs: [tab], projects: {} });
  const other = await db.member('editor', { tabs: [tab], projects: {} });
  const req = newId();
  await db.commit([request(tab, req)], editor);
  // Sin responsable: aprueba la propietaria, no un editor.
  await rejects(db.commit([update('tasks.purchase_requests', req, 1, { status: 'approved' })], editor), 'FORBIDDEN');
  await db.commit([update('tasks.purchase_requests', req, 1, { status: 'approved' })]);
  let r = await row('tasks.purchase_requests', req);
  assert.ok(r.approved_at && !r.purchased_at);
  // Con responsable: solo él aprueba o rechaza; los demás compran y reciben.
  await db.commit([update('tasks.tabs', tab, 1, { purchase_approver_id: editor })]);
  const second = newId();
  await db.commit([request(tab, second)], other);
  await rejects(db.commit([update('tasks.purchase_requests', second, 1, { status: 'rejected' })]), 'FORBIDDEN');
  await rejects(db.commit([update('tasks.purchase_requests', second, 1, { status: 'approved' })], other), 'FORBIDDEN');
  await db.commit([update('tasks.purchase_requests', second, 1, { status: 'approved' })], editor);
  await db.commit([update('tasks.purchase_requests', req, 2, { status: 'purchased' })], other);
  await db.commit([update('tasks.purchase_requests', req, 3, { status: 'received' })], other);
  r = await row('tasks.purchase_requests', req);
  assert.ok(r.approved_at && r.purchased_at && r.received_at);
  // Crear ya aprobada también es aprobar.
  await rejects(db.commit([request(tab, newId(), { status: 'approved' })], other), 'FORBIDDEN');
  // El responsable tiene que ser una cuenta con el área entera.
  const outsider = await db.member('editor', { tabs: [], projects: {} });
  await rejects(db.commit([update('tasks.tabs', tab, 2, { purchase_approver_id: outsider })]), 'INVALID_APPROVER');
});

test('compras · stock por movimientos: signos, inmutables, una entrada por solicitud y nombre único', async () => {
  const { tab } = await db.area('Almacén');
  const cloro = newId(), req = newId(), entrada = newId();
  await db.commit([item(tab, cloro), request(tab, req, { supply_item_id: cloro, quantity: 20, unit: 'l', status: 'approved' })]);
  await assert.rejects(db.commit([movement(tab, newId(), cloro, 'in', -5)]), /supply_movement_sign/);
  await assert.rejects(db.commit([movement(tab, newId(), cloro, 'out', 5)]), /supply_movement_sign/);
  await db.commit([movement(tab, entrada, cloro, 'in', 20, { purchase_request_id: req }), movement(tab, newId(), cloro, 'out', -3)]);
  await rejects(db.commit([movement(tab, newId(), cloro, 'in', 20, { purchase_request_id: req })]), 'INVALID_PURCHASE');
  await rejects(db.commit([update('tasks.supply_movements', entrada, 1, { delta: 25 })]), 'IMMUTABLE_FIELD');
  await db.commit([update('tasks.supply_movements', entrada, 1, { note: 'Bidones de 5 l' })]);
  const data = await db.data();
  const stock = data['tasks.supply_movements'].filter((m) => m.supply_item_id === cloro && !m.deleted_at).reduce((sum, m) => sum + Number(m.delta), 0);
  assert.equal(stock, 17);
  await rejects(db.commit([item(tab, newId(), { name: ' cloro ' })]), 'SUPPLY_NAME_TAKEN');
  // Un movimiento no queda vivo con su suministro en la papelera: la cascada la hace el cliente.
  await rejects(db.commit([remove('tasks.supply_items', cloro, 1)]), 'INVALID_PURCHASE');
});

test('compras · plan por proveedor: solo aprobadas, paradas de un plan vivo, y un plan con compras se termina', async () => {
  const { tab, inbox } = await db.area('Plan');
  const plan = newId(), stop = newId(), pending = newId(), approved = newId();
  await db.commit([
    insert('tasks.purchase_plans', plan, { tab_id: tab, title: 'Compra del lunes' }),
    insert('tasks.purchase_plan_stops', stop, { tab_id: tab, plan_id: plan, supplier_name: 'Ferretería', position: 1024 }),
    request(tab, pending, { project_id: inbox }),
    request(tab, approved, { project_id: inbox, status: 'approved' }),
  ]);
  await rejects(db.commit([update('tasks.purchase_requests', pending, 1, { plan_stop_id: stop })]), 'INVALID_PURCHASE');
  await db.commit([update('tasks.purchase_requests', approved, 1, { plan_stop_id: stop })]);
  await db.commit([update('tasks.purchase_requests', approved, 2, { status: 'purchased' })]);
  // Borrar el plan con algo comprado: no. Terminarlo, sí.
  await rejects(db.commit([remove('tasks.purchase_plans', plan, 1), remove('tasks.purchase_plan_stops', stop, 1), update('tasks.purchase_requests', approved, 3, { plan_stop_id: null })]), 'INVALID_PURCHASE');
  await db.commit([update('tasks.purchase_plans', plan, 1, { status: 'done' })]);
  // Una parada no queda viva con su plan en la papelera.
  const empty = newId(), emptyStop = newId();
  await db.commit([insert('tasks.purchase_plans', empty, { tab_id: tab, title: 'Vacío' }), insert('tasks.purchase_plan_stops', emptyStop, { tab_id: tab, plan_id: empty, supplier_name: 'Mercado' })]);
  await rejects(db.commit([remove('tasks.purchase_plans', empty, 1)]), 'INVALID_PURCHASE');
  await db.commit([remove('tasks.purchase_plans', empty, 1), remove('tasks.purchase_plan_stops', emptyStop, 1)]);
});

test('compras · ámbitos y visibilidad: el almacén y los planes son del área entera; las solicitudes, de su proyecto', async () => {
  const { tab, inbox } = await db.area('Ámbitos');
  const guest = await db.member('editor', { tabs: [], projects: { [tab]: [inbox] } });
  const req = newId();
  await db.commit([request(tab, req, { project_id: inbox })], guest);
  await rejects(db.commit([request(tab, newId())], guest), 'FORBIDDEN');
  await rejects(db.commit([item(tab, newId(), { name: 'Lejía' })], guest), 'FORBIDDEN');
  const scopes = { tabs: [], projects: { [tab]: [inbox] } };
  assert.equal(visibleRow('tasks.purchase_requests', { tab_id: tab, project_id: inbox }, scopes), true);
  assert.equal(visibleRow('tasks.purchase_requests', { tab_id: tab, project_id: null }, scopes), false);
  assert.equal(visibleRow('tasks.supply_items', { tab_id: tab }, scopes), false);
  assert.equal(visibleRow('tasks.supply_items', { tab_id: tab }, '*'), true);
  // La validación compartida dice lo mismo antes de enviar.
  assert.throws(() => validateOperations([item(tab, newId(), { name: 'Lejía' })], { role: 'editor', scopes }), /área entera/);
  assert.throws(() => validateOperations([movement(tab, newId(), newId(), 'in', -1)], { role: 'owner', scopes: '*' }), /suma/);
});

test('compras · vaciar papelera: lo que cuelga de un área o un proyecto borrados se lleva a la papelera y se purga', async () => {
  const { tab, inbox } = await db.area('Se borra');
  await db.area('Se queda');
  const project = newId(), supply = newId(), plan = newId(), stop = newId(), req = newId(), mov = newId();
  await db.commit([
    insert('tasks.projects', project, { tab_id: tab, title: 'Piscina', position: 2048 }),
    item(tab, supply), insert('tasks.purchase_plans', plan, { tab_id: tab, title: 'Plan' }),
    insert('tasks.purchase_plan_stops', stop, { tab_id: tab, plan_id: plan, supplier_name: 'Proveedor' }),
    request(tab, req, { project_id: project, supply_item_id: supply }), movement(tab, mov, supply, 'in', 5),
  ]);
  void inbox;
  await db.commit([remove('tasks.tabs', tab, 1)]);
  const prepared = await db.commit([{ op: 'call', procedure: 'tasks.empty_trash_prepare', args: {} }]);
  assert.ok((prepared.results[0] as any).result.trashed > 0);
  const data = await db.data();
  for (const [table, id] of [['tasks.supply_movements', mov], ['tasks.purchase_requests', req], ['tasks.purchase_plan_stops', stop], ['tasks.purchase_plans', plan], ['tasks.supply_items', supply]] as const) {
    assert.ok((data as any)[table].find((r: any) => r.id === id).deleted_at, table);
  }
});
