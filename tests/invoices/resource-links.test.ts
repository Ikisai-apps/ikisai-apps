/**
 * R4, PR 1 (0234): las líneas se enlazan con artículos de Recursos. El enlace se recuerda por proveedor y artículo como
 * «Mi nombre», cambiarlo no devuelve una validada a revisión, el artículo y el sitio tienen que existir, y el interruptor
 * `resources_links` empieza apagado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';

let app: TestApp;
let counter = 0;
let flour: string; let tomato: string; let pantry: string;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

async function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `links-${++counter}`, operations } });
}
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function rows(table: string): Promise<Array<Record<string, any>>> {
  return (await app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows;
}
const line = async (id: string) => (await rows('invoices.invoice_lines')).find((l) => l.id === id)!;
async function uploadFile(content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'f.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
  app.supabase.storage.set(ticket.data.path, bytes);
  await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
  return { file_id: ticket.data.id as string, mime_type: 'application/pdf', size_bytes: bytes.byteLength, sha256: sha };
}
async function supplier(name: string) {
  const id = uuid();
  await ok([insert('invoices.suppliers', id, { name })]);
  return id;
}
/** Factura lista para validar; cada línea: descripción, importe y campos extra. */
async function invoiceWith(supplierId: string, lines: Array<[string, number, Record<string, unknown>?]>) {
  const id = uuid();
  const net = lines.reduce((n, [, v]) => n + v, 0);
  const file = await uploadFile(`%PDF ${id}`);
  const lineIds = lines.map(() => uuid());
  await ok([
    insert('invoices.invoices', id, { supplier_id: supplierId, invoice_date: '2026-10-05', object: `compra ${id.slice(0, 8)}`, invoice_number: `R-${id.slice(0, 8)}`, expense_category: 'compras', source_total: Math.round(net * 121) / 100 }),
    ...lines.map(([description, amount, extra], i) => insert('invoices.invoice_lines', lineIds[i]!, { invoice_id: id, position: i, description, net_amount: amount, vat_rate: 21, vat_amount: Math.round(amount * 21) / 100, ...(extra ?? {}) })),
    insert('invoices.tax_lines', uuid(), { invoice_id: id, position: 0, tax_type: 'iva', rate: 21, taxable_base: net, amount: Math.round(net * 21) / 100 }),
    insert('invoices.invoice_files', uuid(), { invoice_id: id, original_filename: 'f.pdf', ...file }),
  ]);
  return { id, lineIds };
}

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
  // Artículos y sitio de Recursos (los escribe su módulo; aquí, directo en la base de la prueba)
  const q = (sql: string) => app.t.db.query<{ id: string }>(sql).then((r) => r.rows[0]!.id);
  flour = await q(`insert into resources.items (name, kind, base_unit) values ('Harina de trigo', 'ingrediente', 'kg') returning id`);
  tomato = await q(`insert into resources.items (name, kind, base_unit) values ('Tomate pera', 'ingrediente', 'kg') returning id`);
  pantry = await q(`select id from resources.spaces where name = 'Altura 1' and deleted_at is null`);
});
test.after(async () => { await app.close(); });

test('enlace manual, recordado en la siguiente factura del proveedor y sin pisar lo que trae la línea', async () => {
  const s = await supplier('Harinas Enlace S.L.');
  const first = await invoiceWith(s, [['HT25 HARINA TRIGO SACO 25KG', 20, { quantity: 1, unit: 'saco', item_id: flour, item_factor: 25, space_id: pantry }], ['Portes', 5]]);
  const l0 = await line(first.lineIds[0]!);
  assert.deepEqual([l0.item_id, Number(l0.item_factor), l0.space_id, l0.item_source, l0.label], [flour, 25, pantry, 'manual', null]);
  assert.equal((await line(first.lineIds[1]!)).item_source, null);

  await ok([call('invoices.validate', { invoice_id: first.id })]);
  const memory = (await rows('invoices.item_labels')).filter((m) => m.supplier_id === s);
  assert.deepEqual(memory.map((m) => [m.match_key, m.label, m.item_id, Number(m.item_factor)]), [['cod:ht25', null, flour, 25]]);

  // Siguiente factura: la misma línea recibe el artículo y el factor («recordado»); el sitio no se recuerda (vale el habitual)
  const second = await invoiceWith(s, [['HT25 Harina trigo saco 25kg', 40, { quantity: 2, unit: 'saco' }], ['HT25 HARINA TRIGO SACO 25KG', 20, { item_id: tomato }]]);
  const [a, b] = [await line(second.lineIds[0]!), await line(second.lineIds[1]!)];
  assert.deepEqual([a.item_id, Number(a.item_factor), a.space_id, a.item_source], [flour, 25, null, 'recordado']);
  // Lo que trae la línea manda
  assert.deepEqual([b.item_id, b.item_factor, b.item_source], [tomato, null, 'manual']);

  // «Mi nombre» y artículo conviven en la memoria: validar sin artículo no borra el recordado
  const third = await invoiceWith(s, [['HT25 HARINA TRIGO SACO 25KG', 20, { label: 'Harina de la casa' }]]);
  const l3 = await line(third.lineIds[0]!);
  assert.equal(l3.item_id, flour, 'sin artículo, recibe el recordado');
  await ok([update('invoices.invoice_lines', l3.id, l3.revision, { item_id: null, item_factor: null })]);
  assert.equal((await line(l3.id)).item_source, null);
  await ok([call('invoices.validate', { invoice_id: third.id })]);
  const m = (await rows('invoices.item_labels')).find((r) => r.supplier_id === s)!;
  assert.deepEqual([m.label, m.item_id, Number(m.item_factor), m.uses], ['Harina de la casa', flour, 25, 2]);
});

