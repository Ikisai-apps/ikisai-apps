/** Booking · espacios de un evento (1430, booking-U1): la marca por evento, una por espacio y solo de espacios vivos. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';
import { eventSpaceItems, eventSpaceOp } from '../../apps/booking/src/app/eventSpaces.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `es-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }

test('marca por evento: se pone, no se repite, no cambia de espacio, no vale un espacio borrado y se quita', async () => {
  const res = uuid(); const event = uuid(); const sala = uuid(); const hab = uuid(); const gone = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro de prueba', status: 'pre_reservada', start_date: '2036-05-01', end_date: '2036-05-03' } },
    { op: 'insert', table: TABLES.spaces, id: sala, fields: { name: 'Sala prueba', kind: 'sala' } },
    { op: 'insert', table: TABLES.spaces, id: hab, fields: { name: 'Hab prueba', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.spaces, id: gone, fields: { name: 'Borrado prueba', kind: 'sala' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const mark = uuid();
  await ok([{ op: 'insert', table: TABLES.eventSpaces, id: mark, fields: { event_id: event, space_id: sala } }]);

  const twice = await commit([{ op: 'insert', table: TABLES.eventSpaces, id: uuid(), fields: { event_id: event, space_id: sala } }]);
  assert.notEqual(twice.status, 200, 'el mismo espacio no se marca dos veces');
  const moved = await commit([{ op: 'update', table: TABLES.eventSpaces, id: mark, expectedRevision: 1, fields: { space_id: hab } }]);
  assert.equal(moved.status, 422, JSON.stringify(moved.data));

  const rev = (await app.t.db.query<{ r: string }>(`select revision r from booking.spaces where id = $1`, [gone])).rows[0]!.r;
  await ok([{ op: 'delete', table: TABLES.spaces, id: gone, expectedRevision: Number(rev) }]);
  const dead = await commit([{ op: 'insert', table: TABLES.eventSpaces, id: uuid(), fields: { event_id: event, space_id: gone } }]);
  assert.equal(dead.status, 422, JSON.stringify(dead.data));

  await ok([{ op: 'delete', table: TABLES.eventSpaces, id: mark, expectedRevision: 1 }]);
  await ok([{ op: 'insert', table: TABLES.eventSpaces, id: uuid(), fields: { event_id: event, space_id: sala } }]);
  const live = await app.t.db.query<{ n: string }>(`select count(*) n from booking.event_spaces where event_id = $1 and deleted_at is null`, [event]);
  assert.equal(Number(live.rows[0]!.n), 1);
});

test('lista de la ficha: activos por zona y orden, el inactivo marcado sigue, y la operación de marcar o quitar', () => {
  const spaces = [
    { id: 'b', name: 'Sala B', zone: 'Casa', position: 2, active: true, deleted_at: null },
    { id: 'a', name: 'Sala A', public_name: 'La sala grande', zone: 'Casa', position: 1, active: true, deleted_at: null },
    { id: 'x', name: 'Antigua', zone: 'Albergue', position: 1, active: false, deleted_at: null },
    { id: 'y', name: 'Otra inactiva', zone: 'Albergue', position: 2, active: false, deleted_at: null },
    { id: 'z', name: 'Borrada', zone: 'Casa', position: 3, active: true, deleted_at: '2036-01-01T00:00:00Z' },
  ];
  const marks = [{ id: 'm1', event_id: 'e', space_id: 'x', revision: 3, deleted_at: null }, { id: 'm2', event_id: 'otro', space_id: 'b', revision: 1, deleted_at: null }];
  const items = eventSpaceItems(spaces, marks, 'e');
  assert.deepEqual(items.map((i) => [i.id, i.name, i.marked]), [['x', 'Antigua', true], ['a', 'La sala grande', false], ['b', 'Sala B', false]]);
  assert.deepEqual(eventSpaceOp(items[1]!, 'e', true, () => 'n'), { op: 'insert', table: 'booking.event_spaces', id: 'n', fields: { event_id: 'e', space_id: 'a' } });
  assert.deepEqual(eventSpaceOp(items[0]!, 'e', false, () => 'n'), { op: 'delete', table: 'booking.event_spaces', id: 'm1', expectedRevision: 3 });
  assert.equal(eventSpaceOp(items[0]!, 'e', true, () => 'n'), null);
});
