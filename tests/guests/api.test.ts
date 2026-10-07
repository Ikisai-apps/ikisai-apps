/**
 * Guests · `guests-api` de punta a punta (docs/guests/API.md §6): canje del enlace de huésped emitido por Booking, su ficha y
 * sus acciones dentro y fuera de ámbito, modo operativo, subida de la firma al bucket `guests-documents` y lectura de
 * archivos cerrada.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createGuestsApp, GUESTS_ORIGINS } from '../../supabase/functions/guests-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const ORIGIN = GUESTS_ORIGINS[0]!;
const uuid = () => crypto.randomUUID();
let booking: TestApp;
let guests: (r: Request) => Promise<Response>;
let seq = 0;

async function call(path: string, init: { token?: string | null; body?: unknown; method?: string; origin?: string } = {}) {
  const res = await guests(new Request(`${booking.supabase.url}/functions/v1/guests-api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Origin: init.origin ?? ORIGIN, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const code = (res: { data: any }) => res.data?.error?.code;

async function commit(operations: unknown[]) {
  const res = await booking.call('/api/v1/commands', { body: { requestId: `gst-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
/** Reserva confirmada (con su evento); `operativo` la deja sin comunicar a SES pidiendo datos. */
async function reservation(title: string, mode: 'ses' | 'operativo' = 'ses'): Promise<{ id: string; event: string }> {
  const id = uuid(); const event = uuid();
  await commit([{ op: 'insert', table: TABLES.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2027-09-10', end_date: '2027-09-12', expected_guests: 12,
    ...(mode === 'operativo' ? { ses_enabled: false, ses_disabled_reason: 'prueba', collect_guest_data: true } : {}) } }]);
  await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: event, from_status: 'pre_reservada' } }]);
  return { id, event };
}
async function guest(event: string, fields: Record<string, unknown>): Promise<string> {
  const id = uuid();
  await commit([{ op: 'insert', table: TABLES.guests, id, fields: { event_id: event, ...fields } }]);
  return id;
}
/** El personal de Booking emite el enlace del huésped; se canjea en Guests. */
async function guestSession(reservation_id: string, guest_id: string, name: string): Promise<string> {
  const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'guests', scope: { reservation_id, guest_id }, person: { name } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.match(link.data.url, /^https:\/\/guests\.ikisai\.com\/i\/[A-Za-z0-9_-]{43}$/);
  const session = await call('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  return session.data.token;
}
const myGuest = (token: string, guest_id: string) => call('/api/v1/read/booking.portal_my_guest', { token, body: { guest_id } });
/** Subida de una imagen por `guests-api` (el simulado no acepta PUT: el objeto se deja como si se hubiera subido). */
async function upload(token: string, bytes: Uint8Array, mime = 'image/png') {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ticket = await call('/api/v1/uploads', { token, body: { filename: 'firma.png', mime, size: bytes.byteLength, sha256 } });
  if (ticket.status !== 200) return ticket;
  booking.supabase.storage.set(ticket.data.path, bytes);
  const verified = await call(`/api/v1/uploads/${ticket.data.id}/verify`, { token, body: {} });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return ticket;
}

let R: { id: string; event: string };
let OP: { id: string; event: string };
let ana: string; let leo: string; let eva: string;
let anaToken: string; let leoToken: string; let evaToken: string;

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  guests = createGuestsApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, origins: [ORIGIN], release: 'test' });
  R = await reservation('Retiro de primavera');
  OP = await reservation('Retiro sin registro', 'operativo');
  ana = await guest(R.event, { first_name: 'Ana', last_name_1: 'Sintética' });
  leo = await guest(R.event, { first_name: 'Leo', email: 'leo@example.invalid' });
  eva = await guest(OP.event, { first_name: 'Eva' });
  anaToken = await guestSession(R.id, ana, 'Ana');
  leoToken = await guestSession(R.id, leo, 'Leo');
  evaToken = await guestSession(OP.id, eva, 'Eva');
});
test.after(async () => { await booking.close(); });

test('guests · auth: health público, sin token 401, origen ajeno 403, enlace inválido 401', async () => {
  const health = await call('/api/v1/health');
  assert.equal(health.status, 200); assert.equal(health.data.app, 'guests');
  assert.equal((await call('/api/v1/bootstrap')).status, 401);
  assert.equal((await call('/api/v1/bootstrap', { token: anaToken, origin: 'https://foreign.example' })).status, 403);
  const bad = await call('/api/v1/auth/link', { body: { token: 'A'.repeat(43) } });
  assert.equal(bad.status, 401); assert.equal(code(bad), 'LINK_INVALID');
});

