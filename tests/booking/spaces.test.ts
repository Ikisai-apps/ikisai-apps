/** Booking · ampliación V2, bloque 1 (API.md §15.1): espacios, camas, asignación por evento y proyección para Tasks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { bedConflicts, eventOccupancy, spaceCapacity, TABLES, validateFields } from '../../supabase/functions/_domain/booking/mod.ts';

const { reservations: RESERVATIONS, spaces: SPACES, beds: BEDS, roomAssignments: ASSIGN, guests: GUESTS } = TABLES;
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
  return app.call('/api/v1/commands', { token, body: { requestId: `s-${++seq}-${uuid()}`, operations } });
}
async function ok(operations: unknown[], token: string = app.tokens.owner) {
  const res = await commands(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
}
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);

/** Reserva confirmada con su evento, en las fechas dadas. */
async function createEvent(start: string, end: string): Promise<{ reservationId: string; eventId: string }> {
  const reservationId = uuid(); const eventId = uuid();
  await ok([{ op: 'insert', table: RESERVATIONS, id: reservationId, fields: { title: `Retiro ${start}`, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 10 } }]);
  await ok([{ op: 'call', procedure: CONFIRM, args: { reservation_id: reservationId, event_id: eventId, from_status: 'pre_reservada' } }]);
  return { reservationId, eventId };
}

/** Habitación con dos camas individuales. */
async function createRoom(name: string): Promise<{ spaceId: string; bedA: string; bedB: string }> {
  const spaceId = uuid(); const bedA = uuid(); const bedB = uuid();
  const res = await ok([
    { op: 'insert', table: SPACES, id: spaceId, fields: { name, kind: 'habitacion', zone: 'Posada', position: 1 } },
    { op: 'insert', table: BEDS, id: bedA, fields: { space_id: spaceId, label: 'Cama 1', kind: 'individual', capacity: 1, position: 1 } },
    { op: 'insert', table: BEDS, id: bedB, fields: { space_id: spaceId, label: 'Cama 2', kind: 'individual', capacity: 1, position: 2 } },
  ]);
  assert.match(res.data.changes[0].after.code, /^ESP_\d{4}_\d{3}$/);
  return { spaceId, bedA, bedB };
}
const assign = (eventId: string, spaceId: string, fields: Record<string, unknown>) => ({ op: 'insert', table: ASSIGN, id: uuid(), fields: { event_id: eventId, space_id: spaceId, ...fields } });

test('espacios · dominio: plazas, ocupación con aviso y conflictos de cama por noches', () => {
  const room = { id: 'r', kind: 'habitacion', capacity: null, active: true };
  const beds = [{ id: 'b1', space_id: 'r', capacity: 1, active: true }, { id: 'b2', space_id: 'r', capacity: 2, active: true }, { id: 'b3', space_id: 'r', capacity: 1, active: false }];
  assert.equal(spaceCapacity(room, beds), 3);
  assert.equal(spaceCapacity({ id: 's', kind: 'sala', capacity: 40, active: true }, []), 40);
  const a = (id: string, persons: number, bed: string | null, from: string | null = null, to: string | null = null) => ({ id, event_id: 'e', space_id: 'r', bed_id: bed, persons, from_date: from, to_date: to });
  assert.deepEqual(eventOccupancy('e', [room], beds, [a('1', 1, 'b1'), a('2', 3, null)]), [{ spaceId: 'r', persons: 4, capacity: 3, over: true }]);

  const res = { start_date: '2027-03-05', end_date: '2027-03-07' };
  const nights: [number, number] = [Date.UTC(2027, 2, 7) / 86_400_000, Date.UTC(2027, 2, 9) / 86_400_000];
  assert.deepEqual(bedConflicts('b1', nights, [{ assignment: a('x', 1, 'b1'), reservation: res }]), [], 'la salida de uno es la entrada del otro');
  assert.equal(bedConflicts('b1', [nights[0] - 1, nights[1]], [{ assignment: a('x', 1, 'b1'), reservation: res }]).length, 1);
  assert.equal(bedConflicts('b2', [nights[0] - 1, nights[1]], [{ assignment: a('x', 1, 'b1'), reservation: res }]).length, 0);

  const issue = (fields: Record<string, unknown>) => validateFields(ASSIGN, { event_id: uuid(), space_id: uuid(), ...fields }, 'insert').map((i) => i.details.field);
  assert.deepEqual(issue({}), ['group_label']);
  assert.deepEqual(issue({ guest_id: uuid(), group_label: 'Equipo' }), ['group_label']);
  assert.deepEqual(issue({ guest_id: uuid(), persons: 2 }), ['persons']);
  assert.deepEqual(issue({ group_label: 'Equipo', persons: 3, from_date: '2027-03-06', to_date: '2027-03-06' }), ['to_date']);
  assert.deepEqual(issue({ group_label: 'Equipo', persons: 3 }), []);
  assert.deepEqual(validateFields(BEDS, { space_id: uuid(), label: 'Cama', capacity: 3 }, 'insert').map((i) => i.details.field), ['capacity']);
});

