/** Booking · alojamiento a la carta (0487): la ruta que manda el cobro a Finance (invoices.record_app_entry). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES, walkinFinanceEntry, walkinNightPrice } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const sent: Array<{ url: string; auth: string | null; body: any }> = [];
let financeStatus = 200;
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], appsFetch: (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init.headers).get('Authorization'), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(financeStatus === 200 ? { results: [{ result: { entry_id: 'e-1', status: 'created' } }] } : { error: { code: 'NO_MEMBERSHIP', message: 'x' } }), { status: financeStatus, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch }),
  });
});
test.after(async () => { await app.close(); });
async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `wf-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

test('precio por noche: la tarifa de alojamiento por persona y noche del tipo y del día', () => {
  const rates = [
    { id: 'a', service: 'alojamiento', unit: 'persona_noche', amount: 40, active: true, event_types: ['retiro'], position: 1 },
    { id: 'b', service: 'alojamiento', unit: 'persona_noche', amount: '25.5', active: true, event_types: null, valid_to: '2031-12-31', position: 2 },
    { id: 'c', service: 'comidas', unit: 'persona_noche', amount: 10, active: true, position: 0 },
  ];
  assert.deepEqual(walkinNightPrice(rates, 'jornadas_abiertas', '2031-10-30'), { rateId: 'b', cents: 2550 });
  assert.equal(walkinNightPrice(rates, 'jornadas_abiertas', '2032-01-01'), null);
  assert.deepEqual(walkinNightPrice(rates, 'retiro', '2031-10-30')?.rateId, 'a');
});

test('envío a Finance: apunte con source_ref booking:stay:<id>, la sesión de la persona; sin cobrar, 409; sin acceso, NEEDS_ACCESS', async () => {
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid(); const guest = uuid(); const assignment = uuid(); const charge = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2031-10-30', end_date: '2031-11-01', expected_guests: 50 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Albergue', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 3' } },
    { op: 'insert', table: TABLES.guests, id: guest, fields: { event_id: event, first_name: 'Ana', last_name_1: 'Sintética' } },
    { op: 'insert', table: TABLES.roomAssignments, id: assignment, fields: { event_id: event, space_id: space, bed_id: bed, guest_id: guest, persons: 1, from_date: '2031-10-30', to_date: '2031-11-01' } },
    { op: 'insert', table: TABLES.walkinCharges, id: charge, fields: { event_id: event, assignment_id: assignment, guest_id: guest, nights: 2, price_cents: 2500, amount_cents: 5000 } },
  ]);
  const send = () => app.call(`/api/v1/walkins/${charge}/send/finance`, { body: {} });
  assert.equal((await send()).data?.error?.code, 'NOT_PAID');
  assert.equal(sent.length, 0);
  const bad = await app.call('/api/v1/commands', { body: { requestId: `wf-${++seq}`, operations: [{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: 1, fields: { amount_cents: 4000 } }] } });
  assert.equal(bad.status, 422, 'el importe es noches × precio');
  await ok([{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: 1, fields: { method: 'cash', paid_at: '2031-10-30T19:00:00Z' } }]);
  const out = await send();
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data.result, { entry_id: 'e-1', status: 'created' });
  assert.match(sent[0]!.url, /\/functions\/v1\/invoices-api\/api\/v1\/commands$/);
  assert.match(String(sent[0]!.auth), /^Bearer /);
  const call = sent[0]!.body.operations[0];
  assert.equal(call.procedure, 'invoices.record_app_entry');
  assert.deepEqual({ ...call.args, description: undefined }, { ...walkinFinanceEntry({ id: charge, event_id: event, nights: 2, price_cents: 2500, amount_cents: 5000, method: 'cash', paid_day: '2031-10-30', title: 'Jornadas', guest: 'Ana S.', space: 'Albergue', bed: 'Cama 3' }), description: undefined });
  assert.equal(call.args.source_ref, `booking:stay:${charge}`);
  assert.deepEqual(call.args.methods, { cash: 5000 });
  // un editor que no ve huéspedes manda el apunte sin el nombre
  const plain = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'editor')`, [plain]);
  const plainToken = app.supabase.tokenFor(plain);
  const before = sent.length;
  const noName = await app.call(`/api/v1/walkins/${charge}/send/finance`, { token: plainToken, body: {} });
  assert.equal(noName.status, 200, JSON.stringify(noName.data));
  assert.ok(!String(sent[before]!.body.operations[0].args.description).includes('Ana'));
  // el cobro toma el evento y el huésped de su asignación
  const row = (await app.t.db.query<{ event_id: string; guest_id: string }>(`select event_id, guest_id from booking.walkin_charges where id = $1`, [charge])).rows[0]!;
  assert.deepEqual([row.event_id, row.guest_id], [event, guest]);
  financeStatus = 403;
  assert.equal((await send()).data?.error?.code, 'NEEDS_ACCESS');
  // un lector no envía
  assert.equal((await app.call(`/api/v1/walkins/${charge}/send/finance`, { token: app.tokens.reader, body: {} })).status, 403);
});
