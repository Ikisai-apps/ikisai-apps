/**
 * R4, PR 2 (0235): las líneas enlazadas generan su `entrada_factura` en Recursos al validar, y el contrario al volver a
 * revisión, al anular o con una rectificativa (`resources.reconcile_entries`, 0804). Con el interruptor apagado, nada.
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
  return app.call('/api/v1/commands', { body: { requestId: `entries-${++counter}`, operations } });
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
  await ok([insert('invoices.suppliers', supplierId, { name: 'Entradas Ejemplo S.L.' })]);
});
test.after(async () => { await app.close(); });

test('con el interruptor apagado, validar no toca Recursos', async () => {
  const inv = await invoiceWith([['HARINA SACO 25KG', 40, { quantity: 2, unit: 'saco', item_id: flour, item_factor: 25 }]]);
  await validate(inv.id);
  assert.deepEqual(await movements(inv.lineIds[0]!), []);
});

test('validar crea la entrada (cantidad en la base, coste, sitio habitual y fecha de la factura); volver a revisión y anular la devuelven', async () => {
  await setLinks(true);
  const inv = await invoiceWith([['HARINA SACO 25KG', 40, { quantity: 2, unit: 'saco', item_id: flour, item_factor: 25 }], ['PORTES', 5]]);
  await validate(inv.id);
  assert.deepEqual(await movements(inv.lineIds[0]!), [[flour, pantry, 50, 0.8, '2026-10-05']]);
  assert.deepEqual(await movements(inv.lineIds[1]!), []);

  // Cambiar la cantidad la devuelve a revisión: sale el contrario
  let l = await line(inv.lineIds[0]!);
  await ok([update('invoices.invoice_lines', l.id, l.revision, { quantity: 3, net_amount: 60, vat_amount: 12.6 })]);
  const t = (await rows('invoices.tax_lines')).find((x) => x.invoice_id === inv.id)!;
  await ok([update('invoices.tax_lines', t.id, t.revision, { taxable_base: 65, amount: 13.65 }),
    update('invoices.invoices', inv.id, (await rows('invoices.invoices')).find((i) => i.id === inv.id)!.revision, { source_total: 78.65 })]);
  assert.equal((await rows('invoices.invoices')).find((i) => i.id === inv.id)!.status, 'pendiente_revision');
  assert.equal(await stock(l.id), 0);
  // Validar de nuevo: entra la cantidad nueva
  await validate(inv.id);
  assert.equal(await stock(l.id), 75);
  // Repetir el cuadre no crea nada (idempotente)
  const before = (await movements(l.id)).length;
  l = await line(l.id);
  await ok([update('invoices.invoice_lines', l.id, l.revision, { label: 'Harina de la casa' })]);
  assert.equal((await movements(l.id)).length, before);

  await ok([call('invoices.annul', { invoice_id: inv.id, reason: 'duplicada' })]);
  assert.equal(await stock(l.id), 0);
});

test('cambiar el artículo de una validada mueve la entrada, sin devolverla a revisión', async () => {
  const inv = await invoiceWith([['SAL 1KG', 10, { quantity: 10, unit: 'kg', item_id: flour, space_id: cellar }]]);
  await validate(inv.id);
  assert.deepEqual(await movements(inv.lineIds[0]!), [[flour, cellar, 10, 1, '2026-10-05']]);
  const l = await line(inv.lineIds[0]!);
  await ok([update('invoices.invoice_lines', l.id, l.revision, { item_id: salt })]);
  assert.equal((await rows('invoices.invoices')).find((i) => i.id === inv.id)!.status, 'validada');
  const now = await movements(l.id);
  assert.equal(now.filter((m) => m[0] === flour).reduce((n, m) => n + (m[2] as number), 0), 0, 'la harina vuelve a 0');
  assert.deepEqual(now.filter((m) => m[0] === salt), [[salt, cellar, 10, 1, '2026-10-05']]);
});

test('sin sitio (ni en la línea ni habitual) o sin cantidad, no entra ni bloquea la validación', async () => {
  const inv = await invoiceWith([['SAL GORDA', 5, { item_id: salt, quantity: 5 }], ['HARINA SIN CANTIDAD', 8, { item_id: flour }]]);
  await validate(inv.id);
  assert.equal((await rows('invoices.invoices')).find((i) => i.id === inv.id)!.status, 'validada');
  assert.deepEqual(await movements(inv.lineIds[0]!), []);
  assert.deepEqual(await movements(inv.lineIds[1]!), []);
  const read = await app.t.db.query<{ r: any }>(`select invoices.resource_entries(jsonb_build_object('args', jsonb_build_object('invoice_ids', jsonb_build_array($1::text)))) r`, [inv.id]);
  assert.deepEqual(read.rows[0]!.r.skipped, [{ line_id: inv.lineIds[0], reason: 'sin_sitio' }, { line_id: inv.lineIds[1], reason: 'sin_cantidad' }].sort((a, b) => String(a.line_id).localeCompare(String(b.line_id))));
});

test('una rectificativa validada rebaja la entrada de la línea original', async () => {
  const original = await invoiceWith([['HARINA SACO 25KG', 40, { quantity: 2, unit: 'saco', item_id: flour, item_factor: 25 }]]);
  await validate(original.id);
  assert.equal(await stock(original.lineIds[0]!), 50);
  const rect = await invoiceWith([['HARINA SACO 25KG', -20, { quantity: -1, unit: 'saco', rectifies_line_id: original.lineIds[0] }]],
    { invoice_kind: 'rectificativa', rectifies_invoice_id: original.id });
  await validate(rect.id);
  assert.equal(await stock(original.lineIds[0]!), 25);
  assert.deepEqual(await movements(rect.lineIds[0]!), [], 'la línea de la rectificativa no tiene entrada propia');
});

test('«Ya entró desde la compra de Food»: la línea no crea entrada y su coste va a la entrada de Food, una sola vez', async () => {
  const food = (await app.t.db.query<{ id: string }>(
    `insert into resources.movements (item_id, space_id, quantity, kind, source_app, source_ref, at) values ($1, $2, 25, 'entrada_manual', 'food', 'shopping_item:demo', now()) returning id`, [flour, pantry])).rows[0]!.id;
  // Otra entrada manual que no es de Food no vale
  const other = (await app.t.db.query<{ id: string }>(
    `insert into resources.movements (item_id, space_id, quantity, kind, at) values ($1, $2, 5, 'entrada_manual', now()) returning id`, [flour, pantry])).rows[0]!.id;
  const inv = await invoiceWith([['HARINA SACO 25KG', 20, { quantity: 1, unit: 'saco', item_id: flour, item_factor: 25 }]]);
  const l = await line(inv.lineIds[0]!);
  const bad = await commit([update('invoices.invoice_lines', l.id, l.revision, { entered_movement_id: other })]);
  assert.equal(bad.data.error.code, 'INVALID_RESOURCE_LINK');
  await ok([update('invoices.invoice_lines', l.id, l.revision, { entered_movement_id: food })]);
  await validate(inv.id);
  assert.deepEqual(await movements(inv.lineIds[0]!), [], 'no cuenta dos veces');
  const costs = async () => (await app.t.db.query<{ unit_cost: string; source_ref: string }>(`select unit_cost::text, source_ref from resources.movement_costs where movement_id = $1 and deleted_at is null`, [food])).rows;
  assert.deepEqual((await costs()).map((c) => [Number(c.unit_cost), c.source_ref]), [[0.8, `invoice_line:${l.id}`]]);
  // Otro commit de la misma factura no lo repite
  const again = await line(l.id);
  await ok([update('invoices.invoice_lines', again.id, again.revision, { label: 'Harina de la casa' })]);
  assert.equal((await costs()).length, 1);
});
