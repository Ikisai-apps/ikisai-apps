/**
 * Tasks · compras no alimentarias (docs/tasks/API.md §18, migración 0305) sobre PGlite, a través de `core.commit`:
 * solicitudes con aprobación del responsable de compras, planes por proveedor y lo que vaciar la papelera hace con ellos.
 * El almacén es de Recursos desde R6 (0333): lo prueba supplies-resources.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addToPlanOps, createdRequestIds, moveToSupplierOps, receiptEntryOperation, receiptPlan, removeFromPlanOps, toBaseQuantity,
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

test('compras · «No se compró» con factura ligada: el servidor también lo rechaza (0338)', async () => {
  const { tab, inbox } = await db.area('Compra con factura');
  const editor = await db.member('editor', { tabs: [tab], projects: {} });
  const req = newId();
  await db.commit([request(tab, req, { project_id: inbox, title: 'Pintura', status: 'approved' })]);
  await db.commit([update('tasks.purchase_requests', req, 1, { status: 'purchased' })], editor);
  const supplier = newId(), invoice = newId(), line = newId();
  await db.t.db.query(`insert into invoices.suppliers (id, name, slug) values ($1, 'Pinturas Sur', 'pinturas_sur_0338')`, [supplier]);
  await db.t.db.query(`insert into invoices.invoices (id, supplier_id, invoice_date, object, code) values ($1, $2, '2026-10-20', 'Pintura', 'F-2026-0338')`, [invoice, supplier]);
  await db.t.db.query(`insert into invoices.invoice_lines (id, invoice_id, position, description, net_amount) values ($1, $2, 0, 'Pintura', 30)`, [line, invoice]);
  await db.t.db.query(`insert into invoices.allocations (id, invoice_line_id, invoice_id, target_app, target_kind, target_id, target_label, allocated_amount) values ($1, $2, $3, 'tasks', 'purchase_request', $4, 'Pintura', 30)`, [newId(), line, invoice, req]);
  // Ni el editor ni la propietaria, aunque la pantalla no lo ofrezca: el servidor lo para.
  await rejects(db.commit([update('tasks.purchase_requests', req, 2, { status: 'approved' })], editor), 'PURCHASE_INVOICED');
  await rejects(db.commit([update('tasks.purchase_requests', req, 2, { status: 'approved' })]), 'PURCHASE_INVOICED');
  // Recibirla sí se puede.
  await db.commit([update('tasks.purchase_requests', req, 2, { status: 'received' })], editor);
  // Con la factura anulada (procedimiento de Finance; aquí solo el estado), otra compra ya se puede deshacer.
  const other = newId();
  await db.commit([request(tab, other, { project_id: inbox, title: 'Rodillos', status: 'approved' })]);
  await db.commit([update('tasks.purchase_requests', other, 1, { status: 'purchased' })], editor);
  await db.t.db.query(`update invoices.allocations set target_id = $1 where invoice_id = $2`, [other, invoice]);
  await rejects(db.commit([update('tasks.purchase_requests', other, 2, { status: 'approved' })], editor), 'PURCHASE_INVOICED');
  await db.t.db.exec(`set session_replication_role = replica`);
  await db.t.db.query(`update invoices.invoices set status = 'anulada', annulled_reason = 'Duplicada' where id = $1`, [invoice]);
  await db.t.db.exec(`set session_replication_role = origin`);
  await db.commit([update('tasks.purchase_requests', other, 2, { status: 'approved' })], editor);
});

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

// --- Compras R6 «Estantería» (MUELA-094, tanda 40) ---------------------------------------------------------------------

const unit = (item: string, u: string, factor: number, extra: Record<string, unknown> = {}) => ({ item_id: item, unit: u, factor, ...extra });
const req = (extra: Record<string, unknown>) => ({ id: newId(), tab_id: newId(), title: 'Compra', item_id: newId(), quantity: null, unit: null, need_quantity: null, estimated_amount: null, ...extra }) as any;

test('compras · envase entero al recibir: la lejía pide 19 l y entran 20; el butano entra tal cual; los guantes, 2 cajas de 100', () => {
  const lejia = req({ title: 'Lejía', quantity: 19, unit: 'l', need_quantity: 19 });
  const units = [unit(lejia.item_id, 'botella de 1 l', 1, { price: 2.1 }), unit(lejia.item_id, 'garrafa de 5 l', 5, { usual: true, price: 9.7 })];
  const p = receiptPlan(lejia, { base_unit: 'l' }, units)!;
  assert.deepEqual([p.need, p.bought, p.extra, p.packs, p.pack?.unit, p.amount, p.unitCost], [19, 20, 1, 4, 'garrafa de 5 l', 38.8, 1.94]);
  const op = receiptEntryOperation(lejia, { id: 'm1', spaceId: 's1', item: { base_unit: 'l' }, units })!;
  assert.deepEqual([op.fields!.quantity, op.fields!.unit_cost, op.fields!.kind], [20, 1.94, 'entrada_manual'], 'entra lo comprado y el coste es sobre eso');
  // El butano, sin envase en la ficha: entra lo pedido.
  const butano = req({ title: 'Butano', quantity: 2, unit: 'ud', estimated_amount: 38.8 });
  assert.deepEqual(receiptEntryOperation(butano, { id: 'm2', spaceId: 's1', item: { base_unit: 'ud' }, units: [] })!.fields!.quantity, 2);
  // Los guantes: 165 unidades → 2 cajas de 100; sobran 35.
  const guantes = req({ title: 'Guantes', quantity: 165, unit: 'ud' });
  const g = receiptPlan(guantes, { base_unit: 'ud' }, [unit(guantes.item_id, 'caja de 100', 100)])!;
  assert.deepEqual([g.bought, g.extra, g.packs, g.amount], [200, 35, 2, null], 'sin precio, el importe es null, nunca 0');
  // Pedido ya en envases: 2 garrafas de 5 l son 10 l.
  assert.equal(receiptPlan({ ...lejia, quantity: 2, unit: 'Garrafa de 5 l', need_quantity: null }, { base_unit: 'l' }, units)!.bought, 10);
});

test('compras · la entrada se pasa a la unidad base del artículo; una unidad que no se sabe pasar se rechaza', () => {
  const cloro = req({ title: 'Cloro', quantity: 2.5, unit: 'kg' });
  assert.equal(receiptPlan(cloro, { base_unit: 'g' }, [])!.bought, 2500);
  assert.equal(toBaseQuantity(500, 'ml', 'l'), 0.5);
  assert.equal(toBaseQuantity(3, '', 'l'), 3);
  assert.equal(toBaseQuantity(3, 'sacos', 'kg'), null);
  assert.throws(() => receiptPlan({ ...cloro, unit: 'sacos' }, { base_unit: 'kg' }, []), (e: any) => e.code === 'INVALID_UNIT');
  // Sin artículo, o sin cantidad, no hay entrada (como antes).
  assert.equal(receiptPlan({ ...cloro, item_id: null }, { base_unit: 'kg' }, []), null);
  assert.equal(receiptEntryOperation({ ...cloro, quantity: null }, { id: 'x', spaceId: 's' }), null);
});

test('compras · R6: «Preparando» al crear, sin lo quitado; añadir y sacar; «Deshacer» borra las recurrentes; no se cambia de tienda en un plan', async () => {
  const { tab } = await db.area('Estantería');
  let data = await db.data();
  const a = await run(requestPurchaseOps(data, { tab_id: tab, title: 'Masilla', supplier_name: 'Ferretería', status: 'approved', need_quantity: 2, quantity: 2, unit: 'ud' }));
  data = await db.data();
  assert.equal(Number((await row('tasks.purchase_requests', a[0]!.id!)).need_quantity), 2, 'need_quantity se guarda');
  const b = await run(requestPurchaseOps(data, { tab_id: tab, title: 'Lejía', supplier_name: 'Droguería', status: 'approved' }));
  data = await db.data();
  const recur = await run(requestPurchaseOps(data, { tab_id: tab, title: 'Butano', supplier_name: 'Gasolinera', repeat_days: 30, status: 'approved' }));
  await db.t.db.exec(`set session_replication_role = replica`);
  await db.t.db.query(`update tasks.purchase_requests set status = 'received', received_at = now() - interval '40 days' where id = $1`, [recur[0]!.id]);
  await db.t.db.exec(`set session_replication_role = origin`);
  data = await db.data();
  const today = new Date().toISOString().slice(0, 10);
  // La lejía se quita de la vista previa: no entra.
  const ops = preparePlanOps(data, { tab_id: tab, title: 'Compra del martes', today, exclude: [b[0]!.id!] });
  assert.equal(ops[0]!.fields!.status, 'draft', 'hallazgo 1: sin «undefined»');
  await run(ops);
  data = await db.data();
  const planId = ops[0]!.id!;
  assert.equal((await row('tasks.purchase_plans', planId)).status, 'draft');
  assert.equal((await row('tasks.purchase_requests', b[0]!.id!)).plan_stop_id, null, 'lo quitado no entra');
  const created = createdRequestIds(ops);
  assert.equal(created.length, 1, 'la recurrente que toca se crea al preparar');
  // No se cambia de tienda una compra que está en un plan.
  assert.throws(() => moveToSupplierOps(data, a[0]!.id!, { supplier_name: 'Bazar' }), /Está en el plan «Compra del martes»/);
  assert.deepEqual(moveToSupplierOps(data, b[0]!.id!, { supplier_name: 'Bazar' }).map((o) => o.fields), [{ supplier_name: 'Bazar', supplier_id: null }]);
  // Añadir la lejía: parada nueva al final (Droguería no estaba); sacarla.
  const add = addToPlanOps(data, planId, b[0]!.id!);
  assert.deepEqual(add.map((o) => `${o.op}:${o.table}`), ['insert:tasks.purchase_plan_stops', 'update:tasks.purchase_requests']);
  await run(add);
  data = await db.data();
  assert.throws(() => addToPlanOps(data, planId, b[0]!.id!), /Ya está en un plan/);
  await run(removeFromPlanOps(data, b[0]!.id!));
  data = await db.data();
  assert.equal((await row('tasks.purchase_requests', b[0]!.id!)).plan_stop_id, null);
  // Comprada no se saca del plan.
  await run(setPurchaseStatusOps(data, a[0]!.id!, 'purchased'));
  data = await db.data();
  assert.throws(() => removeFromPlanOps(data, a[0]!.id!), /Ya está comprada/);
  assert.throws(() => moveToSupplierOps(data, a[0]!.id!, { supplier_name: 'Bazar' }), /Ya está comprada/);
  await run(setPurchaseStatusOps(data, a[0]!.id!, 'approved'));
  data = await db.data();
  // «Deshacer» de crear el plan: la recurrente que creó va a la papelera; lo demás vuelve a estar sin plan.
  await run(deletePlanOps(data, planId, { created }));
  data = await db.data();
  assert.ok((await row('tasks.purchase_requests', created[0]!)).deleted_at, 'la recurrente creada se borra');
  assert.equal((await row('tasks.purchase_requests', a[0]!.id!)).plan_stop_id, null);
  assert.deepEqual(dueRecurring(data, tab, today).map((r) => r.id), [recur[0]!.id], 'vuelve a tocar en el próximo plan');
});
