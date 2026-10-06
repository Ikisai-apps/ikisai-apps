/** Booking · fase B3: cola de sincronización con Calendar, con adaptador en memoria (docs/booking/API.md §7.3 y §11 A–D, I, K). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createFakeCalendarAdapter, fatalError, recoverableError } from '../../supabase/functions/booking-api/calendar/adapter.ts';
import { runCalendarTick } from '../../supabase/functions/booking-api/calendar/worker.ts';
import { buildCalendarPayload, calendarDesired, calendarEventId, calendarPayloadHash, calendarProjection, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const { reservations: RESERVATIONS, events: EVENTS, guests: GUESTS } = TABLES;
const CONFIRM = 'booking.confirm_reservation';
const WORKER_KEY = 'clave-de-worker-de-prueba';
const uuid = () => crypto.randomUUID();
const fake = createFakeCalendarAdapter();

let app: TestApp;
let off: TestApp['handler']; // misma base de datos, sin adaptador: integración apagada
let seq = 0;

test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => {
      off = createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] });
      return createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, calendar: { adapter: fake } });
    },
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[], token: string = app.tokens.owner) {
  const res = await app.call('/api/v1/commands', { token, body: { requestId: `c-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
}
async function rows(sql: string, params: unknown[] = []): Promise<any[]> {
  return (await app.t.db.query(sql, params)).rows as any[];
}
const jobs = (id: string) => rows('select * from booking.calendar_sync_jobs where reservation_id = $1 order by created_at', [id]);
const link = async (id: string) => (await rows('select * from booking.calendar_links where reservation_id = $1', [id]))[0];
const revisionOf = async (table: string, id: string) => (await rows(`select revision from ${table} where id = $1`, [id]))[0].revision;

async function create(fields: Record<string, unknown> = {}): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: RESERVATIONS, id, fields: { title: 'Retiro Sintético', status: 'pre_reservada', start_date: '2027-03-05', end_date: '2027-03-07', expected_guests: 20, contact_name: 'Contacto Inventado', ...fields } }]);
  return id;
}
async function update(table: string, id: string, fields: Record<string, unknown>) {
  await ok([{ op: 'update', table, id, expectedRevision: Number(await revisionOf(table, id)), fields }]);
}
async function confirm(id: string): Promise<string> {
  const eventId = uuid();
  await ok([{ op: 'call', procedure: CONFIRM, args: { reservation_id: id, event_id: eventId, from_status: 'pre_reservada' } }]);
  return eventId;
}
async function tick(body: Record<string, unknown> = {}) {
  const res = await app.call('/api/v1/calendar/tick', { body });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
/** Deja la cola limpia para que cada prueba cuente solo sus llamadas. */
async function drain() { await tick({ limit: 50 }); }
const makeDue = (id: string) => rows(`update booking.calendar_sync_jobs set available_at = now() - interval '1 second' where reservation_id = $1 and status = 'pending' returning id`, [id]);

// --- Dominio puro -----------------------------------------------------------
const RID = '11111111-2222-3333-4444-555555555555';
const base = { id: RID, code: 'RSV_2027_0001', title: 'Retiro', status: 'pre_reservada', start_date: '2027-03-05', end_date: '2027-03-07', expected_guests: 20 };

test('dominio: estado deseado según la tabla de §7.3', () => {
  for (const status of ['pre_reservada', 'confirmada', 'en_ejecucion']) assert.equal(calendarDesired({ ...base, status }), 'present');
  for (const status of ['en_estudio', 'negociacion', 'cancelada', 'perdida']) assert.equal(calendarDesired({ ...base, status }), 'absent');
  assert.equal(calendarDesired({ ...base, status: 'cerrada' }), 'keep');
  assert.equal(calendarDesired({ ...base, status: 'cerrada', archived_at: '2027-04-01T00:00:00Z' }), 'absent');
  assert.equal(calendarDesired({ ...base, status: 'confirmada', deleted_at: '2027-04-01T00:00:00Z' }), 'absent');
});

