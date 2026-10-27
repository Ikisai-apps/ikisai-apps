/**
 * Organizers · comentarios del retiro (bandeja de quien organiza): lo que los asistentes cuentan en Guests sobre el retiro
 * llega a quien lo organiza, por `GET feedback?app=guests` de organizers-api, y solo lo de sus retiros. Lo de los espacios y
 * lo de la aplicación no le llega (lo atiende Ikisai). Contra las Edge sobre PGlite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';
import { loadGuestFeedback, retreatComments, type FeedbackItem } from '../../apps/organizers/src/app/retreat-comments.ts';

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
  const res = await booking.call('/api/v1/commands', { body: { requestId: `rc-${++seq}-${uuid()}`, operations: [
    { op: 'insert', table: BOOKING.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2026-10-02', end_date: '2026-10-04', expected_guests: 8 } }] } });
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
/** Un comentario de huésped tal como lo guarda el núcleo (destino según `core.feedback_route`). */
async function report(reporter: string, fields: { subject: 'event' | 'space' | 'application'; reservation_id: string; message: string; category?: string; at?: string }): Promise<string> {
  const id = uuid();
  const destination = fields.subject === 'event' ? 'organizer' : fields.subject === 'space' ? 'operations' : 'qa';
  await booking.t.db.query(`insert into core.feedback_reports (id, code, request_id, digest, reporter_user_id, reporter_kind, origin_app, subject, intent, message, category, scope, destination, routing_status, created_at)
    values ($1, 'FB_RC_' || $2, $3, 'd', $4, 'guest', 'guests', $5, 'problem', $6, $7, $8::jsonb, $9, 'none', coalesce($10::timestamptz, now()))`,
  [id, String(++seq), `rc-${seq}`, reporter, fields.subject, fields.message, fields.category ?? null, JSON.stringify({ reservation_id: fields.reservation_id, guest_id: uuid() }), destination, fields.at ?? null]);
  return id;
}

let R1: string; let R2: string;
let ana: { token: string; id: string }; let otra: { token: string; id: string };
const ids: Record<string, string> = {};

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  organizers = createOrganizersApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test', origins: [ORGANIZERS_ORIGINS[0]!] });
  R1 = await reservation('Retiro de Ana');
  R2 = await reservation('Retiro de otra');
  ana = await organizerSession(R1, 'ana-rc@example.invalid');
  otra = await organizerSession(R2, 'otra-rc@example.invalid');
  // Quien comenta es un huésped; para la prueba basta una cuenta que no organiza ninguno de los dos retiros.
  const guest = booking.users.reader;
  ids.early = await report(guest, { subject: 'event', reservation_id: R1, message: 'Las sesiones empiezan muy pronto.', category: 'schedule', at: '2026-10-03T08:00:00Z' });
  ids.late = await report(guest, { subject: 'event', reservation_id: R1, message: 'La cena, estupenda.', category: 'food', at: '2026-10-04T20:00:00Z' });
  ids.other = await report(guest, { subject: 'event', reservation_id: R2, message: 'De otro retiro.' });
  ids.space = await report(guest, { subject: 'space', reservation_id: R1, message: 'La ducha no evacúa.' });
  ids.app = await report(guest, { subject: 'application', reservation_id: R1, message: 'Un botón no va.' });
});
test.after(async () => { await booking.close(); });

test('organizers · comentarios del retiro: quien organiza ve lo que cuentan de su retiro, lo más reciente primero', async () => {
  const res = await org('/api/v1/feedback?app=guests&status=all&limit=500', { token: ana.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const items = res.data.items as FeedbackItem[];
  const seen = new Set(items.map((r) => r.id));
  assert.ok(!seen.has(ids.other), 'nada de otro retiro');
  assert.ok(!seen.has(ids.space) && !seen.has(ids.app), 'lo del lugar y lo de la app lo atiende Ikisai');
  assert.deepEqual(retreatComments(items, R1).map((r) => r.id), [ids.late, ids.early]);
  assert.deepEqual(retreatComments(items, R1.toUpperCase()).map((r) => r.category), ['food', 'schedule']);
  assert.deepEqual(retreatComments(items, R2), []);
});

test('organizers · comentarios del retiro: la otra organizadora no ve los de Ana; el cliente pide la ruta de siempre', async () => {
  const res = await org('/api/v1/feedback?app=guests&status=all&limit=500', { token: otra.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const items = res.data.items as FeedbackItem[];
  assert.deepEqual(retreatComments(items, R1), []);
  assert.deepEqual(retreatComments(items, R2).map((r) => r.id), [ids.other]);
  const paths: string[] = [];
  const loaded = await loadGuestFeedback({ api: async <T>(path: string) => { paths.push(path); return { items: [] } as T; } });
  assert.deepEqual(loaded, []);
  assert.deepEqual(paths, ['/feedback?app=guests&status=all&limit=500']);
});
