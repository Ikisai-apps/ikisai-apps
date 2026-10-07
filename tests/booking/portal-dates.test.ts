/** Booking · fase 2 de los portales, parte 1: fecha definitiva, fechas posibles, bloqueos, disponibilidad y avisos (B6–B8). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const tasks: Array<Record<string, any>> = [];
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY,
      ses: { notifyTasks: async (r) => { tasks.push(r as any); return true; } } }),
  });
});
test.after(async () => { await app.close(); });

const commands = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `pd-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commands(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); }
const invoke = (actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: 'organizers', p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: 'organizers', p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);
const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/portal/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();

/** Primer viernes a partir de hoy + `weeks` semanas (hora de Madrid). */
async function friday(weeks: number): Promise<string> {
  return (await app.t.db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date + ((5 - extract(isodow from (now() at time zone 'Europe/Madrid')::date)::int + 7) % 7) + $1 * 7)::text d`, [weeks])).rows[0]!.d;
}
const plus = (d: string, days: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };

async function reservation(fields: Record<string, unknown>): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro fechas', status: 'en_estudio', ...fields } }]);
  return id;
}
async function organizerOf(res: string): Promise<string> {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [user, JSON.stringify({ grants: [{ reservation_id: res }] })]);
  return user;
}

test('fechas · disponibilidad por fin de semana: ocupado, en opción y libre, sin decir quién; la propia no cuenta', async () => {
  const [w1, w2, w3, w4] = [await friday(2), await friday(3), await friday(4), await friday(5)];
  // ocupado por una confirmada
  const busy = await reservation({ status: 'pre_reservada', start_date: w1, end_date: plus(w1, 2), expected_guests: 10 });
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: busy, event_id: uuid(), from_status: 'pre_reservada' } }]);
  // en opción por otra en negociación con fecha definitiva
  await reservation({ status: 'negociacion', start_date: w2, end_date: plus(w2, 2), dates_definitive: true });
  // ocupado por un bloqueo manual (con motivo interno)
  await ok([{ op: 'insert', table: TABLES.dateBlocks, id: uuid(), fields: { start_date: w3, end_date: plus(w3, 2), reason: 'Mantenimiento interno' } }]);

  const mine = await reservation({});
  const org = await organizerOf(mine);
  const out = await read(org, 'booking.portal_availability', { reservation_id: mine, from: w1, to: plus(w4, 2) });
  const status = Object.fromEntries(out.weekends.map((w: any) => [w.start, w.status]));
  assert.deepEqual([status[w1], status[w2], status[w3], status[w4]], ['ocupado', 'en_opcion', 'ocupado', 'libre']);
  assert.ok(out.weekends.every((w: any) => Object.keys(w).sort().join() === 'end,start,status'), 'sin quién ni motivo');
  assert.ok(!JSON.stringify(out).includes('Mantenimiento'));
  await assert.rejects(read(org, 'booking.portal_availability', { reservation_id: busy }), (e: any) => e.code === 'OUT_OF_SCOPE');
});

test('fechas · calendario libre (fechas del organizador), opciones de Ikisai y fecha fija; avisos a Tasks', async () => {
  const [w6, w7, w8] = [await friday(6), await friday(7), await friday(8)];
  const res = await reservation({ expected_guests: 12 });
  const org = await organizerOf(res);

  // sin propuestas: calendario; marca dos fines de semana como posibles
  assert.equal((await read(org, 'booking.portal_dates', { reservation_id: res })).mode, 'calendar');
  await invoke(org, 'booking.portal_set_date_preferences', { reservation_id: res, options: [{ start: w6, end: plus(w6, 2) }, { start: w7, end: plus(w7, 2) }] });
  let dates = await read(org, 'booking.portal_dates', { reservation_id: res });
  assert.deepEqual(dates.options.map((o: any) => [o.start, o.proposed_by, o.organizer_ok, o.availability]), [[w6, 'organizer', true, 'libre'], [w7, 'organizer', true, 'libre']]);
  // sustituye las suyas; una ocupada no se puede marcar; el personal no puede crear fechas «del organizador»
  await ok([{ op: 'insert', table: TABLES.dateBlocks, id: uuid(), fields: { start_date: w8, end_date: plus(w8, 2) } }]);
  await assert.rejects(invoke(org, 'booking.portal_set_date_preferences', { reservation_id: res, options: [{ start: w8, end: plus(w8, 2) }] }), (e: any) => e.code === 'DATE_UNAVAILABLE');
  await invoke(org, 'booking.portal_set_date_preferences', { reservation_id: res, options: [{ start: w7, end: plus(w7, 2) }] });
  assert.equal((await read(org, 'booking.portal_dates', { reservation_id: res })).options.length, 1);
  assert.equal((await commands([{ op: 'insert', table: TABLES.dateOptions, id: uuid(), fields: { reservation_id: res, start_date: w6, end_date: plus(w6, 2), proposed_by: 'organizer' } }])).status, 422);

  // Ikisai propone dos opciones: el organizador solo marca cuáles le vienen bien
  const [o1, o2] = [uuid(), uuid()];
  await ok([
    { op: 'insert', table: TABLES.dateOptions, id: o1, fields: { reservation_id: res, start_date: w6, end_date: plus(w6, 2), position: 1 } },
    { op: 'insert', table: TABLES.dateOptions, id: o2, fields: { reservation_id: res, start_date: w7, end_date: plus(w7, 2), position: 2 } },
  ]);
  dates = await read(org, 'booking.portal_dates', { reservation_id: res });
  assert.equal(dates.mode, 'ikisai_options');
  assert.deepEqual(dates.options.map((o: any) => o.id), [o1, o2]);
  await assert.rejects(invoke(org, 'booking.portal_set_date_preferences', { reservation_id: res, options: [{ start: w8, end: plus(w8, 2) }] }), (e: any) => e.code === 'DATE_NOT_OFFERED');
  await invoke(org, 'booking.portal_set_date_preferences', { reservation_id: res, options: [{ option_id: o2, ok: true }] });
  assert.equal((await app.t.db.query<{ ok: boolean }>(`select organizer_ok ok from booking.reservation_date_options where id = $1`, [o2])).rows[0]!.ok, true);

  // el comercial fija la fecha: el portal la muestra fija y ya no se marcan opciones
  await ok([{ op: 'update', table: TABLES.reservations, id: res, expectedRevision: await revision('booking.reservations', res), fields: { start_date: w7, end_date: plus(w7, 2), dates_definitive: true } }]);
  dates = await read(org, 'booking.portal_dates', { reservation_id: res });
  assert.equal(dates.mode, 'fixed'); assert.equal(dates.definitive.start, w7); assert.deepEqual(dates.options, []);
  await assert.rejects(invoke(org, 'booking.portal_set_date_preferences', { reservation_id: res, options: [{ option_id: o1, ok: true }] }), (e: any) => e.code === 'DATES_FIXED');

  // los avisos llegan a Tasks una sola vez
  tasks.length = 0;
  const t1 = await tick();
  assert.equal(t1.notified, 3, JSON.stringify(t1));
  assert.ok(tasks.every((r) => r.kind === 'booking.organizer_dates' && /^RES.+-FECHAS-[0-9a-f]{8}$/.test(r.external_ref) && r.source === 'booking' && r.external_url.endsWith(res)));
  assert.equal(new Set(tasks.map((r) => r.external_ref)).size, 3);
  assert.equal((await tick()).notified, 0);
  assert.equal((await app.t.db.query<{ v: boolean }>(`select booking.portal_has_work() v`)).rows[0]!.v, false);
});
