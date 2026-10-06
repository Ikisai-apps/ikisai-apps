/** Booking · fase B2: huéspedes (visibilidad por ámbito), restricciones, checklist, recuentos y proyección para Food. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { canSeeGuests, checklistSeedOperations, missingForSes, signsOwnEntry, validateFields, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const { reservations: RESERVATIONS, events: EVENTS, guests: GUESTS, restrictions: RESTRICTIONS, checklist: CHECKLIST } = TABLES;
const CONFIRM = 'booking.confirm_reservation';
const PROJECTION = 'booking.food_event_projection';
const uuid = () => crypto.randomUUID();

let app: TestApp;
let designated: string; // token de un editor con scopes.guests
let foodUser: string;
let seq = 0;

test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, 'editor', '{"guests": true}'::jsonb)`, [user]);
  designated = app.supabase.tokenFor(user);
  foodUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [foodUser]);
});
test.after(async () => { await app.close(); });

function commands(operations: unknown[], token: string = app.tokens.owner) {
  return app.call('/api/v1/commands', { token, body: { requestId: `g-${++seq}-${uuid()}`, operations } });
}
async function ok(operations: unknown[], token: string = app.tokens.owner) {
  const res = await commands(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
}

/** Reserva confirmada con su evento. */
async function createEvent(fields: Record<string, unknown> = {}): Promise<{ reservationId: string; eventId: string }> {
  const reservationId = uuid(); const eventId = uuid();
  await ok([{ op: 'insert', table: RESERVATIONS, id: reservationId, fields: { title: 'Retiro Test', status: 'pre_reservada', start_date: '2027-03-05', end_date: '2027-03-07', expected_guests: 20, requires_meals: true, meal_plan_requested: 'pension_completa', menu_style_requested: 'vegetariano', ...fields } }]);
  await ok([{ op: 'call', procedure: CONFIRM, args: { reservation_id: reservationId, event_id: eventId, from_status: 'pre_reservada' } }]);
  return { reservationId, eventId };
}

const ADULT = {
  first_name: 'Persona', last_name_1: 'Sintética', last_name_2: 'Prueba', sex: 'M', document_type: 'DNI', document_number: '00000000T', document_support_number: 'AAA000000',
  nationality: 'ESP', birth_date: '1990-01-15', residence_address: 'Calle Inventada 1', residence_postal_code: '00000', residence_city: 'Villa Ejemplo', residence_country: 'ESP', phone: '600000000',
};

