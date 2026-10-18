/** Sugerencias con ámbitos (hook `suggestionVisible`): quien revisa solo ve, previsualiza y decide lo que su app le deja ver. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const NOTES = 'tasks.sv_notes';
let app: TestApp;
let seq = 0;
const rid = () => `sv-${++seq}`;
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
// Regla de prueba: un editor con ámbitos `{area}` solo ve las notas de su área; sin ámbitos, todas.
const areaOf = (s: any) => s.operations?.[0]?.fields?.area as string | undefined;

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api',
    hooks: { suggestionVisible: (s, ctx) => { const area = (ctx.membership.scopes as any)?.area; return !area || areaOf(s) === area; } } }) });
  await q(`create table tasks.sv_notes (id uuid primary key, revision bigint not null default 1, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz, text text not null, area text not null)`);
  await q(`select core.register_table('tasks', 'tasks', 'sv_notes', array['text','area'], '{reader,outsider,editor,owner}', '{editor,owner}')`);
  await q(`select core.register_suggestion_kind('tasks', 'sv', 'Nota', array['${NOTES}'], array['insert'])`);
});
test.after(async () => { await app.close(); });

test('sugerencias con ámbitos · el editor de un área no ve, previsualiza ni decide las de otra; la propietaria, todas', async () => {
  const author = await app.t.createUser();
  await q(`select core.apply_house_level($1, 'outsider')`, [author]);
  const token = app.supabase.tokenFor(author);
  const suggest = async (area: string) => (await app.call('/api/v1/suggestions', { token, body: { requestId: rid(), kind: 'sv', summary: area,
    operations: [{ op: 'insert', table: NOTES, id: crypto.randomUUID(), fields: { text: 'x', area } }] } })).data.id as string;
  const mine = await suggest('A'); const other = await suggest('B');
  const scoped = await app.t.createUser();
  await q(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'editor', '{"area":"A"}'::jsonb)`, [scoped]);
  const ed = app.supabase.tokenFor(scoped);

  const pending = await app.call('/api/v1/suggestions?scope=pending', { token: ed });
  assert.equal(pending.status, 200, JSON.stringify(pending.data));
  assert.deepEqual(pending.data.items.map((s: any) => s.id), [mine]);
  assert.equal(pending.data.pendingCount, 1, 'el contador también');
  assert.equal((await app.call(`/api/v1/suggestions/${other}/preview`, { token: ed, body: {} })).status, 404);
  assert.equal((await app.call(`/api/v1/suggestions/${other}/approve`, { token: ed, body: {} })).status, 404);
  assert.equal((await app.call(`/api/v1/suggestions/${other}/reject`, { token: ed, body: {} })).status, 404);
  // Corregir la suya para meterla en otra área tampoco.
  const moved = await app.call(`/api/v1/suggestions/${mine}/approve`, { token: ed, body: { operations: [{ op: 'insert', table: NOTES, id: crypto.randomUUID(), fields: { text: 'x', area: 'B' } }] } });
  assert.equal(moved.status, 404);
  // (Aprobar la suya lo bloquearía el hook SQL de Tasks por la forma de estos ámbitos de prueba; la descarta, que no escribe.)
  const ok = await app.call(`/api/v1/suggestions/${mine}/reject`, { token: ed, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // La propietaria (sin ámbitos) ve y decide la otra.
  assert.equal((await app.call('/api/v1/suggestions?scope=pending', { token: app.tokens.owner })).data.pendingCount, 1);
  assert.equal((await app.call(`/api/v1/suggestions/${other}/reject`, { token: app.tokens.owner, body: {} })).status, 200);
});
