/** El lector vota (migración 0099; tanda 27, P10): escribe solo donde la tabla o el procedimiento lo abren a propósito. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const VOTES = 'tasks.rv_votes';
const NOTES = 'tasks.rv_notes';
let app: TestApp;
let seq = 0;
const rid = () => `rv-${++seq}`;
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const commit = (token: string, operations: unknown[]) => app.call('/api/v1/commands', { token, body: { requestId: rid(), operations } });
const insert = (table: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id: crypto.randomUUID(), fields });

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
  const cols = `id uuid primary key, revision bigint not null default 1, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz`;
  await q(`create table tasks.rv_votes (${cols}, vote text not null)`);
  await q(`create table tasks.rv_notes (${cols}, text text not null)`);
  await q(`select core.register_table('tasks', 'tasks', 'rv_votes', array['vote'], '{reader,editor,owner}', '{reader,editor,owner}')`);
  await q(`select core.register_table('tasks', 'tasks', 'rv_notes', array['text'], '{reader,editor,owner}', '{editor,owner}')`);
  await q(`create function tasks.rv_echo(p jsonb) returns jsonb language sql as 'select jsonb_build_object(''role'', p->>''role'')'`);
  await q(`select core.allow_procedure('tasks', 'tasks.rv_echo')`);
});
test.after(async () => { await app.close(); });

test('lector · escribe en la tabla que lo abre y en ninguna otra; un lote mixto no aplica nada', async () => {
  const ok = await commit(app.tokens.reader, [insert(VOTES, { vote: 'si' })]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await q(`select count(*)::int as n from tasks.rv_votes where updated_by = $1`, [app.users.reader]))[0].n, 1);

  const denied = await commit(app.tokens.reader, [insert(NOTES, { text: 'x' })]);
  assert.equal(denied.status, 403, JSON.stringify(denied.data));

  const mixed = await commit(app.tokens.reader, [insert(VOTES, { vote: 'no' }), insert(NOTES, { text: 'y' })]);
  assert.equal(mixed.status, 403);
  assert.equal((await q(`select count(*)::int as n from tasks.rv_votes where vote = 'no'`))[0].n, 0, 'el lote mixto se deshace entero');

  // El editor, como siempre.
  assert.equal((await commit(app.tokens.editor, [insert(NOTES, { text: 'z' })])).status, 200);
});

test('lector · procedimientos solo si la app los abre con allow_reader_procedure', async () => {
  const call = () => commit(app.tokens.reader, [{ op: 'call', procedure: 'tasks.rv_echo', args: {} }]);
  assert.equal((await call()).status, 403);
  await q(`select core.allow_reader_procedure('tasks', 'tasks.rv_echo')`);
  const ok = await call();
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.results[0].result.role, 'reader');
  await assert.rejects(q(`select core.allow_reader_procedure('tasks', 'tasks.nada')`), /PROCEDURE_NOT_ALLOWED/);
});

test('ensayo (commit_preview) · el lector ensaya lo que puede escribir', async () => {
  const ok = (await q(`select core.commit_preview('tasks', $1, $2::jsonb) as r`, [app.users.reader, JSON.stringify([insert(VOTES, { vote: 'si' })])]))[0].r;
  assert.equal(ok.changes[0].after.vote, 'si');
  await assert.rejects(q(`select core.commit_preview('tasks', $1, $2::jsonb)`, [app.users.reader, JSON.stringify([insert(NOTES, { text: 'x' })])]), /FORBIDDEN/);
});

test('sugerencias · ámbito vote: el lector ve las pendientes sin quién propone; el editor, con nombre; el outsider, no', async () => {
  await q(`select core.register_suggestion_kind('tasks', 'rv_nota', 'Nota', array['${NOTES}'], array['insert'], '{}', '{outsider}')`);
  const author = await app.t.createUser();
  await q(`select core.apply_house_level($1, 'outsider')`, [author]);
  const token = app.supabase.tokenFor(author);
  const made = await app.call('/api/v1/suggestions', { token, body: { requestId: rid(), kind: 'rv_nota', summary: 'Puerta', operations: [insert(NOTES, { text: 'Puerta' })] } });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const asReader = await app.call('/api/v1/suggestions?scope=vote', { token: app.tokens.reader });
  assert.equal(asReader.status, 200, JSON.stringify(asReader.data));
  const item = asReader.data.items.find((s: any) => s.id === made.data.id);
  assert.ok(item, 'la pendiente sale para votar');
  assert.equal(item.author, null);
  assert.equal(item.anonymous, true);
  assert.ok(!JSON.stringify(asReader.data).includes(author), 'ni el id de quien propone');
  assert.equal(asReader.data.pendingCount >= 1, true);

  const asEditor = await app.call('/api/v1/suggestions?scope=vote', { token: app.tokens.editor });
  assert.equal(asEditor.data.items.find((s: any) => s.id === made.data.id).author.id, author);

  assert.equal((await app.call('/api/v1/suggestions?scope=vote', { token })).status, 403, 'el outsider no vota');
  assert.equal((await app.call('/api/v1/suggestions?scope=pending', { token: app.tokens.reader })).status, 403, 'pending sigue siendo de quien decide');
});
