/**
 * Booking · caracterización antes de O2 (estancias de outsider y del staff, retiros abiertos y «Apuntarme»;
 * coordinacion/ampliacion/RECURSOS.md §15.2). Lo que aquí se comprueba tiene que seguir igual después:
 * - Google Calendar: las reservas van a su único calendario, con su color por estado; nada más se proyecta ahí;
 * - camas: un retiro ocupa sus camas frente a otro solapado (`BED_OVERBOOKED`, `bed_free`), y la salida de uno es la
 *   entrada del otro;
 * - disponibilidad del organizador: solo reservas y bloqueos cuentan por fin de semana;
 * - Guests: la misma persona en dos retiros son dos fichas, cada una en su ámbito.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createFakeCalendarAdapter } from '../../supabase/functions/booking-api/calendar/adapter.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const calendar = createFakeCalendarAdapter('reservas@calendar.invalid');
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, calendar: { adapter: calendar } }),
  });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `o2c-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const q = async <T extends Record<string, any>>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
async function retreat(title: string, start: string, end: string, status = 'pre_reservada') {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 4 } }]);
  if (status === 'confirmada') await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}
const member = async (appId: string, grants: unknown[] | null, role = 'editor') => {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, $3, $4::jsonb)`, [appId, user, role, JSON.stringify(grants ? { grants } : {})]);
  return user;
};

test('O2 · calendario: las reservas van a su único calendario y nada más se proyecta', async () => {
  const pre = await retreat('Retiro en pre-reserva', '2030-02-01', '2030-02-03');
  const conf = await retreat('Retiro confirmado', '2030-02-08', '2030-02-10', 'confirmada');
  const tick = await app.call('/api/v1/calendar/tick', { body: { limit: 50 } });
  assert.equal(tick.status, 200, JSON.stringify(tick.data));
  const links = await q<{ reservation_id: string; calendar_id: string; sync_status: string }>(`select reservation_id, calendar_id, sync_status from booking.calendar_links order by created_at`);
  assert.deepEqual(links.map((l) => [l.reservation_id, l.calendar_id, l.sync_status]), [[pre.res, 'reservas@calendar.invalid', 'synced'], [conf.res, 'reservas@calendar.invalid', 'synced']]);
  const payloads = [...calendar.events.values()];
  assert.deepEqual(payloads.map((p) => [p.summary, p.colorId]).sort(), [['Retiro confirmado', '10'], ['[PRE] Retiro en pre-reserva', '5']]);
  assert.ok(payloads.every((p) => typeof p.extendedProperties.private.ikisaiReservationId === 'string'), 'todo lo proyectado es una reserva');
  // el estado del calendario solo lista reservas
  const status = await app.call('/api/v1/calendar/status');
  assert.equal(status.data.calendarId, 'reservas@calendar.invalid');
});

test('O2 · camas: un retiro ocupa sus camas frente a otro solapado; la salida de uno es la entrada del otro', async () => {
  const room = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'Hab O2', kind: 'habitacion', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: room, label: 'Cama 1' } },
  ]);
  const a = await retreat('Retiro A', '2030-03-01', '2030-03-04', 'confirmada');
  const b = await retreat('Retiro B', '2030-03-03', '2030-03-05', 'confirmada');
  const c = await retreat('Retiro C', '2030-03-04', '2030-03-06', 'confirmada');
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: a.event, space_id: room, bed_id: bed, group_label: 'A', persons: 1 } }]);
  const clash = await commit([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: b.event, space_id: room, bed_id: bed, group_label: 'B', persons: 1 } }]);
  assert.equal(clash.data?.error?.code, 'BED_OVERBOOKED');
  // (con huésped nulo, `bed_free` no veía las asignaciones de grupo; lo arregla la 0467 y lo prueba stays.test.ts)
  assert.equal((await q<{ v: boolean }>(`select booking.bed_free($1, $2, $3) v`, [bed, b.event, uuid()]))[0]!.v, false);
  assert.equal((await q<{ v: boolean }>(`select booking.bed_free($1, $2, $3) v`, [bed, c.event, uuid()]))[0]!.v, true);
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: c.event, space_id: room, bed_id: bed, group_label: 'C', persons: 1 } }]);
  // toda ocupación de camas cuelga de un evento de una reserva
  assert.equal((await q(`select 1 from booking.room_assignments where event_id is null`)).length, 0);
});

test('O2 · disponibilidad del organizador: solo reservas y bloqueos cuentan por fin de semana', async () => {
  const busy = await retreat('Ocupa', '2030-05-03', '2030-05-05', 'confirmada');
  await ok([{ op: 'insert', table: TABLES.dateBlocks, id: uuid(), fields: { start_date: '2030-05-10', end_date: '2030-05-12', reason: 'Bloqueo interno' } }]);
  const mine = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: mine, fields: { title: 'Mi retiro', status: 'en_estudio' } }]);
  const org = await member('organizers', [{ reservation_id: mine }]);
  const out = await read('organizers', org, 'booking.portal_availability', { reservation_id: mine, from: '2030-05-03', to: '2030-05-19' });
  const status = Object.fromEntries(out.weekends.map((w: any) => [w.start, w.status]));
  assert.deepEqual([status['2030-05-03'], status['2030-05-10'], status['2030-05-17']], ['ocupado', 'ocupado', 'libre']);
  assert.ok(busy.res);
});

test('O2 · Guests: la misma persona en dos retiros son dos fichas, cada una en su ámbito', async () => {
  const one = await retreat('Retiro uno', '2030-06-05', '2030-06-07', 'confirmada');
  const two = await retreat('Retiro dos', '2030-07-03', '2030-07-05', 'confirmada');
  const [g1, g2] = [uuid(), uuid()];
  for (const [r, g] of [[one.res, g1], [two.res, g2]] as const) {
    const org = await member('organizers', [{ reservation_id: r }]);
    await invoke('organizers', org, 'booking.portal_add_guest', { reservation_id: r, guest_id: g, declaration: true, fields: { first_name: 'Marta', email: 'marta@example.invalid' } });
  }
  // una cuenta con las dos entradas (como la deja el enlace de cada retiro)
  const marta = await member('guests', [{ reservation_id: one.res, guest_id: g1 }, { reservation_id: two.res, guest_id: g2 }]);
  const mine1 = await read('guests', marta, 'booking.portal_my_guest', { guest_id: g1 });
  const mine2 = await read('guests', marta, 'booking.portal_my_guest', { guest_id: g2 });
  assert.notEqual(JSON.stringify(mine1), JSON.stringify(mine2));
  const rows = await q<{ id: string; event_id: string }>(`select id, event_id from booking.guests where id = any($1) order by created_at`, [[g1, g2]]);
  assert.deepEqual(rows.map((r) => r.event_id), [one.event, two.event], 'una ficha por retiro');
  // fuera de sus entradas, nada
  const stranger = await member('guests', [{ reservation_id: one.res, guest_id: g1 }]);
  await assert.rejects(read('guests', stranger, 'booking.portal_my_guest', { guest_id: g2 }));
});
