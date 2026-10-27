/** Booking · un visitante se apunta desde el QR (0489, BG18; contrato C11): petición en lote público y aceptación del personal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, isFault, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { applyPublicOperations } from '../../supabase/functions/_kit/public-write.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
  await app.t.db.query(`select core.register_service_actor($1, 'booking')`, [await app.t.createUser()]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `vj-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
/** Un visitante de verdad (core.visitors), como el que emite el kit al entrar por el QR. */
const visitorOf = async (code: string | null = null) => (await issueVisitor(db(), code)).visitorId;
const ask = (code: string, visitor: string, fields: Record<string, unknown> = {}) =>
  applyPublicOperations(db(), 'booking', [{ op: 'insert', table: TABLES.visitorRequests, id: uuid(), fields: { via_code: code, visitor_id: visitor, ...fields } }], visitor);
async function failsWith(promise: Promise<unknown>, codeText: string) {
  await assert.rejects(promise, (e: unknown) => JSON.stringify(isFault(e) ? { code: e.code, details: (e as any).details } : String(e)).includes(codeText));
}
async function retreat(visible: boolean) {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Carrera sintética', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2031-10-30', end_date: '2031-11-01', expected_guests: 200, guests_visible: visible } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  return { res, event, code };
}

test('visitante: pide apuntarse con el código del QR; solo una pendiente; el personal acepta y se crea su ficha', async () => {
  const { event, code } = await retreat(true);
  const visitor = await visitorOf(code);
  // el event_id que mande el cliente no cuenta: el evento sale del código
  await ask(code.toLowerCase(), visitor, { name: '  Marta  ', note: 'Vengo con mi hija', event_id: uuid() });
  const req = (await app.t.db.query<{ id: string; event_id: string; name: string; status: string }>(`select id, event_id, name, status from booking.visitor_requests where visitor_id = $1`, [visitor])).rows[0]!;
  assert.deepEqual([req.event_id, req.name, req.status], [event, 'Marta', 'pendiente']);
  await assert.rejects(ask(code, visitor), 'una pendiente por visitante y evento');

  // lo que ve el visitante de lo suyo
  const mine = await app.t.rpc('core_public_read', { p_name: 'booking_visitor_requests', p_args: { visitor_id: visitor } }) as any;
  assert.deepEqual(mine.items.map((i: any) => [i.event_code, i.status]), [[code, 'pendiente']]);
  assert.deepEqual((await app.t.rpc('core_public_read', { p_name: 'booking_visitor_requests', p_args: { visitor_id: await visitorOf() } }) as any).items, []);

  // el personal no puede «aceptar» cambiando la fila a mano; con el procedimiento, sí
  const rev = Number((await app.t.db.query<{ r: string }>(`select revision r from booking.visitor_requests where id = $1`, [req.id])).rows[0]!.r);
  assert.equal((await commit([{ op: 'update', table: TABLES.visitorRequests, id: req.id, expectedRevision: rev, fields: { status: 'descartada' } }])).status, 422);
  const accepted = await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: req.id, decision: 'accept' } }]);
  const result = accepted.data.results[0].result;
  assert.equal(result.status, 'aceptada');
  const guest = (await app.t.db.query<{ first_name: string; event_id: string }>(`select first_name, event_id from booking.guests where id = $1`, [result.guest_id])).rows[0]!;
  assert.deepEqual(guest, { first_name: 'Marta', event_id: event });
  // repetir no crea otra ficha
  const again = await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: req.id, decision: 'accept' } }]);
  assert.equal(again.data.results[0].result.guest_id, result.guest_id);
  assert.equal((await app.t.rpc('core_public_read', { p_name: 'booking_visitor_requests', p_args: { visitor_id: visitor, event_code: code } }) as any).items[0].status, 'aceptada');
});

