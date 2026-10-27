/**
 * Capacidad «Registrar compra rápida» (API.md §18, `POST /api/v1/purchases/quick`): proveedor nuevo o reutilizado,
 * importe con o sin IVA, documento opcional de `core.files`, destino evento de Booking o general, idempotente por
 * `requestId`, permiso de edición y errores con su campo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';

let app: TestApp;
let EVENT: string;
const quick = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/purchases/quick', { body, ...(token ? { token } : {}) });
async function ok(body: Record<string, unknown>, token?: string) {
  const res = await quick(body, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rows(table: string): Promise<Array<Record<string, any>>> {
  return (await app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows;
}
async function uploadFile(content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'ticket.jpg', mime: 'image/jpeg', size: bytes.byteLength, sha256: sha } });
  app.supabase.storage.set(ticket.data.path, bytes);
  await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
  return ticket.data.id as string;
}

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
  const reservation = uuid(); EVENT = uuid();
  await app.t.db.query(`insert into booking.reservations (id, title, status, start_date, end_date, expected_guests, requires_meals, meal_plan_requested, menu_style_requested)
    values ($1, 'Evento de octubre', 'confirmada', '2026-10-30', '2026-11-01', 60, true, 'pension_completa', 'vegetariano')`, [reservation]);
  await app.t.db.query(`insert into booking.events (id, reservation_id) values ($1, $2)`, [EVENT, reservation]);
});
test.after(async () => { await app.close(); });

test('compra al evento con proveedor nuevo, IVA conocido y foto; repetirla devuelve lo mismo sin duplicar', async () => {
  const fileId = await uploadFile('foto del ticket del hielo');
  const body = { requestId: 'flow-hielo-31', supplier: { name: 'Hielos del Sur', tax_id: 'B00000000' }, date: '2026-10-31', total: 36.3, vat_rate: 21,
    description: 'Hielo para la barra', file_id: fileId, target: { app: 'booking', kind: 'event', id: EVENT } };
  const first = await ok(body, app.tokens.editor);
  assert.equal(first.replayed, false);
  assert.equal(first.supplier.created, true);
  assert.equal(first.nature, 'fiscal', 'con foto: fiscal');
  assert.deepEqual([first.base, first.vat, first.total], [30, 6.3, 36.3]);
  assert.match(first.code, /^FVR_2026_\d{3}$/);
  assert.match(first.target.label, /Evento de octubre/);
  assert.equal(first.summary, `${first.code} · Hielos del Sur · 36,30 € · ${first.target.label}`);
  assert.notEqual(first.status, 'validada', 'la oficina la revisa y la valida');

  const invoice = (await rows('invoices.invoices')).find((r) => r.id === first.invoice_id)!;
  assert.equal(invoice.object, 'Hielo para la barra');
  assert.equal(Number(invoice.source_total), 36.3);
  const line = (await rows('invoices.invoice_lines')).find((r) => r.invoice_id === first.invoice_id)!;
  assert.deepEqual([Number(line.net_amount), Number(line.vat_rate), Number(line.vat_amount)], [30, 21, 6.3]);
  const allocation = (await rows('invoices.allocations')).find((r) => r.invoice_line_id === line.id)!;
  assert.deepEqual([allocation.target_app, allocation.target_kind, allocation.target_id, Number(allocation.allocated_amount)], ['booking', 'event', EVENT, 30]);
  assert.ok((await rows('invoices.invoice_files')).some((f) => f.invoice_id === first.invoice_id && f.file_id === fileId));

  const again = await ok(body, app.tokens.editor);
  assert.equal(again.replayed, true);
  assert.equal(again.invoice_id, first.invoice_id);
  assert.equal(again.supplier.id, first.supplier.id);
  assert.equal((await rows('invoices.suppliers')).filter((s) => s.name === 'Hielos del Sur').length, 1);
  assert.equal((await rows('invoices.invoices')).filter((i) => i.object === 'Hielo para la barra').length, 1);

  // El mismo requestId con otra compra no es un reintento
  const reuse = await quick({ ...body, total: 40 }, app.tokens.editor);
  assert.equal(reuse.status, 409, JSON.stringify(reuse.data));
  assert.equal(reuse.data.error.code, 'IDEMPOTENCY_REUSE');
});

test('proveedor que ya existe (por nombre, sin acentos ni mayúsculas) y destino general sin IVA conocido', async () => {
  const out = await ok({ requestId: 'flow-servilletas', supplier: { name: 'HIELOS DEL SUR' }, date: '2026-10-30', total: 12.5,
    description: 'Servilletas', target: { app: 'general', kind: 'operating_expense' } });
  assert.equal(out.supplier.created, false);
  assert.equal(out.nature, 'process', 'sin foto ni número: de proceso (no llega a la gestoría hasta tener su justificante)');
  assert.equal(out.supplier.name, 'Hielos del Sur');
  assert.deepEqual([out.base, out.vat], [12.5, null]);
  assert.equal(out.target.label, 'Gasto de explotación');
  const line = (await rows('invoices.invoice_lines')).find((r) => r.invoice_id === out.invoice_id)!;
  assert.equal(Number(line.net_amount), 12.5);
  assert.equal((await rows('invoices.tax_lines')).filter((t) => t.invoice_id === out.invoice_id).length, 0);
  // Por id de proveedor
  const byId = await ok({ requestId: 'flow-vasos', supplier: { id: out.supplier.id }, date: '2026-10-30', total: 8, vat_rate: 10, description: 'Vasos', invoice_number: 'T-0042', target: { app: 'general', kind: 'unassigned' } });
  assert.equal(byId.supplier.id, out.supplier.id);
  assert.equal(byId.nature, 'fiscal', 'con número de factura: fiscal');
  // Con ticket (0247): se registra como ticket, de proceso, fuera de la gestoría
  const ticket = await ok({ requestId: 'flow-limones', supplier: { id: out.supplier.id }, date: '2026-10-30', total: 4.4, vat_rate: 10, description: 'Limones', invoice_number: 'T-12', receipt_kind: 'ticket', target: { app: 'general', kind: 'operating_expense' } });
  assert.equal(ticket.nature, 'process');
  assert.equal((await rows('invoices.invoices')).find((i) => i.id === ticket.invoice_id)!.receipt_kind, 'ticket');
  assert.equal((await rows('invoices.invoices')).find((i) => i.id === byId.invoice_id)!.invoice_number, 'T-0042');
});

test('permiso y validación: el lector no registra; cada error dice su campo', async () => {
  const valid = { requestId: 'x-1', supplier: { name: 'Uno' }, date: '2026-10-31', total: 10, description: 'Algo', target: { app: 'general', kind: 'unassigned' } };
  const reader = await quick(valid, app.tokens.reader);
  assert.equal(reader.status, 403);
  const field = async (patch: Record<string, unknown>, expected: string, code = 'INVALID_FIELDS') => {
    const res = await quick({ ...valid, ...patch });
    assert.equal(res.status, 422, JSON.stringify(res.data));
    assert.equal(res.data.error.code, code);
    assert.equal(res.data.error.details.field, expected);
  };
  await field({ requestId: 'con espacios' }, 'requestId');
  await field({ supplier: { name: '' } }, 'supplier.name');
  await field({ supplier: { id: 'no-uuid' } }, 'supplier.id');
  await field({ supplier: { id: uuid() } }, 'supplier.id', 'SUPPLIER_NOT_FOUND');
  await field({ date: '31/10/2026' }, 'date');
  await field({ total: -3 }, 'total');
  await field({ total: 10.555 }, 'total');
  await field({ vat_rate: 7 }, 'vat_rate');
  await field({ receipt_kind: 'albaran' }, 'receipt_kind');
  await field({ description: '' }, 'description');
  await field({ file_id: 'x' }, 'file_id');
  await field({ target: { app: 'tasks', kind: 'project', id: uuid() } }, 'target.app');
  await field({ target: { app: 'general', kind: 'otro' } }, 'target.kind');
  // Un evento que no existe lo rechaza la resolución de destinos con el token de la persona
  const missing = await quick({ ...valid, requestId: 'x-2', target: { app: 'booking', kind: 'event', id: uuid() } });
  assert.equal(missing.status, 422);
  assert.equal(missing.data.error.code, 'TARGET_NOT_FOUND');
});
