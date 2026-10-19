/**
 * R4, PR 5 (0238): una línea asignada a una compra ya recibida en Tasks (`entrada_manual`, `source_ref
 * 'purchase_request:<id>'`) solo mete en Recursos lo que no entró ya, y da su coste a la entrada de Tasks si no lo tenía.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';

let app: TestApp;
let counter = 0;
let flour: string; let salt: string; let pantry: string; let cellar: string;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

async function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `entries-tasks-${++counter}`, operations } });
}
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function rows(table: string): Promise<Array<Record<string, any>>> {
  return (await app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows;
}
const line = async (id: string) => (await rows('invoices.invoice_lines')).find((l) => l.id === id)!;
/** Movimientos de una línea en Recursos: [artículo, sitio, cantidad, coste, fecha] en orden. */
async function movements(lineId: string) {
  const r = await app.t.db.query<{ item_id: string; space_id: string; quantity: string; unit_cost: string | null; at: string }>(
    `select item_id, space_id, quantity::text, unit_cost::text, to_char(at at time zone 'UTC', 'YYYY-MM-DD') at from resources.movements
      where source_app = 'invoices' and source_ref = $1 and kind = 'entrada_factura' and deleted_at is null order by created_at, quantity desc`, [`invoice_line:${lineId}`]);
  return r.rows.map((m) => [m.item_id, m.space_id, Number(m.quantity), m.unit_cost === null ? null : Number(m.unit_cost), m.at]);
}
const stock = async (lineId: string) => (await movements(lineId)).reduce((n, m) => n + (m[2] as number), 0);
async function uploadFile(content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'f.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
  app.supabase.storage.set(ticket.data.path, bytes);
  await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
  return { file_id: ticket.data.id as string, mime_type: 'application/pdf', size_bytes: bytes.byteLength, sha256: sha };
}
let supplierId: string;
/** Factura con las líneas dadas (descripción, importe, campos extra) y, si se pide, validada. */
async function invoiceWith(lines: Array<[string, number, Record<string, unknown>?]>, extra: Record<string, unknown> = {}) {
  const id = uuid();
  const net = lines.reduce((n, [, v]) => n + v, 0);
  const file = await uploadFile(`%PDF ${id}`);
  const lineIds = lines.map(() => uuid());
  await ok([
    insert('invoices.invoices', id, { supplier_id: supplierId, invoice_date: '2026-10-05', object: `compra ${id.slice(0, 8)}`, invoice_number: `E-${id.slice(0, 8)}`, expense_category: 'compras', source_total: Math.round(net * 121) / 100, ...extra }),
    ...lines.map(([description, amount, more], i) => insert('invoices.invoice_lines', lineIds[i]!, { invoice_id: id, position: i, description, net_amount: amount, vat_rate: 21, vat_amount: Math.round(amount * 21) / 100, ...(more ?? {}) })),
    insert('invoices.tax_lines', uuid(), { invoice_id: id, position: 0, tax_type: 'iva', rate: 21, taxable_base: net, amount: Math.round(net * 21) / 100 }),
    insert('invoices.invoice_files', uuid(), { invoice_id: id, original_filename: 'f.pdf', ...file }),
  ]);
  return { id, lineIds };
}
const validate = (id: string) => ok([call('invoices.validate', { invoice_id: id })]);
async function setLinks(on: boolean) {
  const current = (await rows('invoices.settings')).find((s) => s.key === 'resources_links');
  await ok([current ? update('invoices.settings', current.id, current.revision, { value: on }) : insert('invoices.settings', uuid(), { key: 'resources_links', value: on })]);
}

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
  const q = (sql: string) => app.t.db.query<{ id: string }>(sql).then((r) => r.rows[0]!.id);
  pantry = await q(`select id from resources.spaces where name = 'Altura 1' and deleted_at is null`);
  cellar = await q(`select id from resources.spaces where name = 'Altura 2' and deleted_at is null`);
  flour = await q(`insert into resources.items (name, kind, base_unit, default_space_id) values ('Harina de trigo', 'ingrediente', 'kg', '${pantry}') returning id`);
  salt = await q(`insert into resources.items (name, kind, base_unit) values ('Sal', 'ingrediente', 'kg') returning id`);
  supplierId = uuid();
  await ok([insert('invoices.suppliers', supplierId, { name: 'Compras Tasks Ejemplo S.L.' })]);
  await setLinks(true);
});
test.after(async () => { await app.close(); });

