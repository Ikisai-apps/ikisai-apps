/**
 * Tasks · compras no alimentarias (docs/tasks/API.md §18, migración 0305) sobre PGlite, a través de `core.commit`:
 * solicitudes con aprobación del responsable de compras, planes por proveedor y lo que vaciar la papelera hace con ellos.
 * El almacén es de Recursos desde R6 (0333): lo prueba supplies-resources.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deletePlanOps, dueRecurring, nextRecurringOps, preparePlanOps, receivePurchaseOps, requestPurchaseOps, setPurchaseStatusOps, undoPurchaseOps, validateOperations, visibleRow,
} from '../../packages/domain-tasks/src/index.ts';
import { createTasksDb, insert, newId, rejects, remove, update, type TasksDb } from './db.ts';

let db: TasksDb;
test.before(async () => { db = await createTasksDb(); });
test.after(async () => { await db.close(); });

const request = (tab: string, id: string, extra: Record<string, unknown> = {}) => insert('tasks.purchase_requests', id, { tab_id: tab, title: 'Cloro', position: 1024, ...extra });
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

test('compras · «No se compró» (0337): terminar por error y deshacer, reabrir el plan y, con factura, no', async () => {
  const { tab, inbox } = await db.area('Deshacer compra');
  const editor = await db.member('editor', { tabs: [tab], projects: {} });
  const plan = newId(), stop = newId(), buy = newId(), invoiced = newId();
  await db.commit([
    insert('tasks.purchase_plans', plan, { tab_id: tab, title: 'Compra del martes', status: 'shopping' }),
    insert('tasks.purchase_plan_stops', stop, { tab_id: tab, plan_id: plan, supplier_name: 'Ferretería', position: 1024 }),
    request(tab, buy, { project_id: inbox, status: 'approved', plan_stop_id: stop }),
    request(tab, invoiced, { project_id: inbox, title: 'Pintura', status: 'approved', plan_stop_id: stop }),
  ]);
  await db.commit([update('tasks.purchase_requests', buy, 1, { status: 'purchased' }), update('tasks.purchase_requests', invoiced, 1, { status: 'purchased' })], editor);
  // VG pulsa «Terminar» por error.
  await db.commit([update('tasks.purchase_plans', plan, 1, { status: 'done' })], editor);
  // Deshacer la compra: vuelve a aprobada, sin fecha de compra y fuera del plan terminado (lo hace un editor, como marcarla).
  let data = await db.data();
  const ops = undoPurchaseOps(data, buy);
  assert.deepEqual(ops[0]!.fields, { status: 'approved', plan_stop_id: null });
  await run(ops, editor);
  let r = await row('tasks.purchase_requests', buy);
  assert.deepEqual([r.status, r.purchased_at, r.plan_stop_id], ['approved', null, null]);
  assert.ok(r.approved_at, 'sigue aprobada desde cuando lo estaba');
  // Elegible para otro plan.
  const other = newId(), otherStop = newId();
  await db.commit([
    insert('tasks.purchase_plans', other, { tab_id: tab, title: 'Compra del jueves' }),
    insert('tasks.purchase_plan_stops', otherStop, { tab_id: tab, plan_id: other, supplier_name: 'Ferretería', position: 1024 }),
    update('tasks.purchase_requests', buy, r.revision, { plan_stop_id: otherStop }),
  ], editor);
  // Reabrir el plan terminado: vuelve a «De compras».
  await db.commit([update('tasks.purchase_plans', plan, 2, { status: 'shopping' })], editor);
  assert.equal((await row('tasks.purchase_plans', plan)).status, 'shopping');
  // En un plan abierto, deshacer deja la solicitud en su parada (es desmarcar la casilla).
  data = await db.data();
  assert.deepEqual(undoPurchaseOps(data, invoiced)[0]!.fields, { status: 'approved' });
  // Con una factura ligada (lo que lee la pantalla de Finance), el dominio no lo construye.
  assert.throws(() => undoPurchaseOps(data, invoiced, { invoiced: true }), /Finance/);
  await run(undoPurchaseOps(data, invoiced), editor);
  // Lo recibido no se deshace por aquí.
  await run(setPurchaseStatusOps(await db.data(), buy, 'purchased'));
  await run(receivePurchaseOps(await db.data(), buy));
  data = await db.data();
  assert.throws(() => undoPurchaseOps(data, buy), /aún no se ha recibido/);
});

test('compras · «No se compró» con factura ligada: el servidor también lo rechaza', { todo: 'espera la comprobación publicada por Finance (pedida a Core en SALIDA del 20-10)' }, () => {});

test('compras · ámbitos y visibilidad: los planes son del área entera; las solicitudes, de su proyecto', async () => {
  const { tab, inbox } = await db.area('Ámbitos');
  const guest = await db.member('editor', { tabs: [], projects: { [tab]: [inbox] } });
  const req = newId();
  await db.commit([request(tab, req, { project_id: inbox })], guest);
  await rejects(db.commit([request(tab, newId())], guest), 'FORBIDDEN');
  await rejects(db.commit([insert('tasks.purchase_plans', newId(), { tab_id: tab, title: 'Plan' })], guest), 'FORBIDDEN');
  const scopes = { tabs: [], projects: { [tab]: [inbox] } };
  assert.equal(visibleRow('tasks.purchase_requests', { tab_id: tab, project_id: inbox }, scopes), true);
  assert.equal(visibleRow('tasks.purchase_requests', { tab_id: tab, project_id: null }, scopes), false);
  assert.equal(visibleRow('tasks.purchase_plans', { tab_id: tab }, scopes), false);
  assert.equal(visibleRow('tasks.purchase_plans', { tab_id: tab }, '*'), true);
  // La validación compartida dice lo mismo antes de enviar.
  assert.throws(() => validateOperations([insert('tasks.purchase_plans', newId(), { tab_id: tab, title: 'Plan' })], { role: 'editor', scopes }), /área entera/);
  // El responsable de compras se elige desde el editor de área: la validación del cliente lo admite (y un id que no es uuid, no).
  validateOperations([update('tasks.tabs', tab, 1, { purchase_approver_id: newId() })], { role: 'owner', scopes: '*' });
  assert.throws(() => validateOperations([update('tasks.tabs', tab, 1, { purchase_approver_id: 'nadie' })], { role: 'owner', scopes: '*' }));
});

test('compras · vaciar papelera: lo que cuelga de un área o un proyecto borrados se lleva a la papelera y se purga', async () => {
  const { tab, inbox } = await db.area('Se borra');
  await db.area('Se queda');
  const project = newId(), plan = newId(), stop = newId(), req = newId();
  await db.commit([
    insert('tasks.projects', project, { tab_id: tab, title: 'Piscina', position: 2048 }),
    insert('tasks.purchase_plans', plan, { tab_id: tab, title: 'Plan' }),
    insert('tasks.purchase_plan_stops', stop, { tab_id: tab, plan_id: plan, supplier_name: 'Proveedor' }),
    request(tab, req, { project_id: project }),
  ]);
  void inbox;
  await db.commit([remove('tasks.tabs', tab, 1)]);
  const prepared = await db.commit([{ op: 'call', procedure: 'tasks.empty_trash_prepare', args: {} }]);
  assert.ok((prepared.results[0] as any).result.trashed > 0);
  const data = await db.data();
  for (const [table, id] of [['tasks.purchase_requests', req], ['tasks.purchase_plan_stops', stop], ['tasks.purchase_plans', plan]] as const) {
    assert.ok((data as any)[table].find((r: any) => r.id === id).deleted_at, table);
  }
});

/** Valida como la Edge y confirma; devuelve el lote. */
async function run(ops: any[], actor?: string) {
  validateOperations(ops, { role: 'owner', scopes: '*' });
  if (ops.length) await db.commit(ops, actor);
  return ops;
}