test('guests · el enlace da acceso de editor con ámbito por huésped; members solo devuelve a la propia persona', async () => {
  const boot = await call('/api/v1/bootstrap', { token: anaToken });
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  assert.equal(boot.data.membership.role, 'editor');
  assert.deepEqual(boot.data.membership.scopes.grants, [{ reservation_id: R.id, guest_id: ana }]);
  const members = await call('/api/v1/members', { token: anaToken });
  assert.equal(members.status, 200, JSON.stringify(members.data));
  assert.equal(members.data.length, 1);
  // Un huésped no emite enlaces.
  assert.ok((await call('/api/v1/portal-links', { token: anaToken, body: { app: 'guests', scope: { reservation_id: R.id, guest_id: leo }, person: { name: 'Leo' } } })).status >= 400);
});

test('guests · su ficha sí; la de otro huésped de la misma reserva, OUT_OF_SCOPE; las lecturas de Organizers, no', async () => {
  const mine = await myGuest(anaToken, ana);
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.data.fields.first_name, 'Ana');
  assert.equal(mine.data.mode, 'ses');
  assert.equal(mine.data.signed, false);
  assert.equal(mine.data.reservation.title, 'Retiro de primavera');
  assert.ok(mine.data.missing.includes('birth_date'));

  const other = await myGuest(anaToken, leo);
  assert.equal(other.status, 403); assert.equal(code(other), 'OUT_OF_SCOPE');
  assert.equal(code(await myGuest(anaToken, uuid())), 'OUT_OF_SCOPE'); // inexistente responde igual
  assert.ok((await call('/api/v1/read/booking.portal_guests', { token: anaToken, body: { reservation_id: R.id } })).status >= 400);
  assert.ok((await call('/api/v1/invoke/booking.portal_update_guest', { token: anaToken, body: { guest_id: ana, fields: { phone: '600000000' } } })).status >= 400);
});