test('espacios · una cama no se ocupa dos veces en noches solapadas; la salida puede ser la entrada del siguiente', async () => {
  const { spaceId, bedA, bedB } = await createRoom('Habitación 1');
  const first = await createEvent('2027-03-05', '2027-03-07');
  const overlapping = await createEvent('2027-03-06', '2027-03-08');
  const next = await createEvent('2027-03-07', '2027-03-09');

  await ok([assign(first.eventId, spaceId, { bed_id: bedA, group_label: 'Grupo A' })]);
  const clash = await commands([assign(overlapping.eventId, spaceId, { bed_id: bedA, group_label: 'Grupo B' })]);
  assert.equal(clash.status, 422); assert.equal(clash.data.error.code, 'BED_OVERBOOKED');
  await ok([assign(overlapping.eventId, spaceId, { bed_id: bedB, group_label: 'Grupo B' })]);
  await ok([assign(next.eventId, spaceId, { bed_id: bedA, group_label: 'Grupo C' })]);

  // fechas propias dentro del evento: solo las noches indicadas
  const partial = await createEvent('2027-04-01', '2027-04-05');
  const other = await createEvent('2027-04-01', '2027-04-05');
  await ok([assign(partial.eventId, spaceId, { bed_id: bedA, group_label: 'Dos noches', from_date: '2027-04-01', to_date: '2027-04-03' })]);
  await ok([assign(other.eventId, spaceId, { bed_id: bedA, group_label: 'Otras dos', from_date: '2027-04-03', to_date: '2027-04-05' })]);
  assert.equal((await commands([assign(other.eventId, spaceId, { bed_id: bedA, group_label: 'Choca', from_date: '2027-04-02', to_date: '2027-04-04' })])).data.error.code, 'BED_OVERBOOKED');

  // una reserva cancelada deja libre su cama
  const cancelled = await createEvent('2027-05-01', '2027-05-03');
  await ok([assign(cancelled.eventId, spaceId, { bed_id: bedA, group_label: 'Se cancela' })]);
  const later = await createEvent('2027-05-01', '2027-05-03');
  assert.equal((await commands([assign(later.eventId, spaceId, { bed_id: bedA, group_label: 'Espera' })])).data.error.code, 'BED_OVERBOOKED');
  await ok([{ op: 'update', table: RESERVATIONS, id: cancelled.reservationId, expectedRevision: await revision(RESERVATIONS, cancelled.reservationId), fields: { status: 'cancelada' } }]);
  await ok([assign(later.eventId, spaceId, { bed_id: bedA, group_label: 'Espera' })]);
});

test('espacios · coherencias: cama del mismo espacio, huésped del mismo evento, sin huérfanos; la capacidad solo avisa', async () => {
  const room = await createRoom('Habitación 2');
  const otherRoom = await createRoom('Habitación 3');
  const { eventId } = await createEvent('2027-06-01', '2027-06-03');
  const foreign = await createEvent('2027-06-01', '2027-06-03');

  assert.equal((await commands([assign(eventId, room.spaceId, { bed_id: otherRoom.bedA, group_label: 'Mal' })])).data.error.code, 'BED_SPACE_MISMATCH');
  const guestId = uuid();
  await ok([{ op: 'insert', table: GUESTS, id: guestId, fields: { event_id: foreign.eventId, first_name: 'Persona Sintética' } }]);
  assert.equal((await commands([assign(eventId, room.spaceId, { guest_id: guestId })])).data.error.code, 'GUEST_MISMATCH');
  // más personas que camas en una habitación: se guarda (aviso en la interfaz)
  await ok([assign(eventId, room.spaceId, { group_label: 'Familia', persons: 5 })]);

  const bedRevision = await revision(BEDS, room.bedA);
  assert.equal((await commands([{ op: 'update', table: BEDS, id: room.bedA, expectedRevision: bedRevision, fields: { space_id: otherRoom.spaceId } }])).data.error.code, 'INVALID_FIELDS');
  const spaceDelete = await commands([{ op: 'delete', table: SPACES, id: room.spaceId, expectedRevision: await revision(SPACES, room.spaceId) }]);
  assert.equal(spaceDelete.data.error.code, 'ORPHAN_CHILD');
  // reader no escribe inventario
  assert.equal((await commands([{ op: 'insert', table: SPACES, id: uuid(), fields: { name: 'Sala', kind: 'sala' } }], app.tokens.reader)).status, 403);
});

test('espacios · proyección para Tasks: inventario sin ocupación ni huéspedes; Food no la lee', async () => {
  const { spaceId } = await createRoom('Habitación 4');
  const tasksUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'reader')`, [tasksUser]);
  const out = (await app.t.rpc('core_read', { p_app: 'tasks', p_actor: tasksUser, p_name: 'booking.tasks_space_projection', p_args: { where: { space_id: spaceId } } })) as any;
  assert.equal(out.rows.length, 1);
  assert.deepEqual(Object.keys(out.rows[0]).sort(), ['active', 'code', 'kind', 'name', 'revision', 'space_id', 'zone']);
  assert.equal(out.rows[0].name, 'Habitación 4');
  const foodUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [foodUser]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: 'booking.tasks_space_projection', p_args: {} }), (e: any) => e.code === 'INVALID_OPERATION');
});
