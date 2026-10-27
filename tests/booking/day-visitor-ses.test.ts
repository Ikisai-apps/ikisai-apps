/** Booking · visitante solo de jornada (1404, aceptación H): sin pernocta no va a SES ni se le pide el documento. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { applyPublicOperations } from '../../supabase/functions/_kit/public-write.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `dv-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });

async function event(type: string) {
  const res = uuid(); const ev = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: `Evento ${type}`, event_type: type, status: 'pre_reservada', start_date: '2032-12-04', end_date: '2032-12-06', expected_guests: 40, guests_visible: true } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: ev, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [ev])).rows[0]!.c;
  return { res, ev, code };
}
async function joinAndAccept(code: string) {
  const { visitorId } = await issueVisitor(db(), code);
  const id = uuid();
  await applyPublicOperations(db(), 'booking', [{ op: 'insert', table: TABLES.visitorRequests, id, fields: { via_code: code, visitor_id: visitorId, kind: 'join', name: 'Visitante de día' } }], visitorId);
  await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: id, decision: 'accept' } }]);
  return (await app.t.db.query<{ g: string }>(`select guest_id g from booking.visitor_requests where id = $1`, [id])).rows[0]!.g;
}
const statusOf = async (guest: string) => (await app.t.db.query<{ s: string; d: string }>(`select ses_status s, data_status d from booking.guests where id = $1`, [guest])).rows[0]!;

test('jornadas: quien se apunta sin noches no va a SES; si luego duerme, sí; en un retiro, como siempre', async () => {
  const open = await event('jornadas_abiertas');
  const guest = await joinAndAccept(open.code);
  assert.deepEqual(await statusOf(guest), { s: 'no_aplica', d: 'no_aplica' });

  // aunque llegue (Flow marca su llegada), el parte de viajeros no lo incluye
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.guestArrive, args: { guest_id: guest } }])).status, 200);
  const source = await app.t.db.query<{ s: any }>(`select booking.ses_guest_report_source_base(jsonb_build_object('args', jsonb_build_object('reservation_id', $1::text))) s`, [open.res]).catch(() => null);
  if (source) assert.ok(!JSON.stringify(source.rows[0]!.s).includes(guest), 'fuera del parte');

  // si se le da cama, vuelve a necesitar SES
  const space = uuid(); const bed = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Albergue del día', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 1' } },
  ]);
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: open.ev, space_id: space, bed_id: bed, guest_id: guest, persons: 1, from_date: '2032-12-04', to_date: '2032-12-05' } }]);
  assert.deepEqual(await statusOf(guest), { s: 'pendiente_envio', d: 'pendiente_datos' });

  // en un retiro, apuntarse es venir a dormir: como siempre
  const retreat = await event('retiro');
  assert.deepEqual(await statusOf(await joinAndAccept(retreat.code)), { s: 'pendiente_envio', d: 'pendiente_datos' });
});
