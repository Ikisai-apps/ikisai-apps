/**
 * Tasks · R6: Compras y Suministros sobre Recursos (migración 0333). Sin migración de datos (decisión del usuario del
 * 19-10-2026, con 0 suministros en producción): la 0333 retira el almacén de Tasks solo si está vacío, las solicitudes
 * apuntan a un artículo de `resources.items` (`item_id`), recibir apunta una `entrada_manual` estable en Recursos, y
 * «Queda poco», la lectura del artículo y el indicador de Central leen el inventario común.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, migrationFiles } from '../../packages/test-kit/src/pglite.ts';
import { lowStock, receiptEntryOperation, receivePurchaseOps, reorderItemOps, requestPurchaseOps, type ResourceItem } from '../../packages/domain-tasks/src/index.ts';
import { createTasksDb, insert, newId, rejects, update, type TasksDb } from './db.ts';

let db: TasksDb;
let seq = 0;
test.after(async () => { await db.close(); });

/** Lote en Recursos como la propietaria de Tasks (miembro derivado de `resources`, 0091). */
const resources = (operations: unknown[], requestId = `r6-${++seq}`) =>
  db.t.rpc('core_commit', { p_app: 'resources', p_actor: db.owner, p_request_id: requestId, p_digest: requestId, p_expected_cursor: null, p_operations: operations }) as Promise<any>;
const resourceRows = async (table: string) => ((await db.t.rpc('core_snapshot_table', { p_app: 'resources', p_role: 'owner', p_table: table, p_include_deleted: true, p_limit: 2000, p_offset: 0 })) as { rows: any[] }).rows;
const space = (id: string, parent: string, name: string) => ({ op: 'insert', table: 'resources.spaces', id, fields: { parent_id: parent, kind: 'edificio', name, position: 1024 } });
const item = (id: string, name: string, kind: string, extra: Record<string, unknown> = {}) => ({ op: 'insert', table: 'resources.items', id, fields: { name, kind, base_unit: 'l', ...extra } });
const entry = (itemId: string, spaceId: string, quantity: number) => ({ op: 'insert', table: 'resources.movements', id: newId(), fields: { item_id: itemId, space_id: spaceId, quantity, kind: 'entrada_manual' } });

const ALMACEN = newId(), CLORO = newId(), LEJIA = newId(), HARINA = newId();

