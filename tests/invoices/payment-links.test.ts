/**
 * Enlaces de pago de las emitidas (finance-18, PR 2; API.md §19.2) con el Stripe falso: se crea con el importe de la
 * factura, se reutiliza mientras está abierto, caduca y se crea otro, se cancela al cobrar a mano y sale en el portal del
 * organizador (F5) solo si está abierto. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { createFakeStripe } from '../../supabase/functions/_domain/payments/fake.ts';

const stripe = createFakeStripe();
let app: TestApp;
let seq = 0;
const RES = '5a1d0c2e-7b3f-4e8a-9c6d-2f4b8e1a3c50';
const OTHER_RES = '6b2e1d3f-8c4a-4f9b-8d7e-3a5c9f2b4d61';
const WORKER_KEY = 'clave-de-worker-de-pruebas';

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null }, payments: stripe, workerKey: WORKER_KEY }),
  });
});

const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `pl-${++seq}`, operations }, ...(token ? { token } : {}) });
const link = (id: string, token?: string) => app.call(`/api/v1/issued/${id}/payment-link`, { body: {}, ...(token ? { token } : {}) });
const links = async (id: string) => (await app.call('/api/v1/read/invoices.payment_links_of', { body: { issued_invoice_id: id } })).data.items as Array<Record<string, any>>;
/** Una emitida registrada con una línea (el total sale de las líneas: base + 10 % de IVA). */
async function issued(net: number): Promise<string> {
  const id = uuid();
  const res = await commit([
    { op: 'insert', table: 'invoices.issued_invoices', id, fields: { series_code: 'PL', number: `2026-${String(++seq).padStart(4, '0')}`, issue_date: '2026-10-20', invoice_type: 'F2', description: 'Saldo del retiro' } },
    { op: 'insert', table: 'invoices.issued_invoice_lines', id: uuid(), fields: { issued_invoice_id: id, description: 'Alojamiento', net_amount: net, vat_rate: 10 } },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}
const totalOf = async (id: string) => Number((await app.t.db.query<{ t: string }>(`select total t from invoices.issued_invoices where id = $1`, [id])).rows[0]!.t);

test('se crea con el importe de la factura, se reutiliza mientras está abierto y el lector no puede', async () => {
  const id = await issued(400);
  assert.equal(await totalOf(id), 440);
  const first = await link(id);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.deepEqual([Number(first.data.amount), first.data.reused], [440, false]);
  const sent = stripe.requests.at(-1)!;
  assert.deepEqual([sent.amountCents, sent.currency, sent.metadata.issued_invoice_id], [44000, 'eur', id], 'el importe sale de la factura');
  const again = await link(id);
  assert.deepEqual([again.data.url, again.data.reused], [first.data.url, true]);
  assert.equal(stripe.requests.length, 1, 'no crea otra sesión');
  assert.equal((await link(id, app.tokens.reader)).status, 403);
  assert.equal((await links(id))[0]!.status, 'abierto');
});

test('caducado: se marca y el siguiente es una sesión nueva; cobrada a mano: se cancela y ya no se puede pagar', async () => {
  const id = await issued(100);
  const first = await link(id);
  await app.t.db.query(`update invoices.payment_links set expires_at = now() - interval '1 minute' where issued_invoice_id = $1`, [id]);
  const second = await link(id);
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.notEqual(second.data.url, first.data.url, 'otra sesión');
  assert.deepEqual((await links(id)).map((l) => l.status), ['abierto', 'caducado']);
  // Cobrada a mano (transferencia): el abierto pasa a cancelado y no se crea otro
  const row = (await app.t.db.query<{ revision: number }>(`select revision from invoices.issued_invoices where id = $1`, [id])).rows[0]!;
  const paid = await commit([{ op: 'update', table: 'invoices.issued_invoices', id, expectedRevision: Number(row.revision), fields: { payment_status: 'cobrada', paid_at: '2026-10-21', payment_method: 'transferencia' } }]);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.deepEqual((await links(id)).map((l) => l.status), ['cancelado', 'caducado']);
  const refused = await link(id);
  assert.deepEqual([refused.status, refused.data.error.code], [409, 'PAYMENT_NOT_ALLOWED']);
});

test('F5: el portal del organizador ve el enlace abierto de cada factura sin cobrar (leer no crea nada)', async () => {
  const id = await issued(300);
  assert.equal(await totalOf(id), 330);
  await app.t.db.query(`insert into invoices.issued_allocations (issued_invoice_id, target_app, target_kind, target_id, target_label, allocated_amount) values ($1, 'booking', 'reservation', $2, 'Reserva', 300)`, [id, RES]);
  const uid = (await app.t.db.query<{ u: string }>(`select user_id u from core.memberships where app = 'invoices' and role = 'reader' limit 1`)).rows[0]!.u;
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2) on conflict (app, user_id) do update set scopes = excluded.scopes`,
    [uid, JSON.stringify({ grants: [{ reservation_id: RES }] })]);
  const money = async () => (await app.t.db.query<{ r: any }>(`select core.read('organizers', $1, 'invoices.portal_reservation_money', $2) r`, [uid, JSON.stringify({ reservation_id: RES })])).rows[0]!.r;
  const before = stripe.requests.length;
  assert.equal((await money()).invoices.find((i: any) => i.id === id).payment_link, null);
  assert.equal(stripe.requests.length, before, 'leer no crea sesiones');
  const created = await link(id);
  const shown = (await money()).invoices.find((i: any) => i.id === id).payment_link;
  assert.deepEqual([shown.url, shown.provider], [created.data.url, 'stripe']);
});

test('«Pagar ahora» del portal (F5, worker de Organizers): solo dentro del ámbito y vuelve a Organizers', async () => {
  const id = await issued(200);
  const other = await issued(50);
  await app.t.db.query(`insert into invoices.issued_allocations (issued_invoice_id, target_app, target_kind, target_id, target_label, allocated_amount) values ($1, 'booking', 'reservation', $2, 'Reserva', 200), ($3, 'booking', 'reservation', $4, 'Otra', 50)`,
    [id, RES, other, OTHER_RES]);
  const uid = (await app.t.db.query<{ u: string }>(`select user_id u from core.memberships where app = 'organizers' limit 1`)).rows[0]!.u;
  const portal = (body: Record<string, unknown>, caller = 'organizers') => app.call('/api/v1/worker/payment-links/portal', { token: null, method: 'POST', body,
    headers: { 'x-ikisai-worker-key': WORKER_KEY, 'x-ikisai-caller': caller } });
  const ok = await portal({ actor: uid, reservation_id: RES, issued_invoice_id: id, return_url: 'https://organizers.ikisai.com/#/retiro/x' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const sent = stripe.requests.at(-1)!;
  assert.deepEqual([sent.successUrl, sent.amountCents], ['https://organizers.ikisai.com/#/retiro/x', 22000]);
  assert.equal((await links(id))[0]!.requested_from, 'portal');
  // Una URL de vuelta ajena no se usa
  await app.t.db.query(`update invoices.payment_links set status = 'cancelado' where issued_invoice_id = $1`, [id]);
  await portal({ actor: uid, reservation_id: RES, issued_invoice_id: id, return_url: 'https://ejemplo.invalid/robar' });
  assert.equal(stripe.requests.at(-1)!.successUrl, 'https://organizers.ikisai.com/');
  // Fuera de ámbito (factura de otra reserva u otra reserva) y otro llamante
  for (const body of [{ actor: uid, reservation_id: RES, issued_invoice_id: other }, { actor: uid, reservation_id: OTHER_RES, issued_invoice_id: other }]) {
    const res = await portal(body);
    assert.deepEqual([res.status, res.data.error.code], [403, 'OUT_OF_SCOPE']);
  }
  assert.equal((await portal({ actor: uid, reservation_id: RES, issued_invoice_id: id }, 'booking')).status, 403);
});

