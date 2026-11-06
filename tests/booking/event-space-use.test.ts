/**
 * Booking · «También para todos los eventos» (1432, booking-U1): booking-api pide a Central el uso general de alojamiento
 * del espacio de una marca, con la clave de worker y `X-Ikisai-Caller: booking`; Booking no escribe en Recursos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const calls: Array<{ url: string; body: any; caller: string | null; key: string | null }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: { uses: ['eventos', 'alojamiento'], added: true } };
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({
      ...config, workerKey: 'clave-de-usos', origins: [BOOKING_ORIGINS[0]!],
      appsFetch: (async (url: string, init: RequestInit) => {
        const h = new Headers(init.headers);
        calls.push({ url, body: JSON.parse(String(init.body)), caller: h.get('X-Ikisai-Caller'), key: h.get('X-Ikisai-Worker-Key') });
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    }),
  });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `eu-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }

test('pide a Central el uso de alojamiento del espacio de la marca; si Central falla, la marca se queda', async () => {
  const res = uuid(); const event = uuid(); const sala = uuid(); const local = uuid(); const resource = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro de usos', status: 'pre_reservada', start_date: '2036-06-01', end_date: '2036-06-03', expected_guests: 12 } },
    { op: 'insert', table: TABLES.spaces, id: sala, fields: { name: 'Sala de usos', kind: 'sala' } },
    { op: 'insert', table: TABLES.spaces, id: local, fields: { name: 'Solo de Booking', kind: 'sala' } },
  ]);
  await app.t.db.query(`update booking.spaces set resource_id = $2, uses = '{eventos}' where id = $1`, [sala, resource]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const mark = uuid(); const localMark = uuid();
  await ok([
    { op: 'insert', table: TABLES.eventSpaces, id: mark, fields: { event_id: event, space_id: sala } },
    { op: 'insert', table: TABLES.eventSpaces, id: localMark, fields: { event_id: event, space_id: local } },
  ]);

  const done = await app.call(`/api/v1/event-spaces/${mark}/all-events`, { body: {} });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data, { uses: ['eventos', 'alojamiento'], added: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/functions\/v1\/central-api\/api\/v1\/worker\/space-use$/);
  assert.deepEqual([calls[0]!.caller, calls[0]!.key], ['booking', 'clave-de-usos']);
  assert.deepEqual({ ...calls[0]!.body, requested_by: typeof calls[0]!.body.requested_by }, { space_id: resource, use: 'alojamiento', source_ref: `booking:reservation:${res}`, requested_by: 'string' });

  // un espacio que no viene de Recursos no se pide
  assert.equal((await app.call(`/api/v1/event-spaces/${localMark}/all-events`, { body: {} })).status, 409);
  // Central falla: error, y la marca sigue
  answer = { status: 500, body: { error: { code: 'BOOM', message: 'fallo' } } };
  assert.equal((await app.call(`/api/v1/event-spaces/${mark}/all-events`, { body: {} })).status, 502);
  const live = await app.t.db.query<{ n: string }>(`select count(*) n from booking.event_spaces where id = $1 and deleted_at is null`, [mark]);
  assert.equal(Number(live.rows[0]!.n), 1);
  // ya de alojamiento (el espejo trajo el uso): no se vuelve a pedir
  await app.t.db.query(`update booking.spaces set uses = '{eventos,alojamiento}' where id = $1`, [sala]);
  const again = await app.call(`/api/v1/event-spaces/${mark}/all-events`, { body: {} });
  assert.deepEqual([again.status, again.data.added], [200, false]);
  assert.equal(calls.length, 2);
  // una marca que no existe
  assert.equal((await app.call(`/api/v1/event-spaces/${uuid()}/all-events`, { body: {} })).status, 404);
});
