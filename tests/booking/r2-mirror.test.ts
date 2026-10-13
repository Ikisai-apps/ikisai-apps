/**
 * Booking · R2 paso 2: con el interruptor en `resources`, `booking.spaces` y `beds` son un espejo de Recursos. La misma
 * caracterización que con la fuente de hoy (`spaces-characterization.shared.ts`) tiene que seguir en verde; además, las
 * camas con plazas fijas y supletorias, los cambios a mano rechazados y la vuelta atrás con el interruptor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';
import { characterize, type Inventory } from './spaces-characterization.shared.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY }),
  });
});
test.after(async () => { await app.close(); });

const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/spaces/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();
/** Ticks hasta que el espejo queda igual que Recursos (los espacios primero, sus camas en la pasada siguiente). */
async function mirror() {
  for (let i = 0; i < 4; i++) if (Number((await tick()).applied ?? 0) === 0) return;
  assert.fail('el espejo no se estabiliza');
}
const q = async <T extends Record<string, any>>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
// Recursos lo escribe Core (owner) y su hook valida; aquí se siembra como quedaría tras la migración de R1 y #479.
async function resource(kind: string, name: string, parent: string | null, attributes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const id = uuid();
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, public_name, position, attributes) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, parent, kind, name, extra.public_name ?? null, extra.position ?? 0, JSON.stringify(attributes)]);
  return id;
}
const altura = async () => (await q<{ id: string }>(`select id from resources.spaces where kind = 'altura' and name = 'Altura 3'`))[0]?.id ?? resource('altura', 'Altura 3', null);
const bedOf = async (resourceId: string, part = 'fija') => (await q<{ id: string }>(`select id from booking.beds where resource_id = $1 and resource_part = $2 and deleted_at is null`, [resourceId, part]))[0]!.id;
const spaceOf = async (resourceId: string) => (await q<{ id: string }>(`select id from booking.spaces where resource_id = $1 and deleted_at is null`, [resourceId]))[0]!.id;

test('R2 · la caracterización sigue igual con Recursos como fuente (espejo por el tick)', async () => {
  await app.t.db.query(`update booking.module_settings set spaces_source = 'resources'`);
  await characterize(app, async (): Promise<Inventory> => {
    const albergue = await resource('edificio', 'Albergue', await altura());
    const room = await resource('habitacion', 'H-12 interna', albergue, { bookable: true, en_suite: true, accessible: true }, { public_name: 'Habitación Encina' });
    const hall = await resource('sala', 'Sala grande', albergue, { capacity: 40 }, { public_name: 'Sala del Roble' });
    const single = await resource('cama', 'Cama 1', room, { bed_kind: 'individual', capacity: 1 }, { position: 1 });
    const double = await resource('cama', 'Cama 2', room, { bed_kind: 'doble', capacity: 2 }, { position: 2 });
    const extra = await resource('cama', 'Supletoria', room, { bed_kind: 'individual', capacity: 0, extra_capacity: 1 }, { position: 3 });
    await mirror();
    return { room: await spaceOf(room), hall: await spaceOf(hall), single: await bedOf(single), double: await bedOf(double), extra: await bedOf(extra, 'supletoria') };
  });
});

