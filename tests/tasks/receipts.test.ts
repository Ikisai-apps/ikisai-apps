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
  // Tasks recibe: su entrada (como recordReceipt) y el estado.
  const tasksEntry = uuid();
  const res = await app.call('/api/v1/resources/commands', { body: { requestId: `tasks-receipt-${REQUEST}`, operations: [
    { op: 'insert', table: 'resources.movements', id: tasksEntry, fields: { item_id: ITEM, space_id: SPACE, quantity: 4, kind: 'entrada_manual', source_app: 'tasks', source_ref: `purchase_request:${REQUEST}` } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(await stock(), 8, 'antes de cuadrar, entraría dos veces');
  const out = await reconcile([REQUEST]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
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
  assert.deepEqual([out.status, out.data], [200, { movements: 0, costs: 0 }]);
  assert.equal((await reconcile(['no-es-un-id'])).status, 422);
  assert.equal((await reconcile([])).status, 422);
  assert.equal((await reconcile([REQUEST], app.tokens.reader)).status, 403);
});
