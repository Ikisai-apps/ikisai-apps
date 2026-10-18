/**
 * Ikisai Tasks · O1, pasos 3 y 4 (RECURSOS.md §14.2, docs/tasks/API.md §31). El outsider propone una tarea nueva o un
 * añadido (un paso o una línea en la nota) solo en lo que tiene abierto; staff o dirección (editor u owner) la aprueba, la
 * descarta con un comentario o él la retira. Al aprobar, el lote se aplica como commit de quien aprueba. «Abrir a…»: la
 * propietaria cambia los ámbitos de un outsider sin tocar su rol. Nombres inventados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const insert = (table: string, id: string, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });

let app: TestApp;
let sequence = 0;
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `o1p-${++sequence}`, operations }, ...(token ? { token } : {}) });
async function ok(operations: Operation[]) {
  const result = await commit(operations);
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
const status = (result: { status: number; data: any }) => `${result.status} ${result.data?.error?.code ?? ''}`.trim();
const row = async (table: string, id: string) => (await app.t.db.query<any>(`select * from ${table} where id = $1`, [id])).rows[0];
const rows = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;

const users = new Map<string, string>();
async function outsider(scopes: unknown, name = 'Voluntario Nilo'): Promise<string> {
  const id = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'outsider', $2::jsonb)`, [id, scopes === null ? null : JSON.stringify(scopes)]);
  await app.t.db.query(`insert into core.profiles (user_id, display_name) values ($1, $2)`, [id, name]);
  const token = app.supabase.tokenFor(id);
  users.set(token, id);
  return token;
}

const TAB = uuid(), INBOX = uuid(), OPEN = uuid(), CLOSED = uuid(), SECOND = uuid(), T_OPEN = uuid(), T_CLOSED = uuid(), LABEL = uuid(), PLABEL = uuid();
let none: string, open: string;

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Huerto', position: 1024, inboxId: INBOX }));
  const family = (await rows(`select id from tasks.families where tab_id = $1 order by position limit 1`, [TAB]))[0].id;
  await ok([
    insert('tasks.projects', OPEN, { tab_id: TAB, title: 'Bancales', position: 2048 }),
    insert('tasks.projects', CLOSED, { tab_id: TAB, title: 'Contabilidad', position: 3072 }),
    insert('tasks.projects', SECOND, { tab_id: TAB, title: 'Invernadero', position: 4096 }),
    insert('tasks.labels', LABEL, { tab_id: TAB, family_id: family, name: 'Riego', position: 1024 }),
  ]);
  await ok([
    insert('tasks.project_labels', PLABEL, { tab_id: TAB, project_id: OPEN, label_id: LABEL }),
    insert('tasks.tasks', T_OPEN, { tab_id: TAB, project_id: OPEN, title: 'Plantar tomates', note: 'Variedad corazón de buey.', position: 1024 }),
    insert('tasks.tasks', T_CLOSED, { tab_id: TAB, project_id: CLOSED, title: 'Cuadrar la caja', position: 1024 }),
  ]);
  none = await outsider(null);
  open = await outsider({ tabs: [], projects: { [TAB]: [OPEN] } });
});
test.after(async () => { await app.close(); });

/** Lote de una tarea nueva, como lo construye la interfaz (createTaskOps: hereda las etiquetas propias del proyecto). */
function newTaskOps(project: string, title: string, options: { id?: string; label?: string | null; note?: string } = {}): Operation[] {
  const id = options.id ?? uuid();
  const ops: Operation[] = [insert('tasks.tasks', id, { tab_id: TAB, project_id: project, parent_id: null, title, note: options.note ?? '', done: false, priority: 'normal', due: null, position: 9000 })];
  if (options.label) ops.push(insert('tasks.task_labels', uuid(), { tab_id: TAB, project_id: project, task_id: id, label_id: options.label }));
  return ops;
}
const suggest = (token: string, kind: string, summary: string, operations: Operation[], detail: Record<string, unknown> = {}) =>
  app.call('/api/v1/suggestions', { body: { requestId: `s-${++sequence}`, kind, summary, detail, operations }, token });
