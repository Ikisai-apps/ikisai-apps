/** Booking · R2 paso 1: interruptor, escritura doble con Recursos por `source_refs` y vista previa del enlace. */
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

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `r2-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const row = async (table: string, id: string) => (await app.t.db.query<Record<string, any>>(`select * from ${table} where id = $1`, [id])).rows[0]!;
// Recursos lo escribe Core (owner); en la prueba se siembra directamente, como lo dejó la migración inicial de R1.
async function resource(kind: string, name: string, parent: string | null, refs: string[]) {
  const id = uuid();
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, source_refs) values ($1, $2, $3, $4, $5)`, [id, parent, kind, name, refs]);
  return id;
}

test('R2 · interruptor apagado, escritura doble en los dos sentidos, vista previa y enlace con un lote normal', async () => {
  assert.equal((await app.t.db.query<{ v: string }>(`select booking.spaces_source() v`)).rows[0]!.v, 'booking', 'por defecto, como hoy');

  const room = uuid(); const bed = uuid(); const lonely = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'Hab 3', kind: 'habitacion', zone: 'Albergue' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: room, label: 'Cama 1' } },
    { op: 'insert', table: TABLES.spaces, id: lonely, fields: { name: 'Caseta', kind: 'otro' } },
  ]);
  const altura = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where kind = 'altura' and name = 'Altura 3'`)).rows[0]?.id ?? await resource('altura', 'Altura 3', null, []);
  const albergue = await resource('edificio', 'Albergue de prueba', altura, []);
  const rRoom = await resource('habitacion', 'Hab 3', albergue, [`booking.space:${room}`]);
  const rBed = await resource('cama', 'Cama 1', rRoom, [`booking.bed:${bed}`]);
  const rOnly = await resource('habitacion', 'Hab 9', albergue, []);

  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro R2', status: 'pre_reservada', start_date: '2029-05-01', end_date: '2029-05-03', expected_guests: 3 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);

  // desde Booking (como hoy): el lado de Recursos se rellena solo
  const a1 = uuid();
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: a1, fields: { event_id: event, space_id: room, bed_id: bed, group_label: 'Grupo', persons: 1 } }]);
  assert.deepEqual([(await row('booking.room_assignments', a1)).resource_space_id, (await row('booking.room_assignments', a1)).resource_bed_id], [rRoom, rBed]);

  // desde Recursos (como en R2): el lado de Booking se deduce; un espacio solo de Recursos deja `space_id` vacío
  const a2 = uuid();
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: a2, fields: { event_id: event, resource_space_id: rOnly, group_label: 'Otro grupo', persons: 2 } }]);
  assert.deepEqual([(await row('booking.room_assignments', a2)).space_id, (await row('booking.room_assignments', a2)).resource_space_id], [null, rOnly]);
  const a2rev = Number((await row('booking.room_assignments', a2)).revision);
  await ok([{ op: 'update', table: TABLES.roomAssignments, id: a2, expectedRevision: a2rev, fields: { resource_space_id: rRoom } }]);
  assert.equal((await row('booking.room_assignments', a2)).space_id, room);

  // una referencia a un espacio de Recursos que no existe no entra; la cama tiene que colgar del espacio
  const bad = await commit([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, resource_space_id: uuid(), group_label: 'X', persons: 1 } }]);
  assert.equal(bad.status, 422);
  const mismatch = await commit([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, resource_space_id: rOnly, resource_bed_id: rBed, group_label: 'Y', persons: 1 } }]);
  assert.equal(mismatch.status, 422);

  // datos de antes de R2 (sin lado de Recursos): la vista previa los clasifica y el owner los enlaza con un lote normal
  const old1 = uuid(); const old2 = uuid();
  await ok([
    { op: 'insert', table: TABLES.roomAssignments, id: old1, fields: { event_id: event, space_id: room, group_label: 'Antes', persons: 1 } },
    { op: 'insert', table: TABLES.roomAssignments, id: old2, fields: { event_id: event, space_id: lonely, group_label: 'Sin pareja', persons: 1 } },
  ]);
  // como estaban antes de R2: sin lado de Recursos (sin triggers, que si no lo deducirían)
  await app.t.db.query(`alter table booking.room_assignments disable trigger room_assignments_space_refs`);
  await app.t.db.query(`update booking.room_assignments set resource_space_id = null where id = $1`, [old1]);
  await app.t.db.query(`alter table booking.room_assignments enable trigger room_assignments_space_refs`);
  const owner = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
  const preview = await app.t.rpc('core_read', { p_app: 'booking', p_actor: owner, p_name: 'booking.r2_preview', p_args: {} }) as any;
  assert.equal(preview.source, 'booking');
  assert.deepEqual([preview.counts.por_enlazar, preview.counts.sin_pareja], [1, 1]);
  assert.deepEqual(preview.spaces_without_twin.map((s: any) => s.name), ['Caseta']);
  const pending = preview.rows.find((r: any) => r.status === 'por_enlazar');
  assert.deepEqual([pending.row_id, pending.resource_name], [old1, 'Hab 3']);
  await ok([{ op: 'update', table: pending.tbl, id: pending.row_id, expectedRevision: Number(pending.revision), fields: { resource_space_id: pending.resource_id } }]);
  const after = await app.t.rpc('core_read', { p_app: 'booking', p_actor: owner, p_name: 'booking.r2_preview', p_args: {} }) as any;
  assert.equal(after.counts.por_enlazar ?? 0, 0);

  // solo el owner ve la vista previa y toca el interruptor
  const editor = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'editor')`, [editor]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'booking', p_actor: editor, p_name: 'booking.r2_preview', p_args: {} }));
});
