/** Booking · tanda 36 (MUELA-049, migración 0477): distribución en cuadrantes y camas en cualquier estancia. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

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

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `t36-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function rejected(operations: unknown[]) {
  const res = await commit(operations);
  assert.notEqual(res.status, 200, 'debía rechazarse');
}
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('distribución · {cols, rows} y {x, y, rot}; lo que no tiene esa forma no entra', async () => {
  const room = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'Dormitorio 1', kind: 'habitacion', layout: { cols: 4, rows: 3 } } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: room, label: 'Litera 1', kind: 'litera', capacity: 2, cell: { x: 2, y: 1, rot: 90 } } },
  ]);
  const row = (await app.t.db.query<{ layout: unknown; cell: unknown }>(`select s.layout, b.cell from booking.spaces s join booking.beds b on b.space_id = s.id where s.id = $1`, [room])).rows[0]!;
  assert.deepEqual(row, { layout: { cols: 4, rows: 3 }, cell: { x: 2, y: 1, rot: 90 } });
  await rejected([{ op: 'insert', table: TABLES.spaces, id: uuid(), fields: { name: 'Ancho', kind: 'habitacion', layout: { cols: 1, rows: 3 } } }]);
  await rejected([{ op: 'insert', table: TABLES.spaces, id: uuid(), fields: { name: 'Texto', kind: 'habitacion', layout: { cols: '4', rows: 3 } } }]);
  await rejected([{ op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: room, label: 'Girada', kind: 'individual', capacity: 1, cell: { x: 0, y: 0, rot: 45 } } }]);
  await rejected([{ op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: room, label: 'Media', kind: 'individual', capacity: 1, cell: { x: 0.5, y: 0, rot: 0 } } }]);
  // vaciarlas vale: no cambian nada por sí solas
  const rev = Number((await app.t.db.query<{ revision: string }>(`select revision from booking.beds where id = $1`, [bed])).rows[0]!.revision);
  await ok([{ op: 'update', table: TABLES.beds, id: bed, expectedRevision: rev, fields: { cell: null } }]);
});

test('una sala con camas: cuenta en las plazas de Central y es habitación del retiro en los portales', async () => {
  const start = addDays(today(), -1), end = addDays(today(), 2);
  const res = uuid(); const event = uuid(); const sala = uuid(); const bed = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro del salón', status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 2 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await ok([
    { op: 'insert', table: TABLES.spaces, id: sala, fields: { name: 'Salón del albergue', kind: 'sala', capacity: 30 } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: sala, label: 'Litera 1', kind: 'litera', capacity: 2 } },
  ]);
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: sala, bed_id: bed, group_label: 'Grupo', persons: 2 } }]);
  const rooms = (await app.t.db.query<{ id: string }>(`select booking.event_rooms($1) id`, [event])).rows.map((r) => r.id);
  assert.deepEqual(rooms, [sala]);
  const month = today().slice(0, 7);
  const kpi = (await app.t.db.query<{ value: string | null }>(`select value from booking.central_kpi_projection where kpi = 'booking.occupancy_rate' and period = $1`, [month])).rows[0]!;
  assert.notEqual(kpi.value, null, 'con las plazas de la sala, la ocupación del mes tiene valor');
});
