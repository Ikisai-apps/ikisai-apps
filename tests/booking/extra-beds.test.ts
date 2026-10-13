/**
 * Booking · supletorias activables por el organizador para su retiro (aprobado el 13-10-2026). Cuántas por habitación con
 * `portal_extra_beds`, cuáles las elige Booking; el huésped y el reparto del organizador (B17) las usan; con la propuesta
 * aceptada quedan pendientes y se avisa al comercial. Lo de antes sigue en `extra-beds-characterization.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { portalTasksRequest } from '../../supabase/functions/booking-api/portal/notices.ts';
import { PROCEDURES, TABLES, extraBedsCharged, extraBedsPending } from '../../supabase/functions/_domain/booking/mod.ts';

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

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `xb-${++seq}-${uuid()}`, operations } });
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
const q = async <T extends Record<string, any>>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const activations = (event: string) => q<{ bed_id: string; status: string; source: string }>(
  `select bed_id, status, source from booking.event_extra_beds where event_id = $1 and deleted_at is null order by status, bed_id`, [event]);
async function retreat(title: string, start: string, end: string) {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 3 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}

test('supletorias · el organizador elige cuántas, el huésped y el reparto las usan, y con propuesta aceptada quedan pendientes', async () => {
  const { res, event } = await retreat('Retiro con supletorias', '2029-08-01', '2029-08-04');
  const room = uuid(); const [b1, b2, x1, x2, x3] = [uuid(), uuid(), uuid(), uuid(), uuid()];
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'Hab 9', public_name: 'Habitación Roble', kind: 'habitacion', capacity: 2, en_suite: true } },
    { op: 'insert', table: TABLES.beds, id: b1, fields: { space_id: room, label: 'Cama 1', position: 1 } },
    { op: 'insert', table: TABLES.beds, id: b2, fields: { space_id: room, label: 'Cama 2', position: 2 } },
    { op: 'insert', table: TABLES.beds, id: x1, fields: { space_id: room, label: 'Supletoria A', kind: 'supletoria', capacity: 1, position: 3 } },
    { op: 'insert', table: TABLES.beds, id: x2, fields: { space_id: room, label: 'Supletoria B', kind: 'supletoria', capacity: 1, position: 4 } },
    { op: 'insert', table: TABLES.beds, id: x3, fields: { space_id: room, label: 'Supletoria C', kind: 'supletoria', capacity: 1, position: 5 } },
    { op: 'insert', table: TABLES.rates, id: uuid(), fields: { name: 'Cama supletoria', layer: 'extra', unit: 'noche', amount: 15, service: 'cama_supletoria', portal_visible: true, public_name: 'Plaza supletoria' } },
  ]);
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: room, group_label: 'Retiro', persons: 2 } }]);
  // otro retiro solapado ya tiene activada la C: no cuenta como posible
  const other = await retreat('Retiro vecino', '2029-08-03', '2029-08-05');
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: other.event, space_id: room, group_label: 'Vecino', persons: 1 } }]);
  await ok([{ op: 'insert', table: TABLES.eventExtraBeds, id: uuid(), fields: { event_id: other.event, bed_id: x3 } }]);

  const organizer = await member('organizers', [{ reservation_id: res }]);
  const [ana, bea] = [uuid(), uuid()];
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: ana, declaration: true, fields: { first_name: 'Ana' } });
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: bea, declaration: true, fields: { first_name: 'Bea' } });
  const gAna = await member('guests', [{ reservation_id: res, guest_id: ana }]);
  await invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choice: 'choose', rooms: [{ space_id: room }] });

  // contador de partida y precio de la supletoria (su tarifa es visible en el portal)
  const start = await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res });
  assert.deepEqual(start.rooms[0].extra, { possible: 2, activated: 0, wanted: 0, requested: 0, release_requested: 0, occupied: 0 });
  assert.deepEqual([start.extra_pending_mode, start.extra_rate], [false, { name: 'Plaza supletoria', unit: 'noche', amount: 15 }]);

  // no más de las posibles; activar 2 es inmediato (sin propuesta aceptada) y Booking elige por orden
  await fails(invoke('organizers', organizer, 'booking.portal_extra_beds', { reservation_id: res, space_id: room, count: 3 }), 'EXTRA_BEDS_LIMIT');
  const two = await invoke('organizers', organizer, 'booking.portal_extra_beds', { reservation_id: res, space_id: room, count: 2 });
  assert.deepEqual([two.activated, two.wanted, two.pending], [2, 2, false]);
  assert.deepEqual((await activations(event)).map((x) => [x.bed_id, x.status, x.source]).sort(), [[x1, 'active', 'organizer'], [x2, 'active', 'organizer']].sort());

  // BG13: el huésped las ve aparte; las fijas no cambian
  const lodging = (await read('guests', gAna, 'booking.portal_lodging', { guest_id: ana })).rooms[0];
  assert.deepEqual([lodging.beds_total, lodging.beds_free, lodging.extra_total, lodging.extra_free], [2, 2, 2, 2]);
  assert.deepEqual(lodging.beds.map((b: any) => [b.label, b.kind]), [['Cama 1', 'individual'], ['Cama 2', 'individual'], ['Supletoria A', 'supletoria'], ['Supletoria B', 'supletoria']]);

  // el huésped elige una supletoria activada; la no activada sigue fuera
  await invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: x2 });
  await fails(invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: x3 }), 'NOT_OFFERED');
  // «quién y dónde» del organizador (B17) también en una activada; nunca en una ocupada
  await fails(invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: bea, bed_id: x2 }), 'BED_TAKEN');
  await invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: bea, bed_id: x1 });
  const both = await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res });
  assert.deepEqual(both.rooms[0].beds.filter((b: any) => b.kind === 'supletoria').map((b: any) => [b.label, b.guest_id, b.source]), [['Supletoria A', bea, 'organizer'], ['Supletoria B', ana, 'guest']]);

  // no se baja por debajo de las ocupadas; soltando a Bea sí, y se queda la ocupada por Ana
  await fails(invoke('organizers', organizer, 'booking.portal_extra_beds', { reservation_id: res, space_id: room, count: 1 }), 'EXTRA_BED_IN_USE');
  await invoke('organizers', organizer, 'booking.portal_assign_bed', { reservation_id: res, guest_id: bea, bed_id: null });
  await invoke('organizers', organizer, 'booking.portal_extra_beds', { reservation_id: res, space_id: room, count: 1 });
  assert.deepEqual((await activations(event)).map((x) => x.bed_id), [x2]);

  // cobro: las activadas aunque nadie las ocupe, y las ocupadas sin activar (como hoy)
  const beds = await q('select * from booking.beds'); const assigns = await q('select * from booking.room_assignments'); const extras = await q('select * from booking.event_extra_beds');
  assert.deepEqual(extraBedsCharged(event, beds as any, assigns as any, extras as any).map((b) => b.id), [x2]);
  await invoke('guests', gAna, 'booking.portal_release_bed', { guest_id: ana });
  assert.equal(extraBedsCharged(event, await q('select * from booking.beds') as any, await q('select * from booking.room_assignments') as any, await q('select * from booking.event_extra_beds') as any).length, 1, 'activada sin ocupar: se cobra');

  // con la propuesta aceptada: activar más queda pedido, retirar queda pedido, y se avisa al comercial
  const proposal = uuid();
  await ok([{ op: 'insert', table: TABLES.conditions, id: uuid(), fields: { name: 'Condiciones supletorias', is_default: true, deposit_percent: 30, deposit_minimum: 0, deposit_days: 5, short_notice_days: 15 } }]);
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: proposal } }]);
  await ok([{ op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, description: 'Estancia', unit: 'unidad', quantity: 1, unit_amount: 1000, position: 1 } }]);
  await ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: proposal } }]);
  await ok([{ op: 'call', procedure: PROCEDURES.acceptProposal, args: { proposal_id: proposal } }]);
  const asked = await invoke('organizers', organizer, 'booking.portal_extra_beds', { reservation_id: res, space_id: room, count: 2 });
  assert.deepEqual([asked.activated, asked.wanted, asked.requested, asked.pending], [1, 2, 1, true]);
  assert.deepEqual((await activations(event)).map((x) => [x.bed_id, x.status]), [[x2, 'active'], [x1, 'requested']]);
  await fails(invoke('guests', gAna, 'booking.portal_choose_bed', { guest_id: ana, bed_id: x1 }), 'NOT_OFFERED');
  const down = await invoke('organizers', organizer, 'booking.portal_extra_beds', { reservation_id: res, space_id: room, count: 0 });
  assert.deepEqual([down.activated, down.wanted, down.release_requested], [1, 0, 1], 'la retirada pedida se sigue cobrando');
  assert.deepEqual((await activations(event)).map((x) => [x.bed_id, x.status]), [[x2, 'release_requested']]);
  assert.deepEqual(extraBedsPending(event, await q('select * from booking.event_extra_beds') as any).map((x) => x.bed_id), [x2]);
  const notices = await q<{ kind: string }>(`select kind from booking.portal_notices where reservation_id = $1`, [res]);
  assert.deepEqual(notices.map((n) => n.kind), ['supletorias', 'supletorias']);
  const task = portalTasksRequest({ id: uuid(), kind: 'supletorias', reservation_id: res, code: '2029-1', title: 'Retiro con supletorias' });
  assert.deepEqual([task.kind, task.kind_label, task.external_ref.startsWith('RES2029-1-SUPLETORIAS-')], ['booking.proposal_comment', 'Organizador · Supletorias por confirmar', true]);

  // el personal confirma la retirada (la quita) con un lote normal; también puede activar
  const row = (await q<{ id: string; revision: string }>(`select id, revision from booking.event_extra_beds where event_id = $1 and deleted_at is null`, [event]))[0]!;
  await ok([{ op: 'delete', table: TABLES.eventExtraBeds, id: row.id, expectedRevision: Number(row.revision) }]);
  await ok([{ op: 'insert', table: TABLES.eventExtraBeds, id: uuid(), fields: { event_id: event, bed_id: x1 } }]);
  assert.deepEqual((await activations(event)).map((x) => [x.bed_id, x.status, x.source]), [[x1, 'active', 'staff']]);

  // reglas al final del lote: dos retiros solapados no comparten supletoria; solo camas supletorias
  const clash = await commit([{ op: 'insert', table: TABLES.eventExtraBeds, id: uuid(), fields: { event_id: other.event, bed_id: x1 } }]);
  assert.equal(clash.data?.error?.code, 'EXTRA_BED_TAKEN');
  const fixed = await commit([{ op: 'insert', table: TABLES.eventExtraBeds, id: uuid(), fields: { event_id: event, bed_id: b1 } }]);
  assert.equal(fixed.status, 422);

  // fuera del retiro, nada
  const stranger = await member('organizers', [{ reservation_id: uuid() }]);
  await fails(invoke('organizers', stranger, 'booking.portal_extra_beds', { reservation_id: res, space_id: room, count: 1 }), 'OUT_OF_SCOPE');
  await fails(invoke('organizers', organizer, 'booking.portal_extra_beds', { reservation_id: res, space_id: uuid(), count: 1 }), 'NOT_OFFERED');
});