async function projection(eventId: string): Promise<any> {
  const out = (await app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: PROJECTION, p_args: { where: { event_id: eventId } } })) as any;
  return out.rows[0];
}
async function snapshotRows(table: string, token: string): Promise<any[]> {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}`, { token });
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows;
}

test('huéspedes · reglas de dominio: ámbito, datos para SES y firma', () => {
  assert.equal(canSeeGuests({ role: 'owner' }), true);
  assert.equal(canSeeGuests({ role: 'editor', scopes: { guests: true } }), true);
  assert.equal(canSeeGuests({ role: 'editor', scopes: null }), false);
  assert.equal(canSeeGuests({ role: 'editor', scopes: { guests: 'true' } }), false);
  assert.equal(canSeeGuests({ role: 'reader', scopes: { guests: true } }), false);

  assert.deepEqual(missingForSes(ADULT), []);
  assert.deepEqual(missingForSes({ ...ADULT, last_name_2: null, document_support_number: '' }), ['last_name_2', 'document_support_number']);
  assert.deepEqual(missingForSes({ ...ADULT, document_type: 'Pasaporte', last_name_2: null, document_support_number: null }), [], 'pasaporte: ni segundo apellido ni soporte');
  assert.deepEqual(missingForSes({ ...ADULT, document_type: 'NIE', last_name_2: null, document_support_number: null }), ['document_support_number']);
  assert.deepEqual(missingForSes({ ...ADULT, phone: null, email: null }), ['contact']);
  assert.deepEqual(missingForSes({ ...ADULT, phone: null, email: 'persona@example.invalid' }), []);
  const minor = { first_name: 'Menor', last_name_1: 'Sintético', birth_date: '2018-06-01', residence_address: 'Calle Inventada 1', residence_postal_code: '00000', residence_city: 'Villa Ejemplo', residence_country: 'ESP', phone: '600000000', is_minor: true };
  assert.deepEqual(missingForSes(minor), ['kinship'], 'un menor no necesita documento, sí parentesco');
  assert.deepEqual(missingForSes({ ...minor, kinship: 'hija' }), []);
  assert.deepEqual(missingForSes({ first_name: 'Solo' }), ['last_name_1', 'birth_date', 'residence_address', 'residence_postal_code', 'residence_city', 'residence_country', 'contact', 'document_type', 'document_number']);

  assert.equal(signsOwnEntry({ birth_date: '2013-03-05' }, '2027-03-05'), true, 'cumple 14 el día de entrada');
  assert.equal(signsOwnEntry({ birth_date: '2013-03-06' }, '2027-03-05'), false);
  assert.equal(signsOwnEntry({ birth_date: null, is_minor: true }, '2027-03-05'), false);
  assert.equal(signsOwnEntry({ birth_date: null, is_minor: false }, '2027-03-05'), true);

  const sha = 'a'.repeat(64);
  assert.deepEqual(validateFields(GUESTS, { signature_file_id: { $blob: sha }, signed_at: '2027-03-05T17:10:00Z' }, 'update'), [], 'marcador de adjunto en cola');
  assert.equal(validateFields(GUESTS, { signature_file_id: { $blob: 'corto' } }, 'update')[0]!.details.field, 'signature_file_id');
  assert.equal(validateFields(GUESTS, { signature_file_id: uuid(), signed_at: null }, 'update')[0]!.details.field, 'signed_at');
  assert.equal(validateFields(GUESTS, { nationality: 'es' }, 'update')[0]!.details.field, 'nationality');
});

test('huéspedes · solo los ve y escribe quien está designado; reader no recibe la tabla', async () => {
  const { eventId } = await createEvent();
  const before = (await app.call('/api/v1/bootstrap')).data.cursor;
  const guestId = uuid();
  const created = await ok([{ op: 'insert', table: GUESTS, id: guestId, fields: { event_id: eventId, ...ADULT } }], designated);
  assert.match(created.data.changes[0].after.code, /^HSP_\d{4}_\d{3}$/);

  const boot = await app.call('/api/v1/bootstrap', { token: app.tokens.reader });
  assert.equal(boot.data.tables.find((t: any) => t.table === GUESTS).readable, false);
  assert.equal((await app.call(`/api/v1/snapshot?tables=${GUESTS}`, { token: app.tokens.reader })).status, 403);
  const readerChanges = await app.call(`/api/v1/changes?after=${before}`, { token: app.tokens.reader });
  assert.equal(readerChanges.data.items.some((c: any) => c.table === GUESTS), false);
  assert.equal(JSON.stringify((await app.call('/api/v1/history?limit=5', { token: app.tokens.reader })).data).includes('00000000T'), false);

  // un editor sin designar: la tabla es legible para su rol, pero la Edge no le entrega ninguna fila
  assert.deepEqual(await snapshotRows(GUESTS, app.tokens.editor), []);
  const editorChanges = await app.call(`/api/v1/changes?after=${before}`, { token: app.tokens.editor });
  assert.equal(editorChanges.data.items.some((c: any) => c.table === GUESTS), false);
  assert.equal(JSON.stringify((await app.call('/api/v1/history?limit=5', { token: app.tokens.editor })).data).includes('00000000T'), false);
  const denied = await commands([{ op: 'insert', table: GUESTS, id: uuid(), fields: { event_id: eventId, first_name: 'Intruso' } }], app.tokens.editor);
  assert.equal(denied.status, 403);
  assert.equal((await commands([{ op: 'update', table: GUESTS, id: guestId, expectedRevision: 1, fields: { notes: 'x' } }], app.tokens.editor)).status, 403);
  assert.equal((await commands([{ op: 'delete', table: GUESTS, id: guestId, expectedRevision: 1 }], app.tokens.editor)).status, 403);

  assert.equal((await snapshotRows(GUESTS, designated)).some((g) => g.id === guestId), true);
  assert.equal((await snapshotRows(GUESTS, app.tokens.owner)).some((g) => g.id === guestId), true);
  const designatedChanges = await app.call(`/api/v1/changes?after=${before}`, { token: designated });
  assert.equal(designatedChanges.data.items.some((c: any) => c.table === GUESTS && c.id === guestId), true);
});

test('huéspedes · estados de datos y de envío a SES; el evento no se puede cambiar', async () => {
  const { eventId } = await createEvent();
  const other = await createEvent();
  const incomplete = await commands([{ op: 'insert', table: GUESTS, id: uuid(), fields: { event_id: eventId, first_name: 'Incompleta', data_status: 'datos_revisados' } }]);
  assert.equal(incomplete.status, 422); assert.equal(incomplete.data.error.details.field, 'data_status');
  assert.ok(incomplete.data.error.details.missing.includes('last_name_1'));

  const id = uuid();
  await ok([{ op: 'insert', table: GUESTS, id, fields: { event_id: eventId, ...ADULT, data_status: 'datos_revisados' } }]);
  const noDate = await commands([{ op: 'update', table: GUESTS, id, expectedRevision: 1, fields: { ses_status: 'enviado_SES' } }]);
  assert.equal(noDate.data.error.code, 'CONSTRAINT_VIOLATION', 'la base exige fecha de envío');
  await ok([{ op: 'update', table: GUESTS, id, expectedRevision: 1, fields: { ses_status: 'listo_para_envio' } }]);
  await ok([{ op: 'update', table: GUESTS, id, expectedRevision: 2, fields: { ses_status: 'enviado_SES', ses_sent_at: '2027-03-05T18:00:00Z', ses_sent_by: 'Responsable', ses_receipt_ref: 'REF-0001' } }]);

  const raw = uuid();
  await ok([{ op: 'insert', table: GUESTS, id: raw, fields: { event_id: eventId, first_name: 'Sin revisar' } }]);
  const notReady = await commands([{ op: 'update', table: GUESTS, id: raw, expectedRevision: 1, fields: { ses_status: 'listo_para_envio' } }]);
  assert.equal(notReady.data.error.code, 'CONSTRAINT_VIOLATION');
  const moved = await commands([{ op: 'update', table: GUESTS, id: raw, expectedRevision: 1, fields: { event_id: other.eventId } }]);
  assert.equal(moved.data.error.code, 'INVALID_FIELDS'); assert.equal(moved.data.error.details.field, 'event_id');
  const noFile = await commands([{ op: 'update', table: GUESTS, id: raw, expectedRevision: 1, fields: { signature_file_id: uuid(), signed_at: '2027-03-05T17:00:00Z' } }]);
  assert.equal(noFile.data.error.code, 'CONSTRAINT_VIOLATION', 'la firma debe apuntar a un archivo registrado');
  await ok([{ op: 'update', table: GUESTS, id: raw, expectedRevision: 1, fields: { signed_at: '2027-03-05T17:00:00Z', signed_by_name: 'Sin revisar' } }]);
});

test('restricciones · huésped o número de personas, gravedad solo en alergias, coherencia con el evento', async () => {
  const { eventId } = await createEvent();
  const other = await createEvent();
  const guestId = uuid(); const foreign = uuid();
  await ok([{ op: 'insert', table: GUESTS, id: guestId, fields: { event_id: eventId, first_name: 'Alérgica' } }, { op: 'insert', table: GUESTS, id: foreign, fields: { event_id: other.eventId, first_name: 'De otro evento' } }]);

  const field = async (fields: Record<string, unknown>) => (await commands([{ op: 'insert', table: RESTRICTIONS, id: uuid(), fields: { event_id: eventId, ...fields } }], app.tokens.editor)).data.error?.details?.field;
  assert.equal(await field({ restriction_type: 'vegano' }), 'servings');
  assert.equal(await field({ restriction_type: 'vegano', guest_id: guestId, servings: 2 }), 'servings');
  assert.equal(await field({ restriction_type: 'vegano', servings: 0 }), 'servings');
  assert.equal(await field({ restriction_type: 'alergia', servings: 1 }), 'subject');
  assert.equal(await field({ restriction_type: 'preferencia', servings: 1, severity: 'grave' }), 'severity');
  assert.equal(await field({ restriction_type: 'celiaco', servings: 1 }), 'restriction_type');

  const allergy = uuid();
  await ok([
    { op: 'insert', table: RESTRICTIONS, id: allergy, fields: { event_id: eventId, guest_id: guestId, restriction_type: 'alergia', subject: 'Pistacho', severity: 'grave' } },
    { op: 'insert', table: RESTRICTIONS, id: uuid(), fields: { event_id: eventId, restriction_type: 'vegano', servings: 2 } },
  ], app.tokens.editor);
  const mismatch = await commands([{ op: 'insert', table: RESTRICTIONS, id: uuid(), fields: { event_id: eventId, guest_id: foreign, restriction_type: 'vegano' } }]);
  assert.equal(mismatch.data.error.code, 'GUEST_MISMATCH');
  // la base cierra lo que el lote no enseña: quitar el huésped sin poner número de personas
  const dangling = await commands([{ op: 'update', table: RESTRICTIONS, id: allergy, expectedRevision: 1, fields: { guest_id: null } }]);
  assert.equal(dangling.data.error.code, 'CONSTRAINT_VIOLATION');
  // borrar al huésped exige borrar o soltar su restricción en el mismo lote
  assert.equal((await commands([{ op: 'delete', table: GUESTS, id: guestId, expectedRevision: 1 }])).data.error.code, 'GUEST_MISMATCH');
  await ok([{ op: 'update', table: RESTRICTIONS, id: allergy, expectedRevision: 1, fields: { guest_id: null, servings: 1 } }, { op: 'delete', table: GUESTS, id: guestId, expectedRevision: 1 }]);
});

test('checklist · base desde la plantilla, sin duplicar, y nada vivo bajo un evento borrado', async () => {
  const { reservationId, eventId } = await createEvent();
  const seed = checklistSeedOperations(eventId, uuid);
  assert.equal(seed.length, 20);
  await ok(seed, app.tokens.editor);
  const items = (await snapshotRows(CHECKLIST, app.tokens.reader)).filter((i) => i.event_id === eventId);
  assert.equal(items.length, 20);
  assert.equal(checklistSeedOperations(eventId, uuid, { existing: items }).length, 0);
  assert.equal(checklistSeedOperations(eventId, uuid, { types: ['salas'], existing: items.filter((i) => i.checklist_type !== 'salas') }).length, 4);
  const first = items[0]!;
  await ok([{ op: 'update', table: CHECKLIST, id: first.id, expectedRevision: 1, fields: { status: 'hecho', reviewed_on: '2027-03-04', responsible_name: 'Responsable' } }], app.tokens.editor);
  assert.equal((await commands([{ op: 'update', table: CHECKLIST, id: first.id, expectedRevision: 2, fields: { status: 'a medias' } }])).data.error.details.field, 'status');

  // borrar el evento (y su reserva) sin sus ítems deja huérfanos
  const event = (await snapshotRows(EVENTS, app.tokens.owner)).find((e) => e.id === eventId);
  const reservation = (await snapshotRows(RESERVATIONS, app.tokens.owner)).find((r) => r.id === reservationId);
  const orphan = await commands([{ op: 'delete', table: EVENTS, id: eventId, expectedRevision: event.revision }, { op: 'delete', table: RESERVATIONS, id: reservationId, expectedRevision: reservation.revision }]);
  assert.equal(orphan.data.error.code, 'ORPHAN_CHILD');
  const current = (await snapshotRows(CHECKLIST, app.tokens.owner)).filter((i) => i.event_id === eventId);
  await ok([
    ...current.map((i) => ({ op: 'delete', table: CHECKLIST, id: i.id, expectedRevision: i.revision })),
    { op: 'delete', table: EVENTS, id: eventId, expectedRevision: event.revision },
    { op: 'delete', table: RESERVATIONS, id: reservationId, expectedRevision: reservation.revision },
  ]);
});

test('recuentos · quien no ve huéspedes obtiene totales sin identificar', async () => {
  const { eventId } = await createEvent();
  await ok([
    { op: 'insert', table: GUESTS, id: uuid(), fields: { event_id: eventId, ...ADULT, data_status: 'datos_revisados', signed_at: '2027-03-05T17:00:00Z' } },
    { op: 'insert', table: GUESTS, id: uuid(), fields: { event_id: eventId, first_name: 'Otro', sex: 'H' } },
    { op: 'insert', table: GUESTS, id: uuid(), fields: { event_id: eventId, first_name: 'Menor', is_minor: true } },
  ]);
  const summary = await app.call('/api/v1/read/booking.guest_summary', { token: app.tokens.reader, body: { event_id: eventId } });
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.deepEqual(summary.data, {
    eventId, total: 3, bySex: { H: 1, M: 1, X: 0, sinDato: 1 }, minors: 1, signed: 1,
    dataStatus: { datos_revisados: 1, pendiente_datos: 2 }, sesStatus: { pendiente_envio: 3 },
  });
  assert.equal(JSON.stringify(summary.data).includes('Sintética'), false);
  assert.equal((await app.call('/api/v1/read/booking.guest_summary', { token: app.tokens.reader, body: { event_id: uuid() } })).status, 404);
  assert.equal((await app.call('/api/v1/read/booking.guest_summary', { token: app.tokens.reader, body: {} })).data.error.code, 'INVALID_OPERATION');
});

test('proyección para Food · columnas del contrato, restricciones agregadas y sin datos personales', async () => {
  const { reservationId, eventId } = await createEvent({ minors_count: 2, meal_notes: 'Sin picante' });
  const guestId = uuid();
  await ok([
    { op: 'insert', table: GUESTS, id: guestId, fields: { event_id: eventId, ...ADULT } },
    { op: 'insert', table: RESTRICTIONS, id: uuid(), fields: { event_id: eventId, guest_id: guestId, restriction_type: 'alergia', subject: ' Pistacho ', severity: 'grave' } },
    { op: 'insert', table: RESTRICTIONS, id: uuid(), fields: { event_id: eventId, restriction_type: 'vegano', servings: 1 } },
    { op: 'insert', table: RESTRICTIONS, id: uuid(), fields: { event_id: eventId, guest_id: guestId, restriction_type: 'vegano' } },
    { op: 'insert', table: RESTRICTIONS, id: uuid(), fields: { event_id: eventId, restriction_type: 'sin_gluten', servings: 3, active: false } },
  ]);
  const row = await projection(eventId);
  // jsonb no conserva el orden de las columnas: se compara el conjunto
  assert.deepEqual(Object.keys(row).sort(), [
    'event_id', 'event_code', 'reservation_code', 'title', 'event_type', 'start_date', 'end_date', 'arrival_time', 'departure_time',
    'guest_count', 'minors_count', 'meal_plan', 'menu_style', 'dietary_restrictions', 'event_revision',
    'reservation_status', 'guest_count_is_final', 'requires_meals', 'meal_notes', 'reservation_id',
  ].sort());
  assert.match(row.event_code, /^EVT_/); assert.match(row.reservation_code, /^RSV_/);
  assert.equal(row.guest_count, 20); assert.equal(row.guest_count_is_final, false); assert.equal(row.minors_count, 2);
  assert.equal(row.meal_plan, 'pension_completa'); assert.equal(row.menu_style, 'vegetariano');
  assert.equal(row.reservation_status, 'confirmada'); assert.equal(row.reservation_id, reservationId); assert.equal(row.requires_meals, true); assert.equal(row.meal_notes, 'Sin picante');
  assert.deepEqual(row.dietary_restrictions, [
    { type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1, kitchen_notes: null },
    { type: 'vegano', subject: null, severity: null, servings: 2, kitchen_notes: null },
  ]);
  const text = JSON.stringify(row);
  for (const secret of [guestId, '00000000T', 'Sintética', '1990-01-15', 'Calle Inventada']) assert.equal(text.includes(secret), false, secret);

  // Food no puede leer otra cosa de Booking, y un usuario de Booking no entra como Food
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: 'booking.guest_summary', p_args: { event_id: eventId } }), (e: any) => e.code === 'INVALID_OPERATION');
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: app.users.owner, p_name: PROJECTION, p_args: {} }), (e: any) => e.code === 'NO_MEMBERSHIP');
  const own = await app.call(`/api/v1/read/${PROJECTION}?where[event_id]=${eventId}`, { token: app.tokens.reader });
  assert.equal(own.status, 200); assert.equal(own.data.rows[0].event_id, eventId);

  // una reserva cancelada sigue en la proyección con su estado; borrada, desaparece
  const reservation = (await snapshotRows(RESERVATIONS, app.tokens.owner)).find((r) => r.id === reservationId);
  await ok([{ op: 'update', table: RESERVATIONS, id: reservationId, expectedRevision: reservation.revision, fields: { status: 'cancelada' } }]);
  assert.equal((await projection(eventId)).reservation_status, 'cancelada');
});

test('proyección para Food · event_revision solo avanza con cambios que afectan a cocina', async () => {
  const { reservationId, eventId } = await createEvent();
  let reservationRevision = (await snapshotRows(RESERVATIONS, app.tokens.owner)).find((r) => r.id === reservationId).revision;
  let eventRevision = 1;
  const revision = async () => (await projection(eventId)).event_revision as number;
  const updateEvent = async (fields: Record<string, unknown>) => { await ok([{ op: 'update', table: EVENTS, id: eventId, expectedRevision: eventRevision, fields }]); eventRevision += 1; };
  const updateReservation = async (fields: Record<string, unknown>) => { await ok([{ op: 'update', table: RESERVATIONS, id: reservationId, expectedRevision: reservationRevision, fields }]); reservationRevision += 1; };

  let last = await revision();
  const unchanged = async (label: string) => assert.equal(await revision(), last, label);
  const advanced = async (label: string) => { const now = await revision(); assert.ok(now > last, `${label}: ${now} > ${last}`); last = now; };

  await updateEvent({ cleaning_status: 'hecha', preparation_status: 'en_proceso', operational_notes: 'Llaves en recepción' });
  await unchanged('estados operativos y notas');
  await updateReservation({ internal_notes: 'Llamar el lunes', contact_phone: '600000001', priority: 'alta' });
  await unchanged('notas internas, contacto y prioridad');

  await updateEvent({ final_guests: 22 });
  await advanced('personas finales');
  assert.equal((await projection(eventId)).guest_count, 22); assert.equal((await projection(eventId)).guest_count_is_final, true);
  await updateEvent({ arrival_time: '17:00', departure_time: '12:00' });
  await advanced('horario');
  await updateEvent({ meal_plan_confirmed: 'media_pension' });
  await advanced('régimen confirmado');
  assert.equal((await projection(eventId)).meal_plan, 'media_pension');
  await updateReservation({ end_date: '2027-03-08' });
  await advanced('fechas de la reserva');
  await updateReservation({ expected_guests: 25 });
  await advanced('personas previstas');

  const restriction = uuid();
  await ok([{ op: 'insert', table: RESTRICTIONS, id: restriction, fields: { event_id: eventId, restriction_type: 'vegano', servings: 2 } }]);
  await advanced('alta de restricción');
  await ok([{ op: 'update', table: RESTRICTIONS, id: restriction, expectedRevision: 1, fields: { servings: 3 } }]);
  await advanced('cambio de restricción');
  await ok([{ op: 'delete', table: RESTRICTIONS, id: restriction, expectedRevision: 2 }]);
  await advanced('baja de restricción');
  assert.deepEqual((await projection(eventId)).dietary_restrictions, []);

  await ok([{ op: 'insert', table: GUESTS, id: uuid(), fields: { event_id: eventId, first_name: 'Nueva' } }]);
  await unchanged('un huésped nuevo no cambia nada para cocina');
  // la revisión de la fila del evento sí cambió con todo lo anterior: no es el mismo número
  assert.notEqual((await snapshotRows(EVENTS, app.tokens.owner)).find((e) => e.id === eventId).revision, last);
});

test('vaciar papelera · la purga de hijos a padres borra una reserva completa y solo un propietario puede', async () => {
  const { reservationId, eventId } = await createEvent();
  const guestId = uuid();
  const restrictionId = uuid();
  await ok([
    { op: 'insert', table: GUESTS, id: guestId, fields: { event_id: eventId, ...ADULT } },
    { op: 'insert', table: RESTRICTIONS, id: restrictionId, fields: { event_id: eventId, guest_id: guestId, restriction_type: 'vegano' } },
    ...checklistSeedOperations(eventId, uuid, { types: ['salas'] }),
  ]);
  const revision = async (table: string, id: string) => (await snapshotRows(table, app.tokens.owner)).find((r) => r.id === id).revision;
  const items = (await snapshotRows(CHECKLIST, app.tokens.owner)).filter((i) => i.event_id === eventId);
  await ok([
    ...items.map((i) => ({ op: 'delete', table: CHECKLIST, id: i.id, expectedRevision: i.revision })),
    { op: 'delete', table: RESTRICTIONS, id: restrictionId, expectedRevision: 1 },
    { op: 'delete', table: GUESTS, id: guestId, expectedRevision: 1 },
    { op: 'delete', table: EVENTS, id: eventId, expectedRevision: await revision(EVENTS, eventId) },
    { op: 'delete', table: RESERVATIONS, id: reservationId, expectedRevision: await revision(RESERVATIONS, reservationId) },
  ]);

  const tables = [CHECKLIST, RESTRICTIONS, GUESTS, EVENTS, TABLES.finance, RESERVATIONS];
  const denied = await app.call('/api/v1/trash/purge', { token: app.tokens.editor, body: { requestId: `purge-${uuid()}`, tables } });
  assert.equal(denied.status, 403);
  const purged = await app.call('/api/v1/trash/purge', { body: { requestId: `purge-${uuid()}`, tables } });
  assert.equal(purged.status, 200, JSON.stringify(purged.data));
  assert.ok(purged.data.purged >= 7, `reserva, evento, huésped, restricción y cuatro tareas: ${purged.data.purged}`);
  const left = async (table: string, id: string) => (await app.t.db.query(`select 1 from ${table} where id = $1`, [id])).rows.length;
  assert.deepEqual([await left(RESERVATIONS, reservationId), await left(EVENTS, eventId), await left(GUESTS, guestId), await left(RESTRICTIONS, restrictionId)], [0, 0, 0, 0]);
  assert.equal((await app.t.db.query('select 1 from booking.event_food_state where id = $1', [eventId])).rows.length, 0, 'el contador de la proyección se va con el evento');
});
