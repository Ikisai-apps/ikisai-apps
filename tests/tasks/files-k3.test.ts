/**
 * Tasks · K3 para miembros (`uploads.membersK3`, núcleo #585; RESPUESTAS de Core del 19-10-2026, como Central en #589).
 * Conocer el id de un archivo no basta: `GET files/:id` firma un archivo ajeno solo si quien pide ve (hook `visible`) una
 * fila viva que lo referencia (adjunto o foto de comentario). Un editor con un solo proyecto no lee el adjunto de otro;
 * lo propio y la propietaria, siempre. Las descargas de la app (`attachments/:id`, `comments/:id/photo`) no cambian.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS, TASKS_UPLOADS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = () => crypto.randomUUID();
let app: TestApp;
let scoped: string, scopedUser: string;
let seq = 0;
const TAB = uuid(), P1 = uuid(), P2 = uuid(), T1 = uuid(), T2 = uuid();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `k3-${++seq}`, operations } });
const ok = async (operations: unknown[], token?: string) => { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r; };
const read = async (id: string, token: string) => (await app.call(`/api/v1/files/${id}`, { token })).status;

async function upload(text: string, token = app.tokens.owner, mime = 'application/pdf') {
  const bytes = new TextEncoder().encode(text);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { token, body: { filename: mime === 'application/pdf' ? 'a.pdf' : 'a.png', mime, size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { token, body: {} })).status, 200);
  return { id: ticket.data.id as string, sha, size: bytes.byteLength, mime };
}
const attach = (id: string, project: string, task: string, file: { id: string; sha: string; size: number; mime: string }) =>
  ({ op: 'insert', table: 'tasks.attachments', id, fields: { tab_id: TAB, project_id: project, task_id: task, name: 'plano.pdf', mime: file.mime, size: file.size, sha256: file.sha, file_id: file.id, position: 1024 } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (c) => createTasksApp({ ...c, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: P1, fields: { tab_id: TAB, title: 'Jardín', position: 2048 } }, { op: 'insert', table: 'tasks.projects', id: P2, fields: { tab_id: TAB, title: 'Cuentas', position: 3072 } }]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: T1, fields: { tab_id: TAB, project_id: P1, title: 'Podar', position: 1024 } }, { op: 'insert', table: 'tasks.tasks', id: T2, fields: { tab_id: TAB, project_id: P2, title: 'Pagar', position: 1024 } }]);
  scopedUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'editor', $2::jsonb)`, [scopedUser, JSON.stringify({ tabs: [], projects: { [TAB]: [P1] } })]);
  scoped = app.supabase.tokenFor(scopedUser);
});
test.after(async () => { await app.close(); });

test('k3 · Tasks lo activa, y sus columnas de archivo están en core.register_file_field', async () => {
  assert.equal(TASKS_UPLOADS.membersK3, true);
  const registered = (await app.t.db.query<{ col: string }>(`select schema_name || '.' || table_name || '.' || column_name as col from core.file_fields where app = 'tasks' order by 1`)).rows.map((r) => r.col);
  assert.deepEqual(registered, ['tasks.attachments.file_id', 'tasks.purchase_requests.receipt_file_id', 'tasks.task_comments.file_id']);
  // Ninguna otra columna del schema tasks guarda un archivo (ni en JSON ni en texto).
  const columns = (await app.t.db.query<{ col: string }>(`select c.table_schema || '.' || c.table_name || '.' || c.column_name as col
      from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'tasks' and (c.column_name like '%file%' or c.column_name like '%photo%') order by 1`)).rows.map((r) => r.col);
  assert.deepEqual(columns, registered);
});

test('k3 · un editor con un solo proyecto: lee el adjunto del suyo y recibe 404 en el de otro', async () => {
  const mine = await upload('%PDF-1.4 plano del jardín'), other = await upload('%PDF-1.4 cuentas');
  await ok([attach(uuid(), P1, T1, mine), attach(uuid(), P2, T2, other)]);
  assert.equal(await read(mine.id, scoped), 200, 'su proyecto');
  assert.equal(await read(other.id, scoped), 404, 'el proyecto que no ve');
  for (const token of [app.tokens.owner, app.tokens.editor, app.tokens.reader]) {
    assert.equal(await read(mine.id, token), 200);
    assert.equal(await read(other.id, token), 200, 'con toda la app, los dos');
  }
  // Un archivo que ninguna fila referencia: quien lo subió y la propietaria.
  const orphan = await upload('%PDF-1.4 suelto', scoped);
  assert.equal(await read(orphan.id, scoped), 200, 'lo propio');
  assert.equal(await read(orphan.id, app.tokens.editor), 404);
  assert.equal(await read(orphan.id, app.tokens.owner), 200);
});

test('k3 · papelera: el adjunto de una fila borrada solo lo leen quien lo subió y la propietaria; al restaurar, como antes', async () => {
  const file = await upload('%PDF-1.4 presupuesto', app.tokens.editor);
  const id = uuid();
  await ok([attach(id, P1, T1, file)], app.tokens.editor);
  await ok([{ op: 'delete', table: 'tasks.attachments', id, expectedRevision: 1 }]);
  assert.equal(await read(file.id, scoped), 404, 'el editor del proyecto, en la papelera, no');
  assert.equal(await read(file.id, app.tokens.reader), 404);
  assert.equal(await read(file.id, app.tokens.editor), 200, 'quien lo subió');
  assert.equal(await read(file.id, app.tokens.owner), 200, 'la propietaria');
  await ok([{ op: 'restore', table: 'tasks.attachments', id, expectedRevision: 2 }]);
  assert.equal(await read(file.id, scoped), 200);
});
