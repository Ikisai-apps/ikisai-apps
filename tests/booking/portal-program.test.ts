/** Booking · fase 4 de los portales: programa del retiro (Organizers B16, Guests BG9) y huésped de muestra (BG11). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

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

async function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `f4-${++seq}-${uuid()}`, operations } });
}
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const fails = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (err: any) => JSON.stringify(err?.data ?? err?.message ?? err).includes(code));
};
const member = async (appId: string, grants: unknown[]) => {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)`, [appId, user, JSON.stringify({ grants })]);
  return user;
};

async function confirmedReservation(title: string) {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title, status: 'pre_reservada', start_date: '2028-05-01', end_date: '2028-05-03', expected_guests: 8 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}

test('programa · el organizador lo edita, el huésped lo lee sin notas internas, fuera de ámbito nada', async () => {
  const { res, event } = await confirmedReservation('Retiro programa');
  const sala = uuid();
  await ok([{ op: 'insert', table: TABLES.spaces, id: sala, fields: { name: 'Sala grande interna', public_name: 'Sala del Roble', kind: 'sala' } }]);
  const organizer = await member('organizers', [{ reservation_id: res }]);
  const stranger = await member('organizers', [{ reservation_id: uuid() }]);

  // sin evento (reserva sin confirmar) no hay programa que editar
  const draft = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: draft, fields: { title: 'Sin confirmar', status: 'pre_reservada', start_date: '2028-06-01', end_date: '2028-06-02', expected_guests: 4 } }]);
  const draftOrganizer = await member('organizers', [{ reservation_id: draft }]);
  await fails(invoke('organizers', draftOrganizer, 'booking.portal_program_save', { reservation_id: draft, item: { id: uuid(), day: '2028-06-01', title: 'Algo' } }), 'EVENT_REQUIRED');

  const a = uuid(); const b = uuid();
  const s1 = await invoke('organizers', organizer, 'booking.portal_program_save', { reservation_id: res, item: { id: a, day: '2028-05-02', starts_at: '10:00', ends_at: '12:00', title: 'Meditación', space_id: sala, public_note: 'Trae esterilla', internal_note: 'Pedir cojines' } });
  assert.equal(s1.id, a);
  await invoke('organizers', organizer, 'booking.portal_program_save', { reservation_id: res, item: { id: b, day: '2028-05-02', title: 'Excursión', place_text: 'Al pinar', position: 2 } });
  const s2 = await invoke('organizers', organizer, 'booking.portal_program_save', { reservation_id: res, expectedRevision: s1.revision, item: { id: a, title: 'Meditación guiada' } });
  assert.equal(s2.revision, s1.revision + 1);
  await fails(invoke('organizers', organizer, 'booking.portal_program_save', { reservation_id: res, expectedRevision: s1.revision, item: { id: a, title: 'Viejo' } }), 'VERSION_CONFLICT');
  await fails(invoke('organizers', organizer, 'booking.portal_program_save', { reservation_id: res, item: { id: uuid(), day: '2028-05-09', title: 'Fuera' } }), 'PROGRAM_DAY_OUT_OF_RANGE');
  await fails(invoke('organizers', organizer, 'booking.portal_program_save', { reservation_id: res, item: { id: uuid(), day: '2028-05-02', starts_at: '12:00', ends_at: '11:00', title: 'Al revés' } }), 'program_items_times');
  await fails(invoke('organizers', stranger, 'booking.portal_program_save', { reservation_id: res, item: { id: uuid(), day: '2028-05-02', title: 'Intruso' } }), 'OUT_OF_SCOPE');
  await fails(invoke('organizers', stranger, 'booking.portal_program_save', { reservation_id: uuid(), item: { id: a, title: 'Intruso' } }), 'OUT_OF_SCOPE');

  const forOrganizer = await read('organizers', organizer, 'booking.portal_program', { reservation_id: res });
  assert.deepEqual(forOrganizer.items.map((i: any) => [i.title, i.starts_at, i.place]), [['Excursión', null, 'Al pinar'], ['Meditación guiada', '10:00', 'Sala del Roble']]);
  assert.equal(forOrganizer.items[1].internal_note, 'Pedir cojines');
  assert.deepEqual(forOrganizer.spaces.map((s: any) => s.name), ['Sala del Roble']);

  // el huésped: mismo programa, sin notas internas ni lista de espacios
  const guestId = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guestId, declaration: true, fields: { first_name: 'Ana' } });
  const guest = await member('guests', [{ reservation_id: res, guest_id: guestId }]);
  const forGuest = await read('guests', guest, 'booking.portal_program', { reservation_id: res });
  assert.equal(forGuest.items.length, 2);
  assert.ok(!JSON.stringify(forGuest).includes('Pedir cojines') && forGuest.spaces === undefined);
  assert.equal(forGuest.revision, forOrganizer.revision);
  const otherGuest = await member('guests', [{ reservation_id: uuid(), guest_id: uuid() }]);
  await fails(read('guests', otherGuest, 'booking.portal_program', { reservation_id: res }), 'OUT_OF_SCOPE');

  // orden y baja; la revisión crece con cada cambio
  await invoke('organizers', organizer, 'booking.portal_program_reorder', { reservation_id: res, ids: [a, b] });
  await invoke('organizers', organizer, 'booking.portal_program_remove', { reservation_id: res, id: b });
  const after = await read('organizers', organizer, 'booking.portal_program', { reservation_id: res });
  assert.deepEqual(after.items.map((i: any) => i.id), [a]);
  assert.ok(Number(after.revision) > Number(forOrganizer.revision));

  // el personal lo ve y lo corrige con la sincronización normal
  const rev = Number((await app.t.db.query<{ revision: string }>(`select revision from booking.program_items where id = $1`, [a])).rows[0]!.revision);
  await ok([{ op: 'update', table: TABLES.programItems, id: a, expectedRevision: rev, fields: { title: 'Meditación (personal)' } }]);
  await ok([{ op: 'insert', table: TABLES.programItems, id: uuid(), fields: { event_id: event, day: '2028-05-03', title: 'Cierre', kind: 'otro' } }]);
  assert.equal((await read('guests', guest, 'booking.portal_program', { reservation_id: res })).items.length, 2);
});

test('huésped de muestra · único, no cuenta, no se escribe como huésped y no llega a cocina ni a SES', async () => {
  const { res, event } = await confirmedReservation('Retiro muestra');
  const organizer = await member('organizers', [{ reservation_id: res }]);
  const realId = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: realId, declaration: true, fields: { first_name: 'Real' } });

  const p1 = await invoke('organizers', organizer, 'booking.portal_preview_guest', { reservation_id: res });
  const p2 = await invoke('organizers', organizer, 'booking.portal_preview_guest', { reservation_id: res });
  assert.deepEqual([p1.created, p2.created, p2.guest_id], [true, false, p1.guest_id]);

  // el organizador no lo ve en su lista ni cuenta en totales
  assert.deepEqual((await read('organizers', organizer, 'booking.portal_guests', { reservation_id: res })).items.map((g: any) => g.id), [realId]);
  const mine = (await read('organizers', organizer, 'booking.portal_reservations', {})).items.find((r: any) => r.id === res);
  assert.equal(Number(mine.guests), 1);
  const summary = (await app.t.db.query<{ s: any }>(`select booking.guest_summary(jsonb_build_object('args', jsonb_build_object('event_id', $1::text))) s`, [event])).rows[0]!.s;
  assert.equal(Number(summary.total), 1);

  // abierto en Guests: lee lo de un huésped, pero no guarda nada
  const viewer = await member('guests', [{ reservation_id: res, guest_id: p1.guest_id }]);
  assert.equal((await read('guests', viewer, 'booking.portal_my_guest', { guest_id: p1.guest_id })).id, p1.guest_id);
  await fails(invoke('guests', viewer, 'booking.portal_guest_update', { guest_id: p1.guest_id, fields: { last_name_2: 'Cambio' } }), 'PREVIEW_READ_ONLY');
  await fails(invoke('guests', viewer, 'booking.portal_set_restrictions', { guest_id: p1.guest_id, items: [{ restriction_type: 'vegetariano' }] }), 'PREVIEW_READ_ONLY');

  // el personal no puede crear otro ni convertir a uno real en muestra; su llegada no se marca (no hay parte para SES)
  await fails(commit([{ op: 'insert', table: TABLES.guests, id: uuid(), fields: { event_id: event, first_name: 'Otro', preview: true } }]).then((r) => { if (r.status !== 200) throw r; }), 'preview');
  await assert.rejects(app.t.db.query(`update booking.guests set arrived_at = now() where id = $1`, [p1.guest_id]));

  // cocina: una restricción del organizador sobre la muestra no llega a la proyección de Food
  await invoke('organizers', organizer, 'booking.portal_set_restrictions', { guest_id: p1.guest_id, items: [{ restriction_type: 'sin_gluten' }] });
  const projection = (await app.t.db.query<{ d: any }>(`select dietary_restrictions d from booking.food_event_projection where event_id = $1`, [event])).rows[0]!.d;
  assert.ok(!JSON.stringify(projection).includes('sin_gluten'));
});
