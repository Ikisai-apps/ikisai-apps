/**
 * «Cobros sin casar» (API.md §19.7, migración 0263): los avisos de la pasarela que no casaron salen para revisar, se marcan
 * revisados con nota (editor u owner; el lector no) y dejan de salir salvo con «ver también los revisados». Las
 * explicaciones de la pantalla. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { explainUnmatched } from '../../apps/invoices/src/app/unmatched.ts';

let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }) });
});

const review = async (all = false, token?: string) => app.call('/api/v1/read/invoices.payment_events_review', { body: { all }, ...(token ? { token } : {}) });
const resolve = (id: string, note: string, token?: string) => app.call('/api/v1/commands', { body: { requestId: `um-${++seq}`, operations: [{ op: 'call', procedure: 'invoices.payment_event_resolve', args: { id, note } }] }, ...(token ? { token } : {}) });

test('los avisos que no casan salen por revisar; revisado con nota deja de salir; el lector no marca', async () => {
  const inv = uuid();
  const res = await app.call('/api/v1/commands', { body: { requestId: `um-${++seq}`, operations: [
    { op: 'insert', table: 'invoices.issued_invoices', id: inv, fields: { series_code: 'UM', number: '2026-0001', issue_date: '2026-10-20', invoice_type: 'F2', description: 'Saldo' } },
    { op: 'insert', table: 'invoices.issued_invoice_lines', id: uuid(), fields: { issued_invoice_id: inv, description: 'Alojamiento', net_amount: 100, vat_rate: 10 } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const link = (await app.t.db.query<{ id: string }>(`insert into invoices.payment_links (issued_invoice_id, provider, provider_ref, url, amount, expires_at, status)
    values ($1, 'stripe', 'cs_test_um', 'https://checkout.stripe.com/c/pay/cs_test_um', 110, now() + interval '1 day', 'pagado') returning id`, [inv])).rows[0]!.id;
  const ev = (await app.t.db.query<{ id: string }>(`insert into invoices.payment_events (provider, provider_event_id, kind, provider_ref, payment_link_id, outcome, detail)
    values ('stripe', 'evt_um_1', 'paid', 'cs_test_um', $1, 'mismatch', 'La factura ya no estaba por cobrar.') returning id`, [link])).rows[0]!.id;
  await app.t.db.query(`insert into invoices.payment_events (provider, provider_event_id, kind, outcome) values ('stripe', 'evt_um_ok', 'paid', 'applied')`);

  const first = await review();
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.pending, 1);
  const item = first.data.items.find((i: any) => i.id === ev);
  assert.deepEqual([item.invoice_number, Number(item.amount), item.issued_invoice_id], ['UM-2026-0001', 110, inv]);
  assert.equal(first.data.items.length, 1, 'lo que casó no sale');

  assert.equal((await resolve(ev, 'Devuelto en Stripe', app.tokens.reader)).status, 403);
  const empty = await resolve(ev, '  ');
  assert.equal(empty.data.error.code, 'INVALID_ARGS');
  const done = await resolve(ev, 'Devuelto en Stripe', app.tokens.editor);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const after = await review();
  assert.deepEqual([after.data.pending, after.data.items.length], [0, 0]);
  const withReviewed = (await review(true)).data.items.find((i: any) => i.id === ev);
  assert.equal(withReviewed.review_note, 'Devuelto en Stripe');
  assert.ok(withReviewed.reviewed_at);
  assert.equal((await resolve(uuid(), 'x')).data.error.code, 'NOT_FOUND');
});

test('la pantalla explica qué pasó y qué hacer', () => {
  const base = { kind: 'paid' as const, outcome: 'mismatch' as const, invoice_status: 'emitida', payment_status: 'pendiente', amount: 110, invoice_total: 110 };
  assert.match(explainUnmatched({ ...base, kind: 'refunded' }).todo, /rectificativa/);
  assert.match(explainUnmatched({ ...base, outcome: 'unknown' }).title, /sin enlace/);
  assert.match(explainUnmatched({ ...base, invoice_status: 'anulada' }).title, /anulada/);
  assert.match(explainUnmatched({ ...base, payment_status: 'cobrada' }).title, /ya cobrada/);
  assert.match(explainUnmatched({ ...base, amount: 100 }).title, /importe/);
});
