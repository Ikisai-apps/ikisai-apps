/**
 * R4, PR 4 (0236): vista previa del enlace de lo ya validado y de la memoria con artículos de Recursos, aplicarla con el
 * mismo `digest`, y las retroactivas al encender el interruptor (con la fecha de cada factura).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';

let app: TestApp;
let counter = 0;
let supplierId: string; let salt: string; let pantry: string;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `preview-${++counter}`, operations } });
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
/** Factura con líneas (descripción, importe, campos extra); validada salvo que se pida lo contrario. */
async function invoiceWith(lines: Array<[string, number, Record<string, unknown>?]>, { validate = true, date = '2026-09-10' } = {}) {
  const id = uuid();
  const net = lines.reduce((n, [, v]) => n + v, 0);
  const file = await uploadFile(`%PDF ${id}`);
  const lineIds = lines.map(() => uuid());
  await ok([
    insert('invoices.invoices', id, { supplier_id: supplierId, invoice_date: date, object: `compra ${id.slice(0, 8)}`, invoice_number: `P-${id.slice(0, 8)}`, expense_category: 'compras', source_total: Math.round(net * 121) / 100 }),
    ...lines.map(([description, amount, more], i) => insert('invoices.invoice_lines', lineIds[i]!, { invoice_id: id, position: i, description, net_amount: amount, vat_rate: 21, vat_amount: Math.round(amount * 21) / 100, ...(more ?? {}) })),
    insert('invoices.tax_lines', uuid(), { invoice_id: id, position: 0, tax_type: 'iva', rate: 21, taxable_base: net, amount: Math.round(net * 21) / 100 }),
    insert('invoices.invoice_files', uuid(), { invoice_id: id, original_filename: 'f.pdf', ...file }),
  ]);
  if (validate) await ok([call('invoices.validate', { invoice_id: id })]);
  return { id, lineIds };
}
const preview = async () => {
  const res = await app.call('/api/v1/resource-links/preview');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data as { rows: Array<Record<string, any>>; counts: Record<string, number>; digest: string };
};
const byId = (p: { rows: Array<Record<string, any>> }, id: string) => p.rows.find((r) => r.id === id);

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
  const q = (sql: string) => app.t.db.query<{ id: string }>(sql).then((r) => r.rows[0]!.id);
  pantry = await q(`select id from resources.spaces where name = 'Altura 1' and deleted_at is null`);
  salt = await q(`insert into resources.items (name, kind, base_unit) values ('Sal', 'ingrediente', 'kg') returning id`);
  supplierId = uuid();
  await ok([insert('invoices.suppliers', supplierId, { name: 'Vista Previa S.L.' })]);
});
test.after(async () => { await app.close(); });