const decide = (id: string, decision: 'approve' | 'reject', body: Record<string, unknown> = {}, token = app.tokens.editor) =>
  app.call(`/api/v1/suggestions/${id}/${decision}`, { body, token });

test('O1 · paso 3: el outsider propone una tarea en su proyecto abierto, con lo que hereda del proyecto', async () => {
  const res = await suggest(open, 'tarea', 'Regar los bancales', newTaskOps(OPEN, 'Regar los bancales', { label: LABEL }), { projectId: OPEN, title: 'Regar los bancales' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'pending');
  assert.equal(res.data.label, 'Tarea nueva');
  const mine = await app.call('/api/v1/suggestions?scope=mine', { token: open });
  assert.deepEqual(mine.data.items.map((s: any) => [s.summary, s.status]), [['Regar los bancales', 'pending']]);
});

test('O1 · paso 3: no puede proponer en un proyecto que no tiene abierto, ni sin nada abierto', async () => {
  assert.equal(status(await suggest(open, 'tarea', 'Mirar la caja', newTaskOps(CLOSED, 'Mirar la caja'))), '403 SUGGESTION_NOT_ALLOWED');
  assert.equal(status(await suggest(none, 'tarea', 'Regar', newTaskOps(OPEN, 'Regar'))), '403 SUGGESTION_NOT_ALLOWED');
  // Ni etiquetas que el proyecto no da, ni una tarea ya hecha, ni campos de más.
  const other = uuid();
  await ok([insert('tasks.labels', other, { tab_id: TAB, family_id: (await row('tasks.labels', LABEL)).family_id, name: 'Urgente', position: 2048 })]);
  assert.equal(status(await suggest(open, 'tarea', 'Etiqueta ajena', newTaskOps(OPEN, 'Etiqueta ajena', { label: other }))), '403 SUGGESTION_NOT_ALLOWED');
  const done = newTaskOps(OPEN, 'Hecha');
  (done[0] as any).fields.done = true;
  assert.equal(status(await suggest(open, 'tarea', 'Hecha', done)), '403 SUGGESTION_NOT_ALLOWED');
  const extra = newTaskOps(OPEN, 'Con coste');
  (extra[0] as any).fields.cost = 500;
  assert.equal(status(await suggest(open, 'tarea', 'Con coste', extra)), '403 SUGGESTION_NOT_ALLOWED');
  // Ni otra tabla, ni borrar (lo para el tipo, en el núcleo).
  assert.equal(status(await suggest(open, 'tarea', 'Vista', [insert('tasks.saved_views', uuid(), { tab_id: TAB, name: 'Mía', filters: {} })])), '403 SUGGESTION_NOT_ALLOWED');
  assert.equal(status(await suggest(open, 'tarea', 'Borrar', [{ op: 'delete', table: 'tasks.tasks', id: T_OPEN, expectedRevision: 1 }])), '403 SUGGESTION_NOT_ALLOWED');
  // Nada de eso se ha guardado.
  const mine = await app.call('/api/v1/suggestions?scope=mine', { token: open });
  assert.equal(mine.data.items.length, 1);
  assert.equal((await app.call('/api/v1/suggestions?scope=mine', { token: none })).data.items.length, 0);
});

test('O1 · paso 3: un lector o un editor no pueden proponer; un outsider no decide ni ve las de los demás', async () => {
  assert.equal(status(await suggest(app.tokens.reader, 'tarea', 'Del lector', newTaskOps(OPEN, 'Del lector'))), '403 FORBIDDEN');
  assert.equal(status(await suggest(app.tokens.editor, 'tarea', 'Del editor', newTaskOps(OPEN, 'Del editor'))), '403 FORBIDDEN');
  const pending = (await app.call('/api/v1/suggestions?scope=pending', { token: app.tokens.editor })).data.items;
  assert.equal(status(await app.call('/api/v1/suggestions?scope=pending', { token: open })), '403 FORBIDDEN');
  assert.equal(status(await decide(pending[0].id, 'approve', {}, open)), '403 FORBIDDEN');
  assert.equal(status(await app.call(`/api/v1/suggestions/${pending[0].id}/preview`, { body: {}, token: open })), '403 FORBIDDEN');
});

test('O1 · paso 3: un editor la aprueba y la tarea existe, con su etiqueta heredada y como cambio suyo', async () => {
  const [s] = (await app.call('/api/v1/suggestions?scope=pending', { token: app.tokens.editor })).data.items;
  const preview = await app.call(`/api/v1/suggestions/${s.id}/preview`, { body: {}, token: app.tokens.editor });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const res = await decide(s.id, 'approve', { comment: 'Gracias, Nilo' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'approved');
  const taskId = s.operations[0].id;
  const task = await row('tasks.tasks', taskId);
  assert.equal(task.title, 'Regar los bancales');
  assert.equal(task.project_id, OPEN);
  assert.equal(task.updated_by, app.users.editor);
  assert.deepEqual((await rows(`select label_id from tasks.task_labels where task_id = $1`, [taskId])).map((r) => r.label_id), [LABEL]);
  // El outsider la ve aprobada, con el comentario, y ve la tarea en su snapshot.
  const mine = (await app.call('/api/v1/suggestions?scope=mine', { token: open })).data.items[0];
  assert.deepEqual([mine.status, mine.comment], ['approved', 'Gracias, Nilo']);
  const snap = await app.call('/api/v1/snapshot', { token: open });
  assert.ok(snap.data.tables.find((t: any) => t.table === 'tasks.tasks').rows.some((r: any) => r.id === taskId));
});

test('O1 · paso 3: al aprobar se puede cambiar el destino (otro proyecto) con el lote corregido', async () => {
  const res = await suggest(open, 'tarea', 'Abonar', newTaskOps(OPEN, 'Abonar', { label: LABEL }), { projectId: OPEN, title: 'Abonar' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const moved = newTaskOps(SECOND, 'Abonar');
  const approved = await decide(res.data.id, 'approve', { operations: moved }, app.tokens.owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal((await row('tasks.tasks', (moved[0] as any).id)).project_id, SECOND);
  assert.equal(await row('tasks.tasks', res.data.operations[0].id), undefined);
});

test('O1 · paso 3: descartar con un comentario, y retirar una pendiente', async () => {
  const a = await suggest(open, 'tarea', 'Comprar semillas', newTaskOps(OPEN, 'Comprar semillas'));
  const rejected = await decide(a.data.id, 'reject', { comment: 'Ya hay semillas en el almacén' });
  assert.deepEqual([rejected.data.status, rejected.data.comment], ['rejected', 'Ya hay semillas en el almacén']);
  assert.equal(await row('tasks.tasks', a.data.operations[0].id), undefined);

  const b = await suggest(open, 'tarea', 'Quitar malas hierbas', newTaskOps(OPEN, 'Quitar malas hierbas'));
  assert.equal(status(await app.call(`/api/v1/suggestions/${b.data.id}/withdraw`, { body: {}, token: app.tokens.editor })), '404 NOT_FOUND');
  const withdrawn = await app.call(`/api/v1/suggestions/${b.data.id}/withdraw`, { body: {}, token: open });
  assert.equal(withdrawn.data.status, 'withdrawn');
  assert.equal(status(await decide(b.data.id, 'approve')), '409 SUGGESTION_UNAVAILABLE');
  assert.equal(await row('tasks.tasks', b.data.operations[0].id), undefined);
});

test('O1 · paso 3: «añadido» con una línea en la nota y con un paso nuevo; nada fuera de lo abierto', async () => {
  const task = await row('tasks.tasks', T_OPEN);
  const note = { op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: Number(task.revision), fields: { note: task.note + '\nHay que entutorarlos.' } } as Operation;
  const step = uuid();
  const child = [insert('tasks.tasks', step, { tab_id: TAB, project_id: OPEN, parent_id: T_OPEN, title: 'Comprar cañas', note: '', done: false, priority: 'normal', due: null, position: 1024 }),
    insert('tasks.task_labels', uuid(), { tab_id: TAB, project_id: OPEN, task_id: step, label_id: LABEL })];
  const a = await suggest(open, 'anadido', 'Una línea en «Plantar tomates»', [note]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const b = await suggest(open, 'anadido', 'Un paso en «Plantar tomates»', child);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  // Otro campo, otra tarea fuera de lo abierto, o un paso de una tarea que no ve: no.
  assert.equal(status(await suggest(open, 'anadido', 'Título', [{ ...note, fields: { title: 'Otra cosa' } } as Operation])), '403 SUGGESTION_NOT_ALLOWED');
  const closed = await row('tasks.tasks', T_CLOSED);
  assert.equal(status(await suggest(open, 'anadido', 'Nota ajena', [{ op: 'update', table: 'tasks.tasks', id: T_CLOSED, expectedRevision: Number(closed.revision), fields: { note: 'x' } } as Operation])), '403 SUGGESTION_NOT_ALLOWED');
  assert.equal(status(await suggest(open, 'anadido', 'Paso ajeno', [insert('tasks.tasks', uuid(), { tab_id: TAB, project_id: CLOSED, parent_id: T_CLOSED, title: 'Paso', position: 1 })])), '403 SUGGESTION_NOT_ALLOWED');
  // Una tarea suelta no es un añadido.
  assert.equal(status(await suggest(open, 'anadido', 'Suelta', newTaskOps(OPEN, 'Suelta'))), '403 SUGGESTION_NOT_ALLOWED');

  assert.equal((await decide(a.data.id, 'approve')).status, 200);
  assert.equal((await decide(b.data.id, 'approve')).status, 200);
  assert.equal((await row('tasks.tasks', T_OPEN)).note, 'Variedad corazón de buey.\nHay que entutorarlos.');
  const created = await row('tasks.tasks', step);
  assert.deepEqual([created.parent_id, created.title], [T_OPEN, 'Comprar cañas']);
});

test('O1 · paso 3: si el lote ya no encaja (la nota cambió), aprobar falla y la propuesta sigue pendiente', async () => {
  const task = await row('tasks.tasks', T_OPEN);
  const a = await suggest(open, 'anadido', 'Otra línea', [{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: Number(task.revision), fields: { note: task.note + '\nY regarlos.' } } as Operation]);
  await ok([{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: Number(task.revision), fields: { note: 'Cambiada a mano.' } }]);
  assert.equal(status(await decide(a.data.id, 'approve')), '409 VERSION_CONFLICT');
  const fresh = await row('tasks.tasks', T_OPEN);
  const rebuilt = [{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: Number(fresh.revision), fields: { note: fresh.note + '\nY regarlos.' } } as Operation];
  assert.equal((await decide(a.data.id, 'approve', { operations: rebuilt })).status, 200);
  assert.equal((await row('tasks.tasks', T_OPEN)).note, 'Cambiada a mano.\nY regarlos.');
});

async function upload(token: string, bytes: Uint8Array, mime: string, filename: string) {
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename, mime, size: bytes.byteLength, sha256: sha }, token });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {}, token })).data.verified, true);
  return { id: ticket.data.id as string, sha, size: bytes.byteLength };
}

