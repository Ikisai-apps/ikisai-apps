/** Booking · seguridad B8 (1407): las peticiones públicas del QR tienen límite por visitante y por evento. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, isFault, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { applyPublicOperations } from '../../supabase/functions/_kit/public-write.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });
async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `vr-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const join = (code: string, visitor: string) =>
  applyPublicOperations(db(), 'booking', [{ op: 'insert', table: TABLES.visitorRequests, id: uuid(), fields: { via_code: code, visitor_id: visitor, kind: 'join', name: 'Visitante' } }], visitor);
async function codeOf(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (e) { return isFault(e) ? e.code : (String((e as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(e)); }
}
/** Peticiones ya hechas (sin pasar por la guarda), descartadas para no chocar con «una pendiente». */
async function past(event: string, visitor: string, n: number) {
  await app.t.db.exec(`select set_config('booking.visitor_procedure', 'on', false);
    insert into booking.visitor_requests (event_id, visitor_id, kind, status, decided_at)
      select '${event}', '${visitor}', 'contact', 'descartada', now() from generate_series(1, ${n});
    select set_config('booking.visitor_procedure', '', false);`);
}
async function event() {
  const res = uuid(); const ev = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas del límite', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2033-01-07', end_date: '2033-01-09', expected_guests: 300, guests_visible: true } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: ev, from_status: 'pre_reservada' } }]);
  return { ev, code: (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [ev])).rows[0]!.c };
}

test('B8 · 20 por visitante en una hora; 120 por evento en 10 minutos', async () => {
  const a = await event();
  const busy = (await issueVisitor(db(), a.code)).visitorId;
  await past(a.ev, busy, 20);
  assert.equal(await codeOf(join(a.code, busy)), 'RATE_LIMITED', 'el mismo visitante');
  const calm = (await issueVisitor(db(), a.code)).visitorId;
  assert.equal(await codeOf(join(a.code, calm)), 'OK', 'otro visitante, sí');

  const b = await event();
  for (let i = 0; i < 6; i++) await past(b.ev, uuid(), 20);
  assert.equal(await codeOf(join(b.code, (await issueVisitor(db(), b.code)).visitorId)), 'RATE_LIMITED', 'el evento');
});
