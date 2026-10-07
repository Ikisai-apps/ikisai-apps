/** Central · equipos: quién los gestiona (Edge y base), una persona en varios equipos, papelera y proyección para el núcleo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/central/mod.ts';

const { people: PEOPLE, teams: TEAMS, personTeams: PT } = TABLES;
const uuid = () => crypto.randomUUID();
let app: TestApp;
let scoped: string;
let scopedUser: string;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `team-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  });
  scopedUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('central', $1, 'editor', '{"people": true}'::jsonb)`, [scopedUser]);
  scoped = app.supabase.tokenFor(scopedUser);
});
test.after(async () => { await app.close(); });

test('equipos · gestionan owner y editor con ámbito; editor sin ámbito 403 (Edge y base); lector lee', async () => {
  const kitchen = uuid();
  assert.equal((await commit([{ op: 'insert', table: TEAMS, id: uuid(), fields: { name: 'Cocina' } }], app.tokens.editor)).status, 403);
  const ok = await commit([{ op: 'insert', table: TEAMS, id: kitchen, fields: { name: 'Cocina', color: '#56663f', position: 1 } }], scoped);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const dup = await commit([{ op: 'insert', table: TEAMS, id: uuid(), fields: { name: ' cocina ' } }]);
  assert.equal(dup.data.error.code, 'CONSTRAINT_VIOLATION');
  // La base también lo impide aunque se salte la Edge.
  const editor = (await app.t.db.query<{ user_id: string }>(`select user_id from core.memberships where app = 'central' and role = 'editor' and scopes is null limit 1`)).rows[0]!.user_id;
  await assert.rejects(app.t.rpc('core_commit', { p_app: 'central', p_actor: editor, p_request_id: 'sql-team', p_digest: 'sql-team', p_expected_cursor: null,
    p_operations: [{ op: 'insert', table: TEAMS, id: uuid(), fields: { name: 'Limpieza' } }] }), (e: any) => e.code === 'FORBIDDEN');
  const snap = await app.call(`/api/v1/snapshot?tables=${TEAMS}`, { token: app.tokens.reader });
  assert.equal(snap.status, 200); assert.equal(snap.data.tables[0].rows.length, 1);
});

test('equipos · una persona en varios; la proyección solo trae personas activas con cuenta', async () => {
  const maint = uuid(); const reception = uuid();
  await commit([{ op: 'insert', table: TEAMS, id: maint, fields: { name: 'Mantenimiento' } }, { op: 'insert', table: TEAMS, id: reception, fields: { name: 'Recepción' } }]);
  const withAccount = uuid(); const without = uuid(); const inactive = uuid();
  const res = await commit([
    { op: 'insert', table: PEOPLE, id: withAccount, fields: { display_name: 'Con cuenta', relation: 'equipo', user_id: app.users.reader } },
    { op: 'insert', table: PEOPLE, id: without, fields: { display_name: 'Sin cuenta', relation: 'equipo' } },
    { op: 'insert', table: PEOPLE, id: inactive, fields: { display_name: 'Inactiva', relation: 'equipo', active: false, user_id: app.users.editor } },
    { op: 'insert', table: PT, id: uuid(), fields: { person_id: withAccount, team_id: maint } },
    { op: 'insert', table: PT, id: uuid(), fields: { person_id: withAccount, team_id: reception } },
    { op: 'insert', table: PT, id: uuid(), fields: { person_id: without, team_id: maint } },
    { op: 'insert', table: PT, id: uuid(), fields: { person_id: inactive, team_id: maint } },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const twice = await commit([{ op: 'insert', table: PT, id: uuid(), fields: { person_id: withAccount, team_id: maint } }]);
  assert.equal(twice.data.error.code, 'CONSTRAINT_VIOLATION');
  const rows = (await app.t.db.query<{ name: string; user_id: string }>(`select name, user_id from central.common_team_projection order by name`)).rows;
  assert.deepEqual(rows.map((r) => [r.name, r.user_id]), [['Mantenimiento', app.users.reader], ['Recepción', app.users.reader]]);
  const read = await app.t.rpc('core_read', { p_app: 'central', p_actor: app.users.owner, p_name: 'central.common_team_projection', p_args: {} }) as { rows: unknown[] };
  assert.equal(read.rows.length, 2);

  // No se puede borrar un equipo ni una persona con pertenencias vivas sin borrarlas en el mismo lote.
  const orphan = await commit([{ op: 'delete', table: TEAMS, id: reception, expectedRevision: 1 }]);
  assert.equal(orphan.data.error.code, 'ORPHAN_CHILD');
  const pair = (await app.t.db.query<{ id: string }>(`select id from central.person_teams where team_id = $1`, [reception])).rows[0]!.id;
  const both = await commit([{ op: 'delete', table: PT, id: pair, expectedRevision: 1 }, { op: 'delete', table: TEAMS, id: reception, expectedRevision: 1 }]);
  assert.equal(both.status, 200, JSON.stringify(both.data));
  const reparent = await commit([{ op: 'update', table: PT, id: uuid(), expectedRevision: 1, fields: { team_id: maint } }]);
  assert.equal(reparent.data.error.code, 'IMMUTABLE_FIELD');
});
