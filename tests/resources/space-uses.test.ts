/**
 * Recursos · los usos generales de cada espacio (migración 0825; VG, 06-11): lista cerrada y sin repetir, varios por
 * espacio; solo los pone o cambia Central (o lo que va sin app). Las demás apps los leen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://central.ikisai.com';
const SPACES = 'resources.spaces';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let building = ''; let room = '';
/** Un lote del módulo Recursos confirmado desde la Edge de `client` (lo que hace el kit con su app), o sin app (null). */
const commitAs = (client: string | null, operations: unknown[]) => app.t.db.query(
  `select public.core_commit('resources', $1, $2, 'x', null, $3::jsonb, null, 'browser', $4) as r`,
  [app.users.owner, `su-${++seq}`, JSON.stringify(operations), client]);
const usesOf = async (id: string) => (await app.t.db.query<{ uses: string[] }>(`select uses from resources.spaces where id = $1`, [id])).rows[0]!.uses;
const revisionOf = async (id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from resources.spaces where id = $1`, [id])).rows[0]!.revision);
const setUses = async (client: string | null, id: string, uses: string[]) =>
  commitAs(client, [{ op: 'update', table: SPACES, id, expectedRevision: await revisionOf(id), fields: { uses } }]);

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'central', slug: 'central-api' }),
  });
  const altura = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3' and kind = 'altura'`)).rows[0]!.id;
  building = uuid(); room = uuid();
  await commitAs('central', [
    { op: 'insert', table: SPACES, id: building, fields: { parent_id: altura, kind: 'edificio', name: 'Casa de los usos' } },
    { op: 'insert', table: SPACES, id: room, fields: { parent_id: building, kind: 'habitacion', name: 'Hab de los usos' } },
  ]);
});
test.after(async () => { await app.close(); });

test('usos · por defecto ninguno; Central pone varios de la lista, sin repetir ni claves de fuera', async () => {
  assert.deepEqual(await usesOf(room), []);
  await setUses('central', room, ['alojamiento', 'trabajo']);
  assert.deepEqual(await usesOf(room), ['alojamiento', 'trabajo']);
  await assert.rejects(setUses('central', room, ['alojamiento', 'alojamiento']));
  await assert.rejects(setUses('central', room, ['piscina']));
  assert.deepEqual(await usesOf(room), ['alojamiento', 'trabajo']);
  // Sin app (una carga), también.
  await setUses(null, building, ['eventos', 'exterior']);
  assert.deepEqual(await usesOf(building), ['eventos', 'exterior']);
});

test('usos · las demás apps no los ponen ni los cambian; Booking sigue añadiendo camas', async () => {
  for (const client of ['booking', 'tasks', 'food']) {
    await assert.rejects(setUses(client, room, ['ocio']), /FORBIDDEN/, client);
  }
  await assert.rejects(commitAs('booking', [{ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: room, kind: 'cama', name: 'Cama con usos', uses: ['alojamiento'] } }]), /FORBIDDEN/);
  const bed = uuid();
  await commitAs('booking', [{ op: 'insert', table: SPACES, id: bed, fields: { parent_id: room, kind: 'cama', name: 'Cama sin usos' } }]);
  assert.deepEqual(await usesOf(bed), []);
  assert.deepEqual(await usesOf(room), ['alojamiento', 'trabajo']);
});
