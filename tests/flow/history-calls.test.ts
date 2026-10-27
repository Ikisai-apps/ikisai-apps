/**
 * Flow · historial (FL3, gancho `visibleCall` del kit #885), sobre PGlite: las llamadas a procedimientos, con sus
 * argumentos y resultado, solo las ven el owner y quien las hizo. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const AGUA = '0f10a000-0000-4000-8000-000000000301';
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  await app.t.db.query(`update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($2::text)) where app = 'flow' and user_id = $1`, [app.users.editor, V1]);
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[], token: string) {
  const r = await app.call('/api/v1/commands', { token, body: { requestId: `h-${++seq}-${crypto.randomUUID()}`, operations } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result;
}
async function paidOrder(token: string): Promise<void> {
  const id = crypto.randomUUID();
  await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: V1, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: crypto.randomUUID(), fields: { order_id: id, product_id: AGUA, quantity: 1 } }], token);
  const snap = await app.call(`/api/v1/snapshot?tables=${TABLES.orders}`, { token });
  const order = snap.data.tables[0].rows.find((o: any) => o.id === id);
  await ok([{ op: 'call', procedure: PROCEDURES.confirmPayment, args: { order_id: id, method: 'cash', expected_revision: order.revision } }], token);
}
const calls = async (token: string) => {
  const res = await app.call('/api/v1/history?limit=200', { token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return (res.data.items as any[]).flatMap((i) => i.changes.filter((c: any) => c.op === 'call').map((c: any) => ({ ...c, actorId: i.actorId })));
};

test('historial · los call de otros no llegan al editor; los suyos sí; el owner los ve todos', async () => {
  await paidOrder(app.tokens.owner);
  await paidOrder(app.tokens.editor);
  const editor = await calls(app.tokens.editor);
  assert.ok(editor.length >= 1);
  assert.ok(editor.every((c) => c.actorId === app.users.editor), JSON.stringify(editor.map((c) => c.actorId)));
  const owner = await calls(app.tokens.owner);
  assert.ok(owner.some((c) => c.actorId === app.users.owner) && owner.some((c) => c.actorId === app.users.editor));
});