test('O1 · paso 3: una tarea propuesta con una foto suya; con una foto ajena, no', async () => {
  const mine = await upload(open, new Uint8Array([1, 2, 3, 4, 5]), 'image/webp', 'grieta.webp');
  const ops = newTaskOps(OPEN, 'Arreglar la valla');
  const taskId = (ops[0] as any).id;
  const attachment = (file: { id: string; sha: string; size: number }) => insert('tasks.attachments', uuid(), { tab_id: TAB, project_id: OPEN, task_id: taskId, name: 'grieta.webp', mime: 'image/webp', size: file.size, sha256: file.sha, file_id: file.id, position: 1024 });
  const owners = await upload(app.tokens.owner, new Uint8Array([9, 9, 9]), 'image/webp', 'privada.webp');
  assert.equal(status(await suggest(open, 'tarea', 'Valla', [...ops, attachment(owners)])), '422 FILE_NOT_UPLOADED');
  const pdf = await upload(open, new Uint8Array([7, 7]), 'application/pdf', 'papel.pdf');
  assert.equal(status(await suggest(open, 'tarea', 'Valla', [...ops, attachment(pdf)])), '422 FILE_NOT_UPLOADED');
  const res = await suggest(open, 'tarea', 'Arreglar la valla', [...ops, attachment(mine)]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await decide(res.data.id, 'approve')).status, 200);
  assert.deepEqual((await rows(`select file_id from tasks.attachments where task_id = $1`, [taskId])).map((r) => r.file_id), [mine.id]);
  // El outsider sigue sin poder escribir adjuntos por su cuenta.
  assert.equal(status(await commit([insert('tasks.attachments', uuid(), { tab_id: TAB, project_id: OPEN, task_id: T_OPEN, name: 'x.webp', mime: 'image/webp', size: mine.size, sha256: mine.sha, file_id: mine.id, position: 1 })], open)), '403 FORBIDDEN');
});