test('R2 · camas con plazas fijas y supletorias, cambios a mano rechazados y vuelta atrás con el interruptor', async () => {
  await app.t.db.query(`update booking.module_settings set spaces_source = 'resources'`);
  const albergue = await resource('edificio', 'Albergue B', await altura(), { bookable: true, capacity: 56 });
  const hab = await resource('habitacion', 'Hab 4', albergue, { bookable: true });
  const partida = await resource('cama', 'Litera 1', hab, { bed_kind: 'litera', capacity: 1, extra_capacity: 1 });
  const salaMulti = await resource('sala', 'Sala multiusos', albergue, {});
  const sofa = await resource('cama', 'Sofá 1', salaMulti, { bed_kind: 'sofa_cama', capacity: 0, extra_capacity: 1 });
  await mirror();

  // el edificio reservable entero también está (alojamiento «por edificio», como el Albergue de hoy)
  assert.deepEqual((await q(`select kind, bookable, capacity from booking.spaces where resource_id = $1`, [albergue]))[0], { kind: 'otro', bookable: true, capacity: 56 });
  // litera «partida»: abajo fija (litera, 1 plaza) y arriba supletoria (1, se cobra como extra)
  assert.deepEqual(await q(`select label, kind, capacity, resource_part from booking.beds where resource_id = $1 and deleted_at is null order by resource_part`, [partida]),
    [{ label: 'Litera 1', kind: 'litera', capacity: 1, resource_part: 'fija' }, { label: 'Litera 1 (supletoria)', kind: 'supletoria', capacity: 1, resource_part: 'supletoria' }]);
  // sofá cama de base 0 en una sala: solo supletoria
  assert.deepEqual(await q(`select label, kind from booking.beds where resource_id = $1 and deleted_at is null`, [sofa]), [{ label: 'Sofá 1', kind: 'supletoria' }]);

  // a mano en Booking no se cambia nada de lo que viene de Recursos (ni se crea nada suelto)
  const habB = await spaceOf(hab);
  const rev = Number((await q<{ revision: string }>(`select revision from booking.spaces where id = $1`, [habB]))[0]!.revision);
  const edit = await app.call('/api/v1/commands', { body: { requestId: `m-${uuid()}`, operations: [{ op: 'update', table: TABLES.spaces, id: habB, expectedRevision: rev, fields: { name: 'Otro nombre' } }] } });
  assert.equal(edit.data?.error?.code, 'SPACES_IN_RESOURCES');
  const loose = await app.call('/api/v1/commands', { body: { requestId: `m-${uuid()}`, operations: [{ op: 'insert', table: TABLES.spaces, id: uuid(), fields: { name: 'Suelta', kind: 'sala' } }] } });
  assert.equal(loose.data?.error?.code, 'SPACES_IN_RESOURCES');

  // cambios en Recursos llegan con el tick: renombrar, quitar la supletoria de la litera, borrar el sofá
  await app.t.db.query(`update resources.spaces set name = 'Hab 4 bis', revision = revision + 1 where id = $1`, [hab]);
  await app.t.db.query(`update resources.spaces set attributes = attributes - 'extra_capacity' where id = $1`, [partida]);
  await app.t.db.query(`update resources.spaces set deleted_at = now() where id = $1`, [sofa]);
  assert.equal((await q<{ v: boolean }>(`select booking.spaces_mirror_has_work() v`))[0]!.v, true);
  await mirror();
  assert.equal((await q<{ name: string }>(`select name from booking.spaces where id = $1`, [habB]))[0]!.name, 'Hab 4 bis');
  assert.deepEqual((await q(`select resource_part from booking.beds where resource_id = $1 and deleted_at is null`, [partida])).map((r) => r.resource_part), ['fija']);
  assert.equal((await q(`select 1 from booking.beds where resource_id = $1 and deleted_at is null`, [sofa])).length, 0);

  // la app del owner ve lo pendiente con la misma planificación (vacío ahora)
  const owner = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
  assert.deepEqual((await app.t.rpc('core_read', { p_app: 'booking', p_actor: owner, p_name: 'booking.spaces_mirror_pending', p_args: {} }) as any).operations, []);

  // vuelta atrás: con el interruptor en `booking`, se vuelve a editar en Booking y el tick no hace nada
  await app.t.db.query(`update booking.module_settings set spaces_source = 'booking'`);
  const rev2 = Number((await q<{ revision: string }>(`select revision from booking.spaces where id = $1`, [habB]))[0]!.revision);
  const back = await app.call('/api/v1/commands', { body: { requestId: `m-${uuid()}`, operations: [{ op: 'update', table: TABLES.spaces, id: habB, expectedRevision: rev2, fields: { notes: 'editado en Booking' } }] } });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(Number((await tick()).applied ?? 0), 0);
});