test('vista previa, aplicar con el mismo digest y retroactivas al encender el interruptor', async () => {
  const a = await invoiceWith([
    ['HARINA 1KG', 4, { quantity: 2, unit: 'kg', item_type: 'food_ingredient' }],
    ['Base al 21 % según documento', 10],
    ['PORTES', 5, { item_type: 'service' }],
    ['Tornillos', 3, { quantity: 10, unit: 'ud' }],
    ['LECHE', 6, { quantity: 6, unit: 'brick', item_type: 'food_ingredient' }],
    ['SAL', 2, { quantity: 1, unit: 'kg', item_type: 'food_ingredient' }],
    ['SAL LIQUIDA', 2, { quantity: 1, unit: 'l', item_type: 'food_ingredient', label: 'Sal' }],
  ], { date: '2026-09-10' });
  const b = await invoiceWith([['Harina 1kg', 6, { quantity: 3000, unit: 'g', item_type: 'food_ingredient' }]], { date: '2026-09-20' });
  const pending = await invoiceWith([['HARINA 1KG', 4, { quantity: 2, unit: 'kg', item_type: 'food_ingredient' }]], { validate: false });
  // La memoria (la escribe el servidor al validar; aquí, directa): hereda el tipo y la unidad de las líneas del mismo nombre
  const memoryId = (await app.t.db.query<{ id: string }>(`insert into invoices.item_labels (supplier_id, match_key, label) values ($1, 'txt:harina granel', 'Harina 1KG') returning id`, [supplierId])).rows[0]!.id;

  const p = await preview();
  const act = (id: string) => [byId(p, id)?.action, byId(p, id)?.reason ?? null];
  assert.deepEqual(act(a.lineIds[0]!), ['crear', null]);
  assert.deepEqual([byId(p, a.lineIds[0]!)!.kind, byId(p, a.lineIds[0]!)!.base_unit, byId(p, a.lineIds[0]!)!.item_factor], ['ingrediente', 'kg', 1]);
  assert.deepEqual(act(a.lineIds[1]!), ['omitir', 'generica']);
  assert.deepEqual(act(a.lineIds[2]!), ['omitir', 'servicio']);
  assert.deepEqual(act(a.lineIds[3]!), ['dudoso', 'sin_tipo']);
  assert.deepEqual(act(a.lineIds[4]!), ['dudoso', 'unidad']);
  assert.deepEqual(act(a.lineIds[5]!), ['enlazar', null]);
  assert.equal(byId(p, a.lineIds[5]!)!.item_id, salt);
  assert.deepEqual(act(a.lineIds[6]!), ['dudoso', 'unidad_distinta'], 'la «Sal» existente está en kg y la línea en litros');
  assert.deepEqual(act(b.lineIds[0]!), ['crear', null]);
  assert.equal(Number(byId(p, b.lineIds[0]!)!.item_factor), 0.001, 'gramos a kg');
  assert.equal(byId(p, pending.lineIds[0]!), undefined, 'lo pendiente de revisión no entra');
  assert.deepEqual(act(memoryId), ['crear', null]);
  // La memoria tiene también «Sal», aprendida al validar la línea con ese «Mi nombre»: se enlaza con la existente
  assert.deepEqual(p.counts, { lines: 8, memory: 2, enlazar: 2, crear: 3, dudoso: 3, omitir: 2, new_items: 1 });

  // Con otro digest no se aplica
  const stale = await app.call('/api/v1/resource-links/apply', { body: { digest: 'otro', space_id: pantry } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'PREVIEW_CHANGED');

  const applied = await app.call('/api/v1/resource-links/apply', { body: { digest: p.digest, space_id: pantry } });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(applied.data, { created: 1, linked: 3, memory: 2 });
  const items = (await app.t.db.query<{ id: string; name: string; kind: string; base_unit: string; default_space_id: string; source_refs: string[] }>(
    `select id, name, kind, base_unit, default_space_id, source_refs from resources.items where name ilike 'harina%' and deleted_at is null`)).rows;
  assert.equal(items.length, 1, 'un solo artículo para «HARINA 1KG» y «Harina 1kg»');
  assert.deepEqual([items[0]!.kind, items[0]!.base_unit, items[0]!.default_space_id, items[0]!.source_refs.length], ['ingrediente', 'kg', pantry, 2]);
  const lines = await rows('invoices.invoice_lines');
  const line = (id: string) => lines.find((l) => l.id === id)!;
  assert.deepEqual([line(a.lineIds[0]!).item_id, line(b.lineIds[0]!).item_id, line(a.lineIds[5]!).item_id], [items[0]!.id, items[0]!.id, salt]);
  assert.equal(line(a.lineIds[3]!).item_id, null, 'lo dudoso no se toca');
  assert.equal(line(pending.lineIds[0]!).item_id, null);
  assert.equal((await rows('invoices.item_labels')).find((m) => m.id === memoryId)!.item_id, items[0]!.id);
  // Siguen validadas
  assert.ok((await rows('invoices.invoices')).filter((i) => i.id === a.id || i.id === b.id).every((i) => i.status === 'validada'));

  // Con el interruptor apagado no hay entradas; al encenderlo salen las retroactivas con la fecha de cada factura
  const count = async () => Number((await app.t.db.query<{ n: string }>(`select count(*)::text n from resources.movements where source_app = 'invoices'`)).rows[0]!.n);
  assert.equal(await count(), 0);
  await ok([insert('invoices.settings', uuid(), { key: 'resources_links', value: true })]);
  const moves = (await app.t.db.query<{ ref: string; q: string; at: string }>(
    `select source_ref ref, quantity::text q, to_char(at at time zone 'UTC', 'YYYY-MM-DD') at from resources.movements where source_app = 'invoices' order by at`)).rows;
  assert.deepEqual(moves.map((m) => [m.ref, Number(m.q), m.at]), [
    [`invoice_line:${a.lineIds[0]}`, 2, '2026-09-10'],
    [`invoice_line:${b.lineIds[0]}`, 3, '2026-09-20'],
  ], 'la sal enlazada no tiene sitio habitual: no entra');

  // Volver a pedir la vista previa: ya no queda nada que crear ni enlazar; aplicar de nuevo no duplica
  const again = await preview();
  assert.deepEqual([again.counts.crear, again.counts.enlazar], [0, 0]);
  const twice = await app.call('/api/v1/resource-links/apply', { body: { digest: again.digest } });
  assert.deepEqual(twice.data, { created: 0, linked: 0, memory: 0 });
  assert.equal(await count(), 2);
});