test('dominio: título, color, fechas, id determinista y hash estable', async () => {
  const pre = buildCalendarPayload(base, null);
  assert.equal(pre.summary, '[PRE] Retiro'); assert.equal(pre.colorId, '5');
  assert.deepEqual([pre.start, pre.end], [{ date: '2027-03-05' }, { date: '2027-03-08' }], 'día completo que incluye el día de salida');
  assert.match(pre.description, /^\[\[IKISAI_CALENDAR_SYNC\]\]\n\[\[ID_RESERVA=RSV_2027_0001\]\]/);
  const described = buildCalendarPayload({ ...base, status: 'en_ejecucion', contact_email: 'grupo_prueba@example.invalid', meal_plan_requested: 'pension_completa' }, { code: 'EVT_2027_0001', preparation_status: 'en_proceso' }).description;
  for (const expected of ['Código: RSV_2027_0001', 'Estado: en ejecucion', 'grupo_prueba@example.invalid', 'OPERACIÓN\nCódigo: EVT_2027_0001', 'Preparación: en proceso', 'Régimen solicitado: pension completa']) assert.ok(described.includes(expected), expected);
  assert.deepEqual(pre.extendedProperties.private, { ikisaiReservationId: RID, ikisaiReservationCode: 'RSV_2027_0001' });
  assert.equal(buildCalendarPayload({ ...base, status: 'confirmada' }, null).colorId, '10');
  assert.equal(buildCalendarPayload({ ...base, status: 'en_ejecucion' }, null).colorId, '9');
  assert.equal(buildCalendarPayload({ ...base, status: 'confirmada' }, null).summary, 'Retiro');

  const timed = buildCalendarPayload({ ...base, status: 'confirmada' }, { arrival_time: '17:00:00', departure_time: '12:00' });
  assert.deepEqual(timed.start, { dateTime: '2027-03-05T17:00:00', timeZone: 'Europe/Madrid' });
  assert.deepEqual(timed.end, { dateTime: '2027-03-07T12:00:00', timeZone: 'Europe/Madrid' });
  const oneHour = buildCalendarPayload(base, { arrival_time: '17:00' });
  assert.deepEqual(oneHour.start, { date: '2027-03-05' }, 'con una sola hora no se inventa la otra');
  const sameDay = buildCalendarPayload({ ...base, end_date: '2027-03-05' }, { arrival_time: '17:00', departure_time: '12:00' });
  assert.deepEqual(sameDay.end, { dateTime: '2027-03-06T12:00:00', timeZone: 'Europe/Madrid' }, 'fin no posterior al inicio: +1 día');
  assert.deepEqual(buildCalendarPayload({ ...base, start_date: '2027-12-30', end_date: '2027-12-31' }, null).end, { date: '2028-01-01' });

  assert.equal(calendarEventId(RID), 'iki11111111222233334444555555555555g1');
  assert.equal(calendarEventId(RID, 3), 'iki11111111222233334444555555555555g3');
  assert.match(calendarEventId(RID, 2), /^[a-v0-9]+$/);

  const a = await calendarPayloadHash(pre);
  const reordered = Object.fromEntries(Object.entries(pre).reverse()) as typeof pre;
  assert.equal(await calendarPayloadHash(reordered), a, 'el orden de las claves no cambia el hash');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(await calendarPayloadHash({ ...pre, summary: 'Otro' }), a);
  const projection = await calendarProjection(base, null);
  assert.deepEqual([projection.desired, projection.payloadHash, projection.eventId], ['present', a, calendarEventId(RID)]);
  assert.equal((await calendarProjection({ ...base, status: 'cerrada' }, null)).payload, undefined);
});

// --- Cola y worker ----------------------------------------------------------
test('A: una reserva en negociación ni encola ni publica', async () => {
  const id = await create({ status: 'negociacion' });
  assert.equal((await jobs(id)).length, 0);
  await drain();
  assert.equal(await link(id), undefined);
  assert.equal(fake.events.has(calendarEventId(id)), false);
});

