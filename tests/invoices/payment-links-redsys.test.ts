/**
 * Pagos en línea con Redsys (API.md §19.6, migración 0262) con el Redsys falso: el enlace es la página de paso de Finance,
 * que manda el formulario firmado mientras el enlace vale; el aviso firmado cobra la factura (Bizum como «bizum») una sola
 * vez; manipulado no vale; la conciliación cierra los caducados sin preguntar a Redsys. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { createFakeRedsys } from '../../supabase/functions/_domain/payments/fake-redsys.ts';

const redsys = createFakeRedsys();
const WORKER_KEY = 'clave-de-worker-de-pruebas';
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null }, payments: redsys, redsysSecretKey: redsys.secretKey, workerKey: WORKER_KEY }),
  });
});

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `rs-${++seq}`, operations } });
async function issued(net: number): Promise<string> {
  const id = uuid();
  const res = await commit([
    { op: 'insert', table: 'invoices.issued_invoices', id, fields: { series_code: 'RS', number: `2026-${String(++seq).padStart(4, '0')}`, issue_date: '2026-10-20', invoice_type: 'F2', description: 'Saldo del retiro' } },
    { op: 'insert', table: 'invoices.issued_invoice_lines', id: uuid(), fields: { issued_invoice_id: id, description: 'Alojamiento', net_amount: net, vat_rate: 10 } },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}
const orderOf = (url: string) => url.split('/').at(-1)!;
const go = (order: string) => app.call(`/api/v1/public/payments/redsys/go/${order}`, { token: null, method: 'GET' });
async function notify(fields: Record<string, string>): Promise<{ status: number; data: any }> {
  const res = await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/public/payments/redsys`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }));
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const invoice = async (id: string) => (await app.t.db.query<Record<string, any>>(`select payment_status, payment_method from invoices.issued_invoices where id = $1`, [id])).rows[0]!;

test('el enlace es la página de paso: manda el formulario firmado a Redsys con el importe de la factura', async () => {
  const id = await issued(400);
  const link = await app.call(`/api/v1/issued/${id}/payment-link`, { body: {} });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.equal(link.data.provider, 'redsys');
  assert.match(link.data.url, /\/api\/v1\/public\/payments\/redsys\/go\/\d{4}[0-9a-z]{8}$/);
  assert.equal(redsys.requests.at(-1)!.amountCents, 44000);
  const page = await go(orderOf(link.data.url));
  assert.equal(page.status, 200);
  assert.match(String(page.data), /action="https:\/\/sis-t\.redsys\.es:25443\/sis\/realizarPago"/);
  assert.ok(String(page.data).includes('name="Ds_Signature"'));
  assert.equal((await go('0000aaaaaaaa')).status, 404, 'un pedido que no existe');
});

test('aviso firmado con Bizum: la factura queda cobrada con «bizum», una sola vez; después la página dice que ya está pagado', async () => {
  const id = await issued(100);
  const link = await app.call(`/api/v1/issued/${id}/payment-link`, { body: {} });
  const order = orderOf(link.data.url);
  const fields = await redsys.notification(order, 'ok', { bizum: true });
  // Manipulado: no vale y nada cambia
  const bad = await notify({ ...fields, Ds_Signature: fields.Ds_Signature!.slice(0, -4) + 'AAAA' });
  assert.equal(bad.status, 400);
  assert.equal((await invoice(id)).payment_status, 'pendiente');
  const ok = await notify(fields);
  assert.deepEqual([ok.status, ok.data.outcome], [200, 'applied'], JSON.stringify(ok.data));
  assert.deepEqual([(await invoice(id)).payment_status, (await invoice(id)).payment_method], ['cobrada', 'bizum']);
  assert.equal((await notify(fields)).data.outcome, 'duplicate');
  assert.equal((await go(order)).status, 410);
});

test('denegado no cobra; la conciliación cierra un enlace caducado sin preguntar a Redsys y la página ya no lo manda', async () => {
  const id = await issued(50);
  const link = await app.call(`/api/v1/issued/${id}/payment-link`, { body: {} });
  const order = orderOf(link.data.url);
  const denied = await notify(await redsys.notification(order, 'denied'));
  assert.equal(denied.status, 200);
  assert.equal((await invoice(id)).payment_status, 'pendiente');
  await app.t.db.query(`update invoices.payment_links set expires_at = now() - interval '1 minute' where provider_ref = $1`, [order]);
  assert.equal((await go(order)).status, 410, 'caducado: no se manda el formulario');
  const rec = await app.call('/api/v1/worker/payments/reconcile', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  assert.ok(rec.data.closed >= 1);
  const row = (await app.t.db.query<Record<string, any>>(`select status, gateway_closed_at from invoices.payment_links where provider_ref = $1`, [order])).rows[0]!;
  assert.equal(row.status, 'caducado'); assert.ok(row.gateway_closed_at);
});
