/**
 * Flow · `flow-api` sobre el `_kit` (primer incremento, sin tablas). La conformidad del núcleo va en `conformance.test.ts`;
 * aquí, lo propio de Flow: health con su release, bootstrap sin tablas, nada que escribir y sin subidas.
 * Requiere `flow` en `core.apps` (migración core del lanzador).
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

test('flow · health público con su app y su release', async () => {
  const health = await app.call('/api/v1/health', { token: null });
  assert.equal(health.status, 200); assert.equal(health.data.app, 'flow'); assert.equal(health.data.release, 'test');
});

test('flow · bootstrap del owner sin tablas; el reader también entra', async () => {
  const boot = await app.call('/api/v1/bootstrap');
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  assert.equal(boot.data.membership.role, 'owner');
  assert.deepEqual(boot.data.tables, []);
  assert.equal((await app.call('/api/v1/bootstrap', { token: app.tokens.reader })).status, 200);
});

test('flow · sin tablas: insert en tabla ajena y call no permitido → 422', async () => {
  const insert = await app.call('/api/v1/commands', { body: { requestId: 'flow-c1', operations: [{ op: 'insert', table: 'central.people', id: crypto.randomUUID(), fields: {} }] } });
  assert.equal(insert.status, 422, JSON.stringify(insert.data));
  const call = await app.call('/api/v1/commands', { body: { requestId: 'flow-c2', operations: [{ op: 'call', procedure: 'invoices.nada', args: {} }] } });
  assert.equal(call.status, 422); assert.equal(call.data.error.code, 'INVALID_OPERATION');
});

test('flow · no declara subidas: el ticket no existe', async () => {
  const res = await app.call('/api/v1/uploads', { body: { filename: 'x.pdf', mime: 'application/pdf', size: 1, sha256: 'a'.repeat(64) } });
  assert.equal(res.status, 404);
});
