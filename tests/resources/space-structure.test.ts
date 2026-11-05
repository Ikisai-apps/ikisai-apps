/**
 * Recursos · los espacios se gestionan desde Central (migración 0824, R7; vg-52 y R-8 c de VG): según la app cliente del
 * lote (`core.client_app()`, núcleo 0119), Central y lo que va fuera de una app (sistema, carga) cambian la estructura;
 * Booking solo añade camas en habitaciones que ya existían; Tasks, solo los espacios que derivan de sus etiquetas o zonas;
 * las demás, nada de estructura.
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
  [app.users.owner, `ss-${++seq}`, JSON.stringify(operations), client]);
const space = (fields: Record<string, unknown>) => ({ op: 'insert', table: SPACES, id: uuid(), fields });

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'central', slug: 'central-api' }),
  });
  const altura = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3' and kind = 'altura'`)).rows[0]!.id;
  building = uuid(); room = uuid();
  await commitAs('central', [
    { op: 'insert', table: SPACES, id: building, fields: { parent_id: altura, kind: 'edificio', name: 'Casa de la estructura' } },
    { op: 'insert', table: SPACES, id: room, fields: { parent_id: building, kind: 'habitacion', name: 'Hab de la estructura' } },
  ]);
});
test.after(async () => { await app.close(); });

test('estructura · Booking solo añade camas a una habitación que ya existía', async () => {
  await commitAs('booking', [space({ parent_id: room, kind: 'cama', name: 'Cama nueva' })]);
  await assert.rejects(commitAs('booking', [space({ parent_id: building, kind: 'sala', name: 'Sala de Booking' })]), /FORBIDDEN/);
  const rev = Number((await app.t.db.query<{ revision: string }>(`select revision from resources.spaces where id = $1`, [room])).rows[0]!.revision);
  await assert.rejects(commitAs('booking', [{ op: 'update', table: SPACES, id: room, expectedRevision: rev, fields: { name: 'Otro nombre' } }]), /FORBIDDEN/);
  // Una habitación nueva y su cama en el mismo lote, tampoco.
  const fresh = uuid();
  await assert.rejects(commitAs('booking', [
    { op: 'insert', table: SPACES, id: fresh, fields: { parent_id: building, kind: 'habitacion', name: 'Hab nueva' } },
    space({ parent_id: fresh, kind: 'cama', name: 'Cama de la nueva' }),
  ]), /FORBIDDEN/);
});

test('estructura · Tasks solo con sus derivados; otra app, nada; Central y sin app, todo', async () => {
  await commitAs('tasks', [space({ parent_id: building, kind: 'sala', name: 'Zona de Tasks', source_refs: ['tasks.label:zona-1'] })]);
  await assert.rejects(commitAs('tasks', [space({ parent_id: building, kind: 'sala', name: 'Sala suelta' })]), /FORBIDDEN/);
  await assert.rejects(commitAs('food', [space({ parent_id: building, kind: 'sala', name: 'Sala de Food' })]), /FORBIDDEN/);
  await commitAs('central', [space({ parent_id: building, kind: 'sala', name: 'Sala de Central' })]);
  await commitAs(null, [space({ parent_id: building, kind: 'sala', name: 'Sala de la carga' })]);
  const names = (await app.t.db.query<{ name: string }>(`select name from resources.spaces where parent_id = $1 and deleted_at is null order by name`, [building])).rows.map((r) => r.name);
  assert.deepEqual(names, ['Hab de la estructura', 'Sala de Central', 'Sala de la carga', 'Zona de Tasks']);
});