test('compras · operaciones: pedir, aprobar y recibir (la entrada en Recursos la prueba supplies-resources.test.ts)', async () => {
  const { tab } = await db.area('Operaciones');
  let data = await db.data();
  const [order] = await run(requestPurchaseOps(data, { tab_id: tab, title: 'Cloro', quantity: 25, unit: 'l', supplier_name: 'Piscinas Sur' }));
  data = await db.data();
  await run(setPurchaseStatusOps(data, order!.id!, 'approved'));
  data = await db.data();
  const received = await run(receivePurchaseOps(data, order!.id!));
  assert.deepEqual(received.map((o) => o.table), ['tasks.purchase_requests']);
  data = await db.data();
  assert.deepEqual(receivePurchaseOps(data, order!.id!), [], 'recibir dos veces no cambia nada');
});

test('compras · plan: agrupa por proveedor las aprobadas y las recurrentes que tocan; se quita si no hay compras', async () => {
  const { tab, inbox } = await db.area('Plan por proveedor');
  let data = await db.data();
  const a = await run(requestPurchaseOps(data, { tab_id: tab, project_id: inbox, title: 'Tornillos', supplier_name: 'Ferretería', status: 'approved' }));
  data = await db.data();
  const b = await run(requestPurchaseOps(data, { tab_id: tab, title: 'Lejía', supplier_name: 'Droguería', status: 'approved' }));
  data = await db.data();
  const c = await run(requestPurchaseOps(data, { tab_id: tab, title: 'Bombillas', status: 'approved' }));
  data = await db.data();
  // Una recurrente recibida hace 40 días cada 30: toca en el próximo plan.
  const recur = await run(requestPurchaseOps(data, { tab_id: tab, title: 'Cloro mensual', supplier_name: 'Ferretería', repeat_days: 30, status: 'approved' }));
  // Fecha de recepción en el pasado: el trigger de fechas la pondría a ahora, así que solo aquí se salta.
  await db.t.db.exec(`set session_replication_role = replica`);
  await db.t.db.query(`update tasks.purchase_requests set status = 'received', received_at = now() - interval '40 days' where id = $1`, [recur[0]!.id]);
  await db.t.db.exec(`set session_replication_role = origin`);
  data = await db.data();
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(dueRecurring(data, tab, today).map((r) => r.id), [recur[0]!.id]);
  const plan = await run(preparePlanOps(data, { tab_id: tab, title: 'Compra del lunes', today }));
  data = await db.data();
  const planId = plan[0]!.id!;
  const stops = data['tasks.purchase_plan_stops'].filter((st) => st.plan_id === planId && !st.deleted_at);
  assert.deepEqual(stops.map((st) => st.supplier_name).sort(), ['Droguería', 'Ferretería', 'Sin proveedor']);
  const ferreteria = stops.find((st) => st.supplier_name === 'Ferretería')!;
  const inStop = data['tasks.purchase_requests'].filter((r) => r.plan_stop_id === ferreteria.id).map((r) => r.title).sort();
  assert.deepEqual(inStop, ['Cloro mensual', 'Tornillos'], 'la recurrente nueva va con su proveedor, ya aprobada');
  assert.deepEqual(dueRecurring(data, tab, today), [], 'ya hay una abierta: no vuelve a tocar');
  void b; void c; void a;
  // Sin compras, el plan se quita y sus solicitudes vuelven a estar sin plan.
  await run(deletePlanOps(data, planId));
  data = await db.data();
  assert.ok(data['tasks.purchase_requests'].filter((r) => r.tab_id === tab && !r.deleted_at).every((r) => !r.plan_stop_id));
  // La siguiente de una recurrente: misma compra, con la fecha desde que se recibió.
  const next = nextRecurringOps(data, recur[0]!.id!);
  assert.equal(next[0]!.fields!.repeat_days, 30);
});

