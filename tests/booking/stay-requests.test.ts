/** Booking · Alojamiento libre, tarjeta 2 (0499): solicitud pública de noches con bloqueo, caducidad y sin doble reserva. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, isFault, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { applyPublicOperations } from '../../supabase/functions/_kit/public-write.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `sr-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const visitorOf = async (code: string) => (await issueVisitor(db(), code)).visitorId;
const ask = (code: string, visitor: string, fields: Record<string, unknown>) =>
  applyPublicOperations(db(), 'booking', [{ op: 'insert', table: TABLES.visitorRequests, id: uuid(), fields: { via_code: code, visitor_id: visitor, kind: 'stay', name: 'Visitante', ...fields } }], visitor);
async function codeOf(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (e) { return isFault(e) ? e.code : (String((e as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(e)); }
}
const rowsOf = (visitor: string) => app.t.db.query<Record<string, any>>(`select * from booking.visitor_requests where visitor_id = $1 order by created_at`, [visitor]).then((r) => r.rows);
const houseFree = async (from: string, to: string) =>
  Number((await app.t.db.query<{ n: string }>(`select coalesce(sum(places), 0) n from booking.free_beds($1, $2)`, [from, to])).rows[0]!.n);
const free = async (from: string, to: string, space: string) =>
  Number((await app.t.db.query<{ n: string }>(`select coalesce(sum(places), 0) n from booking.free_beds($1, $2) where space_id = $3`, [from, to, space])).rows[0]!.n);

/** Unas jornadas con una habitación de dos camas de una plaza (con sus fechas propias, para no cruzarse con otras pruebas). */
async function openDays(start: string, end: string, fields: Record<string, unknown> = {}) {
  const res = uuid(); const event = uuid(); const space = uuid(); const beds = [uuid(), uuid()]; const rate = uuid();
  await ok([
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas sintéticas', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 100, guests_visible: true, ...fields } },
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: `Albergue ${start}`, kind: 'habitacion' } },
    ...beds.map((id, i) => ({ op: 'insert', table: TABLES.beds, id, fields: { space_id: space, label: `Cama ${i + 1}`, capacity: 1 } })),
    { op: 'insert', table: 'booking.rates', id: rate, fields: { name: `Cama ${start}`, layer: 'por_persona', unit: 'persona_noche', amount: 20, service: 'alojamiento', event_types: ['jornadas_abiertas'], valid_from: start, valid_to: end } },
  ]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;
  return { res, event, space, beds, rate, code };
}

test('reserva la plaza N horas: bloquea camas, la última plaza es de uno solo, el personal no la asigna y caduca', async () => {
  const d = await openDays('2032-03-01', '2032-03-05');
  const night = { from_date: '2032-03-02', to_date: '2032-03-04', rate_id: d.rate };
  const [ana, bea, carla] = [await visitorOf(d.code), await visitorOf(d.code), await visitorOf(d.code)];

  // dos personas no caben si solo queda una plaza; una sí, y su total lo pone el servidor
  await ask(d.code, ana, { ...night, persons: 1, total_cents: 1 });
  const [a1] = await rowsOf(ana);
  assert.deepEqual([a1!.status, a1!.pay_mode, a1!.total_cents, a1!.hold_bed_ids.length], ['pendiente', 'hold', 2000 * 2 * 1, 1]);
  // 1403: la retención por defecto es de 2 horas
  assert.ok(new Date(a1!.hold_until).getTime() > Date.now() + 1.5 * 3600_000 && new Date(a1!.hold_until).getTime() <= Date.now() + 2 * 3600_000 + 60_000, '2 horas por defecto');
  assert.equal(await free('2032-03-02', '2032-03-04', d.space), 1);
  assert.equal(await codeOf(ask(d.code, bea, { ...night, persons: 2 })), 'NO_AVAILABILITY');
  assert.equal((await rowsOf(bea)).length, 0, 'sin reserva fantasma');

  // E: dos teléfonos por la última plaza, uno detrás de otro en el mismo servidor: uno la tiene, el otro ve el conflicto
  const results = await Promise.all([codeOf(ask(d.code, bea, { ...night, persons: 1 })), codeOf(ask(d.code, carla, { ...night, persons: 1 }))]);
  assert.deepEqual(results.sort(), ['NO_AVAILABILITY', 'OK']);
  assert.equal(await free('2032-03-02', '2032-03-04', d.space), 0);

  // el personal no puede dar una cama bloqueada (sí una noche que el bloqueo no toca)
  const guest = uuid();
  await ok([{ op: 'insert', table: TABLES.guests, id: guest, fields: { event_id: d.event, first_name: 'Walk-in' } }]);
  const held = a1!.hold_bed_ids[0];
  const assign = (from: string, to: string) => commit([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: d.event, space_id: d.space, bed_id: held, guest_id: guest, persons: 1, from_date: from, to_date: to } }]);
  const blocked = await assign('2032-03-03', '2032-03-04');
  assert.equal(blocked.data?.error?.code, 'BED_HELD', JSON.stringify(blocked.data));
  assert.equal((await assign('2032-03-04', '2032-03-05')).status, 200, 'la noche siguiente está libre');

  // pedir otra vez sustituye la anterior (y suelta su bloqueo); queda en el registro de cambios
  await ask(d.code, ana, { from_date: '2032-03-01', to_date: '2032-03-02', rate_id: d.rate, persons: 1 });
  const again = await rowsOf(ana);
  assert.deepEqual(again.map((r) => r.status), ['descartada', 'pendiente']);
  assert.equal((await app.t.db.query(`select 1 from core.changes where table_name = 'visitor_requests' and row_id = $1 and op = 'update'`, [a1!.id])).rows.length, 1);
  assert.equal(await free('2032-03-02', '2032-03-04', d.space), 1, 'el bloqueo de antes se ha soltado');

  // caducidad: pasada la hora, la plaza vuelve a estar libre y el visitante lo ve
  const current = again[1]!;
  await app.t.db.exec(`select set_config('booking.visitor_procedure', 'on', false);
    update booking.visitor_requests set hold_until = now() - interval '1 minute' where id = '${current.id}';
    select set_config('booking.visitor_procedure', '', false);`);
  assert.equal(await free('2032-03-01', '2032-03-02', d.space), 2);
  const mine = await app.t.rpc('core_public_read', { p_name: 'booking_visitor_requests', p_args: { visitor_id: ana } }) as any;
  const item = mine.items.find((i: any) => i.id === current.id);
  assert.deepEqual([item.kind, item.status, item.pay, item.hold_expired, item.from, item.persons, item.total_cents], ['stay', 'pendiente', 'hold', true, '2032-03-01', 1, 2000]);
});

