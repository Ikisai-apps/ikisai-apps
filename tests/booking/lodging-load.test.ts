/**
 * Booking · carga ligera del sábado (alojamiento como la barra), en PGlite:
 * - 30 solicitudes públicas a la vez por la última cama: solo una la retiene y las demás reciben NO_AVAILABILITY, sin
 *   reservas fantasma;
 * - dos recepciones cobrando el mismo número a la vez: una sola estancia, una sola ficha y un solo cobro.
 */
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

const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `ld-${++seq}-${uuid()}`, operations }, ...(token ? { token } : {}) });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (body: unknown, token: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/stay`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', 'X-Visitor': token }, body: JSON.stringify(body) }));

test('sábado: 30 a la vez por la última cama y dos recepciones con el mismo número; nada doble', async () => {
  const t = app.t.db;
  // una casa de una sola cama libre: la habitación de esta prueba y ninguna otra en esta base
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Sábado con carga', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-03-05', end_date: '2033-03-06', expected_guests: 300, guests_visible: true } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'La última', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama única', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'] } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await t.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  const houseFree = Number((await t.query<{ n: string }>(`select coalesce(sum(places), 0) n from booking.free_beds('2033-03-05', '2033-03-06')`)).rows[0]!.n);
  assert.equal(houseFree, 1, 'solo queda una cama en toda la casa');

  // 30 visitantes distintos a la vez
  const tokens = await Promise.all(Array.from({ length: 30 }, () => issueVisitor(db(), code).then((v) => v.token)));
  const answers = await Promise.all(tokens.map((token, i) => post({ event_code: code, from: '2033-03-05', to: '2033-03-06', persons: 1, name: `Visitante ${i + 1}` }, token)));
  const statuses = answers.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1, `una sola la consigue: ${statuses.join(',')}`);
  assert.equal(statuses.filter((s) => s === 409).length, 29);
  const live = (await t.query<{ n: string }>(`select count(*) n from booking.visitor_requests where event_id = $1 and kind = 'stay' and status = 'pendiente'`, [event])).rows[0]!.n;
  assert.equal(Number(live), 1, 'sin reservas fantasma');
  const winner = await answers.find((r) => r.status === 200)!.json();
  assert.equal(winner.number, 1);

  // dos recepciones cobran el mismo número a la vez
  const staff = async () => { const u = await app.t.createUser(); await t.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, 'editor', '{"guests": true}')`, [u]); return app.supabase.tokenFor(u); };
  const [one, two] = [await staff(), await staff()];
  const accept = (token: string, method: string) => commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: winner.id, decision: 'accept', method } }], token);
  const both = await Promise.all([accept(one, 'cash'), accept(two, 'bizum')]);
  assert.ok(both.every((r) => r.status === 200), JSON.stringify(both.map((r) => r.data)));
  const guests = Number((await t.query<{ n: string }>(`select count(*) n from booking.guests where event_id = $1 and deleted_at is null`, [event])).rows[0]!.n);
  const stays = Number((await t.query<{ n: string }>(`select count(*) n from booking.room_assignments where event_id = $1 and deleted_at is null`, [event])).rows[0]!.n);
  const charges = (await t.query<{ method: string }>(`select method from booking.walkin_charges where event_id = $1 and deleted_at is null`, [event])).rows;
  assert.deepEqual([guests, stays, charges.length], [1, 1, 1], 'una ficha, una estancia y un cobro');
  assert.ok(['cash', 'bizum'].includes(charges[0]!.method), 'el método de quien llegó primero');
  assert.equal((await t.query(`select 1 from booking.free_beds('2033-03-05', '2033-03-06')`)).rows.length, 0, 'la cama ya no está libre');
});
