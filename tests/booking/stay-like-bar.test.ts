/** Booking · Alojamiento libre «como la barra» (1400): número corto, cama elegida, borrador del viajero y lecturas públicas. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, visibleBookingRow, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `lb-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
}
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, token: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', 'X-Visitor': token }, body: JSON.stringify(body) }));
const read = (name: string, args: Record<string, unknown>) => app.t.rpc('core_public_read', { p_name: name, p_args: args }) as Promise<any>;

async function openDays() {
  const res = uuid(); const event = uuid(); const space = uuid(); const beds = [uuid(), uuid(), uuid()]; const rate = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas de la barra', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2032-06-05', end_date: '2032-06-07', expected_guests: 100, guests_visible: true, lodging_hold_hours: 2 } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab interna 7', public_name: 'Habitación del pinar', kind: 'habitacion' } },
    ...beds.map((id, i) => ({ op: 'insert', table: TABLES.beds, id, fields: { space_id: space, label: `Cama ${i + 1}`, capacity: 1 } })),
    { op: 'insert', table: 'booking.rates', id: rate, fields: { name: 'Cama', layer: 'por_persona', unit: 'persona_noche', amount: 18, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2032-06-05', valid_to: '2032-06-07' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  return { res, event, space, beds, rate, code };
}

test('Alójate aquí: camas para elegir, número corto, cama elegida o asignada, borrador y lo que falta', async () => {
  const d = await openDays();
  // camas públicas: el nombre público de la habitación, las camas libres y el precio; nada de personas
  const beds = await read('booking_public_beds', { event_code: d.code, from: '2032-06-05', to: '2032-06-06' });
  const room = beds.rooms.find((r: any) => r.id === d.space);
  assert.deepEqual([beds.nights, beds.price_night_cents, room.name, room.beds.length, room.beds.every((b: any) => b.free)], [1, 1800, 'Habitación del pinar', 3, true]);

  // el primero elige la cama 2, con su borrador; recibe el número 1
  const a = await issueVisitor(db(), d.code);
  const first = await post('stay', { event_code: d.code, from: '2032-06-05', to: '2032-06-06', persons: 1, bed_id: d.beds[1],
    traveler: { first_name: 'Ana', last_name_1: 'Sintética', document_type: 'Pasaporte', email: 'ana@example.invalid', nationality: 'fra' } }, a.token);
  assert.equal(first.status, 200, await first.clone().text());
  const one = await first.json();
  assert.deepEqual([one.number, one.status, one.stay_status, one.total_cents, one.pay, one.bed], [1, 'pendiente', 'por_pagar', 1800, 'hold', { room: 'Habitación del pinar', label: 'Cama 2' }]);
  assert.ok(new Date(one.hold_until).getTime() <= Date.now() + 2 * 3600_000 + 60_000, 'las 2 horas del evento');
  assert.deepEqual(one.missing, [['birth_date', 'residence_address', 'residence_postal_code', 'residence_city', 'residence_country', 'document_number']]);
  assert.ok(!JSON.stringify(one).includes('example.invalid'), 'los datos no vuelven');

  // ya no está libre para otro; quien la pida, BED_TAKEN; sin elegir, se le asigna otra y es el número 2
  assert.equal((await read('booking_public_beds', { event_code: d.code, from: '2032-06-05', to: '2032-06-06' })).rooms.find((r: any) => r.id === d.space).beds.find((b: any) => b.id === d.beds[1]).free, false);
  const b = await issueVisitor(db(), d.code);
  const taken = await post('stay', { event_code: d.code, from: '2032-06-05', to: '2032-06-06', persons: 1, bed_ids: [d.beds[1]], name: 'Bea' }, b.token);
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error.code, 'BED_TAKEN');
  const auto = await (await post('stay', { event_code: d.code, from: '2032-06-05', to: '2032-06-06', persons: 1, assign: true, name: 'Bea' }, b.token)).json();
  assert.equal(auto.number, 2);
  assert.notDeepEqual(auto.bed, { room: 'Habitación del pinar', label: 'Cama 2' }, 'otra cama, no la elegida por el primero');

  // completar el borrador después: solo lo del visitante dueño; dice lo que falta
  const more = await post('stay/traveler', { stay_id: one.id, fields: { birth_date: '1990-01-02', residence_address: 'Calle Sintética 1', residence_postal_code: '00000', residence_city: 'Ciudad', residence_country: 'FRA', document_number: 'x123' } }, a.token);
  assert.equal(more.status, 200, await more.clone().text());
  assert.deepEqual((await more.json()).missing, [[]]);
  const draft = (await app.t.db.query<Record<string, any>>(`select * from booking.stay_travelers where request_id = $1`, [one.id])).rows;
  assert.deepEqual([draft.length, draft[0]!.first_name, draft[0]!.document_number, draft[0]!.nationality], [1, 'Ana', 'X123', 'FRA']);
  const stranger = await post('stay/traveler', { request_id: one.id, traveler: { first_name: 'Intrusa' } }, b.token);
  assert.equal(stranger.status, 404, 'no es suya');

  // lo que ve el visitante
  const stay = await read('booking_visitor_stay', { visitor_id: a.visitorId, event_code: d.code });
  assert.deepEqual([stay.id, stay.number, stay.stay_status, stay.beds], [one.id, 1, 'por_pagar', [{ room: 'Habitación del pinar', label: 'Cama 2' }]]);

  // el borrador es dato de huésped: la Edge no se lo da a un editor sin ámbito (igual que la ficha)
  const ctx = (role: string, scopes: Record<string, unknown> = {}) => ({ membership: { role, scopes } }) as never;
  assert.equal(visibleBookingRow(TABLES.stayTravelers, {}, ctx('editor')), false);
  assert.equal(visibleBookingRow(TABLES.stayTravelers, {}, ctx('editor', { guests: true })), true);
  assert.equal(visibleBookingRow(TABLES.stayTravelers, {}, ctx('owner')), true);
});
  assert.ok(!JSON.stringify(pull.data ?? {}).includes('Sintética'), JSON.stringify(pull.data).slice(0, 300));
});
