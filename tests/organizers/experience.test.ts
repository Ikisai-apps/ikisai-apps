/**
 * Organizers · fase 4 (docs/organizers/API.md §15): tablas propias `organizers.*` con ámbito por reserva (Edge y gancho de
 * validación), archivos de materiales (K3), lecturas para Guests y la acción `organizers.guest_answer` (K4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { createGuestsApp, GUESTS_ORIGINS } from '../../supabase/functions/guests-api/app.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';
import { TABLES, visibleRow } from '../../supabase/functions/_domain/organizers/mod.ts';

const uuid = () => crypto.randomUUID();
let booking: TestApp;
let organizers: (r: Request) => Promise<Response>;
let guests: (r: Request) => Promise<Response>;
let seq = 0;

type Res = { status: number; data: any };
function caller(handler: () => (r: Request) => Promise<Response>, slug: string, origin: string) {
  return async (path: string, init: { token?: string | null; body?: unknown; method?: string } = {}): Promise<Res> => {
    const res = await handler()(new Request(`${booking.supabase.url}/functions/v1/${slug}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }));
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
const org = caller(() => organizers, 'organizers-api', ORGANIZERS_ORIGINS[0]!);
const gst = caller(() => guests, 'guests-api', GUESTS_ORIGINS[0]!);
const code = (res: Res) => res.data?.error?.code;

async function staff(operations: unknown[]) {
  const res = await booking.call('/api/v1/commands', { body: { requestId: `exp-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function reservation(title: string, start = '2027-09-10', end = '2027-09-12'): Promise<string> {
  const id = uuid();
  await staff([{ op: 'insert', table: BOOKING.reservations, id, fields: { title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 12 } }]);
  await staff([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'pre_reservada' } }]);
  return id;
}
async function organizerSession(reservation_id: string, email: string): Promise<string> {
  const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const session = await org('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  return session.data.token;
}
/** La organizadora da de alta a un asistente y le emite su enlace de Guests; devuelve su id y su sesión en Guests. */
async function guestSession(token: string, reservation_id: string, name: string): Promise<{ id: string; token: string }> {
  const id = uuid();
  const added = await org('/api/v1/invoke/booking.portal_add_guest', { token, body: { reservation_id, guest_id: id, fields: { first_name: name }, declaration: true, declaration_version: 'org-v1' } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const link = await org('/api/v1/portal-links', { token, body: { app: 'guests', scope: { reservation_id, guest_id: id }, person: { name } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const session = await gst('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  return { id, token: session.data.token };
}
async function commit(token: string, operations: unknown[]): Promise<Res> {
  return org('/api/v1/commands', { token, body: { requestId: `org-${++seq}-${uuid()}`, operations } });
}

let R1: string; let R3: string; let ana: string; let otra: string; let anaId: string;
let leo: { id: string; token: string }; let eva: { id: string; token: string };

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const base = { url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test' };
  organizers = createOrganizersApp({ ...base, origins: [ORGANIZERS_ORIGINS[0]!] });
  guests = createGuestsApp({ ...base, origins: [GUESTS_ORIGINS[0]!] });
  R1 = await reservation('Retiro de primavera');
  R3 = await reservation('Retiro ajeno');
  ana = await organizerSession(R1, 'ana-org@example.invalid');
  anaId = (await org('/api/v1/me', { token: ana })).data.userId;
  otra = await organizerSession(R3, 'otra-org@example.invalid');
  leo = await guestSession(ana, R1, 'Leo');
  eva = await guestSession(otra, R3, 'Eva');
});
test.after(async () => { await booking.close(); });

test('organizers · fase 4: tablas propias con ámbito por reserva en commands, snapshot y changes', async () => {
  const experience = uuid(); const offer = uuid();
  const ok = await commit(ana, [
    { op: 'insert', table: TABLES.experiences, id: experience, fields: { reservation_id: R1, materials_visible: true, questions_visible: true,
      lodging_options: [{ key: 'doble', label: 'Habitación doble', guest_note: 'Consulta el precio con tu organizadora' }], organizer_message: '¡Bienvenidos!', message_lang: 'es' } },
    { op: 'insert', table: TABLES.offers, id: offer, fields: { reservation_id: R1, name: 'Estándar', price: 450, expected: 10 } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  // Fuera de su ámbito: lo para la Edge y, si alguien se la saltara, el gancho de la base de datos.
  assert.equal(code(await commit(ana, [{ op: 'insert', table: TABLES.offers, id: uuid(), fields: { reservation_id: R3, name: 'Intrusa', price: 1 } }])), 'OUT_OF_SCOPE');
  await assert.rejects(
    booking.t.db.query(`select core.commit('organizers', $1, $2, null, null, $3::jsonb)`, [anaId, `sql-${uuid()}`,
      JSON.stringify([{ op: 'insert', table: TABLES.offers, id: uuid(), fields: { reservation_id: R3, name: 'Intrusa', price: 1 } }])]),
    /OUT_OF_SCOPE/);
  // Ni cambiar de reserva una fila ni escribir respuestas: esas solo las escribe el asistente.
  assert.equal(code(await commit(ana, [{ op: 'update', table: TABLES.offers, id: offer, expectedRevision: 1, fields: { reservation_id: R3 } }])), 'IMMUTABLE_FIELD');
  assert.equal(code(await commit(ana, [{ op: 'insert', table: TABLES.answers, id: uuid(), fields: { reservation_id: R1, question_id: uuid(), guest_id: leo.id, value: 'x' } }])), 'FORBIDDEN');
  // Formas cerradas: opciones de alojamiento y de pregunta.
  assert.equal(code(await commit(ana, [{ op: 'update', table: TABLES.experiences, id: experience, expectedRevision: 1, fields: { lodging_options: [{ key: 'a' }] } }])), 'INVALID_FIELDS');
  assert.equal(code(await commit(ana, [{ op: 'insert', table: TABLES.questions, id: uuid(), fields: { reservation_id: R1, owner_id: anaId, type: 'choice', label: '¿Turno?', options: [{ value: 'm', label: 'Mañana' }] } }])), 'INVALID_FIELDS');

  const mine = await org(`/api/v1/snapshot?tables=${TABLES.offers},${TABLES.experiences}`, { token: ana });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.deepEqual(mine.data.tables.find((t: any) => t.table === TABLES.offers).rows.map((r: any) => r.id), [offer]);
  const theirs = await org(`/api/v1/snapshot?tables=${TABLES.offers},${TABLES.experiences}`, { token: otra });
  assert.ok(theirs.data.tables.every((t: any) => t.rows.length === 0), 'otra organizadora no ve nada de R1');
  const changes = await org('/api/v1/changes?after=0', { token: otra });
  assert.equal(changes.data.items.some((c: any) => c.after?.reservation_id === R1), false);
});

test('organizers · materiales: archivo propio (K3), lectura para Guests y archivo publicado (O1)', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 programa del retiro');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ticket = await org('/api/v1/uploads', { token: ana, body: { filename: 'programa.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256 } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  booking.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await org(`/api/v1/uploads/${ticket.data.id}/verify`, { token: ana, body: {} })).status, 200);
  assert.equal((await org('/api/v1/uploads', { token: ana, body: { filename: 'x.exe', mime: 'application/x-msdownload', size: 10, sha256 } })).status, 422);

  const pdf = uuid(); const link = uuid(); const draft = uuid();
  const ok = await commit(ana, [
    { op: 'insert', table: TABLES.materials, id: pdf, fields: { reservation_id: R1, owner_id: anaId, kind: 'file', title: 'Programa', file_id: ticket.data.id, published: true, position: 1 } },
    { op: 'insert', table: TABLES.materials, id: link, fields: { reservation_id: R1, owner_id: anaId, kind: 'link', title: 'Grupo de WhatsApp', url: 'https://chat.whatsapp.com/abc', published: true, window: 'before', position: 2 } },
    { op: 'insert', table: TABLES.materials, id: draft, fields: { reservation_id: R1, owner_id: anaId, kind: 'text', title: 'Borrador', body: 'Sin publicar', position: 3 } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(code(await commit(ana, [{ op: 'insert', table: TABLES.materials, id: uuid(), fields: { reservation_id: R1, owner_id: anaId, kind: 'link', title: 'Inseguro', url: 'http://x.example' } }])), 'INVALID_FIELDS');

  assert.equal((await org(`/api/v1/files/${ticket.data.id}`, { token: ana })).status, 200);
  assert.equal(code(await org(`/api/v1/files/${ticket.data.id}`, { token: otra })), 'FILE_NOT_FOUND');

  const list = await gst('/api/v1/read/organizers.guest_materials', { token: leo.token, body: { reservation_id: R1, guest_id: leo.id } });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.deepEqual(list.data.items.map((m: any) => m.title), ['Programa', 'Grupo de WhatsApp']);
  assert.equal(list.data.items[0].file.mime, 'application/pdf');
  assert.equal(list.data.items[1].window, 'before');
  assert.equal(code(await gst('/api/v1/read/organizers.guest_materials', { token: eva.token, body: { reservation_id: R1, guest_id: eva.id } })), 'OUT_OF_SCOPE');

  // C8 (#325): Guests abre el archivo con `portal-files`, que pregunta al resolutor de Organizers.
  const leoFile = await gst(`/api/v1/portal-files/${ticket.data.id}`, { token: leo.token });
  assert.equal(leoFile.status, 200, JSON.stringify(leoFile.data));
  assert.equal(leoFile.data.mime, 'application/pdf');
  assert.equal(code(await gst(`/api/v1/portal-files/${ticket.data.id}`, { token: eva.token })), 'FILE_NOT_FOUND');
  const unpublish = await commit(ana, [{ op: 'update', table: TABLES.materials, id: pdf, expectedRevision: 1, fields: { published: false } }]);
  assert.equal(unpublish.status, 200, JSON.stringify(unpublish.data));
  assert.equal(code(await gst(`/api/v1/portal-files/${ticket.data.id}`, { token: leo.token })), 'FILE_NOT_FOUND');

  // Biblioteca: el material es de quien lo creó; nadie lo da de alta en nombre de otra persona.
  assert.equal(code(await commit(ana, [{ op: 'insert', table: TABLES.materials, id: uuid(), fields: { reservation_id: R1, owner_id: uuid(), kind: 'text', title: 'Ajeno', body: 'x' } }])), 'INVALID_FIELDS');
  assert.equal(code(await commit(ana, [{ op: 'update', table: TABLES.materials, id: link, expectedRevision: 1, fields: { owner_id: uuid() } }])), 'IMMUTABLE_FIELD');
  const scopes = { grants: [{ reservation_id: uuid() }] };
  assert.equal(visibleRow(TABLES.materials, { reservation_id: R1, owner_id: anaId }, { scopes }, anaId), true, 'sus materiales le siguen tras el retiro');
  assert.equal(visibleRow(TABLES.materials, { reservation_id: R1, owner_id: anaId }, { scopes }, uuid()), false);
  assert.equal(visibleRow(TABLES.offers, { reservation_id: R1 }, { scopes }, anaId), false, 'las ofertas son del retiro');
});

test('organizers · Guests lee la experiencia y las preguntas; guest_answer valida tipo, ventana y ámbito', async () => {
  const experience = await gst('/api/v1/read/organizers.guest_experience_for', { token: leo.token, body: { reservation_id: R1, guest_id: leo.id } });
  assert.equal(experience.status, 200, JSON.stringify(experience.data));
  assert.equal(experience.data.modules.materials.visible, true);
  assert.equal(experience.data.modules.lodging.options[0].key, 'doble');
  assert.deepEqual(experience.data.organizer_message, { text: '¡Bienvenidos!', lang: 'es' });

  const open = uuid(); const closed = uuid(); const hidden = uuid();
  const ok = await commit(ana, [
    { op: 'insert', table: TABLES.questions, id: open, fields: { reservation_id: R1, owner_id: anaId, type: 'choice', label: '¿Qué turno de yoga prefieres?', required: true,
      options: [{ value: 'm', label: 'Mañana' }, { value: 't', label: 'Tarde' }], published: true, position: 1 } },
    { op: 'insert', table: TABLES.questions, id: closed, fields: { reservation_id: R1, owner_id: anaId, type: 'text', label: '¿Algo más?', closes_at: '2020-01-01', published: true, position: 2 } },
    { op: 'insert', table: TABLES.questions, id: hidden, fields: { reservation_id: R1, owner_id: anaId, type: 'yes_no', label: 'Sin publicar', position: 3 } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const questions = await gst('/api/v1/read/organizers.guest_questions', { token: leo.token, body: { reservation_id: R1, guest_id: leo.id } });
  assert.equal(questions.status, 200, JSON.stringify(questions.data));
  assert.deepEqual(questions.data.items.map((q: any) => [q.id, q.open, q.answer]), [[open, true, null], [closed, false, null]]);

  const answer = (token: string, body: Record<string, unknown>) => gst('/api/v1/invoke/organizers.guest_answer', { token, body });
  assert.equal(code(await answer(leo.token, { question_id: open, value: 'noche' })), 'INVALID_ANSWER');
  assert.equal(code(await answer(leo.token, { question_id: closed, value: 'Nada' })), 'QUESTION_CLOSED');
  assert.equal(code(await answer(leo.token, { question_id: hidden, value: true })), 'OUT_OF_SCOPE');
  assert.equal(code(await answer(eva.token, { question_id: open, value: 'm' })), 'OUT_OF_SCOPE');
});

// K4 (aprobado por Core): `apply_portal_operations('organizers', …)` desde una acción del portal Guests. Hoy el núcleo solo
// admite como destino una app interna y Organizers es un portal; queda pendiente de que Core lo amplíe (K6 en PETICIONES).
test('organizers · guest_answer guarda, cambia y borra la respuesta propia; la organizadora la ve', { skip: 'K6: el núcleo aún no deja escribir en un portal desde otro' }, async () => {
  const questions = await gst('/api/v1/read/organizers.guest_questions', { token: leo.token, body: { reservation_id: R1, guest_id: leo.id } });
  const open = questions.data.items[0].id;
  const saved = await gst('/api/v1/invoke/organizers.guest_answer', { token: leo.token, body: { question_id: open, value: 'm' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.revision, 1);
  const changed = await gst('/api/v1/invoke/organizers.guest_answer', { token: leo.token, body: { question_id: open, value: 't', expectedRevision: 1 } });
  assert.equal(changed.data.revision, 2);
  assert.equal(code(await gst('/api/v1/invoke/organizers.guest_answer', { token: leo.token, body: { question_id: open, value: 'm', expectedRevision: 1 } })), 'VERSION_CONFLICT');
  const seen = await org(`/api/v1/snapshot?tables=${TABLES.answers}`, { token: ana });
  assert.deepEqual(seen.data.tables[0].rows.map((r: any) => [r.guest_id, r.value]), [[leo.id, 't']]);
  const removed = await gst('/api/v1/invoke/organizers.guest_answer', { token: leo.token, body: { question_id: open, value: null } });
  assert.equal(removed.data.revision, null);
});
