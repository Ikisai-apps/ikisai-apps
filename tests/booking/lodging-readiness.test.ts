/** Booking · camas listas para la apertura (1426, para Flow): activa, colocada, libre y sin limpieza en curso en Tasks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let cleaning = 'open';
let tasksDown = false;
const asked: string[][] = [];
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], ses: { notifyTasks: null, tasksPost: async (path, body) => {
      if (path === 'requests/status') {
        if (tasksDown) throw new Error('Tasks no responde');
        asked.push(body.externalRefs as string[]);
        return { status: 200, data: { items: (body.externalRefs as string[]).map((externalRef) => ({ externalRef, status: cleaning })) } };
      }
      return { status: 200, data: { taskId: 'tarea-limpieza', status: 'created' } };
    } } }),
  });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `rd-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }

test('apertura: por habitación, camas listas, ocupadas, sin colocar y con limpieza pendiente según Tasks', async () => {
  const db = app.t.db;
  const today = (await db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const res = uuid(); const event = uuid(); const space = uuid(); const left = uuid(); const loose = uuid(); const ready = uuid(); const busy = uuid();
  const ana = uuid(); const bea = uuid(); const stay = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas de apertura', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: plus(30), end_date: plus(33), expected_guests: 10 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await db.query(`update booking.reservations set start_date = $2, end_date = $3 where id = $1`, [res, plus(-1), plus(2)]);
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Dormitorio de apertura', kind: 'habitacion', layout: { cols: 6, rows: 7 } } },
    { op: 'insert', table: TABLES.beds, id: left, fields: { space_id: space, label: 'Litera 1', capacity: 2, kind: 'litera', cell: { x: 0, y: 1, rot: 0 } } },
    { op: 'insert', table: TABLES.beds, id: loose, fields: { space_id: space, label: 'Litera 2', capacity: 2, kind: 'litera' } },
    { op: 'insert', table: TABLES.beds, id: ready, fields: { space_id: space, label: 'Litera 3', capacity: 2, kind: 'litera', cell: { x: 3, y: 1, rot: 0 } } },
    { op: 'insert', table: TABLES.beds, id: busy, fields: { space_id: space, label: 'Litera 4', capacity: 2, kind: 'litera', cell: { x: 0, y: 3, rot: 0 } } },
    { op: 'insert', table: TABLES.guests, id: ana, fields: { event_id: event, first_name: 'Ana' } },
    { op: 'insert', table: TABLES.guests, id: bea, fields: { event_id: event, first_name: 'Bea' } },
    { op: 'insert', table: TABLES.roomAssignments, id: stay, fields: { event_id: event, space_id: space, bed_id: left, guest_id: ana, persons: 1, from_date: plus(-1), to_date: plus(2) } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, bed_id: busy, guest_id: bea, persons: 1, from_date: plus(-1), to_date: plus(2) } },
  ]);
  // Ana se va hoy: su cama queda libre y se pide la limpieza
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.guestLeave, args: { guest_id: ana } }])).status, 200);

  const read = async () => (await app.call(`/api/v1/lodging/readiness?night=${today}&event_id=${event}`, { method: 'GET' })).data;
  const room = (data: any) => data.rooms.find((r: any) => r.space_id === space);
  const bed = (data: any, id: string) => room(data).bed_list.find((b: any) => b.bed_id === id);

  let data = await read();
  assert.equal(data.cleaning, 'tasks');
  assert.deepEqual(asked.at(-1), [`booking:LIMP-${stay}`]);
  assert.deepEqual([bed(data, left).free, bed(data, left).cleaning, bed(data, left).ready], [true, 'open', false], 'libre, pero la limpieza sigue abierta');
  assert.deepEqual([bed(data, loose).placed, bed(data, loose).ready], [false, false], 'sin colocar en el plano');
  assert.equal(bed(data, ready).ready, true);
  assert.deepEqual([bed(data, busy).free, bed(data, busy).event, bed(data, busy).ready], [false, true, true], 'ocupada por el propio evento');
  const r = room(data);
  assert.deepEqual([r.beds, r.places, r.ready, r.free, r.occupied, r.pending_cleaning, r.unplaced], [4, 8, 2, 3, 1, 1, 1]);
  assert.deepEqual(r.layout, { cols: 6, rows: 7 });

  // Tasks cierra la limpieza: la cama pasa a lista
  cleaning = 'done';
  data = await read();
  assert.deepEqual([bed(data, left).cleaning, bed(data, left).ready], ['done', true]);
  assert.equal(room(data).pending_cleaning, 0);

  // sin Tasks, la limpieza cuenta como pendiente y se dice
  tasksDown = true;
  data = await read();
  assert.equal(data.cleaning, 'unavailable');
  assert.deepEqual([bed(data, left).cleaning, bed(data, left).ready], ['unavailable', false]);
  tasksDown = false;

  assert.equal((await app.call(`/api/v1/lodging/readiness?night=hoy`, { method: 'GET' })).status, 422);
  const cap = (await db.query<{ kind: string; route: string }>(`select kind, route from core.capabilities where id = 'booking.lodging_readiness'`)).rows[0]!;
  assert.deepEqual(cap, { kind: 'read', route: 'GET lodging/readiness' });
});
