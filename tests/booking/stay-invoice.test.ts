/** Booking · factura a petición de las noches (1424, vg-38; contrato con Finance): Booking reenvía, no guarda. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { checkInvoiceCustomer, PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-worker-factura';
// Finance falsa: solo la ruta de la factura a petición (los datos sintéticos)
const asked: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];
let financeOn = true;
const invoices = new Map<string, { request_id: string; status: string }>();
const financeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  asked.push({ method: init?.method ?? 'GET', url, headers, body });
  if (!url.includes('/invoices-api/api/v1/worker/entry-invoice')) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  if (!financeOn) return Response.json({}, { status: 404 });
  if ((init?.method ?? 'GET') === 'GET') {
    const found = invoices.get(new URL(url).searchParams.get('source') ?? '');
    return found ? Response.json(found) : Response.json({ error: { code: 'NOT_REQUESTED' } }, { status: 404 });
  }
  if (body?.customer?.tax_id === '00000000X') return Response.json({ error: { code: 'TAX_ID_INVALID', message: 'NIF no válido', details: { field: 'tax_id' } } }, { status: 422 });
  const prev = invoices.get(body.source);
  if (prev && prev.status !== 'descartada' && prev.request_id !== body.request_id) return Response.json({ error: { code: 'ALREADY_REQUESTED', details: prev } }, { status: 409 });
  const row = { request_id: body.request_id, status: 'pendiente' };
  invoices.set(body.source, row);
  return Response.json(row);
};
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, appsFetch: financeFetch }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `inv-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));
const customer = { name: 'Empresa Sintética SL', tax_id: 'b-1234567-4', kind: 'empresa', address: { line: 'Calle Falsa 1', postal_code: '28000', city: 'Madrid' } };

test('el destinatario se comprueba por forma: nombre, NIF, tipo, país y dirección para empresa', () => {
  assert.deepEqual(checkInvoiceCustomer({ name: 'Ana', tax_id: '12345678z' }), { customer: { name: 'Ana', tax_id: '12345678Z', id_type: 'NIF', country: 'ES', kind: 'particular' } });
  assert.deepEqual(checkInvoiceCustomer({ name: 'X SL', tax_id: 'B12345674', kind: 'empresa' }), { field: 'address' });
  assert.deepEqual(checkInvoiceCustomer({ tax_id: 'B12345674' }), { field: 'name' });
  assert.deepEqual(checkInvoiceCustomer({ name: 'Ana', tax_id: '12345678Z', id_type: 'DNI' }), { field: 'id_type' });
  assert.equal((checkInvoiceCustomer(customer) as any).customer.tax_id, 'B12345674');
});

test('el visitante pide factura de lo cobrado; Booking la pide a Finance por cobro y no guarda los datos fiscales', async () => {
  const res = uuid(); const event = uuid(); const space = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas con factura', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2040-07-01', end_date: '2040-07-03', expected_guests: 50, guests_visible: true } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab factura', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama factura', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2040-07-01', valid_to: '2040-07-03' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  const v = await issueVisitor(db(), code);
  const stay = await (await post('stay', { event_code: code, from: '2040-07-01', to: '2040-07-03', persons: 1, name: 'Eva' }, { 'X-Visitor': v.token })).json();

  // sin cobrar, nada que facturar
  assert.equal((await (await post('stay/invoice', { stay_id: stay.id, customer }, { 'X-Visitor': v.token })).json()).error?.code, 'NOTHING_TO_INVOICE');

  // recepción cobra y aloja; el cobro aún no está en Finance
  await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: stay.id, decision: 'accept', method: 'cash' } }]);
  const charge = (await app.t.db.query<{ id: string }>(`select c.id from booking.walkin_charges c join booking.visitor_requests q on q.guest_id = c.guest_id where q.id = $1`, [stay.id])).rows[0]!.id;
  const notYet = await (await post('stay/invoice', { stay_id: stay.id, customer }, { 'X-Visitor': v.token })).json();
  assert.deepEqual(notYet.invoices.map((i: any) => i.status), ['sin_apunte']);

  // ya en Finance: se pide, con la clave de worker y quién llama; repetir lo mismo usa el mismo request_id
  await app.t.db.query(`update booking.walkin_charges set finance_sent_at = now(), finance_entry_id = gen_random_uuid() where id = $1`, [charge]);
  asked.length = 0;
  const first = await (await post('stay/invoice', { stay_id: stay.id, customer }, { 'X-Visitor': v.token })).json();
  assert.deepEqual(first.invoices, [{ charge_id: charge, status: 'pendiente', issued_invoice_id: null, full_number: null, pdf_url: null }]);
  const call = asked.find((a) => a.method === 'POST' && a.url.endsWith('/worker/entry-invoice'))!;
  assert.deepEqual([call.headers['x-ikisai-worker-key'], call.headers['x-ikisai-caller'], call.body.source], [WORKER_KEY, 'booking', `booking:stay:${charge}`]);
  assert.equal(call.body.customer.tax_id, 'B12345674');
  // repetir: ya hay una pedida, no se vuelve a pedir
  const posts = () => asked.filter((a) => a.method === 'POST').length;
  const before = posts();
  assert.equal((await (await post('stay/invoice', { stay_id: stay.id, customer }, { 'X-Visitor': v.token })).json()).invoices[0].status, 'pendiente');
  assert.equal(posts(), before);
  // Finance descarta el borrador: se puede volver a pedir, con otro request_id
  invoices.get(`booking:stay:${charge}`)!.status = 'descartada';
  assert.equal((await (await post('stay/invoice', { stay_id: stay.id, customer }, { 'X-Visitor': v.token })).json()).invoices[0].status, 'pendiente');
  const retried = asked.filter((a) => a.method === 'POST').at(-1)!;
  assert.notEqual(retried.body.request_id, call.body.request_id);
  const leaked = (await app.t.db.query(`select 1 from booking.guests g where g.event_id = $1 and (g::text ilike '%B12345674%' or g::text ilike '%Sintética SL%')`, [event])).rows.length;
  assert.equal(leaked, 0, 'Booking no guarda los datos fiscales');

  // errores: NIF que Finance rechaza, datos mal, otro visitante, Finance sin la ruta
  invoices.clear();
  const badTax = await (await post('stay/invoice', { stay_id: stay.id, customer: { ...customer, tax_id: '00000000X' } }, { 'X-Visitor': v.token })).json();
  assert.equal(badTax.error?.code, 'TAX_ID_INVALID');
  assert.equal((await app.call(`/api/v1/walkins/${charge}/invoice`, { method: 'GET' })).data?.error?.code, 'NOT_REQUESTED');
  assert.equal((await (await post('stay/invoice', { stay_id: stay.id, customer: { name: 'Sin NIF' } }, { 'X-Visitor': v.token })).json()).error?.details?.field, 'tax_id');
  const other = await issueVisitor(db(), code);
  assert.equal((await post('stay/invoice', { stay_id: stay.id, customer }, { 'X-Visitor': other.token })).status, 404);
  financeOn = false;
  assert.equal((await (await post('stay/invoice', { stay_id: stay.id, customer }, { 'X-Visitor': v.token })).json()).error?.code, 'INVOICES_OFF');
  financeOn = true;

  // desde recepción: pedir y consultar
  const staff = await app.call(`/api/v1/walkins/${charge}/invoice`, { body: { customer } });
  assert.equal(staff.data.status, 'pendiente', JSON.stringify(staff.data));
  const status = await app.call(`/api/v1/walkins/${charge}/invoice`, { method: 'GET' });
  assert.equal(status.data.status, 'pendiente', JSON.stringify(status.data));
  assert.ok(asked.at(-1)!.url.includes(`source=${encodeURIComponent(`booking:stay:${charge}`)}`));
});
