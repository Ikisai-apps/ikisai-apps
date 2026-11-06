/**
 * Booking · usos de los espacios (1431, booking-U1): el espejo copia `resources.spaces.uses` en `booking.spaces.uses`
 * (también lo que ya existía, en la primera pasada) y la ficha enseña los de alojamiento, con camas o marcados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { lodgingResourceIds, lodgingSpaceIds, showsResource } from '../../apps/booking/src/app/lodgingSpaces.ts';

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
async function mirror() {
  for (let i = 0; i < 4; i++) if (Number((await tick()).applied ?? 0) === 0) return;
  assert.fail('el espejo no se estabiliza');
}
const q = async <T extends Record<string, any>>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
async function resource(kind: string, name: string, parent: string | null, uses: string[] = []) {
  const id = uuid();
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, position, attributes, uses) values ($1, $2, $3, $4, 0, '{}'::jsonb, $5)`, [id, parent, kind, name, uses]);
  return id;
}

test('espejo: copia los usos, también los puestos sin lote (como el relleno de Recursos 0825)', async () => {
  await app.t.db.query(`update booking.module_settings set spaces_source = 'resources'`);
  const altura = await resource('altura', 'Altura usos', null);
  const casa = await resource('edificio', 'Casa usos', altura);
  const hab = await resource('habitacion', 'Hab usos', casa, ['alojamiento']);
  const sala = await resource('sala', 'Sala usos', casa, ['eventos', 'trabajo']);
  await mirror();
  const uses = async (id: string) => (await q<{ uses: string[] }>(`select uses from booking.spaces where resource_id = $1 and deleted_at is null`, [id]))[0]!.uses;
  assert.deepEqual(await uses(hab), ['alojamiento']);
  assert.deepEqual(await uses(sala), ['eventos', 'trabajo']);
  // Central cambia el uso directamente en Recursos (sin lote): el tick siguiente lo copia
  await app.t.db.query(`update resources.spaces set uses = '{alojamiento,eventos}' where id = $1`, [sala]);
  await mirror();
  assert.deepEqual(await uses(sala), ['alojamiento', 'eventos']);
});

test('qué se enseña: alojamiento, con camas o marcado en el evento; la cama va con su habitación', () => {
  const spaces = [
    { id: 'h', resource_id: 'rh', uses: ['alojamiento'], deleted_at: null },
    { id: 's', resource_id: 'rs', uses: ['eventos'], deleted_at: null },
    { id: 'c', resource_id: 'rc', uses: [], deleted_at: null },
    { id: 'm', resource_id: 'rm', uses: ['trabajo'], deleted_at: null },
    { id: 'x', resource_id: 'rx', uses: ['alojamiento'], deleted_at: '2036-01-01T00:00:00Z' },
  ];
  const beds = [{ id: 'b1', space_id: 'c', deleted_at: null }, { id: 'b2', space_id: 's', deleted_at: '2036-01-01T00:00:00Z' }];
  assert.deepEqual([...lodgingSpaceIds(spaces, beds)].sort(), ['c', 'h']);
  assert.deepEqual([...lodgingSpaceIds(spaces, beds, ['m'])].sort(), ['c', 'h', 'm']);
  const allowed = lodgingResourceIds(spaces, beds);
  assert.deepEqual([...allowed].sort(), ['rc', 'rh']);
  assert.equal(showsResource(allowed, { id: 'rh', parentId: 'casa', kind: 'habitacion' }), true);
  assert.equal(showsResource(allowed, { id: 'rs', parentId: 'casa', kind: 'sala' }), false);
  assert.equal(showsResource(allowed, { id: 'cama1', parentId: 'rh', kind: 'cama' }), true);
  assert.equal(showsResource(allowed, { id: 'cama2', parentId: 'rs', kind: 'cama' }), false);
});
