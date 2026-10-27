/**
 * Booking · el alojamiento del fin de semana de punta a punta (como la barra; 0498–0499, 1400–1404 y 1403), en PGlite.
 * El orden de la prueba:
 * 1. el visitante pide noches por el QR y recibe un número;
 * 2. recepción completa los datos;
 * 3. recepción cobra y aloja en un gesto;
 * 4. el apunte va a Finance con las cabeceras de servidor;
 * 5. el huésped llega y sale;
 * 6. la cama queda libre y la limpieza va a Tasks.
 * Lo que ve el visitante pasa por por_pagar → pagada → alojado → salida.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSupabase, issueVisitor } from '../../supabase/functions/_kit/mod.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const tasks: Array<{ path: string; body: any }> = [];
const finance: Array<{ body: any; caller: string | null; key: string | null }> = [];
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({
      ...config, workerKey: 'clave-del-finde', origins: [BOOKING_ORIGINS[0]!],
      ses: { notifyTasks: null, tasksPost: async (path, body) => { tasks.push({ path, body }); return { status: 200, data: { taskId: 'limpieza-1', status: 'pending' } }; } },
      appsFetch: (async (_url: string, init: RequestInit) => {
        const h = new Headers(init.headers);
        finance.push({ body: JSON.parse(String(init.body)), caller: h.get('X-Ikisai-Caller'), key: h.get('X-Ikisai-Worker-Key') });
        return new Response(JSON.stringify({ results: [{ result: { entry_id: '00000000-0000-4000-8000-00000000f1de', status: 'created' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    }),
  });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `fd-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const db = () => createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
const post = (path: string, body: unknown, token: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/public/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://guests.ikisai.com', 'X-Visitor': token }, body: JSON.stringify(body) }));
const visitorStay = (visitorId: string, code: string) => app.t.rpc('core_public_read', { p_name: 'booking_visitor_stay', p_args: { visitor_id: visitorId, event_code: code } }) as Promise<any>;

test('fin de semana: QR → número → recepción completa, cobra y aloja → Finance → llega → sale → limpieza a Tasks', async () => {
  const t = app.t.db;
  const today = (await t.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  // las jornadas, abiertas hoy y dos noches más, con una habitación y su tarifa
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid(); const rate = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas del finde', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: plus(40), end_date: plus(42), expected_guests: 150, guests_visible: true } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await t.query(`update booking.reservations set start_date = $2, end_date = $3 where id = $1`, [res, today, plus(2)]);
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Hab 3', public_name: 'Habitación del olivo', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama A', capacity: 1 } },
    { op: 'insert', table: 'booking.rates', id: rate, fields: { name: 'Cama en albergue', layer: 'por_persona', unit: 'persona_noche', amount: 22, service: 'alojamiento', event_types: ['jornadas_abiertas'] } },
  ]);
  const code = (await t.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c;

  // 1) el visitante: noches, cama y sus datos a medias → número y «por pagar»
  const v = await issueVisitor(db(), code);
  const asked = await post('stay', { event_code: code, from: today, to: plus(2), persons: 1, bed_id: bed, traveler: { first_name: 'Ana', last_name_1: 'Sintética', email: 'ana@example.invalid' } }, v.token);
  assert.equal(asked.status, 200, await asked.clone().text());
  const stay = await asked.json();
  assert.deepEqual([stay.number, stay.stay_status, stay.total_cents, stay.bed], [1, 'por_pagar', 2200 * 2, { room: 'Habitación del olivo', label: 'Cama A' }]);
  assert.ok((stay.missing[0] as string[]).includes('document_number'));

  // 2) recepción completa lo que falta en el borrador (el personal sí puede)
  const draft = (await t.query<{ id: string; revision: string }>(`select id, revision::text from booking.stay_travelers where request_id = $1`, [stay.id])).rows[0]!;
  await ok([{ op: 'update', table: TABLES.stayTravelers, id: draft.id, expectedRevision: Number(draft.revision), fields: {
    document_type: 'Pasaporte', document_number: 'P0001', birth_date: '1990-02-03', residence_address: 'Calle Sintética 1', residence_postal_code: '00000', residence_city: 'Ciudad', residence_country: 'FRA' } }]);
  assert.deepEqual((await visitorStay(v.visitorId, code)).missing, [[]], 'ya no falta nada');

  // 3) cobra (Bizum) y aloja en un gesto
  await ok([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: stay.id, decision: 'accept', method: 'bizum' } }]);
  const guest = (await t.query<{ g: string }>(`select guest_id g from booking.visitor_requests where id = $1`, [stay.id])).rows[0]!.g;
  const g = (await t.query<Record<string, any>>(`select first_name, document_number, residence_country from booking.guests where id = $1`, [guest])).rows[0]!;
  assert.deepEqual([g.first_name, g.document_number, g.residence_country], ['Ana', 'P0001', 'FRA'], 'la ficha con los datos completos');
  const charge = (await t.query<Record<string, any>>(`select c.id, c.amount_cents, c.method from booking.walkin_charges c where c.guest_id = $1`, [guest])).rows[0]!;
  assert.deepEqual([charge.amount_cents, charge.method], [4400, 'bizum']);
  assert.equal((await visitorStay(v.visitorId, code)).stay_status, 'pagada');

  // 4) a Finance: un apunte por el cobro, con la prueba de que sale del servidor de Booking
  assert.equal((await app.call(`/api/v1/walkins/${charge.id}/send/finance`, { body: {} })).status, 200);
  const entry = finance.at(-1)!;
  assert.deepEqual([entry.caller, entry.key], ['booking', 'clave-del-finde']);
  const args = entry.body.operations[0].args;
  assert.deepEqual([args.source_app, args.source_ref, args.amount_cents, args.methods], ['booking', `booking:stay:${charge.id}`, 4400, { bizum: 4400 }]);

  // 5) llega
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.guestArrive, args: { guest_id: guest } }])).status, 200);
  assert.equal((await visitorStay(v.visitorId, code)).stay_status, 'alojado');

  // 6) sale: la cama queda libre desde mañana (mínimo una noche) y la limpieza va a Tasks
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.guestLeave, args: { guest_id: guest } }])).status, 200);
  const a = (await t.query<{ t: string; p: string }>(`select to_date::text t, planned_to_date::text p from booking.room_assignments where guest_id = $1`, [guest])).rows[0]!;
  assert.deepEqual(a, { t: plus(1), p: plus(2) });
  assert.equal((await t.query(`select 1 from booking.free_beds($1, $2) where bed_id = $3`, [plus(1), plus(2), bed])).rows.length, 1, 'libre la segunda noche');
  const cleaning = tasks.filter((x) => x.body.kind === 'booking.bed_cleaning');
  assert.equal(cleaning.length, 1);
  assert.deepEqual([cleaning[0]!.body.title, cleaning[0]!.body.external_ref.startsWith('LIMP-')], ['Limpiar Habitación del olivo · Cama A', true]);
  assert.ok(!JSON.stringify(cleaning[0]!.body).includes('Ana'), 'sin datos de la persona');
  assert.equal((await visitorStay(v.visitorId, code)).stay_status, 'salida');
});