const scopesOf = async (token: string) => (await rows(`select scopes, revision from core.memberships where app = 'tasks' and user_id = $1`, [users.get(token)]))[0];
const openTo = (body: Record<string, unknown>, token = app.tokens.owner) => app.call('/api/v1/invoke/tasks.outsider_scopes', { body, token });
const sees = async (token: string, projectId: string) => {
  const snap = await app.call('/api/v1/snapshot', { token });
  return snap.data.tables.find((t: any) => t.table === 'tasks.projects').rows.some((r: any) => r.id === projectId);
};

test('O1 · paso 4: «Abrir a…» abre y cierra un proyecto en los ámbitos del outsider, que pasa a verlo', async () => {
  assert.equal(await sees(open, SECOND), false);
  const before = await scopesOf(open);
  const res = await openTo({ userId: users.get(open), projectId: SECOND, open: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = await scopesOf(open);
  assert.deepEqual(after.scopes, { tabs: [], projects: { [TAB]: [OPEN, SECOND] } });
  assert.equal(Number(after.revision), Number(before.revision) + 1);
  assert.equal(await sees(open, SECOND), true);
  // Ya puede proponer ahí.
  assert.equal((await suggest(open, 'tarea', 'Ventilar', newTaskOps(SECOND, 'Ventilar'))).status, 200);
  // Sigue siendo outsider (el rol no se toca).
  assert.equal((await rows(`select role from core.memberships where app = 'tasks' and user_id = $1`, [users.get(open)]))[0].role, 'outsider');
  // Cerrar.
  assert.equal((await openTo({ userId: users.get(open), projectId: SECOND, open: false })).status, 200);
  assert.deepEqual((await scopesOf(open)).scopes, { tabs: [], projects: { [TAB]: [OPEN] } });
  assert.equal(await sees(open, SECOND), false);
  // Al de sin nada se le abre su primer proyecto (su `scopes` nulo, que era nada, pasa a objeto).
  assert.equal((await openTo({ userId: users.get(none), projectId: OPEN, open: true })).status, 200);
  assert.deepEqual((await scopesOf(none)).scopes, { tabs: [], projects: { [TAB]: [OPEN] } });
});

test('O1 · paso 4: Accesos fija áreas y proyectos de un outsider, nunca toda la app; y solo la propietaria con todo', async () => {
  const userId = users.get(none);
  assert.equal((await openTo({ userId, scopes: { tabs: [TAB], projects: {} } })).status, 200);
  assert.deepEqual((await scopesOf(none)).scopes, { tabs: [TAB], projects: {} });
  assert.equal(await sees(none, CLOSED), true);
  // Con el área entera abierta, un proyecto no se cierra suelto.
  assert.equal(status(await openTo({ userId, projectId: CLOSED, open: false })), '409 TAB_OPEN');
  for (const scopes of ['*', null, [TAB], { tabs: [uuid()] }, { tabs: [], projects: { [TAB]: [uuid()] } }, { tabs: [], all: true }]) {
    assert.equal(status(await openTo({ userId, scopes })), '422 INVALID_SCOPES', JSON.stringify(scopes));
  }
  assert.equal(status(await openTo({ userId, scopes: { tabs: [] } }, app.tokens.editor)), '403 FORBIDDEN');
  assert.equal(status(await openTo({ userId, scopes: { tabs: [] } }, open)), '403 FORBIDDEN');
  assert.equal(status(await openTo({ userId: app.users.reader, scopes: { tabs: [] } })), '422 NOT_OUTSIDER');
  // GET members los lista con su rol.
  const members = await app.call('/api/v1/members', { token: app.tokens.owner });
  assert.equal(members.data.find((m: any) => m.userId === userId)?.role, 'outsider');
});