test('no reserva hasta pagar: comprueba el hueco pero no bloquea; errores de fechas y tarifa', async () => {
  const d = await openDays('2032-04-01', '2032-04-04', { lodging_pay_mode: 'pay_first' });
  const v = await visitorOf(d.code);
  await ask(d.code, v, { from_date: '2032-04-01', to_date: '2032-04-03', rate_id: d.rate, persons: 2 });
  const [r] = await rowsOf(v);
  // 1400: en pay_first las camas quedan como preferencia, sin bloqueo
  assert.deepEqual([r!.pay_mode, r!.hold_bed_ids.length, r!.hold_until, r!.total_cents], ['pay_first', 2, null, 2000 * 2 * 2]);
  assert.equal(await free('2032-04-01', '2032-04-03', d.space), 2, 'no bloquea');
  const w = await visitorOf(d.code);
  // la disponibilidad es de toda la casa: una persona más de las que caben
  const over = (await houseFree('2032-04-01', '2032-04-03')) + 1;
  if (over <= 20) assert.equal(await codeOf(ask(d.code, w, { from_date: '2032-04-01', to_date: '2032-04-03', rate_id: d.rate, persons: over })), 'NO_AVAILABILITY');
  assert.equal(await codeOf(ask(d.code, w, { from_date: '2032-03-31', to_date: '2032-04-02', rate_id: d.rate, persons: 1 })), 'INVALID_FIELDS', 'fuera del evento');
  assert.equal(await codeOf(ask(d.code, w, { from_date: '2032-04-01', to_date: '2032-04-02', rate_id: uuid(), persons: 1 })), 'INVALID_FIELDS', 'tarifa que no vale');
  assert.equal(await codeOf(ask(d.code, w, { from_date: '2032-04-01', to_date: '2032-04-02', rate_id: d.rate, persons: 1, name: null })), 'INVALID_FIELDS', 'sin nombre');
  // la oferta pública dice el modo
  const offer = await app.t.rpc('core_public_read', { p_name: 'booking_public_lodging', p_args: { event_code: d.code, from: '2032-04-01', to: '2032-04-02', persons: 1 } }) as any;
  assert.deepEqual([offer.pay, offer.hold_hours], ['pay_first', null]);
});

test('ruta POST public/stay: sin visitante 401; con visitante crea la solicitud y devuelve total y modo', async () => {
  const d = await openDays('2032-05-01', '2032-05-03', { lodging_hold_hours: 6 });
  const stay = (body: unknown, token?: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/stay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', ...(token ? { 'X-Visitor': token } : {}) }, body: JSON.stringify(body) }));
  assert.equal((await stay({ event_code: d.code })).status, 401);
  const { token } = await issueVisitor(db(), d.code);
  const res = await stay({ event_code: d.code, mode_id: d.rate, from: '2032-05-01', to: '2032-05-03', persons: 1, name: 'Lucía', contact: 'lucia@example.invalid' }, token);
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.deepEqual([out.status, out.from, out.to, out.persons, out.total_cents, out.pay], ['pendiente', '2032-05-01', '2032-05-03', 1, 4000, 'hold']);
  assert.ok(new Date(out.hold_until).getTime() <= Date.now() + 6 * 3600_000 + 60_000, 'las horas del evento');
  assert.ok(!JSON.stringify(out).includes('example.invalid'));
  const over = (await houseFree('2032-05-01', '2032-05-03')) + 1;
  if (over <= 20) {
    const full = await stay({ event_code: d.code, mode_id: d.rate, from: '2032-05-01', to: '2032-05-03', persons: over, name: 'Otra' }, (await issueVisitor(db(), d.code)).token);
    assert.equal(full.status, 409);
    assert.equal((await full.json()).error.code, 'NO_AVAILABILITY');
  }
  assert.equal((await stay({ event_code: d.code, mode_id: 'x', from: '2032-05-01', to: '2032-05-02', name: 'X' }, token)).status, 422);
});
