/**
 * Núcleo · la casa contesta a quien organiza (0117; MUELA/equipo/feedback/organizers/RESPUESTAS_CASA.md). Booking (editor)
 * contesta a un informe de quien organiza sobre su retiro; quien organiza lo ve firmado «Ikisai» y lo marca como visto. Nadie
 * más lo ve ni contesta. Las Edge de Booking y Organizers sobre PGlite; el recuento de Organizers, puro. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';
import { repliesOf, unreadRepliesByReservation, type Reply } from '../../apps/organizers/src/app/replies.ts';

const uuid = () => crypto.randomUUID();
let booking: TestApp;
let organizers: (r: Request) => Promise<Response>;
let seq = 0;

async function org(path: string, init: { token?: string; body?: unknown } = {}): Promise<{ status: number; data: any }> {
  const res = await organizers(new Request(`${booking.supabase.url}/functions/v1/organizers-api${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORGANIZERS_ORIGINS[0]!, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function reservation(title: string): Promise<string> {
  const id = uuid();
  const res = await booking.call('/api/v1/commands', { body: { requestId: `fr-${++seq}-${uuid()}`, operations: [
    { op: 'insert', table: BOOKING.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2026-11-06', end_date: '2026-11-08', expected_guests: 8 } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}
async function organizerSession(reservation_id: string, email: string): Promise<{ token: string; id: string }> {
  const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const session = await org('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const me = await org('/api/v1/me', { token: session.data.token });
  return { token: session.data.token, id: me.data.userId };
}
/** Un informe tal como lo guarda el núcleo: de quien organiza (sobre su retiro) o de un huésped. */
async function report(reporter: string, kind: 'organizer' | 'guest', reservation_id: string): Promise<string> {
  const id = uuid();
  await booking.t.db.query(`insert into core.feedback_reports (id, code, request_id, digest, reporter_user_id, reporter_kind, origin_app, subject, intent, message, category, scope, destination, routing_status)
    values ($1, 'FB_FR_' || $2, $3, 'd', $4, $5, $6, 'event', 'problem', 'Falta la llave del aula.', null, $7::jsonb, 'operations', 'none')`,
  [id, String(++seq), `fr-${seq}`, reporter, kind, kind === 'organizer' ? 'organizers' : 'guests', JSON.stringify({ reservation_id })]);
  return id;
}

let R1: string; let R2: string; let ana: { token: string; id: string }; let otra: { token: string; id: string };

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  organizers = createOrganizersApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test', origins: [ORGANIZERS_ORIGINS[0]!] });
  R1 = await reservation('Retiro de Ana');
  R2 = await reservation('Retiro de otra');
  ana = await organizerSession(R1, 'ana-fr@example.invalid');
  otra = await organizerSession(R2, 'otra-fr@example.invalid');
});
test.after(async () => { await booking.close(); });

test('núcleo · respuestas: Booking contesta a quien organiza, que lo ve firmado «Ikisai» y lo marca como visto', async () => {
  const id = await report(ana.id, 'organizer', R1);
  const sent = await booking.call(`/api/v1/feedback/${id}/replies`, { token: booking.tokens.editor, body: { message: '  Mañana a las 9 la tenéis en recepción.  ' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  // La casa ve quién contestó; quien organiza, no.
  const staff = await booking.call(`/api/v1/feedback/${id}/replies`, { token: booking.tokens.editor, method: 'GET' });
  assert.equal(staff.status, 200, JSON.stringify(staff.data));
  assert.equal(staff.data.items[0].message, 'Mañana a las 9 la tenéis en recepción.');
  assert.ok(staff.data.items[0].author);
  const own = await org(`/api/v1/feedback/${id}/replies`, { token: ana.token });
  assert.equal(own.data.items[0].author, null);

  const mine = await org('/api/v1/feedback/replies', { token: ana.token });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.data.items.length, 1);
  assert.deepEqual([mine.data.items[0].report_id, mine.data.items[0].reservation_id, mine.data.items[0].read], [id, R1, false]);
  // Otra organizadora no la marca ni la ve.
  assert.deepEqual((await org('/api/v1/feedback/replies/read', { token: otra.token, body: { ids: [sent.data.id] } })).data, { read: 0 });
  assert.deepEqual((await org('/api/v1/feedback/replies', { token: otra.token })).data.items, []);
  assert.equal((await org(`/api/v1/feedback/${id}/replies`, { token: otra.token })).status, 404);
  assert.deepEqual((await org('/api/v1/feedback/replies/read', { token: ana.token, body: { ids: [sent.data.id] } })).data, { read: 1 });
  assert.equal((await org('/api/v1/feedback/replies', { token: ana.token })).data.items[0].read, true);
});

test('núcleo · respuestas: no contestan quien organiza, otra organizadora ni un lector; ni a un huésped; ni vacío ni largo', async () => {
  const id = await report(ana.id, 'organizer', R1);
  const own = await org(`/api/v1/feedback/${id}/replies`, { token: ana.token, body: { message: 'Me contesto.' } });
  assert.deepEqual([own.status, own.data.error.code], [403, 'FORBIDDEN']);
  const other = await org(`/api/v1/feedback/${id}/replies`, { token: otra.token, body: { message: 'Hola.' } });
  assert.deepEqual([other.status, other.data.error.code], [404, 'OUT_OF_SCOPE']);
  const reader = await booking.call(`/api/v1/feedback/${id}/replies`, { token: booking.tokens.reader, body: { message: 'Hola.' } });
  assert.equal(reader.status, 404, JSON.stringify(reader.data));
  const guest = await report(booking.users.reader, 'guest', R1);
  const toGuest = await booking.call(`/api/v1/feedback/${guest}/replies`, { token: booking.tokens.editor, body: { message: 'Hola.' } });
  assert.deepEqual([toGuest.status, toGuest.data.error.code], [403, 'FORBIDDEN']);
  for (const message of ['   ', 'x'.repeat(2001)]) {
    const bad = await booking.call(`/api/v1/feedback/${id}/replies`, { token: booking.tokens.editor, body: { message } });
    assert.equal(bad.status, 422, JSON.stringify(bad.data));
  }
  assert.equal((await booking.t.db.query('select 1 from core.feedback_replies where report_id = $1', [id])).rows.length, 0);
});

test('organizers · respuestas: «N respuestas» por retiro, solo las sin ver; las de un informe, en orden', () => {
  const R = uuid(); const S = uuid();
  const reply = (over: Partial<Reply>): Reply => ({ id: uuid(), report_id: 'a', reservation_id: R, message: 'm', created_at: '2026-10-28T10:00:00Z', read: false, ...over });
  const items = [reply({}), reply({ reservation_id: R.toUpperCase(), created_at: '2026-10-28T09:00:00Z' }), reply({ read: true }), reply({ reservation_id: S, report_id: 'b' }), reply({ reservation_id: null })];
  assert.deepEqual([...unreadRepliesByReservation(items)].sort(), [[R, 2], [S, 1]].sort());
  assert.deepEqual(repliesOf(items, 'a').map((r) => r.created_at)[0], '2026-10-28T09:00:00Z');
});
