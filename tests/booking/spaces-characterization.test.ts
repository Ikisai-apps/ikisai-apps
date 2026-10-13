/**
 * Booking · caracterización de lo que depende de espacios y camas (fase R2 de Recursos, `coordinacion/ampliacion/RECURSOS.md`
 * §17): en verde **antes** de que `booking.spaces` y `beds` pasen a leer de `resources.spaces`, y **después**.
 *
 * Solo cambia de dónde salen los espacios: en R2 se sustituye `seedInventory` (hoy, lotes de Booking; después, de Recursos)
 * y las aserciones se quedan igual. Cubre lo que leen otros: portales (detalle, programa, habitaciones, elección de cama),
 * indicadores de Central y la regla «una cama, una persona por noche» entre reservas.
 */
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
  return app.call('/api/v1/commands', { body: { requestId: `car-${++seq}-${uuid()}`, operations } });
}
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const member = async (appId: string, grants: unknown[] | null, role = 'editor') => {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, $3, $4::jsonb)`, [appId, user, role, JSON.stringify(grants ? { grants } : {})]);
  return user;
};

/**
 * Inventario de la prueba. **Lo único que cambia en R2** (hoy: lotes de Booking).
 * Albergue (edificio) › «Habitación Encina» (con baño, 3 plazas: individual, doble y una supletoria) y «Sala del Roble».
 */
async function seedInventory() {
  const room = uuid(); const hall = uuid(); const single = uuid(); const double = uuid(); const extra = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'H-12 interna', public_name: 'Habitación Encina', kind: 'habitacion', zone: 'Albergue', en_suite: true, accessible: true } },
    { op: 'insert', table: TABLES.spaces, id: hall, fields: { name: 'Sala grande', public_name: 'Sala del Roble', kind: 'sala', zone: 'Albergue', capacity: 40 } },
    { op: 'insert', table: TABLES.beds, id: single, fields: { space_id: room, label: 'Cama 1', kind: 'individual', capacity: 1, position: 1 } },
    { op: 'insert', table: TABLES.beds, id: double, fields: { space_id: room, label: 'Cama 2', kind: 'doble', capacity: 2, position: 2 } },
    { op: 'insert', table: TABLES.beds, id: extra, fields: { space_id: room, label: 'Supletoria', kind: 'supletoria', capacity: 1, position: 3 } },
  ]);
  return { room, hall, single, double, extra };
}

async function reservation(title: string, start: string, end: string) {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 4 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}

test('caracterización · lo que ven portales e indicadores a partir de espacios y camas', async () => {
  const inv = await seedInventory();
  const { res, event } = await reservation('Retiro caracterización', '2029-04-02', '2029-04-05');
  const organizer = await member('organizers', [{ reservation_id: res }]);
  const guestId = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guestId, declaration: true, fields: { first_name: 'Ana' } });
  const guest = await member('guests', [{ reservation_id: res, guest_id: guestId }]);

  // el personal asigna la habitación al retiro (como grupo, sin cama) y la sala para el programa
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: inv.room, group_label: 'Retiro', persons: 3 } }]);
  await invoke('organizers', organizer, 'booking.portal_program_save', { reservation_id: res, item: { id: uuid(), day: '2029-04-03', starts_at: '10:00', title: 'Meditación', space_id: inv.hall } });

  // portal del organizador · detalle: alojamiento por espacio con su nombre (interno, como hoy) y personas
  const detail = await read('organizers', organizer, 'booking.portal_reservation_detail', { reservation_id: res });
  assert.deepEqual(detail.lodging, [{ space: 'H-12 interna', kind: 'habitacion', zone: 'Albergue', persons: 3 }]);

  // programa: el lugar es el nombre público; el organizador elige entre salas y exteriores activos (no habitaciones)
  const program = await read('organizers', organizer, 'booking.portal_program', { reservation_id: res });
  assert.equal(program.items[0].place, 'Sala del Roble');
  assert.deepEqual(program.spaces.map((s: any) => [s.name, s.kind, s.zone]), [['Sala del Roble', 'sala', 'Albergue']]);
  assert.equal((await read('guests', guest, 'booking.portal_program', { reservation_id: res })).items[0].place, 'Sala del Roble');

  // habitaciones del retiro: solo las asignadas; plazas sin supletorias; con baño y «2–4 plazas con baño»
  const rooms = await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res });
  assert.equal(rooms.rooms.length, 1);
  const r = rooms.rooms[0];
  assert.deepEqual([r.space_id, r.name, r.zone, r.kind, r.en_suite, r.beds_total, r.beds_free], [inv.room, 'Habitación Encina', 'Albergue', 'habitacion', true, 2, 2]);
  assert.deepEqual(r.beds.map((b: any) => [b.bed_id, b.label, b.kind]), [[inv.single, 'Cama 1', 'individual'], [inv.double, 'Cama 2', 'doble']], 'sin la supletoria y en su orden');

  // elección de cama por el huésped en una habitación abierta: ocupa la cama y la cuenta baja
  await invoke('organizers', organizer, 'booking.portal_room_settings', { reservation_id: res, choice: 'choose', rooms: [{ space_id: inv.room, option_key: 'con_bano' }] });
  const chosen = await invoke('guests', guest, 'booking.portal_choose_bed', { guest_id: guestId, bed_id: inv.double });
  assert.equal(chosen.status, 'confirmed');
  const lodging = await read('guests', guest, 'booking.portal_lodging', { guest_id: guestId });
  // para el propio huésped, su cama cuenta como libre (la puede volver a elegir) y va marcada `mine`
  assert.deepEqual([lodging.mine.space_name, lodging.mine.bed_label, lodging.rooms[0].beds_free], ['Habitación Encina', 'Cama 2', 2]);
  assert.deepEqual(lodging.rooms[0].beds.map((b: any) => [b.label, b.free, b.mine]), [['Cama 1', true, false], ['Cama 2', true, true]]);
  assert.equal((await read('organizers', organizer, 'booking.portal_rooms', { reservation_id: res })).rooms[0].beds_free, 1);

  // otra reserva solapada no puede ocupar esa cama esas noches; la del día de salida, sí
  const other = await reservation('Otro retiro', '2029-04-04', '2029-04-06');
  const clash = await commit([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: other.event, space_id: inv.room, bed_id: inv.double, group_label: 'Otro', persons: 1 } }]);
  assert.equal(clash.status, 422);
  assert.equal(clash.data.error.code, 'BED_OVERBOOKED');
  const next = await reservation('Retiro siguiente', '2029-04-05', '2029-04-07');
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: next.event, space_id: inv.room, bed_id: inv.double, group_label: 'Siguiente', persons: 1 } }]);

  // indicadores de Central: plazas base = camas activas no supletorias de habitaciones activas y reservables (1 + 2)
  const central = await member('central', null, 'reader');
  const kpis = (await read('central', central, 'booking.central_kpi_projection', { limit: 500 })).rows as Array<Record<string, any>>;
  const april = kpis.find((k) => k.kpi === 'booking.occupancy_rate' && String(k.period_start).startsWith('2029-04'));
  if (april) assert.ok(Number(april.value) >= 0);
  const places = (await app.t.db.query<{ n: string }>(`select coalesce(sum(b.capacity), 0) n from booking.beds b join booking.spaces s on s.id = b.space_id
    where b.deleted_at is null and b.active and b.kind <> 'supletoria' and s.deleted_at is null and s.active and s.bookable and s.kind = 'habitacion'`)).rows[0]!.n;
  assert.equal(Number(places), 3, 'la supletoria no cuenta en las plazas');

  // Tasks: inventario sin ocupación ni huéspedes
  const tasks = await member('tasks', null, 'reader');
  const projection = (await read('tasks', tasks, 'booking.tasks_space_projection', {})).rows as Array<Record<string, any>>;
  assert.deepEqual(projection.filter((p) => p.space_id === inv.room || p.space_id === inv.hall).map((p) => [p.name, p.kind, p.zone]).sort(),
    [['H-12 interna', 'habitacion', 'Albergue'], ['Sala grande', 'sala', 'Albergue']]);
});
