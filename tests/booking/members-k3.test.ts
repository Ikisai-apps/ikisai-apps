/** Booking · K3 para miembros (`uploads.membersK3`): el justificante de SES de un huésped solo lo lee por su id quien ve al
 *  huésped (owner o editor con `scopes.guests`); un editor sin ámbito o un lector reciben 404 aunque conozcan el id. En la
 *  papelera, solo quien lo subió y la propietaria. Lo propio, siempre. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const { reservations: RESERVATIONS, guests: GUESTS } = TABLES;
const uuid = () => crypto.randomUUID();

let app: TestApp;
let designated: string; // editor con scopes.guests
let seq = 0;

test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, 'editor', '{"guests": true}'::jsonb)`, [user]);
  designated = app.supabase.tokenFor(user);
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[], token: string = app.tokens.owner) {
  const res = await app.call('/api/v1/commands', { token, body: { requestId: `k3-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function upload(token: string): Promise<string> {
  const t = await app.call('/api/v1/uploads', { token, body: { filename: 'justificante.pdf', mime: 'application/pdf', size: 10, sha256: uuid().replace(/-/g, '').padEnd(64, '0') } });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  await app.t.db.query(`update core.files set status = 'verified' where id = $1`, [t.data.id]);
  return t.data.id as string;
}
const status = async (id: string, token: string) => (await app.call(`/api/v1/files/${id}`, { token })).status;

test('K3 · el justificante de un huésped lo lee quien ve al huésped; el editor sin ámbito y el lector, no', async () => {
  const reservationId = uuid(); const eventId = uuid();
  await ok([{ op: 'insert', table: RESERVATIONS, id: reservationId, fields: { title: 'Retiro K3', status: 'pre_reservada', start_date: '2027-04-02', end_date: '2027-04-04', expected_guests: 4 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: reservationId, event_id: eventId, from_status: 'pre_reservada' } }]);
  const receipt = await upload(designated);
  const guestId = uuid();
  await ok([{ op: 'insert', table: GUESTS, id: guestId, fields: { event_id: eventId, first_name: 'Persona', last_name_1: 'Sintética', ses_receipt_file_id: receipt } }], designated);
  const byOwner = await upload(app.tokens.owner);

  // huésped vivo
  assert.notEqual(await status(receipt, designated), 404, 'el editor designado ve al huésped');
  assert.notEqual(await status(receipt, app.tokens.owner), 404, 'la propietaria, siempre');
  assert.equal(await status(receipt, app.tokens.editor), 404, 'editor sin scopes.guests');
  assert.equal(await status(receipt, app.tokens.reader), 404, 'lector');
  // ajeno sin fila: solo quien lo subió y la propietaria
  assert.equal(await status(byOwner, designated), 404, 'ajeno sin referencia');
  assert.notEqual(await status(byOwner, app.tokens.owner), 404);
  const own = await upload(app.tokens.editor);
  assert.notEqual(await status(own, app.tokens.editor), 404, 'lo suyo');

  // papelera: lo lee quien lo subió (aquí, el designado) y la propietaria; otro designado, no
  const other = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, 'editor', '{"guests": true}'::jsonb)`, [other]);
  const otherToken = app.supabase.tokenFor(other);
  assert.notEqual(await status(receipt, otherToken), 404, 'otro designado, con el huésped vivo');
  const row = (await app.t.db.query<{ revision: number }>('select revision from booking.guests where id = $1', [guestId])).rows[0]!;
  await ok([{ op: 'delete', table: GUESTS, id: guestId, expectedRevision: Number(row.revision) }]);
  assert.equal(await status(receipt, otherToken), 404, 'otro designado, en la papelera');
  assert.notEqual(await status(receipt, designated), 404, 'quien lo subió');
  assert.notEqual(await status(receipt, app.tokens.owner), 404, 'la propietaria');
});
