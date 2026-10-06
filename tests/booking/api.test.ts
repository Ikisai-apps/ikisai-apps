/** Booking · base (fase B1): códigos, restricciones, confirmación, invariantes y permisos, por HTTP sobre PGlite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';

const RESERVATIONS = 'booking.reservations';
const FINANCE = 'booking.reservation_finance';
const EVENTS = 'booking.events';
const CONFIRM = 'booking.confirm_reservation';
const uuid = () => crypto.randomUUID();

let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

function commands(operations: unknown[], options: { token?: string; requestId?: string } = {}) {
  return app.call('/api/v1/commands', { token: options.token ?? app.tokens.editor, body: { requestId: options.requestId ?? `t-${++seq}-${uuid()}`, operations } });
}

/** Crea una reserva (y su fila de importes) lista para confirmar. Devuelve su id. */
async function createReservation(fields: Record<string, unknown> = {}, withFinance = true): Promise<string> {
  const id = uuid();
  const operations: unknown[] = [{
    op: 'insert', table: RESERVATIONS, id,
    fields: { title: 'Retiro Test', status: 'pre_reservada', start_date: '2027-03-05', end_date: '2027-03-07', expected_guests: 20, uses_accommodation: true, requires_meals: true, meal_plan_requested: 'pension_completa', ...fields },
  }];
  if (withFinance) operations.push({ op: 'insert', table: FINANCE, id, fields: { deposit_required: 300 } });
  const res = await commands(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}

async function rows(table: string, token = app.tokens.owner, includeDeleted = false): Promise<any[]> {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}${includeDeleted ? '&includeDeleted=1' : ''}`, { token });
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows;
}
const row = async (table: string, id: string) => (await rows(table, app.tokens.owner, true)).find((r) => r.id === id);
const confirm = (reservationId: string, eventId: string, fromStatus = 'pre_reservada', extra: Record<string, unknown> = {}) =>
  commands([{ op: 'call', procedure: CONFIRM, args: { reservation_id: reservationId, event_id: eventId, from_status: fromStatus, ...extra } }]);

test('booking · tablas registradas; reader no recibe los importes', async () => {
  const boot = await app.call('/api/v1/bootstrap', { token: app.tokens.reader });
  const byName = Object.fromEntries(boot.data.tables.map((t: any) => [t.table, t]));
  assert.deepEqual(Object.keys(byName).sort(), [EVENTS, FINANCE, RESERVATIONS].sort());
  assert.equal(byName[FINANCE].readable, false);
  assert.equal(byName[RESERVATIONS].readable, true);

  const before = (await app.call('/api/v1/bootstrap')).data.cursor;
  const id = await createReservation();
  const all = await app.call('/api/v1/snapshot', { token: app.tokens.reader });
  assert.deepEqual(all.data.tables.map((t: any) => t.table).sort(), [EVENTS, RESERVATIONS].sort());
  assert.equal((await app.call(`/api/v1/snapshot?tables=${FINANCE}`, { token: app.tokens.reader })).status, 403);
  const readerChanges = await app.call(`/api/v1/changes?after=${before}`, { token: app.tokens.reader });
  assert.deepEqual(readerChanges.data.items.map((c: any) => c.table), [RESERVATIONS]);
  const readerHistory = await app.call('/api/v1/history?limit=1', { token: app.tokens.reader });
  assert.equal(readerHistory.data.items[0].changes.some((c: any) => c.table === FINANCE), false);
  const editorChanges = await app.call(`/api/v1/changes?after=${before}`, { token: app.tokens.editor });
  assert.deepEqual(editorChanges.data.items.map((c: any) => c.table), [RESERVATIONS, FINANCE]);
  assert.equal((await rows(FINANCE, app.tokens.editor)).some((r) => r.id === id), true);
});

test('booking · códigos RSV_AAAA_NNN: los pone el servidor, correlativos, y el reintento no consume número', async () => {
  const a = uuid(); const b = uuid();
  const batch = { requestId: `code-${uuid()}`, operations: [{ op: 'insert', table: RESERVATIONS, id: a, fields: { title: 'Código A' } }] };
  const first = await app.call('/api/v1/commands', { body: batch });
  const codeA: string = first.data.changes[0].after.code;
  assert.match(codeA, /^RSV_\d{4}_\d{3}$/);
  assert.equal((await app.call('/api/v1/commands', { body: batch })).data.replayed, true);
  const second = await commands([{ op: 'insert', table: RESERVATIONS, id: b, fields: { title: 'Código B' } }]);
  const codeB: string = second.data.changes[0].after.code;
  assert.equal(Number(codeB.slice(-3)), Number(codeA.slice(-3)) + 1);
  const forced = await commands([{ op: 'insert', table: RESERVATIONS, id: uuid(), fields: { title: 'Código C', code: 'RSV_1999_001' } }]);
  assert.equal(forced.data.error.code, 'INVALID_FIELDS');
});

test('booking · restricciones: fechas obligatorias desde pre-reserva, orden de fechas y menores', async () => {
  const noDates = await commands([{ op: 'insert', table: RESERVATIONS, id: uuid(), fields: { title: 'Sin fechas', status: 'pre_reservada' } }]);
  assert.equal(noDates.status, 422); assert.equal(noDates.data.error.code, 'CONSTRAINT_VIOLATION');
  assert.equal(noDates.data.error.details.sqlstate, '23514');

  const id = uuid();
  assert.equal((await commands([{ op: 'insert', table: RESERVATIONS, id, fields: { title: 'En estudio', status: 'en_estudio' } }])).status, 200);
  const promote = await commands([{ op: 'update', table: RESERVATIONS, id, expectedRevision: 1, fields: { status: 'pre_reservada' } }]);
  assert.equal(promote.data.error.code, 'CONSTRAINT_VIOLATION');
  // el orden de fechas contra un valor ya guardado lo cierra la base
  await commands([{ op: 'update', table: RESERVATIONS, id, expectedRevision: 1, fields: { start_date: '2027-05-10' } }]);
  const backwards = await commands([{ op: 'update', table: RESERVATIONS, id, expectedRevision: 2, fields: { end_date: '2027-05-09' } }]);
  assert.equal(backwards.data.error.code, 'CONSTRAINT_VIOLATION');
  // y dentro del mismo lote lo explica el dominio
  const sameBatch = await commands([{ op: 'update', table: RESERVATIONS, id, expectedRevision: 2, fields: { start_date: '2027-05-10', end_date: '2027-05-09' } }]);
  assert.equal(sameBatch.data.error.code, 'INVALID_FIELDS'); assert.equal(sameBatch.data.error.details.field, 'end_date');
  const minors = await commands([{ op: 'update', table: RESERVATIONS, id, expectedRevision: 2, fields: { expected_guests: 5, minors_count: 6 } }]);
  assert.equal(minors.data.error.details.field, 'minors_count');
  assert.equal((await row(RESERVATIONS, id)).revision, 2, 'ningún lote rechazado cambió la fila');
});

test('booking · confirmar crea el evento una sola vez y es idempotente', async () => {
  const id = await createReservation();
  const plain = await commands([{ op: 'update', table: RESERVATIONS, id, expectedRevision: 1, fields: { status: 'confirmada' } }]);
  assert.equal(plain.status, 422); assert.equal(plain.data.error.code, 'EVENT_REQUIRED');
  assert.equal((await row(RESERVATIONS, id)).status, 'pre_reservada');

  const eventId = uuid();
  const done = await confirm(id, eventId);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const result = done.data.results[0].result;
  assert.equal(result.created, true); assert.equal(result.event_id, eventId); assert.match(result.event_code, /^EVT_\d{4}_\d{3}$/);
  assert.deepEqual(done.data.changes.filter((c: any) => c.op !== 'call').map((c: any) => [c.table, c.op]), [[EVENTS, 'insert'], [RESERVATIONS, 'update']]);
  const reservation = await row(RESERVATIONS, id);
  assert.equal(reservation.status, 'confirmada'); assert.equal(reservation.revision, 2);
  const event = await row(EVENTS, eventId);
  assert.equal(event.reservation_id, id); assert.equal(event.code, result.event_code); assert.equal(event.preparation_status, 'pendiente');

  // otro dispositivo confirma con otro id de evento: no hay segundo evento ni cambios de fila
  const again = await confirm(id, uuid());
  assert.equal(again.status, 200);
  assert.equal(again.data.results[0].result.created, false); assert.equal(again.data.results[0].result.event_id, eventId);
  assert.equal(again.data.changes.filter((c: any) => c.op !== 'call').length, 0);
  assert.equal((await rows(EVENTS)).filter((e) => e.reservation_id === id).length, 1);
  assert.equal((await row(RESERVATIONS, id)).revision, 2);

  // con el evento creado, el resto de transiciones son un update normal
  assert.equal((await commands([{ op: 'update', table: RESERVATIONS, id, expectedRevision: 2, fields: { status: 'en_ejecucion' } }])).status, 200);
  assert.equal((await commands([{ op: 'update', table: EVENTS, id: eventId, expectedRevision: 1, fields: { arrival_time: '17:00', departure_time: '12:00', final_guests: 22 } }])).status, 200);
});

test('booking · confirmar: estado cambiado, requisitos, transición inválida y modo estricto', async () => {
  const moved = await createReservation({ status: 'negociacion' });
  const changed = await confirm(moved, uuid(), 'pre_reservada');
  assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'STATUS_CHANGED');
  assert.equal(changed.data.error.details.currentStatus, 'negociacion');
  assert.equal((await confirm(moved, uuid(), 'negociacion')).status, 200, 'desde el estado que el usuario ve sí se puede');

  const draft = uuid();
  await commands([{ op: 'insert', table: RESERVATIONS, id: draft, fields: { title: 'Borrador', start_date: '2027-06-01' } }]);
  const missing = await confirm(draft, uuid(), 'en_estudio');
  assert.equal(missing.status, 422); assert.equal(missing.data.error.code, 'CONFIRM_REQUIREMENTS');
  assert.deepEqual(missing.data.error.details.missing, ['end_date', 'expected_guests']);

  const cancelled = await createReservation({ status: 'cancelada' });
  assert.equal((await confirm(cancelled, uuid(), 'cancelada')).data.error.code, 'INVALID_TRANSITION');
  const archived = await createReservation({ archived_at: '2027-01-01T00:00:00Z' });
  assert.equal((await confirm(archived, uuid())).data.error.code, 'INVALID_TRANSITION');

  const strict = await createReservation();
  await commands([{ op: 'update', table: RESERVATIONS, id: strict, expectedRevision: 1, fields: { contact_phone: '600000000' } }]);
  const stale = await confirm(strict, uuid(), 'pre_reservada', { expectedRevision: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
  assert.equal((await rows(EVENTS)).some((e) => e.reservation_id === strict), false, 'el lote rechazado no dejó evento');
  assert.equal((await confirm(strict, uuid())).status, 200, 'sin expectedRevision un cambio ajeno en otro campo no estorba');

  assert.equal((await confirm(uuid(), uuid())).data.error.code, 'NOT_FOUND');
  const badArgs = await commands([{ op: 'call', procedure: CONFIRM, args: { reservation_id: strict } }]);
  assert.equal(badArgs.data.error.code, 'INVALID_OPERATION');
  assert.equal((await confirm(strict, uuid(), 'pre_reservada')).status, 200);
  const reader = await app.call('/api/v1/commands', { token: app.tokens.reader, body: { requestId: `r-${uuid()}`, operations: [{ op: 'call', procedure: CONFIRM, args: { reservation_id: strict, event_id: uuid(), from_status: 'confirmada' } }] } });
  assert.equal(reader.status, 403);
});

test('booking · el evento solo nace al confirmar, solo lo borra un propietario y conserva su id', async () => {
  const id = await createReservation();
  const direct = await commands([{ op: 'insert', table: EVENTS, id: uuid(), fields: { reservation_id: id } }]);
  assert.equal(direct.status, 422); assert.equal(direct.data.error.code, 'INVALID_OPERATION');

  const eventId = uuid();
  await confirm(id, eventId);
  const other = await createReservation();
  const reparent = await commands([{ op: 'update', table: EVENTS, id: eventId, expectedRevision: 1, fields: { reservation_id: other } }]);
  assert.equal(reparent.data.error.code, 'INVALID_FIELDS');
  // la base lo impide aunque alguien se salte la Edge
  const raw = app.t.rpc('core_commit', {
    p_app: 'booking', p_actor: app.users.owner, p_request_id: `raw-${uuid()}`, p_digest: 'd', p_expected_cursor: null,
    p_operations: [{ op: 'update', table: EVENTS, id: eventId, expectedRevision: 1, fields: { reservation_id: other } }],
  });
  await assert.rejects(raw, (error: any) => error.code === 'IMMUTABLE_FIELD');

  assert.equal((await commands([{ op: 'delete', table: EVENTS, id: eventId, expectedRevision: 1 }])).status, 403);
  const orphanRule = await commands([{ op: 'delete', table: EVENTS, id: eventId, expectedRevision: 1 }], { token: app.tokens.owner });
  assert.equal(orphanRule.data.error.code, 'EVENT_REQUIRED', 'una reserva confirmada no puede quedarse sin evento');

  // volver a pre-reserva y mandar el evento a la papelera; confirmar de nuevo lo restaura con el mismo id y código
  const code = (await row(EVENTS, eventId)).code;
  const back = await commands([
    { op: 'update', table: RESERVATIONS, id, expectedRevision: 2, fields: { status: 'pre_reservada' } },
    { op: 'delete', table: EVENTS, id: eventId, expectedRevision: 1 },
  ], { token: app.tokens.owner });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const again = await confirm(id, uuid());
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.results[0].result.event_id, eventId); assert.equal(again.data.results[0].result.created, false);
  const restored = await row(EVENTS, eventId);
  assert.equal(restored.deleted_at, null); assert.equal(restored.code, code);
});

test('booking · borrar una reserva exige borrar con ella su evento y sus importes', async () => {
  const id = await createReservation();
  const eventId = uuid();
  await confirm(id, eventId);
  const alone = await commands([{ op: 'delete', table: RESERVATIONS, id, expectedRevision: 2 }], { token: app.tokens.owner });
  assert.equal(alone.data.error.code, 'ORPHAN_EVENT');
  const withoutFinance = await commands([
    { op: 'delete', table: EVENTS, id: eventId, expectedRevision: 1 },
    { op: 'delete', table: RESERVATIONS, id, expectedRevision: 2 },
  ], { token: app.tokens.owner });
  assert.equal(withoutFinance.data.error.code, 'ORPHAN_FINANCE');
  const whole = await commands([
    { op: 'delete', table: EVENTS, id: eventId, expectedRevision: 1 },
    { op: 'delete', table: FINANCE, id, expectedRevision: 1 },
    { op: 'delete', table: RESERVATIONS, id, expectedRevision: 2 },
  ], { token: app.tokens.owner });
  assert.equal(whole.status, 200, JSON.stringify(whole.data));
  assert.equal((await rows(RESERVATIONS)).some((r) => r.id === id), false);

  // se deshace desde el historial: vuelven las tres filas
  const plan = await app.call(`/api/v1/history/${whole.data.cursor}/undo-plan`, { body: {} });
  const undone = await app.call(`/api/v1/history/${whole.data.cursor}/undo`, { body: { requestId: `undo-${uuid()}`, planHash: plan.data.planHash } });
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  assert.equal((await row(RESERVATIONS, id)).deleted_at, null);
  assert.equal((await row(EVENTS, eventId)).deleted_at, null);

  // una reserva sin evento la puede borrar un editor junto con sus importes; la papelera se vacía de hijos a padres
  const loose = await createReservation({ status: 'negociacion' });
  assert.equal((await commands([{ op: 'delete', table: FINANCE, id: loose, expectedRevision: 1 }, { op: 'delete', table: RESERVATIONS, id: loose, expectedRevision: 1 }])).status, 200);
  const purged = await app.call('/api/v1/trash/purge', { body: { requestId: `purge-${uuid()}`, tables: [EVENTS, FINANCE, RESERVATIONS] } });
  assert.equal(purged.status, 200, JSON.stringify(purged.data)); assert.ok(purged.data.purged >= 2);
  assert.equal(await row(RESERVATIONS, loose), undefined);
});

test('booking · importes: validación y mismo id que la reserva', async () => {
  const id = await createReservation({}, false);
  const bad = await commands([{ op: 'insert', table: FINANCE, id, fields: { budget_amount: -5 } }]);
  assert.equal(bad.data.error.code, 'INVALID_FIELDS');
  assert.equal((await commands([{ op: 'insert', table: FINANCE, id, fields: { budget_amount: 1200.5, deposit_required: 300, payment_type: 'transferencia', payment_date: '2027-02-01' } }])).status, 200);
  assert.equal((await commands([{ op: 'insert', table: FINANCE, id, fields: {} }])).data.error.code, 'ROW_EXISTS');
  const stranger = await commands([{ op: 'insert', table: FINANCE, id: uuid(), fields: { budget_amount: 1 } }]);
  assert.equal(stranger.data.error.code, 'CONSTRAINT_VIOLATION', 'sin reserva con ese id no hay fila de importes');
  assert.equal(stranger.data.error.details.sqlstate, '23503');
});
