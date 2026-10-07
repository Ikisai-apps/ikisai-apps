/** Booking · SES-4: conservación del registro de viajeros (API.md §20). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, ses: { notifyTasks: null } }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `ret-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/retention/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();
const today = async () => (await app.t.db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
const shift = (date: string, days: number, months = 0, years = 0) => {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + years); d.setUTCMonth(d.getUTCMonth() + months); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Reserva confirmada con un huésped con datos y firma; las fechas se fijan después en SQL (pueden ser pasadas). */
async function stay(endDate: string, ses: boolean): Promise<{ guest: string; file: string }> {
  const res = uuid(); const event = uuid(); const guest = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Estancia', status: 'pre_reservada', start_date: '2030-01-01', end_date: '2030-01-03', expected_guests: 2 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const file = (await app.t.db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status, retention_class)
    values ('booking', 'booking-documents', $1, 'firma.png', 'image/png', 1, $2, 'verified', 'legal') returning id`, [`f/${uuid()}.png`, 'd'.repeat(64)])).rows[0]!.id;
  await ok([
    { op: 'insert', table: TABLES.guests, id: guest, fields: { event_id: event, first_name: 'Ana', last_name_1: 'Sintética', document_type: 'DNI', document_number: '00000000T',
      birth_date: '1990-01-01', email: 'ana@example.invalid', signed_at: '2030-01-01T10:00:00Z', signed_by_name: 'Ana', signature_file_id: file } },
    { op: 'insert', table: TABLES.restrictions, id: uuid(), fields: { event_id: event, guest_id: guest, restriction_type: 'alergia', subject: 'frutos secos', severity: 'grave' } },
  ]);
  await app.t.db.query(`update booking.reservations set start_date = $2::date - 2, end_date = $2::date, ses_enabled = $3, ses_disabled_reason = case when $3 then null else 'uso_privado' end where id = $1`, [res, endDate, ses]);
  return { guest, file };
}
const guestRow = async (id: string) => (await app.t.db.query<Record<string, any>>(`select * from booking.guests where id = $1`, [id])).rows[0]!;

test('conservación · 3 años con SES, 6 meses sin SES, nunca una estancia en curso; archivos temporales y cambio sincronizado', async () => {
  const d = await today();
  const sesOld = await stay(shift(d, -1, 0, -3), true);        // terminó hace 3 años y 1 día
  const sesRecent = await stay(shift(d, 1, 0, -3), true);      // le falta 1 día para los 3 años
  const privOld = await stay(shift(d, -1, -6), false);         // sin SES, hace 6 meses y 1 día
  const privRecent = await stay(shift(d, 1, -6), false);       // sin SES, le falta 1 día
  const ongoing = await stay(shift(d, 2), false);              // en curso (termina dentro de 2 días)

  assert.equal((await app.t.db.query<{ v: boolean }>(`select booking.retention_has_work() v`)).rows[0]!.v, true);
  const before = (await app.call('/api/v1/bootstrap')).data.cursor;
  const out = await tick();
  assert.equal(out.anonymized, 2, JSON.stringify(out));

  for (const { guest, file } of [sesOld, privOld]) {
    const g = await guestRow(guest);
    assert.equal(g.first_name, 'Huésped anonimizado');
    assert.deepEqual([g.last_name_1, g.document_number, g.birth_date, g.email, g.signed_by_name, g.signature_file_id], [null, null, null, null, null, null]);
    assert.ok(g.anonymized_at); assert.ok(g.signed_at, 'el estado (firmado) se conserva sin el archivo');
    assert.equal((await app.t.db.query<{ r: string }>(`select retention_class r from core.files where id = $1`, [file])).rows[0]!.r, 'temporary');
    assert.equal((await app.t.db.query(`select 1 from booking.dietary_restrictions where guest_id = $1 and deleted_at is null`, [guest])).rows.length, 0);
  }
  for (const { guest } of [sesRecent, privRecent, ongoing]) assert.equal((await guestRow(guest)).first_name, 'Ana');

  // llega a los dispositivos por changes, firmado por «Booking (sistema)»
  const changes = await app.call(`/api/v1/changes?after=${before}`, { token: app.tokens.owner });
  const anonymized = changes.data.items.filter((c: any) => c.table === TABLES.guests && [sesOld.guest, privOld.guest].includes(c.id));
  assert.equal(anonymized.length, 2);
  const actor = (await app.t.db.query<{ a: string }>(`select updated_by::text a from booking.guests where id = $1`, [sesOld.guest])).rows[0]!.a;
  assert.equal(actor, await app.t.rpc('core_service_actor', { p_name: 'booking' }));

  // repetir no hace nada; y un cliente no puede marcar la anonimización a mano
  assert.equal((await tick()).anonymized, 0);
  assert.equal((await app.t.db.query<{ v: boolean }>(`select booking.retention_has_work() v`)).rows[0]!.v, false);
  const g = await guestRow(sesRecent.guest);
  const manual = await app.call('/api/v1/commands', { body: { requestId: `ret-${++seq}`, operations: [{ op: 'update', table: TABLES.guests, id: sesRecent.guest, expectedRevision: Number(g.revision), fields: { anonymized_at: new Date().toISOString() } }] } });
  assert.equal(manual.status, 422);
  const ticks = (await app.t.db.query<{ route: string }>(`select route from core.scheduled_ticks where app = 'booking' and route = 'retention/tick'`)).rows;
  assert.equal(ticks.length, 1);
});
