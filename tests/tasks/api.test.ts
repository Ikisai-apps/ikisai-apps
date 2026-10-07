/** Tasks · `tasks-api` sobre el arnés HTTP del test-kit: hooks de dominio, visibilidad por ámbitos y rutas propias. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, tasksAgentRiskHook, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createSupabase, type RequestContext } from '../../supabase/functions/_kit/mod.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const insert = (table: string, id: string, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });

let app: TestApp;
let sequence = 0;
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `api-${++sequence}`, operations }, ...(token ? { token } : {}) });
async function ok(operations: Operation[], token?: string) {
  const result = await commit(operations, token);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function member(role: string, scopes: unknown): Promise<string> {
  const id = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, $2, $3::jsonb)`, [id, role, JSON.stringify(scopes)]);
  return app.supabase.tokenFor(id);
}

const TAB = uuid(), INBOX = uuid(), MINE = uuid(), SECRET = uuid(), T_MINE = uuid(), T_SECRET = uuid(), LABEL = uuid(), VIEW = uuid();
let guest: string;
let seedCursor = 0;

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const tabOps = createTabOps({ id: TAB, name: 'Obra', position: 1024, inboxId: INBOX });
  const phase = tabOps.find((o) => o.fields?.system_key === 'phase')!.id!;
  await ok(tabOps);
  const seeded = await ok([
    insert('tasks.projects', MINE, { tab_id: TAB, title: 'Reforma', position: 2048 }),
    insert('tasks.projects', SECRET, { tab_id: TAB, title: 'Privado', position: 3072 }),
    insert('tasks.tasks', T_MINE, { tab_id: TAB, project_id: MINE, title: 'Pintar', position: 1024 }),
    insert('tasks.tasks', T_SECRET, { tab_id: TAB, project_id: SECRET, title: 'Enfoscar en secreto', position: 1024 }),
    insert('tasks.labels', LABEL, { tab_id: TAB, family_id: phase, name: 'Acabados' }),
    insert('tasks.saved_views', VIEW, { tab_id: TAB, name: 'Pendientes', filters: { _state: ['pending'] } }),
    insert('tasks.task_dependencies', uuid(), { tab_id: TAB, project_id: MINE, task_id: T_MINE, depends_on_id: T_SECRET, position: 1024 }),
  ]);
  seedCursor = seeded.cursor;
  guest = await member('editor', { tabs: [], projects: { [TAB]: [MINE] } });
});
test.after(async () => { await app.close(); });

test('tasks-api · health y bootstrap con sus diecisiete tablas (diez de tareas, cinco de compras y dos de entradas)', async () => {
  const health = await app.call('/api/v1/health', { token: null });
  assert.equal(health.data.app, 'tasks');
  const boot = await app.call('/api/v1/bootstrap');
  assert.equal(boot.data.tables.length, 17);
  assert.equal(boot.data.tables.find((t: any) => t.table === 'tasks.tabs').writable, true);
  const asEditor = await app.call('/api/v1/bootstrap', { token: app.tokens.editor });
  assert.equal(asEditor.data.tables.find((t: any) => t.table === 'tasks.tabs').writable, false, 'solo el propietario escribe áreas');
});

test('tasks-api · beforeCommit y hook SQL devuelven códigos de dominio como 4xx definitivos', async () => {
  const code = async (operations: Operation[], token?: string) => { const r = await commit(operations, token); return `${r.status} ${r.data.error?.code}`; };
  assert.equal(await code([insert('tasks.tasks', uuid(), { tab_id: TAB, project_id: MINE, title: '  ', position: 1 })]), '422 REQUIRED_TEXT');
  assert.equal(await code([insert('tasks.tasks', uuid(), { tab_id: TAB, project_id: MINE, title: 'x', position: 1, due: '2026-13-01' })]), '422 INVALID_DATE');
  assert.equal(await code([{ op: 'delete', table: 'tasks.labels', id: LABEL, expectedRevision: 1 }]), '422 ARCHIVE_REQUIRED');
  assert.equal(await code([{ op: 'call', procedure: 'tasks.import_rows', args: { rows: {} } }]), '422 INVALID_OPERATION');
  assert.equal(await code([{ op: 'update', table: 'tasks.tasks', id: T_MINE, expectedRevision: 1, fields: { tab_id: uuid() } }]), '422 IMMUTABLE_FIELD');
  const blocked = await commit([{ op: 'update', table: 'tasks.tasks', id: T_MINE, expectedRevision: 1, fields: { done: true } }]);
  assert.equal(blocked.status, 422); assert.equal(blocked.data.error.code, 'TASK_BLOCKED');
  assert.deepEqual(blocked.data.error.details, { taskId: T_MINE, blockedBy: [T_SECRET] });
  const cycle = await commit([insert('tasks.task_dependencies', uuid(), { tab_id: TAB, project_id: SECRET, task_id: T_SECRET, depends_on_id: T_MINE, position: 1 })]);
  assert.equal(`${cycle.status} ${cycle.data.error.code}`, '422 DEPENDENCY_CYCLE');
  assert.equal(await code([insert('tasks.tasks', uuid(), { tab_id: TAB, project_id: SECRET, title: 'Intruso', position: 1 })], guest), '403 FORBIDDEN');
  assert.equal(await code([{ op: 'update', table: 'tasks.tasks', id: T_SECRET, expectedRevision: 1, fields: { note: 'x' } }], guest), '403 FORBIDDEN');
  assert.equal(await code([insert('tasks.tabs', uuid(), { name: 'Sin entrada', position: 1 })]), '422 INBOX_PROTECTED');
});

test('tasks-api · visibilidad: un acceso por proyecto ve su proyecto, el catálogo del área y nada más', async () => {
  const snap = await app.call('/api/v1/snapshot', { token: guest });
  assert.equal(snap.status, 200);
  const rows = (table: string) => snap.data.tables.find((t: any) => t.table === table).rows;
  assert.deepEqual(rows('tasks.tabs').map((r: any) => r.id), [TAB]);
  assert.deepEqual(rows('tasks.projects').map((r: any) => r.id), [MINE]);
  assert.deepEqual(rows('tasks.tasks').map((r: any) => r.id), [T_MINE]);
  assert.equal(rows('tasks.families').length, 5, 'catálogo completo del área (D1)');
  assert.deepEqual(rows('tasks.labels').map((r: any) => r.id), [LABEL]);
  assert.equal(rows('tasks.saved_views').length, 0);
  assert.equal(rows('tasks.task_dependencies').length, 1, 've que su tarea depende de algo');
  assert.equal(JSON.stringify(snap.data).includes('Enfoscar en secreto'), false);

  const changes = await app.call('/api/v1/changes?after=0', { token: guest });
  assert.equal(changes.data.items.some((c: any) => c.id === T_SECRET || c.id === SECRET || c.id === VIEW), false);
  assert.ok(changes.data.items.some((c: any) => c.id === T_MINE));
  const history = await app.call('/api/v1/history', { token: guest });
  assert.equal(JSON.stringify(history.data).includes('Enfoscar en secreto'), false);

  // El invitado trabaja en su proyecto con cualquier etiqueta del área.
  const created = uuid();
  await ok([
    insert('tasks.tasks', created, { tab_id: TAB, project_id: MINE, title: 'Lijar', position: 2048 }),
    insert('tasks.task_labels', uuid(), { tab_id: TAB, project_id: MINE, task_id: created, label_id: LABEL }),
  ], guest);
  const owner = await app.call('/api/v1/snapshot?tables=tasks.tasks');
  assert.equal(owner.data.tables[0].rows.length, 3);
});

test('tasks-api · lectura registrada tasks.targets con el token del usuario', async () => {
  const all = await app.call('/api/v1/read/tasks.targets', { body: { tabId: TAB } });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.deepEqual(all.data.tabs[0].projects.map((p: any) => p.title), ['Entrada', 'Reforma', 'Privado']);
  const seen = await app.call('/api/v1/read/tasks.targets', { body: {}, token: guest });
  assert.deepEqual(seen.data.tabs.map((t: any) => t.projects.map((p: any) => p.title)), [['Reforma']]);
  const viaGet = await app.call('/api/v1/read/tasks.targets', { token: guest });
  assert.equal(viaGet.status, 200); assert.equal(viaGet.data.tabs.length, 1);
  const one = await app.call('/api/v1/read/tasks.targets', { body: { kind: 'project', id: MINE }, token: guest });
  assert.equal(one.data.title, 'Reforma'); assert.equal(one.data.revision, 1);
  const hidden = await app.call('/api/v1/read/tasks.targets', { body: { kind: 'task', id: T_SECRET }, token: guest });
  assert.equal(`${hidden.status} ${hidden.data.error.code}`, '404 NOT_FOUND');
  assert.equal((await app.call('/api/v1/read/tasks.validate_batch', { body: {} })).status, 422, 'solo lo registrado con allow_read');
});

test('tasks-api · blockers: cuenta los bloqueos privados sin revelar la tarea', async () => {
  const mine = await app.call('/api/v1/blockers', { token: guest });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.items, [{ taskId: T_MINE, hidden: 1 }]);
  assert.equal(JSON.stringify(mine.data).includes(T_SECRET), false);
  assert.deepEqual((await app.call('/api/v1/blockers')).data.items, []);
  // Cumplida la condición privada, deja de contar y el invitado puede completar.
  await ok([{ op: 'update', table: 'tasks.tasks', id: T_SECRET, expectedRevision: 1, fields: { done: true } }]);
  assert.deepEqual((await app.call('/api/v1/blockers', { token: guest })).data.items, []);
  await ok([{ op: 'update', table: 'tasks.tasks', id: T_MINE, expectedRevision: 1, fields: { done: true } }], guest);
});

test('tasks-api · adjuntos: subida por ticket, fila con file_id y descarga con comprobación de ámbito', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 plano de la reforma');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'plano.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha }, token: guest });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  const fields = (project: string) => ({ tab_id: TAB, project_id: project, task_id: null, name: 'Plano (v1).pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha, file_id: ticket.data.id });
  const early = await commit([insert('tasks.attachments', uuid(), fields(MINE))], guest);
  assert.equal(`${early.status} ${early.data.error.code}`, '422 FILE_NOT_UPLOADED');
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {}, token: guest })).data.verified, true);
  const mine = uuid(), secret = uuid();
  await ok([insert('tasks.attachments', mine, fields(MINE))], guest);
  await ok([insert('tasks.attachments', secret, fields(SECRET))]);

  const request = (id: string, token: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/tasks-api/api/v1/attachments/${id}`, { headers: { Origin: origin, Authorization: 'Bearer ' + token } }));
  const download = await request(mine, guest);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.equal(download.headers.get('content-disposition'), "attachment; filename*=UTF-8''Plano%20(v1).pdf");
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.equal((await request(secret, guest)).status, 404);
  assert.equal((await request(secret, app.tokens.owner)).status, 200);
  assert.equal((await request(uuid(), app.tokens.owner)).status, 404);
  assert.equal((await request('no-es-uuid', app.tokens.owner)).status, 404);
  assert.ok(seedCursor > 0);
});

test('tasks-api · agentRisk: archivar exige aprobación y el alcance cuenta lo que cuelga, solo lo visible', async () => {
  const supabase = createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
  const hook = tasksAgentRiskHook(supabase);
  const ctx = (role: string, scopes: unknown) => ({ membership: { role, scopes } }) as unknown as RequestContext;
  const extra = Array.from({ length: 12 }, () => uuid());
  await ok(extra.map((id, i) => insert('tasks.tasks', id, { tab_id: TAB, project_id: SECRET, title: `Tarea ${i}`, position: 2048 + i })));

  // Una sola fila que archiva un proyecto con 13 tareas: exige aprobación y su alcance supera el umbral del núcleo.
  const archive: Operation[] = [{ op: 'update', table: 'tasks.projects', id: SECRET, expectedRevision: 1, fields: { status: 'archived' } }];
  const owner = await hook(archive, ctx('owner', '*'));
  assert.equal(owner.required, true);
  assert.deepEqual(owner.reasons, [`archive:project:${SECRET}`]);
  assert.equal(owner.affectedEstimate, 1 + 13);
  // Lo que el agente no ve no cuenta (ni se revela por el recuento).
  const limited = await hook(archive, ctx('editor', { tabs: [], projects: { [TAB]: [MINE] } }));
  assert.equal(limited.affectedEstimate, 1);

  // Editar o completar no añade nada: lo decide el núcleo por número de filas.
  const plain = await hook([{ op: 'update', table: 'tasks.tasks', id: T_MINE, expectedRevision: 1, fields: { done: true } }], ctx('owner', '*'));
  assert.deepEqual(plain, { required: false, reasons: [], affectedEstimate: 1 });
});
