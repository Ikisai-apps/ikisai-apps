/**
 * Flow · ámbito del dispositivo (fl-22), sobre PGlite: con `X-Ikisai-Scope: {"projects": [...]}` el espejo solo baja los datos
 * de esos flujos, también para el owner; la lista de flujos se ve entera para poder elegir; nunca amplía los ámbitos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
let app: TestApp;
let v2 = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  v2 = crypto.randomUUID();
  const r = await app.call('/api/v1/commands', { body: { requestId: `ds-${v2}`, operations: [{ op: 'call', procedure: PROCEDURES.newVersion, args: { source_project_id: V1, project_id: v2 } }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { await app.close(); });

const snapshot = async (table: string, scope?: unknown, token = app.tokens.owner) => {
  const r = await app.call(`/api/v1/snapshot?tables=${table}`, { token, headers: scope ? { 'X-Ikisai-Scope': JSON.stringify(scope) } : {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.tables[0].rows as any[];
};

test('ámbito del dispositivo · solo baja lo de los flujos elegidos (también el owner); la lista de flujos, entera', async () => {
  const all = await snapshot(TABLES.columns);
  assert.ok(all.some((c) => c.project_id === V1) && all.some((c) => c.project_id === v2));
  const only = await snapshot(TABLES.columns, { projects: [v2] });
  assert.ok(only.length > 0 && only.every((c) => c.project_id === v2));
  const projects = await snapshot(TABLES.projects, { projects: [v2] });
  assert.ok(projects.some((p) => p.id === V1) && projects.some((p) => p.id === v2));
});

test('ámbito del dispositivo · no amplía: quien solo ve un flujo no baja otro aunque lo pida', async () => {
  await app.t.db.query("update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($1::text)) where app = 'flow' and user_id = $2", [v2, app.users.editor]);
  const rows = await snapshot(TABLES.columns, { projects: [V1, v2] }, app.tokens.editor);
  assert.ok(rows.length > 0 && rows.every((c) => c.project_id === v2));
});