/** Artículo nuevo por prueba (el stock y el coste medio son solo suyos). */
async function newItem(name: string): Promise<string> {
  return (await app.t.db.query<{ id: string }>(`insert into resources.items (name, kind, base_unit, default_space_id) values ($1, 'material', 'l', $2) returning id`, [name, pantry])).rows[0]!.id;
}
/** Lo que hace Tasks al marcar «Recibida» (0333): su entrada en Recursos. */
async function receiveInTasks(itemId: string, quantity: number, unitCost: number | null = null) {
  const request = uuid();
  const movement = (await app.t.db.query<{ id: string }>(
    `insert into resources.movements (item_id, space_id, quantity, kind, unit_cost, source_app, source_ref, at) values ($1, $2, $3, 'entrada_manual', $4, 'tasks', $5, now()) returning id`,
    [itemId, pantry, quantity, unitCost, `purchase_request:${request}`])).rows[0]!.id;
  return { request, movement };
}
/** Asigna la línea a la solicitud de Tasks (como hace la ficha; aquí directo, sin consultar Tasks). */
async function allocate(lineId: string, request: string, amount: number) {
  await app.t.db.query(`insert into invoices.allocations (invoice_line_id, target_app, target_kind, target_id, target_label, allocated_amount) values ($1, 'tasks', 'purchase_request', $2, 'Compra de Tasks', $3)`, [lineId, request, amount]);
}
const itemStock = async (itemId: string) => Number((await app.t.db.query<{ n: string }>(`select coalesce(sum(quantity), 0)::text n from resources.movements where item_id = $1 and deleted_at is null`, [itemId])).rows[0]!.n);
const averageCost = async (itemId: string) => Number((await app.t.db.query<{ c: string }>(`select average_cost::text c from resources.item_costs where item_id = $1`, [itemId])).rows[0]?.c ?? NaN);
const addedCost = async (movementId: string) => (await app.t.db.query<{ unit_cost: string; source_ref: string }>(`select unit_cost::text, source_ref from resources.movement_costs where movement_id = $1 and deleted_at is null`, [movementId])).rows.map((c) => [Number(c.unit_cost), c.source_ref]);

test('recibida en Tasks y validada después: el stock suma una vez y el coste medio es el de la factura', async () => {
  const bleach = await newItem('Lejía');
  const tasks = await receiveInTasks(bleach, 20);
  const inv = await invoiceWith([['LEJIA 20L', 30, { quantity: 20, unit: 'l', item_id: bleach }]]);
  await allocate(inv.lineIds[0]!, tasks.request, 30);
  await validate(inv.id);
  assert.equal(await stock(inv.lineIds[0]!), 0, 'la factura no mete lo que ya entró');
  assert.equal(await itemStock(bleach), 20);
  assert.deepEqual(await addedCost(tasks.movement), [[1.5, `invoice_line:${inv.lineIds[0]}`]]);
  assert.equal(await averageCost(bleach), 1.5);
  // Repetir el cuadre no cambia nada
  const l = await line(inv.lineIds[0]!);
  await ok([update('invoices.invoice_lines', l.id, l.revision, { label: 'Lejía de la casa' })]);
  assert.equal(await itemStock(bleach), 20);
  assert.equal((await addedCost(tasks.movement)).length, 1);

  // Anular la factura: queda solo lo de Tasks (el coste añadido se queda, como con Food)
  await ok([call('invoices.annul', { invoice_id: inv.id, reason: 'duplicada' })]);
  assert.equal(await stock(inv.lineIds[0]!), 0);
  assert.equal(await itemStock(bleach), 20);
});

test('sin solicitud de Tasks, la línea entra entera', async () => {
  const gloves = await newItem('Guantes de nitrilo');
  await receiveInTasks(gloves, 5); // otra compra, no asignada a esta línea
  const inv = await invoiceWith([['GUANTES NITRILO', 12, { quantity: 6, unit: 'l', item_id: gloves }]]);
  await validate(inv.id);
  assert.equal(await stock(inv.lineIds[0]!), 6);
  assert.equal(await itemStock(gloves), 11);
});