test('guests · corrige sus datos con procedencia «huésped»; revisión antigua VERSION_CONFLICT; nunca los de otro', async () => {
  const before = await myGuest(anaToken, ana);
  const res = await call('/api/v1/invoke/booking.portal_guest_update', { token: anaToken, body: { guest_id: ana, expectedRevision: before.data.revision, fields: { last_name_1: 'Corregida', birth_date: '1990-05-01' } } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const row = await booking.t.db.query<{ field_sources: any; last_name_1: string }>('select field_sources, last_name_1 from booking.guests where id = $1', [ana]);
  assert.equal(row.rows[0]!.last_name_1, 'Corregida');
  assert.equal(row.rows[0]!.field_sources.last_name_1.by, 'guest');
  assert.equal(row.rows[0]!.field_sources.birth_date.by, 'guest');

  const stale = await call('/api/v1/invoke/booking.portal_guest_update', { token: anaToken, body: { guest_id: ana, expectedRevision: before.data.revision, fields: { phone: '600000000' } } });
  assert.equal(code(stale), 'VERSION_CONFLICT');
  assert.equal(code(await call('/api/v1/invoke/booking.portal_guest_update', { token: anaToken, body: { guest_id: leo, fields: { phone: '600000000' } } })), 'OUT_OF_SCOPE');
  const after = await myGuest(anaToken, ana);
  assert.ok(!after.data.missing.includes('birth_date'));
});

test('guests · aviso legal y consentimiento de alergias; restricciones propias', async () => {
  let me = await myGuest(leoToken, leo);
  const ack = await call('/api/v1/invoke/booking.portal_guest_consent', { token: leoToken, body: { guest_id: leo, expectedRevision: me.data.revision, privacy_ack_version: 'v1' } });
  assert.equal(ack.status, 200, JSON.stringify(ack.data));
  me = await myGuest(leoToken, leo);
  assert.equal(me.data.privacy_ack_version, 'v1');
  assert.ok(me.data.privacy_ack_at);

  const set = await call('/api/v1/invoke/booking.portal_set_restrictions', { token: leoToken, body: { guest_id: leo, items: [{ restriction_type: 'alergia', subject: 'frutos secos', severity: 'grave', kitchen_notes: 'trazas también' }, { restriction_type: 'vegetariano' }] } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  me = await myGuest(leoToken, leo);
  assert.deepEqual(me.data.restrictions.map((r: any) => r.restriction_type).sort(), ['alergia', 'vegetariano']);
  const visible = await call('/api/v1/invoke/booking.portal_guest_consent', { token: leoToken, body: { guest_id: leo, expectedRevision: me.data.revision, allergies_visible_to_organizer: true } });
  assert.equal(visible.status, 200, JSON.stringify(visible.data));
  assert.equal((await myGuest(leoToken, leo)).data.allergies_visible_to_organizer, true);

  // Una alergia sin «qué» no pasa.
  assert.equal((await call('/api/v1/invoke/booking.portal_set_restrictions', { token: leoToken, body: { guest_id: leo, items: [{ restriction_type: 'alergia' }] } })).status, 422);
  // La lista vacía las quita todas.
  assert.equal((await call('/api/v1/invoke/booking.portal_set_restrictions', { token: leoToken, body: { guest_id: leo, items: [] } })).status, 200);
  assert.deepEqual((await myGuest(leoToken, leo)).data.restrictions, []);
  assert.equal(code(await call('/api/v1/invoke/booking.portal_set_restrictions', { token: leoToken, body: { guest_id: ana, items: [] } })), 'OUT_OF_SCOPE');
});

test('guests · firma: imagen propia al bucket guests-documents; la de otra cuenta no vale; los archivos no se leen', async () => {
  assert.equal(code(await upload(anaToken, new TextEncoder().encode('%PDF'), 'application/pdf')), 'UNSUPPORTED_MEDIA');
  assert.equal((await call('/api/v1/uploads', { token: anaToken, body: { filename: 'f.png', mime: 'image/png', size: 400_000, sha256: 'a'.repeat(64) } })).status, 413);

  const leoFile = await upload(leoToken, new TextEncoder().encode('trazo-de-leo'));
  const anaFile = await upload(anaToken, new TextEncoder().encode('trazo-de-ana'));
  const bucket = await booking.t.db.query<{ bucket: string; app: string }>('select bucket, app from core.files where id = $1', [anaFile.data.id]);
  assert.deepEqual(bucket.rows[0], { bucket: 'guests-documents', app: 'guests' });
  // Migración 0600: la recogida de huérfanos cubre los archivos de Guests (el campo legal lo declara Booking).
  assert.equal((await booking.t.db.query(`select 1 from core.file_gc_apps where app = 'guests'`)).rows.length, 1);

  let me = await myGuest(anaToken, ana);
  const foreign = await call('/api/v1/invoke/booking.portal_guest_sign', { token: anaToken, body: { guest_id: ana, expectedRevision: me.data.revision, file_id: leoFile.data.id, signed_by_name: 'Ana Corregida' } });
  assert.equal(code(foreign), 'INVALID_OPERATION');
  const signed = await call('/api/v1/invoke/booking.portal_guest_sign', { token: anaToken, body: { guest_id: ana, expectedRevision: me.data.revision, file_id: anaFile.data.id, signed_by_name: 'Ana Corregida' } });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  me = await myGuest(anaToken, ana);
  assert.equal(me.data.signed, true);
  const row = await booking.t.db.query<{ signature_file_id: string; signed_by_name: string }>('select signature_file_id, signed_by_name from booking.guests where id = $1', [ana]);
  assert.deepEqual(row.rows[0], { signature_file_id: anaFile.data.id, signed_by_name: 'Ana Corregida' });

  // Nadie lee archivos por Guests, ni los suyos ni los de otro (API.md §8).
  assert.equal(code(await call(`/api/v1/files/${anaFile.data.id}`, { token: leoToken })), 'FILE_NOT_FOUND');
  assert.equal(code(await call(`/api/v1/files/${anaFile.data.id}`, { token: anaToken })), 'FILE_NOT_FOUND');
});

test('guests · modo operativo: solo nombre, apellido y contacto; sin firma', async () => {
  const me = await myGuest(evaToken, eva);
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.mode, 'operativo');
  assert.deepEqual(me.data.missing, ['contact']);
  const docOnly = await call('/api/v1/invoke/booking.portal_guest_update', { token: evaToken, body: { guest_id: eva, expectedRevision: me.data.revision, fields: { document_number: 'X0000000T' } } });
  assert.equal(code(docOnly), 'INVALID_OPERATION', 'el documento se descarta en modo operativo');
  const contact = await call('/api/v1/invoke/booking.portal_guest_update', { token: evaToken, body: { guest_id: eva, expectedRevision: me.data.revision, fields: { phone: '600000000', document_number: 'X0000000T' } } });
  assert.equal(contact.status, 200, JSON.stringify(contact.data));
  const row = await booking.t.db.query<{ phone: string; document_number: string | null }>('select phone, document_number from booking.guests where id = $1', [eva]);
  assert.deepEqual(row.rows[0], { phone: '600000000', document_number: null });

  const file = await upload(evaToken, new TextEncoder().encode('trazo-de-eva'));
  const now = await myGuest(evaToken, eva);
  assert.equal(code(await call('/api/v1/invoke/booking.portal_guest_sign', { token: evaToken, body: { guest_id: eva, expectedRevision: now.data.revision, file_id: file.data.id, signed_by_name: 'Eva' } })), 'GUEST_DATA_OFF');
});
