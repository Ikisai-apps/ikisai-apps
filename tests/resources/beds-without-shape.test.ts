/**
 * Recursos · las camas, sin forma en el plano (migración 0818; camas con un solo modelo, VG por Core y Central, 27-10-2026):
 * la posición de cada cama vive en Booking y su forma se deriva de la de su habitación, así que Recursos rechaza colocar
 * una cama en un dibujo. Las habitaciones y las demás estancias se siguen colocando como siempre.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const SPACES = 'resources.spaces';
const PLANS = 'resources.floor_plans';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) =>
  app.call('/api/v1/resources/commands', { token, body: { requestId: `bs-${++seq}`, operations } });
const ok = (res: { status: number; data: any }) => assert.equal(res.status, 200, JSON.stringify(res.data));
const fails = (res: { status: number; data: any }, code?: string) => {
  assert.ok(res.status >= 400, `esperaba un error: ${JSON.stringify(res.data)}`);
  if (code) assert.equal(res.data?.error?.code, code, JSON.stringify(res.data));
};
const rev = async (id: string) =>
  Number((await app.t.db.query<{ revision: string }>(`select revision from resources.spaces where id = $1`, [id])).rows[0]!.revision);

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
});
test.after(async () => { await app.close(); });

test('camas · la habitación se coloca en el plano; la cama no (ni al crearla ni al moverla), pero se sigue creando y editando', async () => {
  const building = uuid(); const plan = uuid(); const room = uuid(); const bed = uuid();
  const altura = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3' and kind = 'altura'`)).rows[0]!.id;
  const shape = { points: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]] };
  const small = { points: [[0.15, 0.15], [0.2, 0.15], [0.2, 0.25], [0.15, 0.25]] };
  ok(await commit([{ op: 'insert', table: SPACES, id: building, fields: { parent_id: altura, kind: 'edificio', name: 'Casa de las camas' } }], app.tokens.owner));
  ok(await commit([{ op: 'insert', table: PLANS, id: plan, fields: { building_id: building, floor: 'Planta baja', width: 1000, height: 700 } }], app.tokens.owner));
  ok(await commit([{ op: 'insert', table: SPACES, id: room, fields: { parent_id: building, kind: 'habitacion', name: 'Hab de las camas', plan_id: plan, plan_shape: shape } }], app.tokens.owner));

  // Crear una cama colocada, no; sin colocar, sí (con su tipo y su habitación).
  fails(await commit([{ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: room, kind: 'cama', name: 'Cama colocada', plan_id: plan, plan_shape: small } }], app.tokens.owner), 'INVALID_FIELDS');
  ok(await commit([{ op: 'insert', table: SPACES, id: bed, fields: { parent_id: room, kind: 'cama', name: 'Cama 1', attributes: { bed_kind: 'litera' } } }], app.tokens.owner));
  // Moverla al plano, tampoco; renombrarla, sí.
  fails(await commit([{ op: 'update', table: SPACES, id: bed, expectedRevision: await rev(bed), fields: { plan_id: plan, plan_shape: small } }], app.tokens.owner), 'INVALID_FIELDS');
  ok(await commit([{ op: 'update', table: SPACES, id: bed, expectedRevision: await rev(bed), fields: { name: 'Cama de la ventana' } }], app.tokens.owner));

  const rows = (await app.t.db.query<{ id: string; plan_id: string | null; plan_shape: unknown }>(`select id, plan_id, plan_shape from resources.spaces where id = any($1)`, [[room, bed]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(room)!.plan_id, plan, 'la habitación sigue en el plano');
  assert.deepEqual([byId.get(bed)!.plan_id, byId.get(bed)!.plan_shape], [null, null], 'la cama, sin forma');
});
