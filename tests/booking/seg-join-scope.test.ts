/** Booking · seguridad B7 (1408): aceptar a un visitante (crea fichas) exige el ámbito de huéspedes; descartar, no. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { applyPublicOperations } from '../../supabase/functions/_kit/public-write.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `js-${++seq}-${uuid()}`, operations }, ...(token ? { token } : {}) });
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });

test('B7 · un editor sin ámbito de huéspedes no acepta (no crea fichas), pero sí descarta; con ámbito, acepta', async () => {
  const res = uuid(); const ev = uuid();
  assert.equal((await commit([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas B7', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-02-04', end_date: '2033-02-06', expected_guests: 50, guests_visible: true } }])).status, 200);
  assert.equal((await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: ev, from_status: 'pre_reservada' } }])).status, 200);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [ev])).rows[0]!.c;
  const ask = async () => {
    const { visitorId } = await issueVisitor(db(), code);
    const id = uuid();
    await applyPublicOperations(db(), 'booking', [{ op: 'insert', table: TABLES.visitorRequests, id, fields: { via_code: code, visitor_id: visitorId, kind: 'join', name: 'Visitante B7' } }], visitorId);
    return id;
  };
  const editor = async (scopes: Record<string, unknown>) => {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, 'editor', $2)`, [user, JSON.stringify(scopes)]);
    return app.supabase.tokenFor(user);
  };
  const plain = await editor({});
  const scoped = await editor({ guests: true });
  const decide = (request: string, decision: string, token: string) => commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: request, decision } }], token);

  const first = await ask();
  const denied = await decide(first, 'accept', plain);
  assert.equal(denied.data?.error?.code, 'FORBIDDEN', JSON.stringify(denied.data));
  assert.equal((await app.t.db.query(`select 1 from booking.guests where event_id = $1`, [ev])).rows.length, 0, 'ninguna ficha');
  assert.equal((await decide(first, 'reject', plain)).status, 200, 'descartar sí');

  const second = await ask();
  assert.equal((await decide(second, 'accept', scoped)).status, 200);
  assert.equal((await app.t.db.query(`select 1 from booking.guests where event_id = $1`, [ev])).rows.length, 1);
});
