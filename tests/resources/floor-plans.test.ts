/** Recursos · mapa de zonas, bloque B (migración 0808, MUELA-024): dibujos por planta y formas de las estancias. */
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
  app.call('/api/v1/resources/commands', { token, body: { requestId: `fp-${++seq}`, operations } });
const altura = async (n: number) =>
  (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = $1`, [`Altura ${n}`])).rows[0]!.id;
const square = { points: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.3], [0.1, 0.3]] };

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
});
test.after(async () => { await app.close(); });

test('mapa · el owner sube un dibujo por planta y coloca una estancia; los demás leen y no colocan', async () => {
  const building = uuid();
  const b = await commit([{ op: 'insert', table: SPACES, id: building, fields: { parent_id: await altura(3), kind: 'edificio', name: 'Albergue del mapa' } }], app.tokens.owner);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const plan = uuid();
  const created = await commit([{ op: 'insert', table: PLANS, id: plan, fields: { building_id: building, floor: 'Planta baja', width: 1200, height: 800 } }], app.tokens.owner);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  // El editor no gestiona dibujos.
  assert.equal((await commit([{ op: 'insert', table: PLANS, id: uuid(), fields: { building_id: building, floor: 'Primera', width: 10, height: 10 } }], app.tokens.editor)).status, 403);
  // Una planta por edificio, sin repetir.
  assert.equal((await commit([{ op: 'insert', table: PLANS, id: uuid(), fields: { building_id: building, floor: 'planta baja ', width: 10, height: 10 } }], app.tokens.owner)).status >= 400, true);

  const room = uuid();
  const ins = await commit([{ op: 'insert', table: SPACES, id: room, fields: { parent_id: building, kind: 'sala', name: 'Sala del mapa' } }], app.tokens.owner);
  assert.equal(ins.status, 200, JSON.stringify(ins.data));
  const rev = async () => (await app.t.db.query<{ revision: string }>(`select revision from resources.spaces where id = $1`, [room])).rows[0]!.revision;

  const byEditor = await commit([{ op: 'update', table: SPACES, id: room, expectedRevision: Number(await rev()), fields: { plan_id: plan, plan_shape: square } }], app.tokens.editor);
  assert.equal(byEditor.status, 403, 'colocar es del owner');
  const byOwner = await commit([{ op: 'update', table: SPACES, id: room, expectedRevision: Number(await rev()), fields: { plan_id: plan, plan_shape: square } }], app.tokens.owner);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.data));

  // El editor sigue cambiando el nombre de una estancia colocada.
  assert.equal((await commit([{ op: 'update', table: SPACES, id: room, expectedRevision: Number(await rev()), fields: { notes: 'con proyector' } }], app.tokens.editor)).status, 200);

  // Formas inválidas: fuera de 0..1 o con menos de 3 puntos.
  const bad = await commit([{ op: 'update', table: SPACES, id: room, expectedRevision: Number(await rev()), fields: { plan_shape: { points: [[0, 0], [2, 0], [0, 1]] } } }], app.tokens.owner);
  assert.ok(bad.status >= 400);
  const few = await commit([{ op: 'update', table: SPACES, id: room, expectedRevision: Number(await rev()), fields: { plan_shape: { points: [[0, 0], [1, 1]] } } }], app.tokens.owner);
  assert.ok(few.status >= 400);

  // El lector lee el dibujo y la forma en su snapshot.
  const snap = await app.call(`/api/v1/resources/snapshot?tables=${PLANS},${SPACES}`, { token: app.tokens.reader });
  assert.equal(snap.status, 200);
  const plans = snap.data.tables.find((t: any) => t.table === PLANS).rows;
  assert.equal(plans[0].floor, 'Planta baja');
  const placed = snap.data.tables.find((t: any) => t.table === SPACES).rows.find((r: any) => r.id === room);
  assert.deepEqual(placed.plan_shape, square);

  // No se borra un dibujo con estancias encima.
  const planRev = Number((await app.t.db.query<{ revision: string }>(`select revision from resources.floor_plans where id = $1`, [plan])).rows[0]!.revision);
  assert.ok((await commit([{ op: 'delete', table: PLANS, id: plan, expectedRevision: planRev }], app.tokens.owner)).status >= 400);
});

test('mapa · subidas del módulo: solo imágenes al bucket de planos', async () => {
  const body = (mime: string) => ({ filename: 'plano.' + mime.split('/')[1], mime, size: 1000, sha256: 'a'.repeat(64) });
  const pdf = await app.call('/api/v1/resources/uploads', { token: app.tokens.owner, body: body('application/pdf') });
  assert.ok(pdf.status >= 400, 'un PDF no vale como dibujo');
  const svg = await app.call('/api/v1/resources/uploads', { token: app.tokens.owner, body: body('image/svg+xml') });
  assert.equal(svg.status, 200, JSON.stringify(svg.data));
  assert.equal((await app.call('/api/v1/resources/uploads', { token: app.tokens.reader, body: body('image/png') })).status, 403);
});

test('mapa · el portal de Guests lee dibujos y formas, sin datos internos; otra app, no', async () => {
  const guest = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [guest]);
  const out = await app.t.rpc('core_read', { p_app: 'guests', p_actor: guest, p_name: 'resources.portal_plans', p_args: {} }) as any;
  assert.ok(out.plans.some((p: any) => p.floor === 'Planta baja' && p.width === 1200));
  const placed = out.spaces.find((s: any) => s.name === 'Sala del mapa');
  assert.ok(placed?.planShape?.points?.length === 4);
  assert.equal(JSON.stringify(out).includes('con proyector'), false, 'sin notas');
  assert.equal('notes' in placed, false);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'booking', p_actor: app.users.owner, p_name: 'resources.portal_plans', p_args: {} }));
});
