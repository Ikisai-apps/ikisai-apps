/** Booking · venta en línea (1415, con la 0109 del núcleo): al confirmarse el pago, el servidor aloja solo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { fakePaymentProvider } from '../../supabase/functions/booking-api/payments.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const gateway = fakePaymentProvider('firma-auto');
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], payments: gateway }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `aa-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));

test('pagado en línea: el servidor aloja solo (ficha con el borrador, cama y cobro «online»); el sistema no aloja sin pagar', async () => {
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas que se alojan solas', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-07-01', end_date: '2033-07-03', expected_guests: 50, guests_visible: true, lodging_pay_mode: 'online' } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab automática', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 2', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama automática', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2033-07-01', valid_to: '2033-07-03' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  const v = await issueVisitor(db(), code);
  const stay = await (await post('stay', { event_code: code, from: '2033-07-01', to: '2033-07-03', persons: 1, bed_id: bed,
    traveler: { first_name: 'Noa', last_name_1: 'Sintética', email: 'noa@example.invalid' } }, { 'X-Visitor': v.token })).json();
  assert.equal((await post('stay/pay', { stay_id: stay.id }, { 'X-Visitor': v.token })).status, 200);
  const ref = (await app.t.db.query<{ r: string }>(`select provider_ref r from booking.stay_payments where request_id = $1`, [stay.id])).rows[0]!.r;

  const paid = await (await post('payments/fake', { eventId: 'ev-auto', providerRef: ref, status: 'paid' }, { 'X-Fake-Signature': 'firma-auto' })).json();
  assert.deepEqual([paid.status, paid.accepted], ['paid', true]);

  const req = (await app.t.db.query<{ status: string; guest_id: string }>(`select status, guest_id from booking.visitor_requests where id = $1`, [stay.id])).rows[0]!;
  assert.equal(req.status, 'aceptada');
  const guest = (await app.t.db.query<Record<string, any>>(`select first_name, last_name_1, email from booking.guests where id = $1`, [req.guest_id])).rows[0]!;
  assert.deepEqual([guest.first_name, guest.last_name_1, guest.email], ['Noa', 'Sintética', 'noa@example.invalid']);
  const stayRow = (await app.t.db.query<Record<string, any>>(`select a.bed_id, a.from_date::text f, a.to_date::text t, c.method, c.amount_cents, (c.paid_at is not null) paid
    from booking.room_assignments a join booking.walkin_charges c on c.assignment_id = a.id where a.guest_id = $1`, [req.guest_id])).rows[0]!;
  assert.deepEqual(stayRow, { bed_id: bed, f: '2033-07-01', t: '2033-07-03', method: 'online', amount_cents: 4000, paid: true });
  const seen = await app.t.rpc('core_public_read', { p_name: 'booking_visitor_stay', p_args: { visitor_id: v.visitorId, event_code: code } }) as any;
  assert.equal(seen.stay_status, 'pagada');

  // el aviso repetido no aloja dos veces
  await post('payments/fake', { eventId: 'ev-auto', providerRef: ref, status: 'paid' }, { 'X-Fake-Signature': 'firma-auto' });
  assert.equal((await app.t.db.query(`select 1 from booking.guests where event_id = $1 and deleted_at is null`, [event])).rows.length, 1);

  // el personal sigue necesitando el ámbito para aceptar; y nadie acepta «online» sin pago (lo comprueba la base)
  const other = await issueVisitor(db(), code);
  const unpaid = await (await post('stay', { event_code: code, from: '2033-07-02', to: '2033-07-03', persons: 1, name: 'Sin pagar' }, { 'X-Visitor': other.token })).json();
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: unpaid.id, decision: 'accept', method: 'online' } }])).data?.error?.code, 'NOT_PAID_ONLINE');
});
