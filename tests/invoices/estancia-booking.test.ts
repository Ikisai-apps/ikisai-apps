/**
 * Alojamiento «como la barra» (Booking #901, finance-15): «Cobrar y alojar» manda el cobro a Finance desde el servidor de
 * Booking (`X-Ikisai-Caller: booking`, §17.10) con el apunte de `walkinFinanceEntry`. Aquí, del lado de Finance:
 * entra una vez como ingreso fiscal con justificante de ticket, y un reintento de recepción no lo duplica.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { walkinFinanceEntry } from '../../supabase/functions/_domain/booking/walkin.ts';
import { dayReceipt } from '../../apps/invoices/src/app/day-receipt.ts';

const WORKER_KEY = 'clave-de-worker-sintetica';
const EVENT = 'e1000000-0000-4000-8000-000000000001';
const STAY = 'a7c3e9d1-0000-4000-8000-000000000042';
let app: TestApp;

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null }, workerKey: WORKER_KEY }),
  });
});

test('cobro de alojamiento de recepción: entra como ticket, una sola vez, aunque recepción reintente', async () => {
  // Lo que manda Booking (datos sintéticos): 2 noches a 35 € en metálico, sin nombre del huésped
  const args = walkinFinanceEntry({ id: STAY, event_id: EVENT, nights: 2, price_cents: 3500, amount_cents: 7000, method: 'cash',
    paid_day: '2026-10-31', title: 'Fin de semana de octubre', guest: null, space: 'Casa grande', bed: 'Cama 3' });
  const send = (requestId: string, headers: Record<string, string> = { 'X-Ikisai-Worker-Key': WORKER_KEY, 'X-Ikisai-Caller': 'booking' }) =>
    app.call('/api/v1/commands', { headers, body: { requestId, operations: [{ op: 'call', procedure: 'invoices.record_app_entry', args }] } });

  const first = await send('booking:walkin:estancia-1');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const result = first.data.results[0].result;
  assert.deepEqual([result.status, result.nature], ['created', 'fiscal'], 'un cobro de alojamiento es ingreso fiscal');
  // Recepción reintenta: el mismo lote se repite; uno nuevo con el mismo apunte no cambia nada
  const replay = await send('booking:walkin:estancia-1');
  assert.equal(replay.status, 200); assert.equal(replay.data.results[0].result.entry_id, result.entry_id);
  const again = await send('booking:walkin:estancia-1-bis');
  assert.deepEqual([again.status, again.data.results[0].result.status], [200, 'unchanged']);
  const rows = (await app.t.db.query<Record<string, any>>(`select * from invoices.app_entries where source_ref = $1 and deleted_at is null`, [`booking:stay:${STAY}`])).rows;
  assert.equal(rows.length, 1, 'un apunte por hecho económico');
  const row = rows[0]!;
  assert.deepEqual([row.kind, Number(row.amount_cents), Number(row.net_cents) + Number(row.tax_cents), row.event_id], ['income', 7000, 7000, EVENT]);
  // El justificante es un ticket con número (los 8 primeros del id), nunca una factura
  const receipt = dayReceipt(row as never);
  assert.deepEqual([receipt.kind, receipt.title, receipt.number], ['ticket', 'Ticket de venta', 'A7C3E9D1']);
  assert.match(receipt.notice, /no es una factura/);
  // Desde fuera del servidor de Booking, «de Booking» no vale: otra app no puede hacerse pasar por Booking
  const spoofed = await send('booking:walkin:estancia-falsa', { 'X-Ikisai-Worker-Key': WORKER_KEY, 'X-Ikisai-Caller': 'flow' });
  assert.deepEqual([spoofed.status, spoofed.data.error.code], [403, 'SOURCE_MISMATCH']);
});
