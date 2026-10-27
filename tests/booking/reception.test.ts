/** Booking · «Recepción» (1401): cobrar y alojar en un gesto una solicitud de noches del QR. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `rc-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, token: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', 'X-Visitor': token }, body: JSON.stringify(body) }));
const read = (name: string, args: Record<string, unknown>) => app.t.rpc('core_public_read', { p_name: name, p_args: args }) as Promise<any>;
const accept = (requestId: string, method?: string) => commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: requestId, decision: 'accept', ...(method ? { method } : {}) } }]);

async function openDays(start: string, end: string, fields: Record<string, unknown> = {}) {
  const res = uuid(); const event = uuid(); const space = uuid(); const beds = [uuid(), uuid(), uuid()]; const rate = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas de recepción', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 100, guests_visible: true, ...fields } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: `Albergue ${start}`, kind: 'habitacion' } },
    ...beds.map((id, i) => ({ op: 'insert', table: TABLES.beds, id, fields: { space_id: space, label: `Cama ${i + 1}`, capacity: 1 } })),
    { op: 'insert', table: 'booking.rates', id: rate, fields: { name: `Cama ${start}`, layer: 'por_persona', unit: 'persona_noche', amount: 15, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: start, valid_to: end } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  return { res, event, space, beds, rate, code };
}

test('cobrar y alojar: ficha con el borrador, la cama elegida con sus fechas y el cobro ya cobrado; el visitante lo ve', async () => {
  const d = await openDays('2032-07-03', '2032-07-05');
  const v = await issueVisitor(db(), d.code);
  const stay = await (await post('stay', { event_code: d.code, from: '2032-07-03', to: '2032-07-05', persons: 1, bed_id: d.beds[2],
    traveler: { first_name: 'Ana', last_name_1: 'Sintética', document_type: 'Pasaporte', document_number: 'P123', email: 'ana@example.invalid' } }, v.token)).json();
  assert.equal(stay.stay_status, 'por_pagar');

  const out = await accept(stay.id, 'bizum');
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const req = (await app.t.db.query<Record<string, any>>(`select * from booking.visitor_requests where id = $1`, [stay.id])).rows[0]!;
  assert.equal(req.status, 'aceptada');
  const guest = (await app.t.db.query<Record<string, any>>(`select * from booking.guests where id = $1`, [req.guest_id])).rows[0]!;
  assert.deepEqual([guest.first_name, guest.last_name_1, guest.document_type, guest.document_number, guest.email], ['Ana', 'Sintética', 'Pasaporte', 'P123', 'ana@example.invalid']);
  assert.equal((await app.t.db.query(`select 1 from booking.stay_travelers where request_id = $1 and deleted_at is null`, [stay.id])).rows.length, 0, 'el borrador se borra al pasarlo');
  const assignment = (await app.t.db.query<Record<string, any>>(`select bed_id, from_date::text f, to_date::text t, persons from booking.room_assignments where guest_id = $1 and deleted_at is null`, [guest.id])).rows;
  assert.deepEqual(assignment, [{ bed_id: d.beds[2], f: '2032-07-03', t: '2032-07-05', persons: 1 }]);
  const charge = (await app.t.db.query<Record<string, any>>(`select nights, price_cents, amount_cents, method, paid_at from booking.walkin_charges where guest_id = $1`, [guest.id])).rows[0]!;
  assert.deepEqual([charge.nights, charge.price_cents, charge.amount_cents, charge.method, !!charge.paid_at], [2, 1500, 3000, 'bizum', true]);
  const seen = await read('booking_visitor_stay', { visitor_id: v.visitorId, event_code: d.code });
  assert.deepEqual([seen.stay_status, seen.beds, !!seen.paid_at], ['pagada', [{ room: `Albergue 2032-07-03`, label: 'Cama 3' }], true]);

  // repetir no duplica nada
  assert.equal((await accept(stay.id, 'bizum')).status, 200);
  assert.equal((await app.t.db.query(`select 1 from booking.walkin_charges where event_id = $1 and deleted_at is null`, [d.event])).rows.length, 1);

  // llegada: el visitante pasa a «alojado»
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.guestArrive, args: { guest_id: guest.id } }])).status, 200);
  assert.equal((await read('booking_visitor_stay', { visitor_id: v.visitorId, event_code: d.code })).stay_status, 'alojado');
});

test('sin método queda por cobrar; dos personas, dos fichas; Bitcoin vale; un método raro, no', async () => {
  const d = await openDays('2032-08-07', '2032-08-09', { lodging_pay_mode: 'pay_first' });
  const v = await issueVisitor(db(), d.code);
  const stay = await (await post('stay', { event_code: d.code, from: '2032-08-07', to: '2032-08-08', persons: 2, name: 'Luis' }, v.token)).json();
  assert.equal((await accept(stay.id, 'cheque')).data?.error?.code, 'INVALID_FIELDS');
  assert.equal((await accept(stay.id)).status, 200);
  const guests = (await app.t.db.query<{ first_name: string }>(`select first_name from booking.guests where event_id = $1 and deleted_at is null order by created_at, first_name`, [d.event])).rows.map((g) => g.first_name);
  assert.deepEqual(guests.sort(), ['Acompañante 1 de Luis', 'Luis']);
  const charges = (await app.t.db.query<Record<string, any>>(`select amount_cents, method from booking.walkin_charges where event_id = $1 and deleted_at is null`, [d.event])).rows;
  assert.equal(charges.reduce((s, c) => s + Number(c.amount_cents), 0), 1500 * 2);
  assert.ok(charges.every((c) => c.method === null), 'por cobrar');
  assert.equal((await read('booking_visitor_stay', { visitor_id: v.visitorId, event_code: d.code })).stay_status, 'por_pagar');

  // Bitcoin como método del cobro (0487 + 1401)
  const w = await issueVisitor(db(), d.code);
  const other = await (await post('stay', { event_code: d.code, from: '2032-08-08', to: '2032-08-09', persons: 1, name: 'Eva' }, w.token)).json();
  assert.equal((await accept(other.id, 'bitcoin')).status, 200);
  assert.equal((await app.t.db.query<{ m: string }>(`select c.method m from booking.walkin_charges c join booking.visitor_requests q on q.guest_id = c.guest_id where q.id = $1`, [other.id])).rows[0]!.m, 'bitcoin');
});

test('retención caducada y la cama elegida ocupada: se aloja en otra libre; sin ninguna, NO_AVAILABILITY sin nada a medias', async () => {
  const d = await openDays('2032-09-04', '2032-09-05');
  const v = await issueVisitor(db(), d.code);
  const stay = await (await post('stay', { event_code: d.code, from: '2032-09-04', to: '2032-09-05', persons: 1, bed_id: d.beds[0], name: 'Mar' }, v.token)).json();
  await app.t.db.exec(`select set_config('booking.visitor_procedure', 'on', false);
    update booking.visitor_requests set hold_until = now() - interval '1 minute' where id = '${stay.id}';
    select set_config('booking.visitor_procedure', '', false);`);
  // el personal da la cama 1 (ya no está retenida) y la 2
  const walk = [uuid(), uuid()];
  await ok(walk.map((id, i) => ({ op: 'insert', table: TABLES.guests, id, fields: { event_id: d.event, first_name: `Walk-in ${i}` } })));
  await ok(walk.map((id, i) => ({ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: d.event, space_id: d.space, bed_id: d.beds[i], guest_id: id, persons: 1, from_date: '2032-09-04', to_date: '2032-09-05' } })));
  assert.equal((await accept(stay.id, 'cash')).status, 200);
  const bed = (await app.t.db.query<{ b: string }>(`select a.bed_id b from booking.room_assignments a join booking.visitor_requests q on q.guest_id = a.guest_id where q.id = $1`, [stay.id])).rows[0]!.b;
  assert.equal(bed, d.beds[2], 'la que queda libre');

  // otra caducada sin camas: nada a medias
  const w = await issueVisitor(db(), d.code);
  const late = await (await post('stay', { event_code: d.code, from: '2032-09-04', to: '2032-09-05', persons: 1, name: 'Tarde' }, w.token)).json();
  assert.equal(late.error?.code ?? null, 'NO_AVAILABILITY', 'ni siquiera se puede pedir: no queda sitio');
  const before = Number((await app.t.db.query<{ n: string }>(`select count(*) n from booking.guests where event_id = $1`, [d.event])).rows[0]!.n);
  assert.ok(before >= 3);
});
