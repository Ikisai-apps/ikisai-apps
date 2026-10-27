/** Booking · B5 de Organizers (0490): `is_minor` sin contestar sale null en la ficha del organizador; contestar «no» cuenta. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `pm-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;

test('B5: is_minor que nadie contestó sale null; el que el organizador contesta (también «no») sale con su valor', async () => {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro menores', status: 'pre_reservada', start_date: '2031-04-04', end_date: '2031-04-06', expected_guests: 10 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const organizer = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [organizer, JSON.stringify({ grants: [{ reservation_id: res }] })]);
  const blank = uuid(); const adult = uuid(); const child = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: blank, declaration: true, fields: { first_name: 'Sin contestar' } });
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: adult, declaration: true, fields: { first_name: 'Adulta', is_minor: false } });
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: child, declaration: true, fields: { first_name: 'Niña', is_minor: true, guardian_name: 'Tutora Sintética', kinship: 'madre' } });
  const items = (await read('organizers', organizer, 'booking.portal_guests', { reservation_id: res })).items as any[];
  const minor = (id: string) => items.find((g) => g.id === id)!.fields.is_minor;
  assert.equal(minor(blank), null, 'el false por defecto no cuenta como contestado');
  assert.equal(minor(adult), false, '«no» contestado por el organizador');
  assert.equal(minor(child), true);
});