test('factura con más de lo recibido: entra la diferencia; si Tasks ya tenía coste, se respeta', async () => {
  const soap = await newItem('Jabón de manos');
  const tasks = await receiveInTasks(soap, 10, 2.5);
  const inv = await invoiceWith([['JABON MANOS', 45, { quantity: 15, unit: 'l', item_id: soap }]]);
  await allocate(inv.lineIds[0]!, tasks.request, 45);
  await validate(inv.id);
  assert.deepEqual((await movements(inv.lineIds[0]!)).map((m) => [m[2], m[3]]), [[5, 3]]);
  assert.equal(await itemStock(soap), 15);
  assert.deepEqual(await addedCost(tasks.movement), [], 'Tasks ya tenía coste: no se añade otro');
  assert.equal(await averageCost(soap), Math.round(((10 * 2.5 + 5 * 3) / 15) * 1e6) / 1e6);
  // Anular: vuelve a quedar solo lo de Tasks
  await ok([call('invoices.annul', { invoice_id: inv.id, reason: 'error' })]);
  assert.equal(await itemStock(soap), 10);
});

test('una compra de Tasks repartida en dos facturas: lo recibido se descuenta una sola vez, por orden', async () => {
  const paper = await newItem('Papel de cocina');
  const tasks = await receiveInTasks(paper, 8);
  const first = await invoiceWith([['PAPEL COCINA', 10, { quantity: 5, unit: 'l', item_id: paper }]]);
  const second = await invoiceWith([['PAPEL COCINA', 10, { quantity: 5, unit: 'l', item_id: paper }]], { invoice_date: '2026-10-06' });
  await allocate(first.lineIds[0]!, tasks.request, 10);
  await allocate(second.lineIds[0]!, tasks.request, 10);
  await validate(first.id);
  await validate(second.id);
  assert.equal(await stock(first.lineIds[0]!), 0);
  assert.equal(await stock(second.lineIds[0]!), 2);
  assert.equal(await itemStock(paper), 10);
  assert.deepEqual(await addedCost(tasks.movement), [[2, `invoice_line:${first.lineIds[0]}`]]);
});

test('orden inverso (0239): Tasks lee el cuadre de sus solicitudes y solo ve las líneas asignadas a ellas', async () => {
  const mop = await newItem('Fregona');
  const request = uuid();
  // Validada antes de recibir: la línea entra entera
  const inv = await invoiceWith([['FREGONA', 8, { quantity: 4, unit: 'l', item_id: mop }], ['HARINA SACO 25KG', 40, { quantity: 2, unit: 'saco', item_id: flour, item_factor: 25 }]]);
  await allocate(inv.lineIds[0]!, request, 8);
  await validate(inv.id);
  assert.equal(await itemStock(mop), 4);
  // Tasks recibe después (su entrada) y pide el cuadre de esa solicitud
  await app.t.db.query(`insert into resources.movements (item_id, space_id, quantity, kind, source_app, source_ref, at) values ($1, $2, 4, 'entrada_manual', 'tasks', $3, now())`, [mop, pantry, `purchase_request:${request}`]);
  const read = async (requests: string[]) => (await app.t.db.query<{ r: any }>(`select invoices.tasks_resource_entries(jsonb_build_object('app', 'tasks', 'args', jsonb_build_object('request_ids', $1::jsonb))) r`, [JSON.stringify(requests)])).rows[0]!.r;
  const out = await read([request]);
  const ref = `invoice_line:${inv.lineIds[0]}`;
  assert.deepEqual(out.entries.map((e: any) => [e.source_ref, Number(e.quantity)]), [[ref, 0]], 'solo la línea asignada, ya a 0');
  assert.deepEqual(out.refs, [ref]);
  assert.equal(out.costs.length, 1);
  assert.equal(out.costs[0].source_ref, ref);
  assert.ok(!JSON.stringify(out).includes(inv.lineIds[1]!), 'nada de la otra línea de la factura');
  // Cuadrar con eso (lo que hará Tasks en un lote de Recursos) deja el stock en lo recibido
  await app.t.db.query(`select set_config('resources.reconciling', '1', false)`);
  await app.t.db.query(`insert into resources.movements (item_id, space_id, quantity, kind, unit_cost, source_app, source_ref, at) values ($1, $2, -4, 'entrada_factura', 2, 'invoices', $3, now())`, [mop, pantry, ref]);
  await app.t.db.query(`select set_config('resources.reconciling', '', false)`);
  assert.equal(await itemStock(mop), 4);
  // Sin solicitudes conocidas o con ids que no son uuid: vacío
  assert.deepEqual((await read([uuid()])).entries, []);
  assert.deepEqual((await read(['no-es-un-id'])).entries, []);
  // Registrada como lectura de Tasks (editor y owner)
  const reg = await app.t.db.query<{ roles: string[] }>(`select roles from core.allowed_reads where app = 'tasks' and name = 'invoices.tasks_resource_entries'`);
  assert.deepEqual(reg.rows[0]?.roles, ['editor', 'owner']);
});

