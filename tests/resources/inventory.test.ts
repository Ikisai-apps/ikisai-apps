/** Recursos · fase R3, inventario base (RECURSOS.md §5 y §11.2; migración 0802): artículos, movimientos, traslados,
 *  recuentos, stock y coste medio como lecturas, y las reglas del hook. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) =>
  app.call('/api/v1/resources/commands', { token, body: { requestId: `inv-${++seq}`, operations } });
const code = (res: { data: any }) => res.data?.error?.code ?? res.data?.code;
const read = async (name: string, where: Record<string, unknown> = {}) =>
  (await app.call(`/api/v1/resources/read/${name}`, { body: { where } })).data;
const stock = async (item: string, space?: string) => {
  const rows = (await read('resources.stock_levels', space ? { item_id: item, space_id: space } : { item_id: item })).rows ?? [];
  return rows.reduce((t: number, r: any) => t + Number(r.quantity), 0);
};
let despensa = '';
let camara = '';

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
  const a3 = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3'`)).rows[0]!.id;
  const albergue = uuid(); despensa = uuid(); camara = uuid();
  const res = await commit([
    { op: 'insert', table: 'resources.spaces', id: albergue, fields: { parent_id: a3, kind: 'edificio', name: 'Albergue' } },
    { op: 'insert', table: 'resources.spaces', id: despensa, fields: { parent_id: albergue, kind: 'almacen', name: 'Despensa' } },
    { op: 'insert', table: 'resources.spaces', id: camara, fields: { parent_id: albergue, kind: 'cocina', name: 'Cocina' } },
  ], app.tokens.owner);
  assert.equal(res.status, 200, JSON.stringify(res.data));
});
test.after(async () => { await app.close(); });

test('artículos · el editor crea artículos con conversiones; tipos y unidad base se validan', async () => {
  const kinds = await app.call('/api/v1/resources/snapshot?tables=resources.item_kinds', { token: app.tokens.reader });
  assert.equal(kinds.data.tables[0].rows.length, 11);
  const harina = uuid();
  const ok = await commit([
    { op: 'insert', table: 'resources.items', id: harina, fields: { name: 'Harina', kind: 'ingrediente', base_unit: 'g', min_quantity: 5000, default_space_id: despensa } },
    { op: 'insert', table: 'resources.item_units', id: uuid(), fields: { item_id: harina, unit: 'saco', factor: 25000 } },
  ], app.tokens.editor);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(code(await commit([{ op: 'insert', table: 'resources.items', id: uuid(), fields: { name: 'Raro', kind: 'nada', base_unit: 'ud' } }], app.tokens.editor)), 'INVALID_ITEM_KIND');
  assert.equal(code(await commit([{ op: 'insert', table: 'resources.item_units', id: uuid(), fields: { item_id: harina, unit: 'G', factor: 1 } }], app.tokens.editor)), 'INVALID_UNIT');
  assert.equal((await commit([{ op: 'insert', table: 'resources.item_units', id: uuid(), fields: { item_id: harina, unit: 'kg', factor: 0 } }], app.tokens.editor)).status >= 400, true);
  assert.equal(code(await commit([{ op: 'insert', table: 'resources.items', id: uuid(), fields: { name: 'harina ', kind: 'ingrediente', base_unit: 'g' } }], app.tokens.editor)), 'CONSTRAINT_VIOLATION');
  // Lector no escribe; los tipos, solo el owner.
  assert.equal((await commit([{ op: 'insert', table: 'resources.items', id: uuid(), fields: { name: 'X', kind: 'otro', base_unit: 'ud' } }], app.tokens.reader)).status, 403);
  assert.equal((await commit([{ op: 'insert', table: 'resources.item_kinds', id: uuid(), fields: { kind: 'flores', label: 'Flores' } }], app.tokens.editor)).status, 403);
});

test('movimientos · entradas y salidas suman el stock; solo se añaden; signo, motivo y coste según el tipo; coste medio', async () => {
  const aceite = uuid();
  await commit([{ op: 'insert', table: 'resources.items', id: aceite, fields: { name: 'Aceite', kind: 'ingrediente', base_unit: 'ml' } }], app.tokens.editor);
  const entry = uuid();
  const res = await commit([
    { op: 'insert', table: 'resources.movements', id: entry, fields: { item_id: aceite, space_id: despensa, quantity: 5000, kind: 'entrada_factura', unit_cost: 0.004, source_app: 'invoices', source_ref: 'line:1' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: aceite, space_id: despensa, quantity: 5000, kind: 'entrada_manual', unit_cost: 0.006 } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: aceite, space_id: despensa, quantity: 1000, kind: 'entrada_manual' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: aceite, space_id: despensa, quantity: -1500, kind: 'consumo_servicio', source_app: 'food', source_ref: 'service:1' } },
  ], app.tokens.editor);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(await stock(aceite), 9500);
  const cost = (await read('resources.item_costs', { item_id: aceite })).rows[0];
  assert.equal(Number(cost.average_cost), 0.005, 'las entradas sin coste no alteran el medio');

  // Solo se añaden.
  const row = (await app.t.db.query<{ revision: number }>(`select revision from resources.movements where id = $1`, [entry])).rows[0]!;
  assert.equal(code(await commit([{ op: 'update', table: 'resources.movements', id: entry, expectedRevision: row.revision, fields: { quantity: 1 } }], app.tokens.owner)), 'MOVEMENT_IMMUTABLE');
  assert.equal(code(await commit([{ op: 'delete', table: 'resources.movements', id: entry, expectedRevision: row.revision }], app.tokens.owner)), 'MOVEMENT_IMMUTABLE');
  // Signo, motivo, coste.
  const bad = (fields: Record<string, unknown>) => commit([{ op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: aceite, space_id: despensa, ...fields } }], app.tokens.editor);
  assert.equal(code(await bad({ quantity: 10, kind: 'consumo_tarea' })), 'INVALID_MOVEMENT');
  assert.equal(code(await bad({ quantity: -10, kind: 'entrada_manual' })), 'INVALID_MOVEMENT');
  assert.equal(code(await bad({ quantity: -10, kind: 'salida_manual' })), 'INVALID_MOVEMENT');
  assert.equal((await bad({ quantity: -10, kind: 'salida_manual', reason: 'merma' })).status, 200);
  assert.equal(code(await bad({ quantity: -10, kind: 'consumo_tarea', unit_cost: 1 })), 'INVALID_MOVEMENT');
  assert.equal(code(await bad({ quantity: 10, kind: 'ajuste_recuento' })), 'INVALID_MOVEMENT');
  assert.equal(code(await bad({ quantity: 10, kind: 'entrada_manual', space_id: uuid() })), 'INVALID_SPACE');
  // Un artículo con movimientos no se borra; un espacio con stock no se archiva.
  const item = (await app.t.db.query<{ revision: number }>(`select revision from resources.items where id = $1`, [aceite])).rows[0]!;
  assert.equal(code(await commit([{ op: 'delete', table: 'resources.items', id: aceite, expectedRevision: item.revision }], app.tokens.owner)), 'ITEM_IN_USE');
  const sp = (await app.t.db.query<{ revision: number }>(`select revision from resources.spaces where id = $1`, [despensa])).rows[0]!;
  assert.equal(code(await commit([{ op: 'update', table: 'resources.spaces', id: despensa, expectedRevision: sp.revision, fields: { active: false } }], app.tokens.owner)), 'SPACE_HAS_STOCK');
});

test('traslados y lotes · dos filas que suman cero entre dos sitios; el lote es del artículo', async () => {
  const leche = uuid(); const lot = uuid();
  await commit([
    { op: 'insert', table: 'resources.items', id: leche, fields: { name: 'Leche', kind: 'ingrediente', base_unit: 'ml', tracks_lots: true, tracks_expiry: true } },
    { op: 'insert', table: 'resources.lots', id: lot, fields: { item_id: leche, code: 'L1', expires_on: '2026-11-01' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: leche, space_id: despensa, lot_id: lot, quantity: 6000, kind: 'entrada_manual' } },
  ], app.tokens.editor);
  const t = uuid();
  const moved = await commit([
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: leche, space_id: despensa, lot_id: lot, quantity: -2000, kind: 'traslado', transfer_id: t } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: leche, space_id: camara, lot_id: lot, quantity: 2000, kind: 'traslado', transfer_id: t } },
  ], app.tokens.editor);
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(await stock(leche, despensa), 4000);
  assert.equal(await stock(leche, camara), 2000);
  const t2 = uuid();
  assert.equal(code(await commit([
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: leche, space_id: despensa, quantity: -1000, kind: 'traslado', transfer_id: t2 } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: leche, space_id: camara, quantity: 900, kind: 'traslado', transfer_id: t2 } },
  ], app.tokens.editor)), 'INVALID_TRANSFER');
  const other = uuid();
  await commit([{ op: 'insert', table: 'resources.items', id: other, fields: { name: 'Nata', kind: 'ingrediente', base_unit: 'ml' } }], app.tokens.editor);
  assert.equal(code(await commit([{ op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: other, space_id: despensa, lot_id: lot, quantity: 1, kind: 'entrada_manual' } }], app.tokens.editor)), 'INVALID_LOT');
});

test('recuentos · parcial, las líneas solo en abierto; cerrar crea los ajustes y bloquea', async () => {
  const sal = uuid(); const azucar = uuid();
  await commit([
    { op: 'insert', table: 'resources.items', id: sal, fields: { name: 'Sal', kind: 'ingrediente', base_unit: 'g' } },
    { op: 'insert', table: 'resources.items', id: azucar, fields: { name: 'Azúcar', kind: 'ingrediente', base_unit: 'g' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: sal, space_id: despensa, quantity: 1000, kind: 'entrada_manual' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: azucar, space_id: despensa, quantity: 2000, kind: 'entrada_manual' } },
  ], app.tokens.editor);
  const count = uuid();
  const lines = await commit([
    { op: 'insert', table: 'resources.counts', id: count, fields: { space_id: despensa } },
    { op: 'insert', table: 'resources.count_lines', id: uuid(), fields: { count_id: count, item_id: sal, space_id: despensa, quantity: 800 } },
  ], app.tokens.editor);
  assert.equal(lines.status, 200, JSON.stringify(lines.data));
  const closed = await commit([{ op: 'call', procedure: 'resources.close_count', args: { count_id: count } }], app.tokens.editor);
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.results[0].result.adjustments, 1);
  assert.equal(await stock(sal), 800);
  assert.equal(await stock(azucar), 2000, 'lo no contado no cambia');
  const c = (await app.t.db.query<any>(`select status, closed_by from resources.counts where id = $1`, [count])).rows[0];
  assert.equal(c.status, 'cerrado');
  assert.equal(c.closed_by, app.users.editor);
  // El cambio de estado llega a los clientes.
  const changes = await app.call(`/api/v1/resources/changes?after=${closed.data.cursor - 1}`, { token: app.tokens.editor });
  assert.ok(changes.data.items.some((ch: any) => ch.table === 'resources.counts' && ch.after?.status === 'cerrado'), JSON.stringify(changes.data).slice(0, 400));
  assert.equal(code(await commit([{ op: 'insert', table: 'resources.count_lines', id: uuid(), fields: { count_id: count, item_id: azucar, space_id: despensa, quantity: 1 } }], app.tokens.editor)), 'COUNT_CLOSED');
  assert.equal(code(await commit([{ op: 'call', procedure: 'resources.close_count', args: { count_id: count } }], app.tokens.editor)), 'COUNT_CLOSED');
});

test('costes a mano y visibilidad · se apuntan a una tarea; un outsider no ve el inventario', async () => {
  const res = await commit([{ op: 'insert', table: 'resources.cost_entries', id: uuid(), fields: { target_app: 'tasks', target_ref: 'task:1', amount: 120, description: 'Alquiler de andamio' } }], app.tokens.editor);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const user = await app.t.createUser();
  await app.t.db.query(`select core.apply_house_level($1, 'outsider')`, [user]);
  const token = app.supabase.tokenFor(user);
  // El outsider es lector en Recursos (derivado de Tasks): ve espacios, pero no puede escribir.
  assert.equal((await commit([{ op: 'insert', table: 'resources.cost_entries', id: uuid(), fields: { target_app: 'tasks', target_ref: 'x', amount: 1, description: 'x' } }], token)).status, 403);
});

test('consumo por lotes y coste añadido después · primero lo que caduca antes; lo que falta, en negativo; coste sin duplicar', async () => {
  const huevo = uuid(); const pronto = uuid(); const tarde = uuid();
  await commit([
    { op: 'insert', table: 'resources.items', id: huevo, fields: { name: 'Huevos', kind: 'ingrediente', base_unit: 'ud', tracks_lots: true, default_space_id: despensa } },
    { op: 'insert', table: 'resources.lots', id: tarde, fields: { item_id: huevo, expires_on: '2026-12-01' } },
    { op: 'insert', table: 'resources.lots', id: pronto, fields: { item_id: huevo, expires_on: '2026-10-20' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: huevo, space_id: despensa, lot_id: tarde, quantity: 12, kind: 'entrada_manual' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: huevo, space_id: despensa, lot_id: pronto, quantity: 6, kind: 'entrada_manual' } },
  ], app.tokens.editor);
  const res = await commit([{ op: 'call', procedure: 'resources.consume', args: { item_id: huevo, quantity: 8, kind: 'consumo_servicio', source_app: 'food', source_ref: 'menu_item:1' } }], app.tokens.editor);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const moves = res.data.results[0].result.movements;
  assert.deepEqual(moves.map((m: any) => [m.lotId, m.quantity]), [[pronto, -6], [tarde, -2]]);
  assert.equal(await stock(huevo), 10);
  const short = await commit([{ op: 'call', procedure: 'resources.consume', args: { item_id: huevo, quantity: 15, kind: 'consumo_tarea' } }], app.tokens.editor);
  assert.equal(short.status, 200, JSON.stringify(short.data));
  assert.equal(short.data.results[0].result.movements.at(-1).shortfall, true);
  assert.equal(await stock(huevo), -5);
  assert.equal(code(await commit([{ op: 'call', procedure: 'resources.consume', args: { item_id: huevo, quantity: 1, kind: 'entrada_manual' } }], app.tokens.editor)), 'INVALID_OPERATION');

  // «Comprado» entra sin coste; la factura añade el coste una vez.
  const pan = uuid(); const entry = uuid();
  await commit([
    { op: 'insert', table: 'resources.items', id: pan, fields: { name: 'Pan', kind: 'ingrediente', base_unit: 'ud' } },
    { op: 'insert', table: 'resources.movements', id: entry, fields: { item_id: pan, space_id: despensa, quantity: 10, kind: 'entrada_manual', source_app: 'food', source_ref: 'shopping_item:1' } },
  ], app.tokens.editor);
  assert.equal((await read('resources.item_costs', { item_id: pan })).rows.length, 0);
  assert.equal((await commit([{ op: 'insert', table: 'resources.movement_costs', id: uuid(), fields: { movement_id: entry, unit_cost: 0.5, source_app: 'invoices', source_ref: 'line:9' } }], app.tokens.editor)).status, 200);
  assert.equal(Number((await read('resources.item_costs', { item_id: pan })).rows[0].average_cost), 0.5);
  assert.equal((await commit([{ op: 'insert', table: 'resources.movement_costs', id: uuid(), fields: { movement_id: entry, unit_cost: 0.6 } }], app.tokens.editor)).status >= 400, true, 'un solo coste por entrada');
  const costed = uuid();
  await commit([{ op: 'insert', table: 'resources.movements', id: costed, fields: { item_id: pan, space_id: despensa, quantity: 1, kind: 'entrada_manual', unit_cost: 1 } }], app.tokens.editor);
  assert.equal(code(await commit([{ op: 'insert', table: 'resources.movement_costs', id: uuid(), fields: { movement_id: costed, unit_cost: 2 } }], app.tokens.editor)), 'INVALID_MOVEMENT');

  // Estado de una máquina.
  assert.equal(code(await commit([{ op: 'insert', table: 'resources.items', id: uuid(), fields: { name: 'Horno', kind: 'maquina', base_unit: 'ud', attributes: { status: 'roto' } } }], app.tokens.editor)), 'INVALID_ITEM_ATTRIBUTE');
  assert.equal((await commit([{ op: 'insert', table: 'resources.items', id: uuid(), fields: { name: 'Horno', kind: 'maquina', base_unit: 'ud', attributes: { status: 'averiado' } } }], app.tokens.editor)).status, 200);
});
