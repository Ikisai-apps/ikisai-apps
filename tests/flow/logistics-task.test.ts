/**
 * Flow · capacidad «Crear tarea de Logística» (FL7, migración 0924), sobre PGlite: editor u owner, proyecto en su ámbito,
 * id aleatorio e idempotente por persona y requestId. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
let app: TestApp;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  // El editor tiene en su ámbito el flujo de la barra (como lo da Central), no los demás.
  await app.t.db.query(`update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($2::text)) where app = 'flow' and user_id = $1`, [app.users.editor, V1]);
});
test.after(async () => { await app.close(); });

const task = (token: string, body: Record<string, unknown>) => app.call('/api/v1/logistics-task', { token, body });
async function rows(table: string): Promise<any[]> { return (await app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows; }

test('logística · el editor crea la tarea en su flujo; repetir devuelve la misma', async () => {
  const body = { requestId: 'aviso-hielo', project_id: V1, label: 'Llega el hielo', priority: true };
  const first = await task(app.tokens.editor, body);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const again = await task(app.tokens.editor, body);
  assert.equal(again.data.id, first.data.id); assert.equal(again.data.replayed, true);
  assert.ok((await rows(TABLES.units)).some((u) => u.id === first.data.id && u.column_key === 'logistics' && u.priority));
  // Otra persona con el mismo requestId no choca: su tarea es otra.
  const owner = await task(app.tokens.owner, body);
  assert.equal(owner.status, 200, JSON.stringify(owner.data)); assert.notEqual(owner.data.id, first.data.id);
});

test('logística · fuera de su ámbito, PROJECT_OUT_OF_SCOPE; sin rol de edición, FORBIDDEN', async () => {
  const other = crypto.randomUUID();
  const r = await app.call('/api/v1/commands', { body: { requestId: `lg-${other}`, operations: [{ op: 'insert', table: TABLES.projects, id: other, fields: { name: 'Otro evento', starts_on: '2026-12-01', ends_on: '2026-12-02' } }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const out = await task(app.tokens.editor, { requestId: 'fuera', project_id: other, label: 'No debería' });
  assert.equal(out.status, 403); assert.equal(out.data.error.code, 'PROJECT_OUT_OF_SCOPE');
  const ghost = await task(app.tokens.owner, { requestId: 'nada', project_id: crypto.randomUUID(), label: 'No existe' });
  assert.equal(ghost.status, 403);
  const reader = await task(app.tokens.reader, { requestId: 'lector', project_id: V1, label: 'No debería' });
  assert.equal(reader.status, 403);
  assert.ok(!(await rows(TABLES.units)).some((u) => u.label === 'No debería' || u.label === 'No existe'));
});