test.before(async () => {
  db = await createTasksDb();
  // Bajo la altura que siembra Recursos, como los espacios reales.
  const altura = (await db.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  await resources([space(ALMACEN, altura, 'Almacén piscina')]);
  await resources([
    item(CLORO, 'Cloro granulado', 'material', { min_quantity: 10, reorder_quantity: 25, default_space_id: ALMACEN }),
    item(LEJIA, 'Lejía', 'limpieza', { min_quantity: 4 }),
    // Lo de cocina no es un suministro de la casa: no sale en «Queda poco» de Tasks.
    item(HARINA, 'Harina', 'ingrediente', { min_quantity: 5, base_unit: 'kg' }),
  ]);
  await resources([entry(CLORO, ALMACEN, 3), entry(LEJIA, ALMACEN, 6)]);
});

test('R6 · la 0333 retira el almacén de Tasks solo si está vacío (papelera incluida)', async () => {
  const files = migrationFiles();
  const at = files.findIndex((f) => f.includes('_0333_tasks_supplies_resources'));
  assert.ok(at > 0, 'la migración 0333 existe');
  const before = files.slice(0, at);
  const sql = (await import('node:fs')).readFileSync(new URL(`../../supabase/migrations/${files[at]}`, import.meta.url), 'utf8');

  const full = await createTestDatabase({ migrations: before });
  try {
    const tab = newId();
    await full.db.query(`insert into tasks.tabs (id, name, position) values ($1, 'Casa', 1024)`, [tab]);
    await full.db.query(`insert into tasks.supply_items (id, tab_id, name, deleted_at) values ($1, $2, 'Cloro', now())`, [newId(), tab]);
    await assert.rejects(full.db.exec(sql), /almacén de Tasks no está vacío \(1 suministros, 0 movimientos, 0 solicitudes enlazadas\)/);
    assert.equal((await full.db.query<{ n: number }>(`select count(*)::int n from tasks.supply_items`)).rows[0]!.n, 1, 'no se pierde nada');
  } finally { await full.close(); }

  const empty = await createTestDatabase({ migrations: before });
  try {
    await empty.db.exec(sql);
    assert.equal((await empty.db.query<{ gone: boolean }>(`select to_regclass('tasks.supply_items') is null as gone`)).rows[0]!.gone, true);
    const cols = (await empty.db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'tasks' and table_name = 'purchase_requests'`)).rows.map((r) => r.column_name);
    assert.ok(cols.includes('item_id') && !cols.includes('supply_item_id'));
    const synced = (await empty.db.query<{ table_name: string }>(`select table_name from core.synced_tables where app = 'tasks' and table_name like 'supply%'`)).rows;
    assert.deepEqual(synced, [], 'ya no se sincronizan');
  } finally { await empty.close(); }
});

test('R6 · una solicitud apunta a un artículo vivo de Recursos', async () => {
  const { tab } = await db.area('Compras R6');
  const req = newId();
  await rejects(db.commit([insert('tasks.purchase_requests', newId(), { tab_id: tab, title: 'Nada', item_id: newId(), position: 1024 })]), 'INVALID_ITEM');
  await db.commit([insert('tasks.purchase_requests', req, { tab_id: tab, title: 'Lejía', item_id: LEJIA, position: 1024 })]);
  // Cambiarlo a uno que no existe, tampoco; quitarlo, sí.
  await rejects(db.commit([update('tasks.purchase_requests', req, 1, { item_id: newId() })]), 'INVALID_ITEM');
  await db.commit([update('tasks.purchase_requests', req, 1, { item_id: null })]);
});

test('R6 · queda poco, pedir y recibir: la entrada va a Recursos una sola vez', async () => {
  const { tab } = await db.area('Recibir R6');
  const items = await resourceRows('resources.items') as ResourceItem[];
  const movements = await resourceRows('resources.movements');
  let data = await db.data();
  const low = lowStock(data, items, movements);
  assert.deepEqual(low.map((x) => [x.item.name, x.stock, x.openRequest]), [['Cloro granulado', 3, null]], 'la lejía tiene 6 de 4; la harina es de cocina');

  const cloro = items.find((i) => i.id === CLORO)!;
  const [order] = reorderItemOps(data, { tab_id: tab, item: cloro, stock: 3 });
  assert.deepEqual([order!.fields!.item_id, order!.fields!.quantity, order!.fields!.unit, order!.fields!.title], [CLORO, 25, 'l', 'Cloro granulado']);
  Object.assign(order!.fields!, { estimated_amount: 50, status: 'approved' });
  await db.commit([order!]);
  data = await db.data();
  assert.equal(lowStock(data, items, movements)[0]!.openRequest!.id, order!.id);

  const request = data['tasks.purchase_requests'].find((r) => r.id === order!.id)!;
  const id = newId();
  const op = receiptEntryOperation(request, { id, spaceId: ALMACEN })!;
  assert.deepEqual([op.fields!.kind, op.fields!.quantity, op.fields!.unit_cost, op.fields!.source_app, op.fields!.source_ref],
    ['entrada_manual', 25, 2, 'tasks', `purchase_request:${order!.id}`]);
  await resources([op], `tasks-receipt-${order!.id}`);
  // Repetir la misma entrada (otro dispositivo, un reintento) no suma dos veces.
  await assert.rejects(resources([op]), /ROW_EXISTS/);
  await db.commit(receivePurchaseOps(data, order!.id!));
  assert.deepEqual(receivePurchaseOps(await db.data(), order!.id!), [], 'ya recibida');

  const stock = (await resourceRows('resources.movements')).filter((m) => m.item_id === CLORO).reduce((s, m) => s + Number(m.quantity), 0);
  assert.equal(stock, 28);
  // Sin artículo o sin cantidad, no hay entrada.
  const plain = requestPurchaseOps(data, { tab_id: tab, title: 'Bombillas' })[0]!;
  assert.equal(receiptEntryOperation({ ...(plain.fields as any), id: plain.id }, { id: newId(), spaceId: ALMACEN }), null);
});

test('R6 · lecturas: tasks.low_stock, tasks.supply_item y el indicador de Central leen Recursos', async () => {
  const { tab } = await db.area('Lecturas R6');
  await resources([entry(LEJIA, ALMACEN, 0.5)]);
  // Lejía 6,5 de 4; cloro ya recibido (28 de 10): nada queda poco. Se gasta lejía hasta 2,5.
  await resources([{ op: 'insert', table: 'resources.movements', id: newId(), fields: { item_id: LEJIA, space_id: ALMACEN, quantity: -4, kind: 'salida_manual', reason: 'uso' } }]);
  const low = await db.read('tasks.low_stock', { tabId: tab });
  assert.deepEqual(low.items.map((x: any) => [x.name, Number(x.stock), Number(x.minQuantity)]), [['Lejía', 2.5, 4]]);
  const guest = await db.member('editor', { tabs: [], projects: { [tab]: [newId()] } });
  assert.deepEqual((await db.read('tasks.low_stock', {}, guest)).items, [], 'el almacén es de quien tiene alguna área entera');

  const one = await db.read('tasks.supply_item', { itemId: CLORO });
  assert.deepEqual([one.item.name, Number(one.item.stock), one.item.base_unit], ['Cloro granulado', 28, 'l']);
  assert.deepEqual(await db.read('tasks.supply_item', { itemId: newId() }), { item: null });

  const kpi = (await db.t.db.query<{ value: string }>(`select value from tasks.central_kpi_projection where kpi = 'tasks.supplies_below_min'`)).rows[0]!;
  assert.equal(Number(kpi.value), 1);
});
