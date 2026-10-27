/**
 * Organizers · «Pagar ahora» sin enlace (F5; Finance API.md §19.3): quien organiza pulsa «Pagar ahora» en una factura que no
 * trae enlace, organizers-api lo pide al worker de Finance en su nombre y Finance lo crea con el Stripe falso. Vuelve a la
 * pestaña Pagos de su retiro, con `pago=ok` o `pago=cancelado`; fuera de su retiro, nada. Las tres Edge sobre el mismo
 * PGlite. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS, paymentReturnUrls } from '../../supabase/functions/organizers-api/app.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { createFakeStripe } from '../../supabase/functions/_domain/payments/fake.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-pruebas';
const stripe = createFakeStripe();
let booking: TestApp;
let invoices: (r: Request) => Promise<Response>;
let organizers: (r: Request) => Promise<Response>;
let organizersOff: (r: Request) => Promise<Response>;
let seq = 0;

type Call = (path: string, init?: { token?: string; body?: unknown }) => Promise<{ status: number; data: any }>;
const caller = (handler: () => (r: Request) => Promise<Response>, slug: string, origin: string): Call => async (path, init = {}) => {
  const res = await handler()(new Request(`${booking.supabase.url}/functions/v1/${slug}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
};
const org = caller(() => organizers, 'organizers-api', ORGANIZERS_ORIGINS[0]!);
const off = caller(() => organizersOff, 'organizers-api', ORGANIZERS_ORIGINS[0]!);
const fin = caller(() => invoices, 'invoices-api', INVOICES_ORIGINS[0]!);

async function reservation(title: string): Promise<string> {
  const id = uuid();
  const res = await booking.call('/api/v1/commands', { body: { requestId: `pn-${++seq}-${uuid()}`, operations: [
    { op: 'insert', table: BOOKING.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2026-11-06', end_date: '2026-11-08', expected_guests: 8 } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}
async function organizerSession(reservation_id: string, email: string): Promise<string> {
  const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const session = await org('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  return session.data.token;
}
/** Una emitida de Finance, imputada a la reserva (como en tests/invoices/payment-links.test.ts). */
async function issued(reservationId: string, net: number): Promise<string> {
  const id = uuid();
  const res = await fin('/api/v1/commands', { token: booking.tokens.editor, body: { requestId: `pn-${++seq}`, operations: [
    { op: 'insert', table: 'invoices.issued_invoices', id, fields: { series_code: 'PN', number: `2026-${String(seq).padStart(4, '0')}`, issue_date: '2026-10-20', invoice_type: 'F2', description: 'Señal del retiro' } },
    { op: 'insert', table: 'invoices.issued_invoice_lines', id: uuid(), fields: { issued_invoice_id: id, description: 'Alojamiento', net_amount: net, vat_rate: 10 } },
  ] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  await booking.t.db.query(`insert into invoices.issued_allocations (issued_invoice_id, target_app, target_kind, target_id, target_label, allocated_amount) values ($1, 'booking', 'reservation', $2, 'Reserva', $3)`,
    [id, reservationId, net]);
  return id;
}

let R1: string; let R2: string; let ana: string; let otra: string;

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const shared = { url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test', workerKey: WORKER_KEY };
  invoices = createInvoicesApp({ ...shared, origins: [INVOICES_ORIGINS[0]!], drive: { api: null }, payments: stripe });
  // organizers-api llama a la Edge de Finance por HTTP: aquí, directamente a su handler.
  const toFinance = ((input: RequestInfo | URL, init?: RequestInit) => invoices(new Request(input, init))) as typeof fetch;
  organizers = createOrganizersApp({ ...shared, origins: [ORGANIZERS_ORIGINS[0]!], payments: { enabled: true, fetch: toFinance } });
  organizersOff = createOrganizersApp({ ...shared, origins: [ORGANIZERS_ORIGINS[0]!], payments: { enabled: false, fetch: toFinance } });
  await booking.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'editor') on conflict (app, user_id) do nothing`, [booking.users.editor]);
  R1 = await reservation('Retiro de Ana');
  R2 = await reservation('Retiro de otra');
  ana = await organizerSession(R1, 'ana-pn@example.invalid');
  otra = await organizerSession(R2, 'otra-pn@example.invalid');
});
test.after(async () => { await booking.close(); });

test('organizers · pagar ahora: sin enlace, Finance lo crea con el total de la factura y vuelve a Pagos del retiro', async () => {
  const invoice = await issued(R1, 300);
  assert.deepEqual((await org('/api/v1/payments/config', { token: ana })).data, { online: true });
  const first = await org('/api/v1/payments/link', { token: ana, body: { reservation_id: R1, issued_invoice_id: invoice } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(first.data.reused, false);
  const sent = stripe.requests.at(-1)!;
  const back = paymentReturnUrls(R1, invoice);
  assert.deepEqual([sent.amountCents, sent.successUrl, sent.cancelUrl], [33000, back.success, back.cancel]);
  assert.equal(back.success, `https://organizers.ikisai.com/#/retiro/${R1}/pagos?factura=${invoice}&pago=ok`);
  // Volver a pulsar reutiliza el abierto («Volver a la pasarela»), y la lectura del portal ya lo trae.
  const again = await org('/api/v1/payments/link', { token: ana, body: { reservation_id: R1, issued_invoice_id: invoice } });
  assert.deepEqual([again.data.url, again.data.reused], [first.data.url, true]);
  const money = await org('/api/v1/read/invoices.portal_reservation_money', { token: ana, body: { reservation_id: R1 } });
  assert.equal(money.status, 200, JSON.stringify(money.data));
  assert.equal(money.data.invoices.find((i: { id: string }) => i.id === invoice)?.payment_link?.url, first.data.url);
});

test('organizers · pagar ahora: fuera de su retiro, ids sin forma o apagado, nada llega a la pasarela', async () => {
  const invoice = await issued(R1, 120);
  const before = stripe.requests.length;
  const other = await org('/api/v1/payments/link', { token: otra, body: { reservation_id: R2, issued_invoice_id: invoice } });
  assert.deepEqual([other.status, other.data.error.code], [403, 'OUT_OF_SCOPE']);
  const foreign = await org('/api/v1/payments/link', { token: otra, body: { reservation_id: R1, issued_invoice_id: invoice } });
  assert.deepEqual([foreign.status, foreign.data.error.code], [403, 'OUT_OF_SCOPE']);
  const bad = await org('/api/v1/payments/link', { token: ana, body: { reservation_id: 'x', issued_invoice_id: invoice } });
  assert.deepEqual([bad.status, bad.data.error.code], [422, 'INVALID_ARGS']);
  assert.deepEqual((await off('/api/v1/payments/config', { token: ana })).data, { online: false });
  const refused = await off('/api/v1/payments/link', { token: ana, body: { reservation_id: R1, issued_invoice_id: invoice } });
  assert.deepEqual([refused.status, refused.data.error.code], [503, 'PAYMENTS_OFF']);
  assert.equal(stripe.requests.length, before, 'ninguna sesión de Stripe');
});
