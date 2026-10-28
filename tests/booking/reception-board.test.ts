/** Booking · recepción por puestos (1427, para Flow): tarjetas por puesto de un evento y un día, sin datos personales de más. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `rb-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...headers }, body: JSON.stringify(body) }));

test('por puestos: solicitud por cobrar, cama que preparar, registro, petición y salida; cada una con su ruta', async () => {
  const res = uuid(); const event = uuid(); const space = uuid(); const b1 = uuid(); const b2 = uuid(); const ana = uuid(); const luis = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas por puestos', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2042-06-01', end_date: '2042-06-04', expected_guests: 30, guests_visible: true, ses_enabled: true } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab puestos', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: b1, fields: { space_id: space, label: 'Cama 1', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: b2, fields: { space_id: space, label: 'Cama 2', capacity: 1 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: space, label: 'Cama 3', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: uuid(), fields: { name: 'Cama puestos', layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: '2042-06-01', valid_to: '2042-06-04' } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await ok([
    { op: 'insert', table: TABLES.guests, id: ana, fields: { event_id: event, first_name: 'Ana María', last_name_1: 'Sintética' } },
    { op: 'insert', table: TABLES.guests, id: luis, fields: { event_id: event, first_name: 'Luis' } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, bed_id: b1, guest_id: ana, persons: 1, from_date: '2042-06-02', to_date: '2042-06-04' } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: space, bed_id: b2, guest_id: luis, persons: 1, from_date: '2042-06-01', to_date: '2042-06-02' } },
  ]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  const v = await issueVisitor(db(), code);
  assert.equal((await post('stay', { event_code: code, from: '2042-06-02', to: '2042-06-03', persons: 1, name: 'Bea Sintética' }, { 'X-Visitor': v.token })).status, 200);

  const board = await app.call(`/api/v1/reception/board?event_id=${event}&day=2042-06-02`, { method: 'GET' });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  const by = (puesto: string) => board.data.items.filter((i: any) => i.puesto === puesto);
  assert.equal(by('solicitud_cobro').length, 1);
  assert.match(by('solicitud_cobro')[0].title, /^Nº \d+ · Bea$/, 'número y nombre de pila');
  assert.deepEqual([by('solicitud_cobro')[0].route, by('solicitud_cobro')[0].anchor, by('solicitud_cobro')[0].status], ['#/recepcion', 'booking.recepcion.cobrar', 'pendiente']);
  assert.deepEqual(by('camas').map((i: any) => [i.title, i.subtitle]), [['Hab puestos · Cama 1', 'Llega Ana']]);
  assert.deepEqual(by('registro').map((i: any) => [i.title, i.route]), [['Ana', `#/huespedes/${event}/${ana}`]]);
  assert.deepEqual(by('salida').map((i: any) => [i.title, i.status]), [['Luis', 'pendiente']]);
  assert.ok(!JSON.stringify(board.data).includes('Sintética'), 'sin apellidos');
  for (const i of board.data.items) assert.ok(i.ref && i.route.startsWith('#/'), JSON.stringify(i));

  assert.equal((await app.call(`/api/v1/reception/board?event_id=${event}&day=mañana`, { method: 'GET' })).status, 422);
  const cap = (await app.t.db.query<{ kind: string; route: string }>(`select kind, route from core.capabilities where id = 'booking.reception_board'`)).rows[0]!;
  assert.deepEqual(cap, { kind: 'read', route: 'GET reception/board' });
});
