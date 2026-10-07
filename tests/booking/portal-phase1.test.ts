/** Booking · peticiones de fase 1 de los portales: Guests BG1–BG6, Organizers B11 y núcleo C6. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { kinshipLabel, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';
import { kinshipCode } from '../../supabase/functions/_domain/booking/ses/mod.ts';

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

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `ph1-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const member = async (appId: string, grants: unknown[], name?: string) => {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)`, [appId, user, JSON.stringify({ grants })]);
  if (name) await app.t.db.query(`insert into core.profiles (user_id, display_name) values ($1, $2) on conflict (user_id) do update set display_name = excluded.display_name`, [user, name]);
  return user;
};
const guestRow = async (id: string) => (await app.t.db.query<Record<string, any>>(`select * from booking.guests where id = $1`, [id])).rows[0]!;

test('portales fase 1 · procedencia, revisión, alimentación revisada, estancia, firma anulada, parentesco, coorganizadores', async () => {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro fase 1', status: 'pre_reservada', start_date: '2028-03-01', end_date: '2028-03-03', expected_guests: 6 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const erev = Number((await app.t.db.query<{ revision: string }>(`select revision from booking.events where id = $1`, [event])).rows[0]!.revision);
  await ok([{ op: 'update', table: TABLES.events, id: event, expectedRevision: erev, fields: { arrival_time: '18:00', departure_time: '11:00' } }]);

  const organizer = await member('organizers', [{ reservation_id: res }], 'Organizadora Uno');
  await member('organizers', [{ reservation_id: res }], 'Organizador Dos');
  await member('organizers', [{ reservation_id: uuid() }], 'De otra reserva');
  const guestId = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guestId, declaration: true, fields: { first_name: 'Ana', email: 'ana@example.invalid' } });
  const guest = await member('guests', [{ reservation_id: res, guest_id: guestId }]);

  // BG2: revisión nueva en cada respuesta, encadenable sin releer
  const u1 = await invoke('guests', guest, 'booking.portal_guest_update', { guest_id: guestId, fields: { last_name_1: 'Sintética', kinship: 'PM' } });
  assert.equal(u1.revision, Number((await guestRow(guestId)).revision));
  const u2 = await invoke('guests', guest, 'booking.portal_guest_update', { guest_id: guestId, expectedRevision: u1.revision, fields: { birth_date: '1990-01-01' } });
  assert.equal(u2.revision, u1.revision + 1);

  // BG3: «No tengo nada» (lista vacía) marca la alimentación como revisada
  const r1 = await invoke('guests', guest, 'booking.portal_set_restrictions', { guest_id: guestId, items: [] });
  assert.ok(r1.revision);
  assert.ok((await guestRow(guestId)).diet_reviewed_at);
  await invoke('organizers', organizer, 'booking.portal_set_restrictions', { guest_id: guestId, items: [{ restriction_type: 'vegetariano' }] });

  // BG1 y BG4
  const mine = await read('guests', guest, 'booking.portal_my_guest', { guest_id: guestId });
  assert.deepEqual(mine.sources, { first_name: 'organizer', email: 'organizer', last_name_1: 'guest', kinship: 'guest', birth_date: 'guest' });
  assert.deepEqual(mine.restrictions.map((r: any) => [r.restriction_type, r.source]), [['vegetariano', 'organizer']]);
  assert.ok(mine.diet_reviewed_at);
  assert.equal(mine.reservation.status, 'confirmada');
  assert.equal(mine.reservation.arrival_time.slice(0, 5), '18:00');
  assert.equal(mine.reservation.departure_time.slice(0, 5), '11:00');
  assert.equal((await read('organizers', organizer, 'booking.portal_guests', { reservation_id: res })).items[0].diet_reviewed, true);

  // BG5: firmar con la versión del texto; cambiar un dato del registro la anula; cambiar el teléfono... también es del registro
  const file = (await app.t.db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status, created_by)
    values ('guests', 'guests-documents', $1, 'f.png', 'image/png', 1, $2, 'verified', $3) returning id`, [`g/${uuid()}.png`, 'e'.repeat(64), guest])).rows[0]!.id;
  const s1 = await invoke('guests', guest, 'booking.portal_guest_sign', { guest_id: guestId, file_id: file, signed_by_name: 'Ana Sintética', text_version: 'v3' });
  assert.ok(s1.revision);
  assert.deepEqual([(await guestRow(guestId)).signature_text_version, !!(await guestRow(guestId)).signed_at], ['v3', true]);
  const changed = await invoke('guests', guest, 'booking.portal_guest_update', { guest_id: guestId, fields: { last_name_2: 'Prueba' } });
  assert.equal(changed.signature_reset, true);
  const after = await guestRow(guestId);
  assert.deepEqual([after.signed_at, after.signature_file_id, after.signature_text_version], [null, null, null]);
  const again = await invoke('guests', guest, 'booking.portal_guest_update', { guest_id: guestId, fields: { last_name_2: 'Prueba2' } });
  assert.equal(again.signature_reset, false, 'sin firma no hay nada que anular');

  // BG6: códigos del catálogo con su etiqueta; el texto libre antiguo sigue funcionando hacia SES
  assert.equal(kinshipLabel('PM'), 'Padre o madre');
  assert.equal(kinshipLabel('madre'), 'madre');
  assert.equal(kinshipCode('PM'), 'PM');

  // B11: nombres de los coorganizadores de la reserva (no los de otras)
  const orgs = await read('organizers', organizer, 'booking.portal_organizers', { reservation_id: res });
  assert.deepEqual(orgs.items.map((o: any) => [o.display_name, o.me]).sort(), [['Organizador Dos', false], ['Organizadora Uno', true]]);
  await assert.rejects(read('organizers', organizer, 'booking.portal_organizers', { reservation_id: uuid() }), (e: any) => e.code === 'OUT_OF_SCOPE');

  // el personal no marca la alimentación revisada a mano
  const g = await guestRow(guestId);
  const manual = await app.call('/api/v1/commands', { body: { requestId: `ph1-${++seq}`, operations: [{ op: 'update', table: TABLES.guests, id: guestId, expectedRevision: Number(g.revision), fields: { diet_reviewed_at: new Date().toISOString() } }] } });
  assert.equal(manual.status, 422);
});
