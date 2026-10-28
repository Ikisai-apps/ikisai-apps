/**
 * Tasks · orden inverso de R4 (RESPUESTAS de Core del 19-10-2026): la factura de una compra se valida en Finance **antes**
 * de que Tasks la reciba. Al recibir, Tasks apunta su entrada y pide el cuadre (`POST purchases/reconcile`): la entrada
 * de la factura se queda en lo que no entró ya y su coste pasa a la entrada de Tasks. El stock suma una sola vez y
 * repetirlo no cambia nada. La factura se prepara con SQL (como la dejaría Finance al validar, 0235-0238).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';
import { reconcileResults } from '../../supabase/functions/tasks-api/receipts.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const TAB = uuid(), REQUEST = uuid(), OTHER_REQUEST = uuid();
let ITEM: string, SPACE: string, LINE: string, OTHER_LINE: string;

const sql = (text: string, params: unknown[] = []) => app.t.db.query<any>(text, params);
const stock = async () => Number((await sql(`select coalesce(sum(quantity), 0) q from resources.movements where item_id = $1 and deleted_at is null`, [ITEM])).rows[0].q);
const reconcile = (ids: string[], token?: string) => app.call('/api/v1/purchases/reconcile', { token, body: { requestIds: ids } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const ok = async (operations: unknown[]) => { const r = await app.call('/api/v1/commands', { body: { requestId: `rc-${++seq}`, operations } }); assert.equal(r.status, 200, JSON.stringify(r.data)); };
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024 }));
  SPACE = (await sql(`select id from resources.spaces where name = 'Altura 1'`)).rows[0].id;
  ITEM = (await sql(`insert into resources.items (name, kind, base_unit, default_space_id) values ('Lejía', 'limpieza', 'l', $1) returning id`, [SPACE])).rows[0].id;
  await ok([
    { op: 'insert', table: 'tasks.purchase_requests', id: REQUEST, fields: { tab_id: TAB, title: 'Lejía', item_id: ITEM, quantity: 4, unit: 'l', status: 'approved', position: 1024 } },
    { op: 'insert', table: 'tasks.purchase_requests', id: OTHER_REQUEST, fields: { tab_id: TAB, title: 'Otra', position: 2048 } },
  ]);
  // Finance: enlace con Recursos encendido y una factura validada con dos líneas; una asignada a la compra de Tasks.
  const supplier = uuid(), invoice = uuid();
  LINE = uuid(); OTHER_LINE = uuid();
  await sql(`set session_replication_role = replica`);
  await sql(`insert into invoices.settings (id, key, value) values ($1, 'resources_links', 'true'::jsonb)`, [uuid()]);
  await sql(`insert into invoices.suppliers (id, name, slug) values ($1, 'Droguería', 'drogueria')`, [supplier]);
  await sql(`insert into invoices.invoices (id, supplier_id, object, invoice_date, status) values ($1, $2, 'Limpieza', '2026-10-19', 'validada')`, [invoice, supplier]);
  await sql(`insert into invoices.invoice_lines (id, invoice_id, position, description, net_amount, quantity, item_id) values ($1, $3, 0, 'Lejía 4 l', 6, 4, $4), ($2, $3, 1, 'Lejía (otra)', 3, 2, $4)`, [LINE, OTHER_LINE, invoice, ITEM]);
  await sql(`insert into invoices.allocations (id, invoice_line_id, invoice_id, target_app, target_kind, target_id, target_label, allocated_amount) values ($1, $2, $3, 'tasks', 'purchase_request', $4, 'Compra', 6)`, [uuid(), LINE, invoice, REQUEST]);
  await sql(`set session_replication_role = origin`);
  // Al validarse, Finance metió lo de su línea (4 l a 1,5 €).
  await sql(`insert into resources.movements (item_id, space_id, quantity, kind, unit_cost, source_app, source_ref, at) values ($1, $2, 4, 'entrada_factura', 1.5, 'invoices', $3, now())`, [ITEM, SPACE, `invoice_line:${LINE}`]);
});
test.after(async () => { await app.close(); });

test('orden inverso: validada antes de recibir; al recibir y cuadrar, el stock suma una vez y el coste pasa a Tasks', async () => {
  assert.equal(await stock(), 4);
  // Tasks recibe: su entrada, desde el servidor como recordReceipt (Recursos 0820: origen server, source_app tasks).
  const res = await app.call(`/api/v1/purchases/${REQUEST}/receipt`, { body: { spaceId: SPACE } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.recorded, true);
  const tasksEntry = res.data.movementId as string;
  assert.equal(await stock(), 8, 'antes de cuadrar, entraría dos veces');
  const out = await reconcile([REQUEST]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  // MUELA-094: una fila por solicitud, nunca «error» si el cuadre se hizo.
  assert.deepEqual(out.data.results.map((r: any) => r.id), [REQUEST]);
  assert.notEqual(out.data.results[0].state, 'error');
  assert.equal(await stock(), 4, 'la factura se queda en lo que no entró ya');
  const costs = (await sql(`select unit_cost::text c, source_ref from resources.movement_costs where movement_id = $1 and deleted_at is null`, [tasksEntry])).rows;
  assert.deepEqual(costs.map((c: any) => [Number(c.c), c.source_ref]), [[1.5, `invoice_line:${LINE}`]], 'el coste de la factura pasa a la entrada de Tasks');
  // Repetirlo no cambia nada (ni duplica el coste).
  const again = await reconcile([REQUEST]);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(await stock(), 4);
  assert.equal((await sql(`select count(*)::int n from resources.movement_costs where movement_id = $1`, [tasksEntry])).rows[0].n, 1);
  // La otra línea de la factura no la toca Tasks.
  assert.equal((await sql(`select count(*)::int n from resources.movements where source_ref = $1`, [`invoice_line:${OTHER_LINE}`])).rows[0].n, 0);
});

test('orden inverso: sin factura asignada no hay nada que cuadrar; ids inválidos y lector, rechazados', async () => {
  const out = await reconcile([OTHER_REQUEST]);
  // MUELA-094: además, el resultado por solicitud; sin factura, «none».
  assert.deepEqual([out.status, out.data], [200, { movements: 0, costs: 0, results: [{ id: OTHER_REQUEST, state: 'none', invoiced: null, estimated: null, diff: null, codes: [] }] }]);
  assert.equal((await reconcile(['no-es-un-id'])).status, 422);
  assert.equal((await reconcile([])).status, 422);
  assert.equal((await reconcile([REQUEST], app.tokens.reader)).status, 403);
});

test('MUELA-094 · el resultado del cuadre por solicitud: cuadrada, con diferencia, sin factura y error', () => {
  const rows = [
    { target_id: 'a', invoice_code: 'F-2026-0412', allocated_amount: 38.8 },
    { target_id: 'b', invoice_code: 'F-2026-0377', allocated_amount: 4 }, { target_id: 'b', invoice_code: 'F-2026-0377', allocated_amount: '3.40' },
  ];
  const est = new Map<string, number | null>([['a', 38.8], ['b', 6.9], ['c', 10]]);
  assert.deepEqual(reconcileResults(['a', 'b', 'c'], rows, est).map((r) => [r.id, r.state, r.invoiced, r.diff, r.codes]), [
    ['a', 'ok', 38.8, 0, ['F-2026-0412']], ['b', 'diff', 7.4, 0.5, ['F-2026-0377']], ['c', 'none', null, null, []],
  ]);
  // Sin previsto, lo facturado cuadra; si el lote falla, las que tenían factura salen con «error» y las demás, «none».
  assert.equal(reconcileResults(['a'], rows, new Map())[0]!.state, 'ok');
  assert.deepEqual(reconcileResults(['a', 'c'], rows, est, true).map((r) => r.state), ['error', 'none']);
});
