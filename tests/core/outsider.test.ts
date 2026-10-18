/** Fase O1 (RECURSOS.md §13.1, §14 y §15.1; migración 0092): rol `outsider`, nivel de casa → roles y sugerencias. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const NOTES = 'tasks.o1_notes';
let app: TestApp;
let seq = 0;
const rid = () => `o1-${++seq}`;
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const role = async (appId: string, user: string) => (await q<{ role: string }>(`select role from core.memberships where app = $1 and user_id = $2`, [appId, user]))[0]?.role;
const level = (user: string, lvl: string | null) => q(`select core.apply_house_level($1, $2)`, [user, lvl]);
const code = (res: { data: any }) => res.data?.error?.code ?? res.data?.code;

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
  // Tabla de prueba: el outsider la lee pero no la escribe; las sugerencias insertan en ella.
  await q(`create table tasks.o1_notes (id uuid primary key, revision bigint not null default 1, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz, text text not null)`);
  await q(`select core.register_table('tasks', 'tasks', 'o1_notes', array['text'], '{reader,outsider,editor,owner}', '{editor,owner}')`);
  await q(`create function tasks.o1_echo(p jsonb) returns jsonb language sql as 'select jsonb_build_object(''role'', p->>''role'')'`);
  await q(`select core.allow_procedure('tasks', 'tasks.o1_echo')`);
});
test.after(async () => { await app.close(); });

test('nivel de casa · outsider da Tasks outsider y Guests editor; nunca rebaja; al quitarlo devuelve solo lo que dio', async () => {
  const fresh = await app.t.createUser();
  assert.deepEqual((await q(`select core.apply_house_level($1, 'outsider') as r`, [fresh]))[0].r.map((c: any) => c.app).sort(), ['guests', 'tasks']);
  assert.equal(await role('tasks', fresh), 'outsider');
  assert.equal(await role('guests', fresh), 'editor');
  assert.equal(await role('resources', fresh), 'reader', 'el módulo deriva lector de un outsider');
  const boot = (await q(`select core.bootstrap('tasks', $1) as b`, [fresh]))[0].b;
  assert.equal(boot.profile.houseLevel, 'outsider');
  assert.equal(boot.membership.role, 'outsider');
  // Idempotente.
  assert.deepEqual((await q(`select core.apply_house_level($1, 'outsider') as r`, [fresh]))[0].r, []);
  await level(fresh, null);
  assert.equal(await role('tasks', fresh), undefined);
  assert.equal(await role('guests', fresh), undefined);
  assert.equal((await q(`select core.bootstrap('tasks', $1) as b`, [app.users.owner]))[0].b.profile.houseLevel, null);

  // Huésped de un retiro (editor con scopes) que pasa a outsider: sigue igual, con sus scopes, y conserva sus lecturas.
  const guest = await app.t.createUser();
  const scopes = { grants: [{ reservationId: crypto.randomUUID(), guestId: crypto.randomUUID() }] };
  await q(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2)`, [guest, JSON.stringify(scopes)]);
  await level(guest, 'outsider');
  const g = (await q(`select role, scopes from core.memberships where app = 'guests' and user_id = $1`, [guest]))[0];
  assert.equal(g.role, 'editor');
  assert.deepEqual(g.scopes, scopes);
  assert.equal((await q(`select count(*)::int as n from core.house_grants where user_id = $1 and app = 'guests'`, [guest]))[0].n, 0);
  assert.equal((await q(`select core.bootstrap('guests', $1) as b`, [guest]))[0].b.profile.houseLevel, 'outsider');
  await level(guest, null);
  assert.equal(await role('guests', guest), 'editor', 'quitar el nivel no toca lo que no dio');

  // Lector en Tasks → sube a outsider y al quitarlo vuelve a lector; editor a mano → no se toca.
  const reader = await app.t.createUser();
  await q(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'reader')`, [reader]);
  await level(reader, 'outsider');
  assert.equal(await role('tasks', reader), 'outsider');
  await level(reader, null);
  assert.equal(await role('tasks', reader), 'reader');
  const editor = await app.t.createUser();
  await q(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'editor')`, [editor]);
  await level(editor, 'outsider');
  assert.equal(await role('tasks', editor), 'editor');

  // Un cambio a mano posterior se respeta al quitar el nivel.
  const later = await app.t.createUser();
  await level(later, 'outsider');
  await q(`update core.memberships set role = 'editor' where app = 'tasks' and user_id = $1`, [later]);
  await level(later, null);
  assert.equal(await role('tasks', later), 'editor');

  // Dirección y staff no derivan nada (decisión del usuario del 13-10-2026), pero el nivel queda guardado.
  const staff = await app.t.createUser();
  await level(staff, 'staff');
  assert.equal(await role('tasks', staff), undefined);
  assert.equal((await q(`select level from core.house_levels where user_id = $1`, [staff]))[0].level, 'staff');

  // Un agente nunca; el rol outsider no se da a mano.
  const agent = await app.t.createUser();
  await q(`insert into core.profiles (user_id, display_name, kind) values ($1, 'Agente', 'agent')`, [agent]);
  await level(agent, 'outsider');
  assert.equal(await role('tasks', agent), undefined);
  await assert.rejects(q(`select core.set_membership('tasks', $1, $2, 'outsider', null, null)`, [app.users.owner, fresh]), /INVALID_ROLE/);
});

test('rol outsider · lee solo lo abierto, no escribe por defecto, no llama procedimientos ni deshace', async () => {
  const user = await app.t.createUser();
  await level(user, 'outsider');
  const token = app.supabase.tokenFor(user);
  const boot = await app.call('/api/v1/bootstrap', { token });
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  assert.equal(boot.data.membership.role, 'outsider');
  assert.equal(boot.data.profile.houseLevel, 'outsider');
  const tables = new Map<string, any>(boot.data.tables.map((t: any) => [t.table, t]));
  assert.equal(tables.get(NOTES).readable, true);
  assert.equal(tables.get(NOTES).writable, false);
  // Tasks abre al outsider sus tablas de tareas (O1, migración 0325); las vistas guardadas siguen cerradas.
  assert.equal(tables.get('tasks.saved_views').readable, false, 'por defecto no lee las tablas de la app');

  const id = crypto.randomUUID();
  await q(`insert into tasks.o1_notes (id, text) values ($1, 'abierta')`, [id]);
  assert.equal((await app.call(`/api/v1/snapshot?tables=${NOTES}`, { token })).status, 200);
  assert.equal((await app.call(`/api/v1/snapshot?tables=tasks.saved_views`, { token })).status, 403);

  const write = await app.call('/api/v1/commands', { token, body: { requestId: rid(), operations: [{ op: 'update', table: NOTES, id, expectedRevision: 1, fields: { text: 'x' } }] } });
  assert.equal(write.status, 403);
  const call = await app.call('/api/v1/commands', { token, body: { requestId: rid(), operations: [{ op: 'call', procedure: 'tasks.o1_echo', args: {} }] } });
  assert.equal(call.status, 403, JSON.stringify(call.data));
  // Con el procedimiento abierto, sí, y le llega el rol.
  await q(`select core.allow_outsider_procedure('tasks', 'tasks.o1_echo')`);
  const ok = await app.call('/api/v1/commands', { token, body: { requestId: rid(), operations: [{ op: 'call', procedure: 'tasks.o1_echo', args: {} }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.results[0].result.role, 'outsider');
  assert.equal((await app.call(`/api/v1/history/${ok.data.cursor}/undo-plan`, { token, body: {} })).status, 403);
  // Abrir otro procedimiento que no está permitido falla.
  await assert.rejects(q(`select core.allow_outsider_procedure('tasks', 'tasks.no_existe')`), /PROCEDURE_NOT_ALLOWED/);
});

test('sugerencias · el outsider sugiere; staff previsualiza, corrige y aprueba (se aplica) o descarta; el autor retira', async () => {
  await q(`select core.register_suggestion_kind('tasks', 'nota', 'Nota nueva', array['${NOTES}'], array['insert'])`);
  const user = await app.t.createUser();
  await q(`insert into core.profiles (user_id, display_name) values ($1, 'Marta') on conflict (user_id) do update set display_name = 'Marta'`, [user]);
  await level(user, 'outsider');
  const token = app.supabase.tokenFor(user);
  const noteId = crypto.randomUUID();
  const body = { requestId: rid(), kind: 'nota', summary: 'Arreglar la puerta', detail: { area: 'Albergue' }, operations: [{ op: 'insert', table: NOTES, id: noteId, fields: { text: 'Puerta' } }] };
  const created = await app.call('/api/v1/suggestions', { token, body });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.author.name, 'Marta');
  assert.equal(created.data.label, 'Nota nueva');
  // Reintento idéntico: el mismo; con otro lote: IDEMPOTENCY_REUSE.
  assert.equal((await app.call('/api/v1/suggestions', { token, body })).data.id, created.data.id);
  assert.equal((await app.call('/api/v1/suggestions', { token, body: { ...body, operations: [{ op: 'insert', table: NOTES, id: crypto.randomUUID(), fields: { text: 'y' } }] } })).status, 409);
  // Fuera del tipo: borrar, otra tabla, o un tipo que no existe.
  const bad = (ops: unknown[], kind = 'nota') => app.call('/api/v1/suggestions', { token, body: { requestId: rid(), kind, summary: 's', operations: ops } });
  const del = await bad([{ op: 'delete', table: NOTES, id: noteId, expectedRevision: 1 }]);
  assert.equal(del.status, 403, JSON.stringify(del.data));
  assert.equal(code(del), 'SUGGESTION_NOT_ALLOWED');
  assert.equal((await bad([{ op: 'insert', table: 'tasks.tasks', id: crypto.randomUUID(), fields: {} }])).status, 403);
  assert.equal((await bad([{ op: 'insert', table: NOTES, id: crypto.randomUUID(), fields: { text: 'x' } }], 'nada')).status, 404);
  // Un lector no puede sugerir este tipo (solo outsider).
  assert.equal((await app.call('/api/v1/suggestions', { token: app.tokens.reader, body: { ...body, requestId: rid() } })).status, 403);

  // Mías, sí; pendientes, solo staff.
  const mine = await app.call('/api/v1/suggestions?scope=mine', { token });
  assert.equal(mine.data.items.length, 1);
  assert.equal((await app.call('/api/v1/suggestions?scope=pending', { token })).status, 403);
  const pending = await app.call('/api/v1/suggestions?scope=pending', { token: app.tokens.editor });
  assert.equal(pending.status, 200);
  assert.equal(pending.data.pendingCount, 1);

  const preview = await app.call(`/api/v1/suggestions/${created.data.id}/preview`, { token: app.tokens.editor, body: {} });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.changes[0].after.text, 'Puerta');
  assert.equal((await q(`select count(*)::int as n from tasks.o1_notes where id = $1`, [noteId]))[0].n, 0, 'previsualizar no escribe');

  // Aprobar con corrección: se aplica como commit de quien aprueba.
  const approved = await app.call(`/api/v1/suggestions/${created.data.id}/approve`, { token: app.tokens.editor,
    body: { comment: 'Hecho', operations: [{ op: 'insert', table: NOTES, id: noteId, fields: { text: 'Puerta del albergue' } }] } });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, 'approved');
  assert.ok(approved.data.appliedCursor > 0);
  assert.equal(approved.data.decidedBy.id, app.users.editor);
  const note = (await q(`select text, updated_by from tasks.o1_notes where id = $1`, [noteId]))[0];
  assert.equal(note.text, 'Puerta del albergue');
  assert.equal(note.updated_by, app.users.editor);
  assert.equal((await app.call(`/api/v1/suggestions/${created.data.id}/reject`, { token: app.tokens.editor, body: {} })).status, 409);

  // Descartar con comentario; retirar la propia; si el lote ya no encaja, sigue pendiente.
  const second = await app.call('/api/v1/suggestions', { token, body: { ...body, requestId: rid(), operations: [{ op: 'insert', table: NOTES, id: crypto.randomUUID(), fields: { text: 'Otra' } }] } });
  const rejected = await app.call(`/api/v1/suggestions/${second.data.id}/reject`, { token: app.tokens.owner, body: { comment: 'Ya está' } });
  assert.equal(rejected.data.status, 'rejected');
  assert.equal(rejected.data.comment, 'Ya está');
  const third = await app.call('/api/v1/suggestions', { token, body: { ...body, requestId: rid(), operations: [{ op: 'insert', table: NOTES, id: crypto.randomUUID(), fields: { text: 'Tercera' } }] } });
  assert.equal((await app.call(`/api/v1/suggestions/${third.data.id}/withdraw`, { token: app.tokens.editor, body: {} })).status, 404, 'solo el autor retira');
  assert.equal((await app.call(`/api/v1/suggestions/${third.data.id}/withdraw`, { token, body: {} })).data.status, 'withdrawn');
  const dup = await app.call('/api/v1/suggestions', { token, body: { ...body, requestId: rid() } }); // la misma nota, que ya existe
  assert.equal(dup.status, 200, JSON.stringify(dup.data));
  const failed = await app.call(`/api/v1/suggestions/${dup.data.id}/approve`, { token: app.tokens.editor, body: {} });
  assert.ok(failed.status >= 400, JSON.stringify(failed.data));
  assert.equal((await q(`select status from core.suggestions where id = $1`, [dup.data.id]))[0].status, 'pending');
  // Un lector no decide.
  assert.equal((await app.call(`/api/v1/suggestions/${dup.data.id}/reject`, { token: app.tokens.reader, body: {} })).status, 403);
});

test('sugerencias · desde otra app (submit_from) y con nivel de casa: p. ej. un plato a Food desde Guests', async () => {
  await q(`create function tasks.o1_house_dish(p jsonb) returns jsonb language sql as 'select jsonb_build_object(''name'', p->''args''->>''name'')'`);
  await q(`select core.allow_procedure('tasks', 'tasks.o1_house_dish')`);
  await q(`select core.register_suggestion_kind('tasks', 'plato', 'Plato', p_procedures => array['tasks.o1_house_dish'], p_submit_roles => '{}', p_submit_from => '{"guests": ["editor"]}', p_house_level => 'outsider')`);
  const outsider = await app.t.createUser();
  await level(outsider, 'outsider');
  const guest = await app.t.createUser();
  await q(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [guest]);
  const suggest = (user: string) => q(`select core.suggest('tasks', $1, $2, 'plato', 'Gazpacho', null, $3) as s`, [user, rid(),
    JSON.stringify([{ op: 'call', procedure: 'tasks.o1_house_dish', args: { name: 'Gazpacho' } }])]);
  const s = (await suggest(outsider))[0].s;
  assert.equal(s.status, 'pending');
  await assert.rejects(suggest(guest), /FORBIDDEN/, 'un huésped sin nivel outsider no sugiere platos');
  const out = (await q(`select core.suggestion_decide('tasks', $1, $2, 'approve') as d`, [app.users.editor, s.id]))[0].d;
  assert.equal(out.status, 'approved');
  assert.equal(out.result[0].result.name, 'Gazpacho');
  const mine = (await q(`select core.suggestion_list('tasks', $1, 'mine') as l`, [outsider]))[0].l;
  assert.equal(mine.items[0].status, 'approved');
});

test('sugerencias · el procedimiento del lote sabe quién sugirió (core.suggestion_author), sin fiarse de args (P23)', async () => {
  await app.t.db.query(`create function tasks.o1_who(p jsonb) returns jsonb language sql as 'select jsonb_build_object(''author'', core.suggestion_author(), ''suggestion'', core.suggestion_id())'`);
  await app.t.db.query(`select core.allow_procedure('tasks', 'tasks.o1_who')`);
  await app.t.db.query(`select core.register_suggestion_kind('tasks', 'quien', 'Quién', p_procedures => array['tasks.o1_who'])`);
  const user = await app.t.createUser();
  await app.t.db.query(`select core.apply_house_level($1, 'outsider')`, [user]);
  const s = (await app.t.db.query<any>(`select core.suggest('tasks', $1, 'who-1', 'quien', 'Yo', null, $2) as s`, [user,
    JSON.stringify([{ op: 'call', procedure: 'tasks.o1_who', args: { author: crypto.randomUUID() } }])])).rows[0].s;
  const d = (await app.t.db.query<any>(`select core.suggestion_decide('tasks', $1, $2, 'approve') as d`, [app.users.editor, s.id])).rows[0].d;
  assert.equal(d.result[0].result.author, user);
  assert.equal(d.result[0].result.suggestion, s.id);
  assert.equal((await app.t.db.query<any>(`select core.suggestion_author() as a`)).rows[0].a, null, 'fuera de una aprobación, null');
});

test('sugerencias · on_submit avisa a la app al llegar una nueva, en la misma transacción', async () => {
  await app.t.db.query(`create table tasks.o1_avisos (kind text, summary text)`);
  await app.t.db.query(`create function tasks.o1_aviso(p jsonb) returns void language sql as 'insert into tasks.o1_avisos values (p->>''kind'', p->''suggestion''->>''summary'')'`);
  await app.t.db.query(`select core.allow_procedure('tasks', 'tasks.o1_aviso')`);
  await app.t.db.query(`select core.set_suggestion_on_submit('tasks', 'nota', 'tasks.o1_aviso')`);
  const user = await app.t.createUser();
  await app.t.db.query(`select core.apply_house_level($1, 'outsider')`, [user]);
  await app.t.db.query(`select core.suggest('tasks', $1, 'aviso-1', 'nota', 'Ventana rota', null, $2)`, [user,
    JSON.stringify([{ op: 'insert', table: 'tasks.o1_notes', id: crypto.randomUUID(), fields: { text: 'Ventana' } }])]);
  assert.deepEqual((await app.t.db.query<any>(`select kind, summary from tasks.o1_avisos`)).rows, [{ kind: 'nota', summary: 'Ventana rota' }]);
  await assert.rejects(app.t.db.query(`select core.set_suggestion_on_submit('tasks', 'nota', 'tasks.no_permitido')`), /PROCEDURE_NOT_ALLOWED/);
});

test('C24 · la propietaria cambia los ámbitos de un outsider con POST members; no da ni quita el rol, ni acepta nulo o «*»', async () => {
  const out = await app.t.createUser();
  const plain = await app.t.createUser();
  await level(out, 'outsider');
  const set = (userId: string, role: string, scopes: unknown, token = app.tokens.owner) => app.call('/api/v1/members', { token, body: { userId, role, scopes } });
  const open = { tabs: [], projects: { [crypto.randomUUID()]: [crypto.randomUUID()] } };
  const ok = await set(out, 'outsider', open);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const row = (await q(`select role, scopes from core.memberships where app = 'tasks' and user_id = $1`, [out]))[0];
  assert.equal(row.role, 'outsider');
  assert.deepEqual(row.scopes, open);
  assert.equal(code(await set(out, 'outsider', null)), 'INVALID_OPERATION', 'nulo sería toda la app');
  assert.equal(code(await set(out, 'outsider', '*')), 'INVALID_OPERATION');
  assert.equal(code(await set(plain, 'outsider', open)), 'INVALID_ROLE', 'el rol lo da el nivel de casa');
  assert.equal(await role('tasks', plain), undefined);
  assert.equal((await set(out, 'outsider', open, app.tokens.editor)).status, 403, 'solo la propietaria');
  // Quitar el nivel le quita la pertenencia, como siempre.
  await level(out, null);
  assert.equal(await role('tasks', out), undefined);
});
