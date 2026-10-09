/**
 * «Mi nombre» de los artículos con memoria por proveedor (0230): al validar se recuerda; en la siguiente factura del mismo
 * proveedor, la línea igual recibe el nombre sola («recordado»). La descripción de la factura no se toca.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';

let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

async function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `labels-${++counter}`, operations } });
}
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function rows(table: string): Promise<Array<Record<string, any>>> {
  return (await app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows;
}
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
/** Factura lista para validar con las líneas dadas (`[descripción, importe, nombre propio?]`). */
async function invoiceWith(supplierId: string, lines: Array<[string, number, string?]>) {
  const id = uuid();
  const net = lines.reduce((n, [, v]) => n + v, 0);
  const file = await uploadFile(`%PDF ${id}`);
  const lineIds = lines.map(() => uuid());
  await ok([
    insert('invoices.invoices', id, { supplier_id: supplierId, invoice_date: '2026-10-05', object: `compra ${id.slice(0, 8)}`, invoice_number: `L-${id.slice(0, 8)}`, expense_category: 'compras', source_total: Math.round(net * 121) / 100 }),
    ...lines.map(([description, amount, label], i) => insert('invoices.invoice_lines', lineIds[i]!, { invoice_id: id, position: i, description, net_amount: amount, vat_rate: 21, vat_amount: Math.round(amount * 21) / 100, ...(label ? { label } : {}) })),
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
});
test.after(async () => { await app.close(); });

test('al validar se recuerda «Mi nombre» por proveedor y artículo; la siguiente factura lo recibe sola, sin tocar la descripción', async () => {
  const makro = await supplier('Makro Etiquetas S.A.');
  const otro = await supplier('Otro Proveedor S.L.');
  const first = await invoiceWith(makro, [['12345 TOMATE PERA 1KG', 10, 'Tomates'], ['Aceite de oliva virgen extra', 20, 'Aceite'], ['Bolsas', 1]]);
  let lines = (await rows('invoices.invoice_lines')).filter((l) => l.invoice_id === first.id).sort((a, b) => a.position - b.position);
  assert.deepEqual(lines.map((l) => [l.label, l.label_source]), [['Tomates', 'manual'], ['Aceite', 'manual'], [null, null]]);
  await ok([call('invoices.validate', { invoice_id: first.id })]);
  const memory = (await rows('invoices.item_labels')).filter((m) => m.supplier_id === makro);
  assert.deepEqual(memory.map((m) => [m.match_key, m.label, m.uses]).sort(), [['cod:12345', 'Tomates', 1], ['txt:aceite de oliva virgen extra', 'Aceite', 1]]);

  // Misma línea (con otra cantidad en el texto y otra grafía): recibe el nombre sola; la descripción queda como en la factura
  const second = await invoiceWith(makro, [['12345 Tomate pera 2KG', 12], ['ACEITE DE OLIVA, VIRGEN EXTRA', 22], ['Algo nuevo', 3]]);
  lines = (await rows('invoices.invoice_lines')).filter((l) => l.invoice_id === second.id).sort((a, b) => a.position - b.position);
  assert.deepEqual(lines.map((l) => [l.description, l.label, l.label_source]), [
    ['12345 Tomate pera 2KG', 'Tomates', 'recordado'], ['ACEITE DE OLIVA, VIRGEN EXTRA', 'Aceite', 'recordado'], ['Algo nuevo', null, null]]);
  // Otro proveedor con el mismo artículo: nada
  const third = await invoiceWith(otro, [['12345 TOMATE PERA 1KG', 10]]);
  assert.equal((await rows('invoices.invoice_lines')).find((l) => l.invoice_id === third.id)!.label, null);

  // Cambiar el nombre a mano: «manual»; al validar, la memoria se actualiza
  const tomato = lines[0]!;
  await ok([update('invoices.invoice_lines', tomato.id, tomato.revision, { label: 'Tomate pera' })]);
  assert.equal((await rows('invoices.invoice_lines')).find((l) => l.id === tomato.id)!.label_source, 'manual');
  await ok([call('invoices.validate', { invoice_id: second.id })]);
  const updated = (await rows('invoices.item_labels')).find((m) => m.supplier_id === makro && m.match_key === 'cod:12345')!;
  assert.deepEqual([updated.label, updated.uses, updated.last_invoice_id], ['Tomate pera', 2, second.id]);
});

test('la memoria la escribe el servidor: el cliente no la crea, pero sí corrige el nombre o la borra', async () => {
  const s = await supplier('Memoria Cliente S.L.');
  const res = await commit([insert('invoices.item_labels', uuid(), { supplier_id: s, match_key: 'txt:algo', label: 'Algo' })]);
  assert.equal(res.status, 422, JSON.stringify(res.data));
  const inv = await invoiceWith(s, [['Café en grano 1kg', 15, 'Café']]);
  await ok([call('invoices.validate', { invoice_id: inv.id })]);
  const m = (await rows('invoices.item_labels')).find((r) => r.supplier_id === s)!;
  await ok([update('invoices.item_labels', m.id, m.revision, { label: 'Café de la casa' })]);
  assert.equal((await rows('invoices.item_labels')).find((r) => r.id === m.id)!.label, 'Café de la casa');
  const bad = await commit([update('invoices.item_labels', m.id, m.revision + 1, { uses: 9 })]);
  assert.equal(bad.status, 422, JSON.stringify(bad.data));
  // Un nombre de más de 120 caracteres no vale
  const long = await commit([update('invoices.invoice_lines', (await rows('invoices.invoice_lines')).find((l) => l.invoice_id === inv.id)!.id, 1, { label: 'x'.repeat(121) })]);
  assert.equal(long.status, 422);
});

test('renombrar una línea de una factura validada no la devuelve a revisión; cambiar otra cosa de la línea, sí', async () => {
  const s = await supplier('Validada Nombres S.L.');
  const inv = await invoiceWith(s, [['Harina de trigo 25kg', 30]]);
  await ok([call('invoices.validate', { invoice_id: inv.id })]);
  let line = (await rows('invoices.invoice_lines')).find((l) => l.invoice_id === inv.id)!;
  await ok([update('invoices.invoice_lines', line.id, line.revision, { label: 'Harina' })]);
  assert.equal((await rows('invoices.invoices')).find((i) => i.id === inv.id)!.status, 'validada');
  line = (await rows('invoices.invoice_lines')).find((l) => l.id === line.id)!;
  assert.deepEqual([line.label, line.label_source, line.description], ['Harina', 'manual', 'Harina de trigo 25kg']);
  await ok([update('invoices.invoice_lines', line.id, line.revision, { notes: 'otra cosa' })]);
  const after = (await rows('invoices.invoices')).find((i) => i.id === inv.id)!;
  assert.deepEqual([after.status, after.review_reason], ['pendiente_revision', 'EDITADA_TRAS_VALIDAR']);
});

test('FB_2026_024 · «Se deja en su trimestre»: ya pasada a la gestoría, no entra en la entrega ni la desactualiza; se deshace', async () => {
  const s = await supplier('Gestoría Ya Pasada S.L.');
  const normal = await invoiceWith(s, [['Servicio abril', 50]]);
  const passed = await invoiceWith(s, [['Servicio mayo', 70]]);
  for (const inv of [normal, passed]) {
    const row = (await rows('invoices.invoices')).find((i) => i.id === inv.id)!;
    await ok([update('invoices.invoices', inv.id, row.revision, { invoice_date: '2026-05-10' })]);
  }
  let row = (await rows('invoices.invoices')).find((i) => i.id === passed.id)!;
  await ok([update('invoices.invoices', passed.id, row.revision, { declared_period: '2026T2', delivered_elsewhere: true })]);
  await ok([call('invoices.validate', { invoice_id: normal.id }), call('invoices.validate', { invoice_id: passed.id })]);
  row = (await rows('invoices.invoices')).find((i) => i.id === passed.id)!;
  assert.deepEqual([row.status, row.declared_period, row.delivered_elsewhere], ['validada', '2026T2', true]);
  const exportId = uuid();
  await ok([call('invoices.create_export', { export_id: exportId, period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 2 })]);
  const bundle = async () => (await app.call('/api/v1/read/invoices.export_bundle', { body: { export_id: exportId } })).data;
  let b = await bundle();
  const codes = (b.manifest.invoices as Array<{ id: string }>).map((i) => i.id);
  assert.ok(codes.includes(normal.id));
  assert.equal(codes.includes(passed.id), false, 'la ya pasada a la gestoría no entra');
  assert.equal(b.stale, false);
  // Deshacer: vuelve a contar y la entrega queda desactualizada
  row = (await rows('invoices.invoices')).find((i) => i.id === passed.id)!;
  await ok([update('invoices.invoices', passed.id, row.revision, { declared_period: null, delivered_elsewhere: false })]);
  b = await bundle();
  assert.equal(b.stale, true);
});