test('cambiar solo el enlace no devuelve una validada a revisión; cambiar el importe sí', async () => {
  const s = await supplier('Tomates Enlace S.L.');
  const inv = await invoiceWith(s, [['TOMATE PERA CAJA 5KG', 10, { quantity: 2, unit: 'caja' }]]);
  await ok([call('invoices.validate', { invoice_id: inv.id })]);
  let l = await line(inv.lineIds[0]!);
  await ok([update('invoices.invoice_lines', l.id, l.revision, { item_id: tomato, item_factor: 5, space_id: pantry })]);
  const status = async () => (await rows('invoices.invoices')).find((i) => i.id === inv.id)!.status;
  assert.equal(await status(), 'validada');
  l = await line(l.id);
  assert.deepEqual([l.item_id, l.item_source], [tomato, 'manual']);
  await ok([update('invoices.invoice_lines', l.id, l.revision, { space_id: null })]);
  assert.equal(await status(), 'validada');
  l = await line(l.id);
  await ok([update('invoices.invoice_lines', l.id, l.revision, { quantity: 3 })]);
  assert.equal(await status(), 'pendiente_revision');
});

test('el artículo y el sitio tienen que existir; el factor, positivo', async () => {
  const s = await supplier('Errores Enlace S.L.');
  const inv = await invoiceWith(s, [['Algo', 10]]);
  const l = await line(inv.lineIds[0]!);
  const missing = await commit([update('invoices.invoice_lines', l.id, l.revision, { item_id: uuid() })]);
  assert.equal(missing.status, 422);
  assert.equal(missing.data.error.code, 'INVALID_RESOURCE_LINK');
  const noSpace = await commit([update('invoices.invoice_lines', l.id, l.revision, { space_id: uuid() })]);
  assert.equal(noSpace.data.error.code, 'INVALID_RESOURCE_LINK');
  const zero = await commit([update('invoices.invoice_lines', l.id, l.revision, { item_id: flour, item_factor: 0 })]);
  assert.equal(zero.status, 422);
  assert.equal(zero.data.error.code, 'INVALID_FIELDS');
  // Un artículo borrado en Recursos ya no se puede enlazar
  const gone = (await app.t.db.query<{ id: string }>(`insert into resources.items (name, kind, base_unit, deleted_at) values ('Borrado', 'otro', 'ud', now()) returning id`)).rows[0]!.id;
  assert.equal((await commit([update('invoices.invoice_lines', l.id, l.revision, { item_id: gone })])).data.error.code, 'INVALID_RESOURCE_LINK');
});

test('interruptor resources_links: apagado sin fila y solo vale sí o no (lo escribe el owner)', async () => {
  const on = async () => (await app.t.db.query<{ v: boolean }>('select invoices.resources_links() v')).rows[0]!.v;
  assert.equal(await on(), false);
  const bad = await commit([insert('invoices.settings', uuid(), { key: 'resources_links', value: 'si' })]);
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error.code, 'INVALID_SETTING');
  assert.equal((await commit([insert('invoices.settings', uuid(), { key: 'otra', value: true })])).data.error.code, 'INVALID_SETTING');
  const id = uuid();
  await ok([insert('invoices.settings', id, { key: 'resources_links', value: true })]);
  assert.equal(await on(), true);
  const row = (await rows('invoices.settings')).find((r) => r.id === id)!;
  await ok([update('invoices.settings', id, row.revision, { value: false })]);
  assert.equal(await on(), false);
});