test('compras · lecturas: tasks.targets con solicitudes de compra (por id y lista)', async () => {
  const { tab, inbox } = await db.area('Lecturas');
  const guest = await db.member('editor', { tabs: [], projects: { [tab]: [inbox] } });
  const own = newId(), general = newId();
  await db.commit([
    request(tab, own, { project_id: inbox, title: 'Pintura', status: 'approved' }),
    request(tab, general, { title: 'Papel', status: 'purchased' }),
    request(tab, newId(), { title: 'Pendiente', status: 'requested' }),
  ]);
  await db.commit([update('tasks.purchase_requests', general, 1, { status: 'received' })]);
  const list = await db.read('tasks.targets', { kind: 'purchase_request', tabId: tab });
  assert.deepEqual(list.items.map((x: any) => x.title).sort(), ['Papel', 'Pintura'], 'aprobadas, compradas o recibidas que esperan factura');
  const one = await db.read('tasks.targets', { kind: 'purchase_request', id: own });
  assert.deepEqual([one.kind, one.status, one.projectId], ['purchase_request', 'approved', inbox]);
  const guestList = await db.read('tasks.targets', { kind: 'purchase_request', tabId: tab }, guest);
  assert.deepEqual(guestList.items.map((x: any) => x.id), [own], 'un acceso por proyecto solo ve las de su proyecto');
  await rejects(db.read('tasks.targets', { kind: 'purchase_request', id: general }, guest), 'NOT_FOUND');
});