test('B–D: pre-reserva, guardar sin cambios, confirmar y horario real sobre un único evento', async () => {
  await drain(); fake.reset();
  const id = await create();
  assert.deepEqual((await jobs(id)).map((j) => [j.status, j.desired_action]), [['pending', 'upsert']]);
  const first = await tick();
  assert.deepEqual([first.processed, first.failed, first.pending, first.health], [1, 0, 0, 'ok']);
  const eventId = calendarEventId(id);
  assert.equal(fake.events.size, 1);
  const pre = fake.events.get(eventId)!;
  assert.equal(pre.summary, '[PRE] Retiro Sintético'); assert.equal(pre.colorId, '5');
  assert.deepEqual([pre.start, pre.end], [{ date: '2027-03-05' }, { date: '2027-03-08' }]);
  let l = await link(id);
  assert.deepEqual([l.sync_status, l.provider_event_id, l.calendar_id, l.generation], ['synced', eventId, 'fake-calendar', 1]);
  assert.equal(Number(l.source_reservation_revision), Number(await revisionOf(RESERVATIONS, id)));
  assert.equal(fake.calls.findByMarker, 1, 'solo la primera sincronización busca un evento que adoptar');

  // Guardar sin cambios visibles en Calendar: se encola, pero el hash coincide y no se llama al adaptador.
  await update(RESERVATIONS, id, { internal_notes: 'nota interna que no sale' });
  assert.equal((await jobs(id)).filter((j) => j.status === 'pending').length, 1);
  await tick();
  assert.equal(fake.calls.upsert, 1);
  assert.equal(Number((await link(id)).source_reservation_revision), Number(await revisionOf(RESERVATIONS, id)));

  const eventRow = await confirm(id);
  await tick();
  assert.equal(fake.events.size, 1, 'se actualiza el mismo evento');
  const confirmed = fake.events.get(eventId)!;
  assert.equal(confirmed.summary, 'Retiro Sintético'); assert.equal(confirmed.colorId, '10');
  assert.equal(fake.calls.upsert, 2);

  await update(EVENTS, eventRow, { arrival_time: '17:00', departure_time: '12:00' });
  await tick();
  const timed = fake.events.get(eventId)!;
  assert.deepEqual(timed.start, { dateTime: '2027-03-05T17:00:00', timeZone: 'Europe/Madrid' });
  assert.deepEqual(timed.end, { dateTime: '2027-03-07T12:00:00', timeZone: 'Europe/Madrid' });
  l = await link(id);
  assert.equal(Number(l.source_event_revision), Number(await revisionOf(EVENTS, eventRow)));
  assert.equal(fake.events.size, 1); assert.equal(fake.calls.findByMarker, 1);
});

test('el payload no lleva huéspedes, importes ni notas internas', async () => {
  await drain();
  const id = await create({ internal_notes: 'SECRETO-INTERNO', customer_notes: 'Llegan en autobús' });
  const eventId = await confirm(id);
  await ok([{ op: 'insert', table: TABLES.finance, id, fields: { budget_amount: 98765.43 } }]).catch(() => update(TABLES.finance, id, { budget_amount: 98765.43 }));
  await ok([{ op: 'insert', table: GUESTS, id: uuid(), fields: { event_id: eventId, first_name: 'Huespedficticio', last_name_1: 'Apellidoficticio' } }]);
  await update(EVENTS, eventId, { operational_notes: 'Montaje en círculo' });
  await tick();
  const text = JSON.stringify(fake.events.get(calendarEventId(id)));
  for (const forbidden of ['SECRETO-INTERNO', '98765', 'Huespedficticio', 'Apellidoficticio']) assert.equal(text.includes(forbidden), false, forbidden);
  for (const expected of ['Llegan en autobús', 'Montaje en círculo', 'Contacto Inventado']) assert.equal(text.includes(expected), true, expected);
});

test('I: cancelar borra el evento, el enlace queda deleted y la reserva sigue', async () => {
  await drain();
  const id = await create();
  await tick();
  assert.equal(fake.events.has(calendarEventId(id)), true);
  const purge = await app.t.db.query('delete from booking.reservations where id = $1', [id]).then(() => null, (e: Error) => e);
  assert.match(String((purge as Error | null)?.message), /INVALID_OPERATION/, 'no se purga una reserva con evento vivo en Calendar');
  await update(RESERVATIONS, id, { status: 'cancelada' });
  assert.equal((await jobs(id)).at(-1).desired_action, 'delete');
  await tick();
  assert.equal(fake.events.has(calendarEventId(id)), false);
  assert.equal((await link(id)).sync_status, 'deleted');
  assert.equal((await rows('select status from booking.reservations where id = $1', [id]))[0].status, 'cancelada');
  // Con el evento ya retirado, la purga física vuelve a estar permitida y arrastra enlace y trabajos.
  await rows('delete from booking.reservation_finance where id = $1', [id]);
  await rows('delete from booking.reservations where id = $1', [id]);
  assert.equal(await link(id), undefined); assert.equal((await jobs(id)).length, 0);
});

test('primera sincronización: adopta un evento existente con el marcador de la reserva', async () => {
  await drain();
  const id = await create({ status: 'negociacion' });
  const code = (await rows('select code from booking.reservations where id = $1', [id]))[0].code as string;
  const legacy = buildCalendarPayload({ ...base, id, code }, null);
  fake.events.set('legacyevent01', legacy);
  await update(RESERVATIONS, id, { status: 'pre_reservada' });
  await tick();
  assert.equal((await link(id)).provider_event_id, 'legacyevent01');
  assert.equal(fake.events.has(calendarEventId(id)), false, 'no se crea un segundo evento');
  assert.equal(fake.events.get('legacyevent01')!.summary, '[PRE] Retiro Sintético');
});

