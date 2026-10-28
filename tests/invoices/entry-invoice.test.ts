/**
 * Factura con NIF a petición de un cobro (vg-38, API.md §17.13, migración 0263): el servidor de Booking pide la factura
 * de un cobro de alojamiento y Finance crea un borrador a revisar, con las líneas del apunte, cobrado y sin sumar dos
 * veces (la venta la cuenta el apunte). Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { walkinFinanceEntry } from '../../supabase/functions/_domain/booking/walkin.ts';
import { issuedSummary } from '../../supabase/functions/_domain/invoices/mod.ts';

const WORKER_KEY = 'clave-de-worker-sintetica';
const EVENT = 'e1000000-0000-4000-8000-000000000001';
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null }, workerKey: WORKER_KEY }),
  });
  await app.t.db.query(`select invoices.seed_series_2026()`);
});

const booking = { 'x-ikisai-worker-key': WORKER_KEY, 'x-ikisai-caller': 'booking' };
/** Un cobro de alojamiento de recepción (2 noches a 35 €: 50 € en metálico y 20 € con tarjeta). */
async function stay(): Promise<string> {
  const id = uuid();
  const args = walkinFinanceEntry({ id, event_id: EVENT, nights: 2, price_cents: 3500, amount_cents: 7000, method: 'cash',
    paid_day: '2026-10-31', title: 'Fin de semana de octubre', guest: null, space: 'Casa grande', bed: 'Cama 3' });
  const res = await app.call('/api/v1/commands', { headers: booking,
    body: { requestId: `ei-${++seq}`, operations: [{ op: 'call', procedure: 'invoices.record_app_entry', args: { ...args, methods: { cash: 5000, card: 2000 } } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return `booking:stay:${id}`;
}
const ask = (body: Record<string, unknown>, headers: Record<string, string> = booking) =>
  app.call('/api/v1/worker/entry-invoice', { token: null, method: 'POST', body, headers });
const state = (source: string, headers: Record<string, string> = booking) =>
  app.call(`/api/v1/worker/entry-invoice?source=${encodeURIComponent(source)}`, { token: null, method: 'GET', headers });
const person = { name: 'Huésped de Prueba', tax_id: '12345678-z', kind: 'particular' };
const company = { name: 'Retiros Sintéticos SL', tax_id: 'B12345674', kind: 'empresa', address: { line: 'Calle Falsa 1', postal_code: '28001', city: 'Madrid', country: 'ES' } };

test('crea un borrador con las líneas del cobro, cobrado, y la misma petición devuelve lo mismo', async () => {
  const source = await stay();
  const request_id = uuid();
  const first = await ask({ request_id, source, customer: person });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual([first.data.status, first.data.request_id, first.data.full_number], ['pendiente', request_id, null]);
  const inv = (await app.t.db.query<Record<string, any>>(`select * from invoices.issued_invoices where id = $1`, [first.data.issued_invoice_id])).rows[0]!;
  assert.deepEqual([inv.status, inv.invoice_type, inv.recipient_tax_id, inv.recipient_id_type, inv.recipient_kind, inv.income_category],
    ['borrador', 'F1', '12345678Z', 'NIF', 'particular', 'alojamiento'], 'el NIF llega normalizado');
  assert.deepEqual([inv.payment_status, inv.payment_method, inv.prices_include_vat], ['cobrada', 'efectivo', true], 'nace cobrada con el medio mayor');
  assert.ok(inv.from_entry_id);
  const lines = (await app.t.db.query<Record<string, any>>(`select * from invoices.issued_invoice_lines where issued_invoice_id = $1 and deleted_at is null`, [inv.id])).rows;
  const cents = (v: unknown) => Math.round(Number(v) * 100);
  assert.equal(lines.reduce((s, l) => s + cents(l.net_amount) + cents(l.vat_amount), 0), 7000, 'IVA incluido: suma exactamente el cobro');
  // La misma petición (reintento) no crea otra; otra petición del mismo cobro dice que ya existe
  const replay = await ask({ request_id, source, customer: person });
  assert.deepEqual([replay.status, replay.data.issued_invoice_id, replay.data.replayed], [200, inv.id, true]);
  const other = await ask({ request_id: uuid(), source, customer: company });
  assert.deepEqual([other.status, other.data.error.code], [409, 'ALREADY_REQUESTED']);
  // Booking consulta el estado
  const seen = await state(source);
  assert.deepEqual([seen.status, seen.data.status, seen.data.request_id], [200, 'pendiente', request_id]);
});

test('NIF con mal dígito, empresa sin domicilio, cobro ajeno o inexistente y otra app: se rechazan', async () => {
  const source = await stay();
  const bad = await ask({ request_id: uuid(), source, customer: { ...person, tax_id: '12345678A' } });
  assert.deepEqual([bad.status, bad.data.error.code], [422, 'TAX_ID_INVALID']);
  const noAddress = await ask({ request_id: uuid(), source, customer: { ...company, address: null } });
  assert.deepEqual([noAddress.status, noAddress.data.error.code], [422, 'INVALID_ARGS']);
  const missing = await ask({ request_id: uuid(), source: `booking:stay:${uuid()}`, customer: person });
  assert.deepEqual([missing.status, missing.data.error.code], [404, 'ENTRY_NOT_FOUND']);
  const foreign = await ask({ request_id: uuid(), source: 'flow:project:x', customer: person });
  assert.deepEqual([foreign.status, foreign.data.error.code], [422, 'INVALID_ARGS']);
  const spoofed = await ask({ request_id: uuid(), source, customer: person }, { ...booking, 'x-ikisai-caller': 'flow' });
  assert.deepEqual([spoofed.status, spoofed.data.error.code], [403, 'CALLER_REJECTED']);
  const noKey = await ask({ request_id: uuid(), source, customer: person }, { 'x-ikisai-caller': 'booking' });
  assert.equal(noKey.status, 401, 'sin la clave de worker no entra');
  // Una persona de Finance no puede poner `from_entry_id` a mano
  const entry = (await app.t.db.query<{ id: string }>(`select id from invoices.app_entries where source_ref = $1`, [source])).rows[0]!.id;
  const manual = await app.call('/api/v1/commands', { body: { requestId: `ei-${++seq}`, operations: [{ op: 'insert', table: 'invoices.issued_invoices', id: uuid(),
    fields: { series_code: 'F', status: 'borrador', issue_date: '2026-10-31', description: 'A mano', from_entry_id: entry } }] } });
  assert.equal(manual.data.error?.code, 'INVALID_FIELDS', JSON.stringify(manual.data)); // el servidor no acepta la columna del cliente (y el SQL tampoco)
});

test('descartar el borrador deja volver a pedirla; una factura de un cobro no suma en el resumen ni en los KPIs', async () => {
  const source = await stay();
  const first = await ask({ request_id: uuid(), source, customer: company });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const rev = (await app.t.db.query<{ r: string }>(`select revision r from invoices.issued_invoices where id = $1`, [first.data.issued_invoice_id])).rows[0]!.r;
  const removed = await app.call('/api/v1/commands', { body: { requestId: `ei-${++seq}`, operations: [{ op: 'delete', table: 'invoices.issued_invoices', id: first.data.issued_invoice_id, expectedRevision: Number(rev) }] } });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await state(source)).data.status, 'descartada');
  const again = await ask({ request_id: uuid(), source, customer: company });
  assert.deepEqual([again.status, again.data.status], [200, 'pendiente']);
  // Una emitida de otro cobro (aquí, registrada directamente como si se hubiera emitido) no suma: la venta es el apunte
  const source2 = await stay();
  const entry = (await app.t.db.query<{ id: string }>(`select id from invoices.app_entries where source_ref = $1`, [source2])).rows[0]!.id;
  const reg = uuid();
  await app.t.db.query(`do $$ begin perform set_config('invoices.procedure', 'entry_invoice_request', true);
    insert into invoices.issued_invoices (id, series_code, number, issue_date, invoice_type, description, recipient_name, recipient_tax_id, base_total, quota_total, total, from_entry_id)
    values ('${reg}', 'EI', '2026-0001', '2026-10-31', 'F1', 'Alojamiento', 'Retiros Sintéticos SL', 'B12345674', 63.64, 6.36, 70, '${entry}'); end $$`);
  const sum = (await app.t.db.query<{ s: any }>(`select invoices.issued_summary_for('2026-10-31', '2026-10-31') s`)).rows[0]!.s;
  assert.equal(Number(sum.invoices.registrada), 0, 'el resumen de emitidas no la cuenta');
  const ts = issuedSummary({ invoices: [{ id: reg, status: 'registrada', issue_date: '2026-10-31', base_total: 63.64, total: 70, from_entry_id: entry } as never], lines: [], taxLines: [], withFile: new Set() }, { from: '2026-10-31', to: '2026-10-31' });
  assert.equal(ts.invoices.registrada, 0, 'tampoco el de la app');
  // El libro de la entrega sí la lleva, con el ticket que sustituye
  const book = (await app.t.db.query<{ m: any[] }>(`select invoices.issued_manifest('2026-10-31', '2026-10-31') m`)).rows[0]!.m;
  assert.equal(book.find((i) => i.id === reg)?.replaces_entry?.source_ref, source2);
  const kpi = (await app.t.db.query<{ n: string }>(`select count(*) n from invoices.central_kpi_projection`)).rows[0]!.n;
  assert.equal(Number(kpi), 36, 'los KPIs siguen siendo 36');
});
