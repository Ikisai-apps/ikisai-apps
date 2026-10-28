/**
 * Flow · cobertura de anclajes y reglas (migración 0946), sobre PGlite: por anclaje, los recorridos publicados y pasos que lo
 * usan; las reglas de Flow con lo que observan y escriben; filtro por app; Central lo lee. Solo metadatos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
let app: TestApp;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

test('cobertura · anclajes de Booking que usan los recorridos, y las reglas que tocan Booking', async () => {
  const r = await app.call('/api/v1/anchor-coverage', { body: { app: 'booking' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ids = r.data.anchors.map((a: any) => a.anchor_id);
  assert.ok(ids.includes('booking.recepcion.cobrar'), JSON.stringify(ids));
  assert.ok(r.data.anchors.every((a: any) => a.app === 'booking'));
  const cobrar = r.data.anchors.find((a: any) => a.anchor_id === 'booking.recepcion.cobrar');
  assert.equal(cobrar.uses[0].flow_key, 'alojamiento_recepcion'); assert.equal(cobrar.uses[0].stage, 3);
  assert.deepEqual(r.data.rules.map((x: any) => x.id), ['flow.checkin']);
  assert.ok(!JSON.stringify(r.data).match(/arrived_at.*\d{4}-\d{2}/)); // metadatos, sin valores
});

test('cobertura · sin app, todo; Central la lee con su rol', async () => {
  const all = (await app.call('/api/v1/anchor-coverage', { body: {} })).data;
  assert.ok(all.rules.length >= 6); assert.ok(all.anchors.length >= 4);
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner') on conflict do nothing`, [app.users.owner]);
  const out = (await app.t.db.query<{ out: any }>(`select core.read('central', $1, 'flow.anchor_coverage_read', '{"app": "food"}'::jsonb) as out`, [app.users.owner])).rows[0]!.out;
  assert.deepEqual(out.rules.map((x: any) => x.id).sort(), ['flow.cierre_food', 'flow.prevision_ingredientes']);
});
