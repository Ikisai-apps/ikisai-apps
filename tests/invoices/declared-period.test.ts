/**
 * Invoices · periodo de declaración (migración 0228, aprobado por Core el 9-10-2026): una factura de un trimestre ya
 * entregado a la gestoría pasa sola al siguiente, marcada como atrasada; el resumen y la entrega van por el periodo de
 * declaración y conservan la fecha real. Año 2024 para no cruzarse con otras pruebas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { declarationDate, fiscalSummary, invoicesCsv, periodOfDate } from '../../packages/domain-invoices/src/index.ts';

let app: TestApp;
let counter = 0;
const uuid = () => crypto.randomUUID();
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `period-${++counter}`, operations } });
async function ok(operations: unknown[]) { const r = await commit(operations); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function row(id: string) {
  const snap = await app.call('/api/v1/snapshot?tables=invoices.invoices');
  return (snap.data.tables[0].rows as Array<Record<string, any>>).find((r) => r.id === id)!;
}
async function uploadFile(content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'f.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
  app.supabase.storage.set(ticket.data.path, bytes);
  await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
  return { file_id: ticket.data.id as string, mime_type: 'application/pdf', size_bytes: bytes.byteLength, sha256: sha };
}
const summary = async (quarter: number) => (await app.call('/api/v1/read/invoices.fiscal_summary', { body: { year: 2024, quarter } })).data;

let supplier: string;
/** Factura manual completa (documento, línea, IVA y categoría): lista para validar. */
async function invoice(date: string, net: number, extra: Record<string, unknown> = {}) {
  const id = uuid(); const file = await uploadFile(`%PDF ${id}`);
  await ok([
    insert('invoices.invoices', id, { supplier_id: supplier, invoice_date: date, object: 'material', invoice_number: `P-${id.slice(0, 6)}`, expense_category: 'compras', source_total: Math.round(net * 121) / 100, ...extra }),
    insert('invoices.invoice_lines', uuid(), { invoice_id: id, position: 0, description: 'Material', net_amount: net, vat_rate: 21, vat_amount: Math.round(net * 21) / 100 }),
    insert('invoices.tax_lines', uuid(), { invoice_id: id, position: 0, tax_type: 'iva', rate: 21, taxable_base: net, amount: Math.round(net * 21) / 100 }),
    insert('invoices.invoice_files', uuid(), { invoice_id: id, original_filename: 'f.pdf', page_order: 1, kind: 'original', ...file }),
  ]);
  return id;
}

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
  supplier = uuid();
  await ok([insert('invoices.suppliers', supplier, { name: 'Periodo Ejemplo SL' })]);
});

test('una factura de un trimestre ya entregado pasa sola al siguiente (atrasada) y se declara allí con su fecha real', async () => {
  const may = await invoice('2024-05-10', 100);
  await ok([call('invoices.validate', { invoice_id: may })]);
  await ok([call('invoices.create_export', { export_id: uuid(), period_kind: 'quarter', fiscal_year: 2024, fiscal_quarter: 2 })]);
  // Llega después una del 2T: el 2T ya se entregó, así que se declara en el 3T
  const late = await invoice('2024-06-20', 50);
  const r = await row(late);
  assert.equal(r.declared_period, '2024T3');
  assert.equal(r.invoice_date, '2024-06-20', 'la fecha real no cambia');
  assert.equal(r.declaration_date, '2024-07-01');
  await ok([call('invoices.validate', { invoice_id: late })]);
  assert.equal(Number((await summary(2)).base), 100, 'el 2T no cambia');
  assert.equal(Number((await summary(3)).base), 50, 'cuenta en el 3T');
  // En la entrega del 3T va con su fecha real y la marca de atrasada
  const manifest = (await app.t.db.query<{ m: any }>(`select invoices.export_manifest('2024-07-01', '2024-09-30', 'quarter', 2024, 3, 'prueba') m`)).rows[0]!.m;
  const item = manifest.invoices.find((i: any) => i.id === late);
  assert.deepEqual([item.invoice_date, item.declared_period, item.late], ['2024-06-20', '2024T3', true]);
  assert.ok(invoicesCsv(manifest).includes(';2024T3;si'));
});

test('a mano: se puede declarar en otro trimestre (y volver al de su fecha); el formato se comprueba', async () => {
  const id = await invoice('2024-08-05', 30);
  let r = await row(id);
  assert.equal(r.declared_period, null, 'el 3T no está entregado: se queda en el de su fecha');
  await ok([update('invoices.invoices', id, r.revision, { declared_period: '2024T4' })]);
  r = await row(id);
  assert.equal(r.declaration_date, '2024-10-01');
  await ok([call('invoices.validate', { invoice_id: id })]);
  assert.equal(Number((await summary(4)).base), 30);
  const bad = await commit([update('invoices.invoices', id, (await row(id)).revision, { declared_period: '2024-3T' })]);
  assert.equal(bad.status, 422);
});

test('dominio: el resumen del dispositivo también cuenta por periodo de declaración', () => {
  assert.equal(declarationDate({ invoice_date: '2024-06-20', declared_period: '2024T3' }), '2024-07-01');
  assert.equal(declarationDate({ invoice_date: '2024-06-20', declared_period: null }), '2024-06-20');
  assert.equal(periodOfDate('2024-06-20'), '2024T2');
  const base = { deleted_at: null, status: 'validada', calculated_base: 50, calculated_vat: 10.5, calculated_other: 0, calculated_withholding: 0, calculated_total: 60.5, totals_delta: null, expense_category: 'compras', is_investment: false, deductibility: 'deducible', id: 'x', code: 'FVR', review_reason: null } as never;
  const q3 = fiscalSummary({ invoices: [{ ...(base as object), invoice_date: '2024-06-20', declared_period: '2024T3' } as never], taxLines: [] }, { kind: 'quarter', year: 2024, quarter: 3, from: '2024-07-01', to: '2024-09-30' } as never);
  assert.equal(q3.base, 50);
});
