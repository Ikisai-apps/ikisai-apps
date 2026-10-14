/**
 * Booking · O2, «Apuntarme» (migración 0470) con las sugerencias del núcleo (contrato §3.10, P23/P24 en 0094):
 * - un huésped de Guests sugiere apuntarse con varias personas; el personal aprueba y se crean las fichas, que la cuenta
 *   autora ve en Guests (`portal_my_retreats`);
 * - la cuenta autora sale del núcleo: poner otra en `args` no sirve, y una `person_key` ajena se rechaza;
 * - «Pasar al organizador»: el lote corregido con `mode: 'organizer'` deja una solicitud que el organizador acepta;
 * - solo retiros visibles y vivos; el personal no escribe solicitudes a mano.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { JOIN_PROCEDURE, JOIN_SUGGESTION_KIND, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `join-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); }
const rpc = (name: string, args: Record<string, unknown>) => app.t.rpc(name, args) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args });
const invoke = (appId: string, actor: string, name: string, args: unknown) => rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args });
async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}
async function member(appId: string, role = 'editor', grants: unknown[] | null = null) {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, $3, $4::jsonb)`, [appId, user, role, grants ? JSON.stringify({ grants }) : null]);
  return user;
}
async function retreat(title: string, visible = true) {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title, status: 'pre_reservada', start_date: '2033-02-04', end_date: '2033-02-06', expected_guests: 10, guests_visible: visible } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}
const suggest = (author: string, args: Record<string, unknown>) => rpc('core_suggest', { p_app: 'booking', p_actor: author, p_request_id: `s-${uuid()}`, p_kind: JOIN_SUGGESTION_KIND,
  p_summary: 'Apuntarme', p_detail: null, p_operations: [{ op: 'call', procedure: JOIN_PROCEDURE, args }] });
const decide = (staff: string, id: string, decision: 'approve' | 'reject', operations: unknown = null) =>
  rpc('core_suggestion_decide', { p_app: 'booking', p_actor: staff, p_id: id, p_decision: decision, p_comment: null, p_operations: operations });

test('aceptar: fichas para las personas marcadas y entrada en Guests para quien lo pidió', async () => {
  const { res, event } = await retreat('Invierno abierto');
  const staff = await member('booking');
  const marta = await member('guests');
  const s = await suggest(marta, { reservation_id: res, persons: [{ name: 'Marta' }, { name: 'Nico' }] });
  assert.equal(s.status, 'pending');
  const approved = await decide(staff, s.id, 'approve');
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  const guests = await app.t.db.query<{ first_name: string; person_key: string | null }>(`select first_name, person_key from booking.guests where event_id = $1 order by first_name`, [event]);
  assert.deepEqual(guests.rows.map((g) => g.first_name), ['Marta', 'Nico']);
  assert.ok(guests.rows.every((g) => g.person_key));
  const mine = await read('guests', marta, 'booking.portal_my_retreats', {});
  assert.deepEqual(mine.items.map((i: any) => [i.title, i.name]).sort(), [['Invierno abierto', 'Marta'], ['Invierno abierto', 'Nico']]);
  const open = await read('guests', marta, 'booking.portal_open_retreats', { from: '2033-02-01', to: '2033-03-01' });
  assert.equal(open.items.find((i: any) => i.reservation_id === res).joined, true);
});

test('la cuenta autora sale del núcleo; claves ajenas y retiros no visibles se rechazan', async () => {
  const { res } = await retreat('Primavera abierta');
  const hidden = await retreat('Privado', false);
  const staff = await member('booking');
  const marta = await member('guests');
  const luis = await member('guests');
  // Luis pone a Marta en `args`: no cuenta, la entrada es para Luis
  const s = await suggest(luis, { reservation_id: res, account_id: marta, persons: [{ name: 'Luis' }] });
  await decide(staff, s.id, 'approve');
  assert.equal((await read('guests', marta, 'booking.portal_my_retreats', {})).items.length, 0);
  assert.equal((await read('guests', luis, 'booking.portal_my_retreats', {})).items.length, 1);
  // una clave de persona que no es suya
  const foreign = await suggest(marta, { reservation_id: res, persons: [{ person_key: uuid(), name: 'Otra' }] });
  assert.equal(await code(decide(staff, foreign.id, 'approve')), 'OUT_OF_SCOPE');
  const closed = await suggest(marta, { reservation_id: hidden.res, persons: [{ name: 'Marta' }] });
  assert.equal(await code(decide(staff, closed.id, 'approve')), 'RESERVATION_NOT_OPEN');
  // fuera de una aprobación, el procedimiento no se ejecuta
  const direct = await commit([{ op: 'call', procedure: JOIN_PROCEDURE, args: { reservation_id: res, persons: [{ name: 'X' }] } }]);
  assert.equal(direct.status, 422);
  const byHand = await commit([{ op: 'insert', table: TABLES.joinRequests, id: uuid(), fields: { reservation_id: res, account_id: marta, persons: [{ name: 'X' }] } }]);
  assert.equal(byHand.status, 422, 'el personal no escribe solicitudes a mano');
});

test('pasar al organizador: lote corregido, solicitud en su portal y aceptarla', async () => {
  const { res, event } = await retreat('Otoño abierto');
  const staff = await member('booking');
  const marta = await member('guests');
  const org = await member('organizers', 'editor', [{ reservation_id: res }]);
  const persons = [{ name: 'Marta' }];
  const s = await suggest(marta, { reservation_id: res, persons, message: '¿Queda sitio?' });
  const handed = await decide(staff, s.id, 'approve', [{ op: 'call', procedure: JOIN_PROCEDURE, args: { reservation_id: res, persons, message: '¿Queda sitio?', mode: 'organizer' } }]);
  assert.equal(handed.status, 'approved');
  assert.equal((await app.t.db.query(`select 1 from booking.guests where event_id = $1`, [event])).rows.length, 0, 'aún sin fichas');

  let list = await read('organizers', org, 'booking.portal_join_requests', { reservation_id: res });
  assert.deepEqual(list.items.map((j: any) => [j.persons, j.message, j.status]), [[['Marta'], '¿Queda sitio?', 'pendiente']]);
  let open = await read('guests', marta, 'booking.portal_open_retreats', { from: '2033-02-01', to: '2033-03-01' });
  assert.equal(open.items.find((i: any) => i.reservation_id === res).request.status, 'con_el_organizador');

  const out = await invoke('organizers', org, 'booking.portal_join_request_decide', { reservation_id: res, id: list.items[0].id, decision: 'aceptar' });
  assert.equal(out.guest_ids.length, 1);
  list = await read('organizers', org, 'booking.portal_join_requests', { reservation_id: res });
  assert.equal(list.items[0].status, 'aceptada');
  open = await read('guests', marta, 'booking.portal_open_retreats', { from: '2033-02-01', to: '2033-03-01' });
  assert.deepEqual([open.items.find((i: any) => i.reservation_id === res).joined, open.items.find((i: any) => i.reservation_id === res).request.status], [true, 'aceptada']);
  assert.equal(await code(invoke('organizers', org, 'booking.portal_join_request_decide', { reservation_id: res, id: list.items[0].id, decision: 'descartar' })), 'JOIN_REQUEST_DECIDED');
  const other = await member('organizers', 'editor', [{ reservation_id: uuid() }]);
  assert.equal(await code(read('organizers', other, 'booking.portal_join_requests', { reservation_id: res })), 'OUT_OF_SCOPE');
});