test('visitante: no en retiros no visibles ni con un código desconocido; en público no cambia ni decide nada; el personal no crea peticiones', async () => {
  const hidden = await retreat(false);
  await failsWith(ask(hidden.code, await visitorOf(hidden.code)), 'RESERVATION_NOT_OPEN');
  await failsWith(ask('ZZZZZZZZZZ', await visitorOf()), 'RESERVATION_NOT_OPEN');
  const open = await retreat(true);
  await failsWith(ask(open.code, await visitorOf(open.code), { status: 'aceptada' }), 'INVALID_FIELDS');
  const visitor = await visitorOf(open.code);
  await ask(open.code, visitor);
  const req = (await app.t.db.query<{ id: string; revision: string }>(`select id, revision from booking.visitor_requests where visitor_id = $1`, [visitor])).rows[0]!;
  await assert.rejects(applyPublicOperations(db(), 'booking', [{ op: 'update', table: TABLES.visitorRequests, id: req.id, expectedRevision: Number(req.revision), fields: { name: 'Otro' } }], visitor));
  // un visitante no escribe a nombre de otro
  await failsWith(applyPublicOperations(db(), 'booking', [{ op: 'insert', table: TABLES.visitorRequests, id: uuid(), fields: { via_code: open.code, visitor_id: await visitorOf(open.code) } }], await visitorOf(open.code)), 'FORBIDDEN');
  assert.equal((await commit([{ op: 'insert', table: TABLES.visitorRequests, id: uuid(), fields: { event_id: open.event, visitor_id: uuid() } }])).status, 422);
  // «Déjanos un dato»: vale en un retiro no visible, exige el contacto y se atiende (no se acepta)
  const dataVisitor = await visitorOf(hidden.code);
  await failsWith(ask(hidden.code, dataVisitor, { kind: 'contact' }), 'contact');
  await ask(hidden.code, dataVisitor, { kind: 'contact', contact: 'visitante@example.invalid', note: 'Avisadme de la próxima' });
  const dato = (await app.t.db.query<{ id: string }>(`select id from booking.visitor_requests where visitor_id = $1`, [dataVisitor])).rows[0]!;
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: dato.id, decision: 'accept' } }])).status, 422);
  const done = await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: dato.id, decision: 'done' } }]);
  assert.equal(done.data.results[0].result.status, 'atendida');
  const rejected = await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: req.id, decision: 'reject' } }]);
  assert.deepEqual([rejected.data.results[0].result.status, rejected.data.results[0].result.guest_id], ['descartada', null]);
});

test('visitante: a los 6 meses del fin del evento se borran su nombre, su contacto y su nota (conservación)', async () => {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Pasado sintético', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2031-10-30', end_date: '2031-11-01', expected_guests: 20, guests_visible: true } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  const visitor = await visitorOf(code);
  await ask(code, visitor, { kind: 'contact', name: 'Persona', contact: 'persona@example.invalid', note: 'Nota' });
  // el evento acabó hace más de 6 meses
  await app.t.db.query(`update booking.reservations set start_date = '2020-01-01', end_date = '2020-01-03' where id = $1`, [res]);
  assert.equal((await app.t.db.query<{ v: boolean }>(`select booking.retention_has_work() v`)).rows[0]!.v, true);
  // como el tick: una acción del sistema (sin actor)
  await app.t.rpc('core_invoke', { p_app: 'booking', p_actor: null, p_name: 'booking.retention_run', p_args: { limit: 100 } });
  const row = (await app.t.db.query<{ name: string | null; contact: string | null; note: string | null; status: string }>(`select name, contact, note, status from booking.visitor_requests where visitor_id = $1`, [visitor])).rows[0]!;
  assert.deepEqual(row, { name: null, contact: null, note: null, status: 'pendiente' });
});

test('ruta POST public/join: sin visitante 401; con visitante crea la petición y repetirla devuelve la misma', async () => {
  const { code } = await retreat(true);
  const join = (body: unknown, token?: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...(token ? { 'X-Visitor': token } : {}) }, body: JSON.stringify(body) }));
  const none = await join({ event_code: code });
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error.code, 'VISITOR_REQUIRED');
  const { token, visitorId } = await issueVisitor(db(), code);
  const first = await join({ event_code: code, name: 'Lucía', contact: 'lucia@example.invalid' }, token);
  assert.equal(first.status, 200, await first.clone().text());
  const out = await first.json();
  assert.deepEqual([out.event_code, out.kind, out.name, out.status], [code, 'join', 'Lucía', 'pendiente']);
  assert.ok(!JSON.stringify(out).includes('example.invalid'), 'el contacto no vuelve');
  const again = await join({ event_code: code }, token);
  assert.equal((await again.json()).status, 'pendiente');
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from booking.visitor_requests where visitor_id = $1`, [visitorId])).rows[0]!.n, 1);
});