test('K1–K2: cerrada no toca nada; archivar una cerrada retira el evento', async () => {
  await drain();
  const id = await create();
  await confirm(id);
  await tick();
  const before = { ...fake.calls };
  // Atajo por SQL: el trigger de encolado es el mismo que dispara core.commit.
  await rows(`update booking.reservations set status = 'cerrada', title = 'Título cambiado tras cerrar' where id = $1`, [id]);
  const closed = await tick();
  assert.equal(closed.processed, 1);
  assert.deepEqual(fake.calls, before, 'cerrada: ni se actualiza ni se borra');
  assert.equal(fake.events.get(calendarEventId(id))!.summary, 'Retiro Sintético');
  assert.equal((await link(id)).sync_status, 'synced');
  await rows('update booking.reservations set archived_at = now() where id = $1', [id]);
  await tick();
  assert.equal(fake.events.has(calendarEventId(id)), false);
  assert.equal((await link(id)).sync_status, 'deleted');
});

test('fallo recuperable: espera creciente y error al octavo intento', async () => {
  await drain();
  const id = await create();
  fake.failNext(recoverableError('HTTP_503'), 8);
  const expectedMinutes = [1, 4, 16, 64, 256, 360, 360];
  for (let attempt = 1; attempt <= 8; attempt++) {
    const out = await tick();
    assert.deepEqual([out.processed, out.failed], [0, 1], `intento ${attempt}`);
    const [job] = await jobs(id);
    assert.equal(job.attempts, attempt); assert.equal(job.last_error, 'HTTP_503');
    if (attempt < 8) {
      assert.equal(job.status, 'pending');
      const wait = (new Date(job.available_at).getTime() - new Date(job.updated_at).getTime()) / 60000;
      assert.ok(Math.abs(wait - expectedMinutes[attempt - 1]!) < 0.1, `espera ${wait} min en el intento ${attempt}`);
      assert.equal((await tick()).processed + (await tick()).failed, 0, 'no se reintenta antes de tiempo');
      await makeDue(id);
    } else assert.equal(job.status, 'error');
  }
  const l = await link(id);
  assert.deepEqual([l.sync_status, l.last_error, l.provider_event_id], ['error', 'HTTP_503', null]);

  // Reintento manual: el lector no puede; el editor reencola y el siguiente tick sincroniza.
  const denied = await app.call(`/api/v1/calendar/${id}/retry`, { token: app.tokens.reader, body: {} });
  assert.equal(denied.status, 403);
  const retried = await app.call(`/api/v1/invoke/booking.calendar_retry`, { token: app.tokens.editor, body: { reservationId: id } });
  assert.equal(retried.status, 200, JSON.stringify(retried.data)); assert.deepEqual(retried.data, { queued: true });
  assert.deepEqual((await jobs(id)).map((j) => j.status), ['error', 'pending']);
  await tick();
  assert.equal((await link(id)).sync_status, 'synced');
  assert.equal(fake.events.has(calendarEventId(id)), true);
});

test('fallo definitivo: error inmediato y health distinto de ok', async () => {
  await drain();
  const id = await create();
  fake.failNext(fatalError('CALENDAR_NOT_FOUND'));
  const out = await tick();
  assert.deepEqual([out.failed, out.health], [1, 'calendar_not_found']);
  const [job] = await jobs(id);
  assert.deepEqual([job.status, job.attempts, job.last_error], ['error', 1, 'CALENDAR_NOT_FOUND']);
  assert.equal((await link(id)).sync_status, 'error');
  // Cancelar una reserva cuyo enlace quedó en error lo deja en deleted, no en error para siempre.
  await update(RESERVATIONS, id, { status: 'cancelada' });
  await tick();
  assert.equal((await link(id)).sync_status, 'deleted');
  const viaRoute = await app.call(`/api/v1/calendar/${id}/retry`, { token: app.tokens.editor, body: {} });
  assert.deepEqual([viaRoute.status, viaRoute.data.queued], [200, true]);
  await drain();
});

