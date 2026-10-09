/**
 * Fase 1 del lector (9-10-2026): el texto que sube la app rellena, con la cuenta de sistema `lector` y el mismo núcleo que
 * Drive (`readAndFill`), solo el borrador en «Pendiente de datos» de quien lo sube, y nunca pisa lo escrito a mano.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import type { PdfTextItem } from '../../packages/domain-invoices/src/index.ts';

let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });

async function ok(operations: unknown[], token?: string) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `lector-${++counter}`, operations }, ...(token ? { token } : {}) });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function invoice(id: string): Promise<Record<string, any>> {
  return (await app.call('/api/v1/snapshot?tables=invoices.invoices')).data.tables[0].rows.find((r: any) => r.id === id);
}
async function uploadFile(content: string, token?: string) {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'factura.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha }, ...(token ? { token } : {}) });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {}, ...(token ? { token } : {}) })).status, 200);
  return { file_id: ticket.data.id as string, mime_type: 'application/pdf', size_bytes: bytes.byteLength, sha256: sha };
}
/** Borrador en «Pendiente de datos» con el proveedor provisional y su documento, subido por `token`. */
async function draft(fields: Record<string, unknown> = {}, token?: string) {
  const id = uuid();
  const placeholder = (await app.call('/api/v1/snapshot?tables=invoices.suppliers')).data.tables[0].rows.find((s: any) => s.slug === 'sin_identificar');
  const supplierId = placeholder?.id ?? uuid();
  const doc = await uploadFile(`%PDF ${id}`, token);
  await ok([
    ...(placeholder ? [] : [insert('invoices.suppliers', supplierId, { name: 'Sin identificar (Drive)', slug: 'sin_identificar' })]),
    insert('invoices.invoices', id, { supplier_id: supplierId, invoice_date: null, object: `factura ${id.slice(0, 8)}`, ...fields }),
    insert('invoices.invoice_files', uuid(), { invoice_id: id, original_filename: 'factura.pdf', kind: 'original', page_order: 1, ...doc }),
  ], token);
  return { id, fileId: doc.file_id };
}
function page(lines: string[]): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  lines.forEach((line, i) => line.split('|').forEach((part, col) => { if (part.trim()) items.push({ str: part.trim(), page: 1, x: 40 + col * 260, y: 800 - i * 14, w: part.trim().length * 5, h: 10 }); }));
  return items;
}
const FULL = page(['FRUTAS LECTOR S.L.|CIF: B12345674', 'Factura nº: LEC-1', 'Fecha factura: 06/10/2026', 'Base imponible|100,00', 'IVA 21%|100,00|21,00', 'TOTAL FACTURA|121,00']);
const NO_DATE = page(['FRUTAS LECTOR S.L.|CIF: B12345674', 'Factura nº: LEC-2', 'Servicio mensual de reparto', 'TOTAL FACTURA|60,50']);
const text = (fileId: string, items: PdfTextItem[], fill: boolean, token?: string) =>
  app.call(`/api/v1/documents/${fileId}/text`, { body: { source: 'pdf_text', items, ...(fill ? { fill: true } : {}) }, ...(token ? { token } : {}) });

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
});
test.after(async () => { await app.close(); });

test('con `fill`, el texto rellena el borrador de quien lo sube (proveedor por NIF, número, fecha, total e importes) y guarda el resumen', async () => {
  const d = await draft();
  const res = await text(d.fileId, FULL, true);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.fill.filled, true, JSON.stringify(res.data.fill));
  assert.equal(res.data.fill.read, 'sufficient');
  const inv = await invoice(d.id);
  assert.equal(inv.status, 'pendiente_revision', 'con importes pasa a revisión, como siempre');
  assert.deepEqual([inv.invoice_number, inv.invoice_date, Number(inv.source_total), Number(inv.calculated_total)], ['LEC-1', '2026-10-06', 121, 121]);
  const supplier = (await app.call('/api/v1/snapshot?tables=invoices.suppliers')).data.tables[0].rows.find((s: any) => s.id === inv.supplier_id);
  assert.deepEqual([supplier.name, supplier.tax_id], ['FRUTAS LECTOR S.L.', 'B12345674']);
  assert.equal(inv.import_meta.reading.read, 'sufficient');
  assert.deepEqual(inv.import_meta.reading.filled.invoice_number, { value: 'LEC-1', level: 'regla' });
  assert.equal(JSON.stringify(inv.import_meta).includes('Fecha factura'), false, 'sin texto del documento en el resumen');
});

test('lectura parcial: rellena lo encontrado y lo escrito a mano manda', async () => {
  const d = await draft({ invoice_number: 'MANO-7' });
  const res = await text(d.fileId, NO_DATE, true);
  assert.equal(res.data.fill.filled, true, JSON.stringify(res.data.fill));
  assert.equal(res.data.fill.read, 'partial');
  assert.ok(res.data.fill.missing.includes('la fecha'));
  assert.match(res.data.fill.message, /no he identificado la fecha/);
  const inv = await invoice(d.id);
  assert.equal(inv.status, 'pendiente_datos');
  assert.equal(inv.invoice_number, 'MANO-7', 'el número escrito a mano no se pisa');
  assert.equal(Number(inv.source_total), 60.5);
});

test('sin `fill` solo guarda el texto; no rellena el borrador de otra persona ni una factura que ya no está pendiente de datos', async () => {
  const mine = await draft();
  const plain = await text(mine.fileId, FULL, false);
  assert.equal(plain.status, 200);
  assert.equal(plain.data.fill, undefined);
  assert.equal((await invoice(mine.id)).invoice_number, null);
  // Otra persona (editora) manda texto con `fill` para el borrador del owner: se guarda el texto, no se rellena
  const other = await text(mine.fileId, FULL, true, app.tokens.editor);
  assert.equal(other.status, 200, JSON.stringify(other.data));
  assert.deepEqual(other.data.fill, { filled: false, reason: 'NO_DRAFT' });
  assert.equal((await invoice(mine.id)).invoice_number, null);
  // Mismo proveedor y número que la factura de la primera prueba: es un duplicado y no se rellena
  const dup = await text(mine.fileId, FULL, true);
  assert.equal(dup.data.fill.reason, 'DUPLICATE', JSON.stringify(dup.data.fill));
  assert.match(dup.data.fill.message, /^Ya está importada como /);
  // Ya leída: deja de estar en «Pendiente de datos» y no se vuelve a rellenar
  const other2 = await draft();
  const full2 = FULL.map((it) => (it.str === 'Factura nº: LEC-1' ? { ...it, str: 'Factura nº: LEC-9' } : it));
  assert.equal((await text(other2.fileId, full2, true)).data.fill.filled, true);
  const again = await text(other2.fileId, full2, true);
  assert.equal(again.data.fill.reason, 'NOT_PENDING');
});

test('el cliente sigue sin poder escribir `import_meta` (ni siquiera `reading`)', async () => {
  const d = await draft();
  const inv = await invoice(d.id);
  const res = await app.call('/api/v1/commands', { body: { requestId: `lector-${++counter}`, operations: [{ op: 'update', table: 'invoices.invoices', id: d.id, expectedRevision: inv.revision, fields: { import_meta: { reading: { read: 'sufficient' } } } }] } });
  assert.equal(res.status, 422, JSON.stringify(res.data));
});
