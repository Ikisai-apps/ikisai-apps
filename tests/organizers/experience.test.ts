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
const WORKER_KEY = 'organizers-worker-key-de-prueba';
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
  organizers = createOrganizersApp({ ...base, origins: [ORGANIZERS_ORIGINS[0]!], workerKey: WORKER_KEY });
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

// K4 y K6 (#334): `apply_portal_operations('organizers', …)` desde una acción de Organizers invocada por el portal Guests.
test('organizers · guest_answer guarda, cambia y borra la respuesta propia; la organizadora la ve', async () => {
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

test('organizers · fase 4 y 5 con Booking, Food y Central: programa, alojamiento, menú, lugar y vista previa de solo lectura', async () => {
  // Programa (B16): se guarda, se lee con su lugar y fuera de las fechas no vale.
  const item = uuid();
  const saved = await org('/api/v1/invoke/booking.portal_program_save', { token: ana, body: { reservation_id: R1, item: { id: item, day: '2027-09-11', starts_at: '09:00', ends_at: '10:30', title: 'Yoga', place_text: 'Junto al río', kind: 'actividad' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(code(await org('/api/v1/invoke/booking.portal_program_save', { token: ana, body: { reservation_id: R1, item: { id: uuid(), day: '2027-10-01', title: 'Fuera' } } })), 'PROGRAM_DAY_OUT_OF_RANGE');
  const program = await org('/api/v1/read/booking.portal_program', { token: ana, body: { reservation_id: R1 } });
  assert.deepEqual(program.data.items.map((i: any) => [i.title, i.starts_at, i.place]), [['Yoga', '09:00', 'Junto al río']]);
  assert.equal(code(await org('/api/v1/read/booking.portal_program', { token: otra, body: { reservation_id: R1 } })), 'OUT_OF_SCOPE');

  // Alojamiento (B17): los ajustes que corresponden a «piden su cama y tú la apruebas».
  const settings = await org('/api/v1/invoke/booking.portal_room_settings', { token: ana, body: { reservation_id: R1, choice: 'request', preferences: true, choose_until: '2027-09-01' } });
  assert.equal(settings.status, 200, JSON.stringify(settings.data));
  const rooms = await org('/api/v1/read/booking.portal_rooms', { token: ana, body: { reservation_id: R1 } });
  assert.equal(rooms.data.settings.choice, 'request');
  assert.equal(rooms.data.settings.preferences, true);

  // Menú (Fd2): sin menú compartido por cocina, nada que ver.
  const menu = await org('/api/v1/read/food.portal_menu', { token: ana, body: { reservation_id: R1 } });
  assert.equal(menu.status, 200, JSON.stringify(menu.data));
  assert.equal(menu.data.available, false);

  // Lugar (X3): proyección de Central legible por el portal.
  assert.equal((await org('/api/v1/read/central.portal_place_projection', { token: ana, body: {} })).status, 200);

  // Vista previa (O6): huésped de muestra y enlace de Guests de solo lectura.
  const sample = await org('/api/v1/invoke/booking.portal_preview_guest', { token: ana, body: { reservation_id: R1 } });
  assert.equal(sample.status, 200, JSON.stringify(sample.data));
  const link = await org('/api/v1/portal-links', { token: ana, body: { app: 'guests', scope: { reservation_id: R1, guest_id: sample.data.guest_id }, person: { name: 'Vista previa' }, label: 'Vista previa', preview: true, replace: true } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const preview = await gst('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const experience = await gst('/api/v1/read/organizers.guest_experience_for', { token: preview.data.token, body: { reservation_id: R1, guest_id: sample.data.guest_id } });
  assert.equal(experience.status, 200, JSON.stringify(experience.data));
  const questions = await gst('/api/v1/read/organizers.guest_questions', { token: preview.data.token, body: { reservation_id: R1, guest_id: sample.data.guest_id } });
  const open = questions.data.items.find((q: any) => q.open);
  assert.equal(code(await gst('/api/v1/invoke/organizers.guest_answer', { token: preview.data.token, body: { question_id: open.id, value: 'm' } })), 'PREVIEW_READ_ONLY');
});

test('organizers · conservación (B18): las respuestas se borran a los 6 meses del fin del retiro; las preguntas se quedan', async () => {
  const R = await reservation('Retiro antiguo', '2027-03-05', '2027-03-07');
  const token = await organizerSession(R, 'antigua-org@example.invalid');
  const userId = (await org('/api/v1/me', { token })).data.userId;
  const guest = await guestSession(token, R, 'Noa');
  const question = uuid();
  assert.equal((await commit(token, [{ op: 'insert', table: TABLES.questions, id: question, fields: { reservation_id: R, owner_id: userId, type: 'yes_no', label: '¿Vienes en coche?', published: true } }])).status, 200);
  await commit(token, [{ op: 'insert', table: TABLES.experiences, id: uuid(), fields: { reservation_id: R, questions_visible: true } }]);
  const answered = await gst('/api/v1/invoke/organizers.guest_answer', { token: guest.token, body: { question_id: question, value: true } });
  assert.equal(answered.status, 200, JSON.stringify(answered.data));

  const tick = async () => (await organizers(new Request(`${booking.supabase.url}/functions/v1/organizers-api/api/v1/worker/retention/tick`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();
  const has = async () => (await booking.t.db.query<{ v: boolean }>('select organizers.retention_has_work() v')).rows[0]!.v;
  assert.equal(await has(), false, 'el retiro aún no ha terminado');

  // K7 (pendiente de Core): la cuenta de servicio `organizers`. Hasta que esté en main, la prueba la da de alta en su base.
  const known = (await booking.t.db.query<{ g: unknown }>(`select core.service_grants('organizers') g`)).rows[0]!.g;
  if (!known) {
    await booking.t.db.query(`create or replace function core.service_grants(p_name text) returns jsonb language sql immutable as $f$
      select case p_name
        when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
        when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
        when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', '[]'::jsonb)
        else null end $f$`);
  }

  // El retiro terminó hace más de seis meses.
  await booking.t.db.query(`update booking.reservations set start_date = date '2025-01-10', end_date = date '2025-01-12' where id = $1`, [R]);
  assert.equal(await has(), true);
  const run = await tick();
  assert.ok(run.purged >= 1, JSON.stringify(run));
  const left = (await booking.t.db.query<{ value: unknown; deleted_at: string | null }>('select value, deleted_at from organizers.answers where question_id = $1', [question])).rows;
  assert.equal(left.length, 1);
  assert.equal(left[0]!.value, null, 'sin el valor');
  assert.ok(left[0]!.deleted_at, 'y borrada');
  assert.equal((await booking.t.db.query('select 1 from organizers.questions where id = $1 and deleted_at is null', [question])).rows.length, 1, 'la pregunta se conserva');
  assert.equal(await has(), false);
});
