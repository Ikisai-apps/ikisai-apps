/** Booking · Alojamiento libre, tarjeta 4 (1402): la salida libera la cama esta misma noche y pide su limpieza a Tasks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const posts: Array<{ path: string; body: any }> = [];
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], ses: { notifyTasks: null, tasksPost: async (path, body) => {
      posts.push({ path, body });
      return { status: 200, data: { taskId: 'tarea-limpieza', status: 'created' } };
    } } }),
  });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `lc-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const call = (procedure: string, args: Record<string, unknown>) => commit([{ op: 'call', procedure, args }]);

test('salida: la cama queda libre desde hoy, se pide su limpieza una vez y «deshacer» la devuelve si sigue libre', async () => {
  const db = app.t.db;
  const today = (await db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid(); const ana = uuid(); const stay = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas de salida', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: plus(30), end_date: plus(33), expected_guests: 10 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  // las jornadas ya han empezado (ayer) y siguen dos noches más
  await db.query(`update booking.reservations set start_date = $2, end_date = $3 where id = $1`, [res, plus(-1), plus(2)]);
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Habitación de salida', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama A', capacity: 1 } },
    { op: 'insert', table: TABLES.guests, id: ana, fields: { event_id: event, first_name: 'Ana' } },
    { op: 'insert', table: TABLES.roomAssignments, id: stay, fields: { event_id: event, space_id: space, bed_id: bed, guest_id: ana, persons: 1, from_date: plus(-1), to_date: plus(2) } },
  ]);
  const assignment = async () => (await db.query<{ t: string; p: string | null }>(`select to_date::text t, planned_to_date::text p from booking.room_assignments where id = $1`, [stay])).rows[0]!;
  const freeTonight = async () => (await db.query(`select 1 from booking.free_beds($1, $2) where bed_id = $3`, [today, plus(1), bed])).rows.length === 1;
  assert.equal(await freeTonight(), false);

  assert.equal((await call(PROCEDURES.guestLeave, { guest_id: ana })).status, 200);
  assert.deepEqual(await assignment(), { t: today, p: plus(2) });
  assert.equal(await freeTonight(), true, 'otra persona puede dormir ahí esta noche');
  const cleaning = posts.filter((p) => p.body.kind === 'booking.bed_cleaning');
  assert.equal(cleaning.length, 1);
  assert.deepEqual([cleaning[0]!.path, cleaning[0]!.body.source, cleaning[0]!.body.external_ref, cleaning[0]!.body.title, cleaning[0]!.body.due],
    ['requests/task', 'booking', `LIMP-${stay}`, 'Limpiar Habitación de salida · Cama A', today]);
  assert.ok(!JSON.stringify(cleaning[0]!.body).includes('Ana'), 'sin datos de la persona');
  // repetir la salida no cambia nada ni pide otra limpieza
  assert.equal((await call(PROCEDURES.guestLeave, { guest_id: ana })).status, 200);
  assert.equal(posts.filter((p) => p.body.kind === 'booking.bed_cleaning').length, 1);

  // deshacer: vuelve la salida prevista
  assert.equal((await call(PROCEDURES.guestLeave, { guest_id: ana, undo: true })).status, 200);
  assert.deepEqual(await assignment(), { t: plus(2), p: null });

  // si otra persona ya ocupa la cama, deshacer falla y no cambia nada
  assert.equal((await call(PROCEDURES.guestLeave, { guest_id: ana })).status, 200);
  const luis = uuid();
  await ok([
    { op: 'insert', table: TABLES.guests, id: luis, fields: { event_id: event, first_name: 'Luis' } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, bed_id: bed, guest_id: luis, persons: 1, from_date: today, to_date: plus(1) } },
  ]);
  const undo = await call(PROCEDURES.guestLeave, { guest_id: ana, undo: true });
  assert.equal(undo.data?.error?.code, 'BED_OVERBOOKED', JSON.stringify(undo.data));
  assert.deepEqual(await assignment(), { t: today, p: plus(2) });
});
