/** Booking · SES.HOSPEDAJES, paso 1 (API.md §17.1): interruptores por reserva, modo de lo que se pide y ajuste global. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { guestMissing, guestModeOf, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

const commands = (operations: unknown[], token = app.tokens.owner) =>
  app.call('/api/v1/commands', { token, body: { requestId: `ss-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) {
  const res = await commands(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);
const mode = async (id: string) => (await app.t.db.query<{ m: string }>(`select booking.guest_mode($1) m`, [id])).rows[0]!.m;
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;

async function confirmed(): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro SES', status: 'pre_reservada', start_date: '2027-10-01', end_date: '2027-10-03', expected_guests: 5 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'pre_reservada' } }]);
  return id;
}
async function organizerOf(reservation: string): Promise<string> {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [user, JSON.stringify({ grants: [{ reservation_id: reservation }] })]);
  return user;
}

test('ses · dominio: modo según los interruptores y nada que pedir en «ninguno»', async () => {
  assert.equal(guestModeOf({}), 'ses');
  assert.equal(guestModeOf({ ses_enabled: false }), 'operativo');
  assert.equal(guestModeOf({ ses_enabled: false, collect_guest_data: false }), 'ninguno');
  assert.equal(guestModeOf({ ses_enabled: true, collect_guest_data: false }), 'ses', 'con SES activo siempre se piden los datos legales');
  assert.deepEqual(guestMissing({ first_name: null } as any, 'ninguno'), []);
  const sql = (await app.t.db.query<{ m: string[] }>(`select booking.guest_missing(jsonb_populate_record(null::booking.guests, '{}'::jsonb), 'ninguno') m`)).rows[0]!.m;
  assert.deepEqual(sql, []);
});

test('ses · interruptores: motivo obligatorio, modo operativo filtra datos legales y firma, «ninguno» sin huéspedes', async () => {
  const id = await confirmed();
  assert.equal(await mode(id), 'ses');
  const update = async (fields: Record<string, unknown>) =>
    commands([{ op: 'update', table: TABLES.reservations, id, expectedRevision: await revision(TABLES.reservations, id), fields }]);
  assert.equal((await update({ ses_enabled: false })).status, 422, 'sin motivo no');
  assert.equal((await update({ ses_enabled: false, ses_disabled_reason: 'otro' })).status, 422, '«otro» pide texto');
  assert.equal((await update({ ses_enabled: false, ses_disabled_reason: 'uso_privado' })).status, 200);
  assert.equal(await mode(id), 'operativo');

  const organizer = await organizerOf(id);
  const guestId = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: id, guest_id: guestId, declaration: true,
    fields: { first_name: 'Ana', last_name_1: 'Sintética', email: 'ana@example.invalid', document_number: '00000000T', birth_date: '1990-01-01', residence_address: 'C/ Falsa 1' } });
  const row = (await app.t.db.query<Record<string, any>>(`select * from booking.guests where id = $1`, [guestId])).rows[0]!;
  assert.equal(row.email, 'ana@example.invalid');
  assert.equal(row.document_number, null, 'sin SES no se guarda el documento');
  assert.equal(row.birth_date, null); assert.equal(row.residence_address, null);
  const view = await read('organizers', organizer, 'booking.portal_guests', { reservation_id: id });
  assert.equal(view.mode, 'operativo');
  assert.deepEqual(view.items[0].missing, []);

  const guestUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2::jsonb)`, [guestUser, JSON.stringify({ grants: [{ reservation_id: id, guest_id: guestId }] })]);
  const file = (await app.t.db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status, created_by)
    values ('guests', 'guests-documents', $1, 'f.png', 'image/png', 1, $2, 'verified', $3) returning id`, [`g/${uuid()}.png`, 'c'.repeat(64), guestUser])).rows[0]!.id;
  await assert.rejects(invoke('guests', guestUser, 'booking.portal_guest_sign', { guest_id: guestId, file_id: file, signed_by_name: 'Ana' }), (e: any) => e.code === 'GUEST_DATA_OFF');

  assert.equal((await update({ collect_guest_data: false })).status, 200);
  assert.equal(await mode(id), 'ninguno');
  assert.deepEqual((await read('organizers', organizer, 'booking.portal_guests', { reservation_id: id })).items, []);
  await assert.rejects(invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: id, guest_id: uuid(), fields: { first_name: 'Leo' } }), (e: any) => e.code === 'GUEST_DATA_OFF');

  assert.equal((await update({ ses_enabled: true })).status, 200, 'se reactiva sin borrar el motivo');
  assert.equal(await mode(id), 'ses');
});

test('ses · ajuste global: una fila en PRE; solo el owner lo cambia', async () => {
  const rows = (await app.t.db.query<{ id: string; environment: string; paused: boolean }>(`select id, environment, paused from booking.ses_settings where deleted_at is null`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.environment, 'pre');
  const id = rows[0]!.id;
  assert.equal((await commands([{ op: 'update', table: TABLES.sesSettings, id, expectedRevision: await revision(TABLES.sesSettings, id), fields: { paused: true } }], app.tokens.editor)).status, 403);
  await ok([{ op: 'update', table: TABLES.sesSettings, id, expectedRevision: await revision(TABLES.sesSettings, id), fields: { paused: true } }]);
  assert.equal((await commands([{ op: 'insert', table: TABLES.sesSettings, id: uuid(), fields: { environment: 'prod' } }])).status, 422, 'una sola fila');
});
