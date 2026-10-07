/** Booking · ampliación V2, bloque 2 (API.md §15.3): turnos del personal, necesidades de refuerzo y proyección de horas para Invoices. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { READS, shiftsWithoutActualHours, staffTotals, TABLES, uncoveredNeedsSoon, validateFields } from '../../supabase/functions/_domain/booking/mod.ts';

const { reservations: RESERVATIONS, events: EVENTS, staffAssignments: STAFF, staffNeeds: NEEDS } = TABLES;
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

function commands(operations: unknown[], token: string = app.tokens.owner) {
  return app.call('/api/v1/commands', { token, body: { requestId: `st-${++seq}-${uuid()}`, operations } });
}
async function ok(operations: unknown[], token: string = app.tokens.owner) {
  const res = await commands(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
}
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);

async function createEvent(start: string, end: string): Promise<{ reservationId: string; eventId: string }> {
  const reservationId = uuid(); const eventId = uuid();
  await ok([{ op: 'insert', table: RESERVATIONS, id: reservationId, fields: { title: `Retiro ${start}`, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 10 } }]);
  await ok([{ op: 'call', procedure: CONFIRM, args: { reservation_id: reservationId, event_id: eventId, from_status: 'pre_reservada' } }]);
  return { reservationId, eventId };
}
const shift = (eventId: string, fields: Record<string, unknown>, id = uuid()) =>
  ({ op: 'insert', table: STAFF, id, fields: { event_id: eventId, person_name: 'Persona Sintética', function: 'cocina', ...fields } });

test('personal · dominio: horas, turnos sin horas reales y refuerzos sin cubrir en 7 días', () => {
  const row = (id: string, status: string, planned: number | string | null, actual: number | string | null) =>
    ({ id, event_id: 'e', status, work_date: null, planned_hours: planned, actual_hours: actual });
  const rows = [row('a', 'prevista', 6, null), row('b', 'realizada', '4.50', '5.25'), row('c', 'cancelada', 8, 8), { ...row('d', 'confirmada', 2, 2), deleted_at: '2027-01-01T00:00:00Z' }];
  assert.deepEqual(staffTotals(rows), { shifts: 2, planned: 10.5, actual: 5.25 });
  assert.deepEqual(shiftsWithoutActualHours(rows).map((r) => r.id), ['a']);

  const dates = new Map([['soon', { start_date: '2027-03-10', end_date: '2027-03-12' }], ['far', { start_date: '2027-04-01', end_date: '2027-04-03' }],
    ['now', { start_date: '2027-03-01', end_date: '2027-03-06' }], ['past', { start_date: '2027-02-01', end_date: '2027-02-03' }]]);
  const need = (id: string, event: string, status = 'detectado') => ({ id, event_id: event, persons: 1, priority: 'alta', status });
  const needs = [need('1', 'soon'), need('2', 'far'), need('3', 'now'), need('4', 'past'), need('5', 'soon', 'cubierto'), need('6', 'nada')];
  assert.deepEqual(uncoveredNeedsSoon(needs, dates, '2027-03-05').map((n) => n.id), ['1', '3']);

  const fields = (f: Record<string, unknown>) => validateFields(STAFF, { event_id: uuid(), person_name: 'X', function: 'cocina', ...f }, 'insert').map((i) => i.details.field);
  assert.deepEqual(fields({ planned_hours: -1 }), ['planned_hours']);
  assert.deepEqual(fields({ actual_hours: 2.555 }), ['actual_hours']);
  assert.deepEqual(fields({ work_date: '2027-03-05', planned_hours: 25 }), ['planned_hours']);
  assert.deepEqual(fields({ planned_hours: 25 }), [], 'sin día concreto, el total del evento puede pasar de 24');
  assert.deepEqual(fields({ person_ref_app: 'central' }), ['person_ref_id']);
  assert.deepEqual(fields({ person_ref_app: 'encarna', person_ref_id: 'P-1' }), ['person_ref_app'], 'la app es Central; encarna es solo su alias');
  assert.deepEqual(fields({ function: 'jardineria' }), ['function']);
  assert.deepEqual(validateFields(NEEDS, { event_id: uuid(), need_type: 'cocina', persons: 0 }, 'insert').map((i) => i.details.field), ['persons']);
});

test('personal · turnos y refuerzos: alta, horas reales, cubrir a mano; SQL rechaza lo que se cuele', async () => {
  const { eventId } = await createEvent('2027-03-05', '2027-03-07');
  const shiftId = uuid(); const needId = uuid();
  await ok([
    shift(eventId, { work_date: '2027-03-05', planned_hours: 6, position: 1 }, shiftId),
    shift(eventId, { person_name: 'Otra Persona', function: 'limpieza_previa', planned_hours: 3, position: 2 }),
    { op: 'insert', table: NEEDS, id: needId, fields: { event_id: eventId, need_type: 'limpieza', persons: 2, priority: 'urgente' } },
  ]);
  const row = (await app.t.db.query<Record<string, unknown>>(`select status, priority from booking.staff_needs where id = $1`, [needId])).rows[0]!;
  assert.deepEqual(row, { status: 'detectado', priority: 'urgente' });
  await ok([{ op: 'update', table: STAFF, id: shiftId, expectedRevision: await revision(STAFF, shiftId), fields: { actual_hours: 6.5, status: 'realizada' } }]);
  await ok([{ op: 'update', table: NEEDS, id: needId, expectedRevision: await revision(NEEDS, needId), fields: { status: 'cubierto' } }]);

  // Negativas, más de 24 h en un día y el turno que cambia de evento: no pasan.
  assert.equal((await commands([shift(eventId, { planned_hours: -2 })])).status, 422);
  await assert.rejects(app.t.db.query(`insert into booking.staff_assignments (event_id, person_name, function, person_ref_app, person_ref_id) values ($1, 'X', 'cocina', 'encarna', 'P-1')`, [eventId]));
  assert.equal((await commands([shift(eventId, { work_date: '2027-03-06', actual_hours: 30 })])).status, 422);
  const other = await createEvent('2027-03-20', '2027-03-21');
  assert.equal((await commands([{ op: 'update', table: STAFF, id: shiftId, expectedRevision: await revision(STAFF, shiftId), fields: { event_id: other.eventId } }])).status, 422);
  await assert.rejects(app.t.db.query(`insert into booking.staff_assignments (event_id, person_name, function, work_date, actual_hours) values ($1, 'X', 'cocina', '2027-03-06', 30)`, [eventId]));

  // Borrar el evento con turnos vivos deja huérfanos: no se puede.
  const del = await commands([{ op: 'delete', table: EVENTS, id: eventId, expectedRevision: await revision(EVENTS, eventId) }]);
  assert.equal(del.status, 422);

  // reader no apunta turnos
  assert.equal((await commands([shift(eventId, {})], app.tokens.reader)).status, 403);
});

test('personal · proyección para Invoices: horas por función sin nombres; Food no la lee', async () => {
  const { eventId, reservationId } = await createEvent('2027-05-05', '2027-05-06');
  const named = uuid(); const linked = uuid();
  await ok([
    shift(eventId, { person_name: 'Nombre Que No Sale', function: 'acogida_grupo', planned_hours: 4, actual_hours: 3.5 }, named),
    shift(eventId, { person_name: 'Con Ficha', person_ref_app: 'central', person_ref_id: 'P-17', planned_hours: 2 }, linked),
  ]);
  const invoicesUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'reader')`, [invoicesUser]);
  const out = (await app.t.rpc('core_read', { p_app: 'invoices', p_actor: invoicesUser, p_name: READS.invoicesStaffHoursProjection, p_args: { where: { event_id: eventId } } })) as any;
  assert.equal(out.rows.length, 2);
  assert.deepEqual(Object.keys(out.rows[0]).sort(), ['actual_hours', 'assignment_id', 'event_code', 'event_id', 'function', 'planned_hours',
    'reservation_code', 'reservation_id', 'revision', 'staff_ref', 'status', 'work_date']);
  assert.ok(!JSON.stringify(out.rows).includes('Nombre Que No Sale'));
  const byId = new Map(out.rows.map((r: any) => [r.assignment_id, r]));
  assert.equal((byId.get(named) as any).staff_ref, named);
  assert.equal((byId.get(linked) as any).staff_ref, 'P-17');
  assert.equal((byId.get(named) as any).reservation_id, reservationId);
  assert.match((byId.get(named) as any).event_code, /^EVT_/);

  const foodUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [foodUser]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: READS.invoicesStaffHoursProjection, p_args: {} }), (e: any) => e.code === 'INVALID_OPERATION');
});