test('un solo trabajo pendiente por reserva: el cambio nuevo sustituye al pendiente', async () => {
  await drain();
  const id = await create();
  await update(RESERVATIONS, id, { title: 'Primer cambio' });
  await update(RESERVATIONS, id, { title: 'Segundo cambio' });
  const pending = await jobs(id);
  assert.equal(pending.length, 1);
  assert.equal(Number(pending[0].source_reservation_revision), Number(await revisionOf(RESERVATIONS, id)));
  // Un trabajo en curso que falla cuando ya hay otro pendiente queda como superseded.
  const claimed = (await app.t.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: 'booking.calendar_claim', p_args: { reservationIds: [id] } })) as any;
  assert.equal(claimed.jobs.length, 1); assert.equal(claimed.jobs[0].reservation.title, 'Segundo cambio');
  assert.equal('internal_notes' in claimed.jobs[0].reservation, false);
  await update(RESERVATIONS, id, { title: 'Tercer cambio' });
  await app.t.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: 'booking.calendar_report', p_args: { jobId: claimed.jobs[0].jobId, outcome: 'retry', error: 'timeout' } });
  assert.deepEqual((await jobs(id)).map((j) => j.status).sort(), ['pending', 'superseded']);
  await tick();
  assert.equal(fake.events.get(calendarEventId(id))!.summary, '[PRE] Tercer cambio');
});

test('permisos: el lector lee calendar_status pero no invoca acciones ni el tick', async () => {
  await drain();
  const id = await create();
  const status = await app.call(`/api/v1/calendar/status?reservationIds=${id}`, { token: app.tokens.reader });
  assert.equal(status.status, 200, JSON.stringify(status.data));
  assert.deepEqual([status.data.configured, status.data.health, status.data.calendarId], [true, 'ok', 'fake-calendar']);
  assert.deepEqual(status.data.items.map((i: any) => [i.reservationId, i.syncStatus, i.pendingJob, i.attempts]), [[id, 'pending', true, 0]]);
  assert.ok(status.data.items[0].nextAttemptAt);
  const read = await app.call('/api/v1/read/booking.calendar_status', { token: app.tokens.reader, body: { reservationIds: [id] } });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  for (const path of ['/api/v1/invoke/booking.calendar_retry', '/api/v1/calendar/tick', `/api/v1/calendar/${id}/retry`]) {
    assert.equal((await app.call(path, { token: app.tokens.reader, body: { reservationId: id } })).status, 403, path);
  }
  // claim y report son solo del sistema: ni siquiera el propietario los invoca.
  assert.equal((await app.call('/api/v1/invoke/booking.calendar_claim', { token: app.tokens.owner, body: {} })).status, 403);
  await tick();
  const after = await app.call(`/api/v1/calendar/status?reservationIds=${id}`, { token: app.tokens.reader });
  assert.deepEqual(after.data.items.map((i: any) => [i.syncStatus, i.pendingJob]), [['synced', false]]);
  assert.ok(after.data.items[0].htmlLink);
});

function worker(handler: TestApp['handler'], name: string, key: string | null, body: unknown = {}) {
  return handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Ikisai-Worker-Key': key } : {}) }, body: JSON.stringify(body),
  }));
}

test('ruta worker: clave correcta, incorrecta y ausente', async () => {
  await drain();
  const id = await create();
  assert.equal((await worker(app.handler, 'booking.calendar_claim', 'otra-clave')).status, 401);
  assert.equal((await worker(app.handler, 'booking.calendar_claim', null)).status, 401);
  assert.equal((await worker(off, 'booking.calendar_claim', WORKER_KEY)).status, 401, 'sin workerKey configurada la ruta no existe');
  const res = await worker(app.handler, 'booking.calendar_claim', WORKER_KEY, { limit: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jobs: [], pending: 1 });
  assert.equal((await jobs(id))[0].status, 'pending');
  await drain();
});

test('sin adaptador configurado: no se marca nada como sincronizado', async () => {
  await drain();
  const id = await create();
  const res = await off(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/calendar/tick`, {
    method: 'POST', headers: { Origin: BOOKING_ORIGINS[0]!, 'Content-Type': 'application/json', Authorization: 'Bearer ' + app.tokens.owner }, body: '{}',
  }));
  assert.deepEqual(await res.json(), { processed: 0, failed: 0, pending: 1, health: 'not_configured' });
  assert.deepEqual((await jobs(id)).map((j) => j.status), ['pending']);
  assert.equal(await link(id), undefined);
  const direct = await runCalendarTick({ adapter: null, invoke: (name, args) => app.t.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: name, p_args: args }) });
  assert.equal(direct.health, 'not_configured');
  await drain();
});
