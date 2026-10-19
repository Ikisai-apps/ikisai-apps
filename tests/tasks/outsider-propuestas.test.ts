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
import {
  DomainError, createTabOps, outsiderScopes, outsiderScopesFrom, outsiderScopesWith, suggestNoteOps, suggestStepOps, suggestTaskOps, suggestionVisibleFor,
  type Dataset, type Operation,
} from '../../packages/domain-tasks/src/index.ts';

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
/** `detail` de un añadido, como lo manda la interfaz: la tarea, su proyecto y su área (el servidor lo comprueba). */
const about = (taskId: string, projectId = OPEN) => ({ kind: 'anadido', taskId, projectId, tabId: TAB });
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
  const a = await suggest(open, 'anadido', 'Una línea en «Plantar tomates»', [note], about(T_OPEN));
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const b = await suggest(open, 'anadido', 'Un paso en «Plantar tomates»', child, about(T_OPEN));
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

test('O1 · paso 3: `detail` tiene que nombrar el destino de verdad (lo usa suggestionVisible)', async () => {
  const task = await row('tasks.tasks', T_OPEN);
  const note = [{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: Number(task.revision), fields: { note: task.note + '\nOtra.' } } as Operation];
  // Sin detail, con otro proyecto, otra área u otra tarea: no.
  assert.equal(status(await suggest(open, 'anadido', 'Sin detalle', note)), '422 INCONSISTENT_KEYS');
  assert.equal(status(await suggest(open, 'anadido', 'Otro proyecto', note, about(T_OPEN, CLOSED))), '422 INCONSISTENT_KEYS');
  assert.equal(status(await suggest(open, 'anadido', 'Otra área', note, { ...about(T_OPEN), tabId: uuid() })), '422 INCONSISTENT_KEYS');
  assert.equal(status(await suggest(open, 'anadido', 'Otra tarea', note, about(T_CLOSED))), '422 INCONSISTENT_KEYS');
  // Un añadido toca una sola tarea.
  const closed = await row('tasks.tasks', T_CLOSED);
  const two = [...note, { op: 'update', table: 'tasks.tasks', id: T_CLOSED, expectedRevision: Number(closed.revision), fields: { note: 'x' } } as Operation];
  assert.match(status(await suggest(open, 'anadido', 'Dos tareas', two, about(T_OPEN))), /^403 /);
  // Una tarea nueva con otro proyecto en detail, tampoco.
  assert.equal(status(await suggest(open, 'tarea', 'Mentira', newTaskOps(OPEN, 'Mentira'), { kind: 'tarea', projectId: SECOND, tabId: TAB })), '422 INCONSISTENT_KEYS');
});

test('O1 · paso 3: si el lote ya no encaja (la nota cambió), aprobar falla y la propuesta sigue pendiente', async () => {
  const task = await row('tasks.tasks', T_OPEN);
  const a = await suggest(open, 'anadido', 'Otra línea', [{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: Number(task.revision), fields: { note: task.note + '\nY regarlos.' } } as Operation], about(T_OPEN));
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
  // Un PDF ni se sube (#572: el outsider solo sube imágenes pequeñas).
  assert.equal(status(await app.call('/api/v1/uploads', { body: { filename: 'papel.pdf', mime: 'application/pdf', size: 2, sha256: '0'.repeat(64) }, token: open })), '422 UNSUPPORTED_MEDIA');
  const res = await suggest(open, 'tarea', 'Arreglar la valla', [...ops, attachment(mine)]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await decide(res.data.id, 'approve')).status, 200);
  assert.deepEqual((await rows(`select file_id from tasks.attachments where task_id = $1`, [taskId])).map((r) => r.file_id), [mine.id]);
  // El outsider sigue sin poder escribir adjuntos por su cuenta.
  assert.equal(status(await commit([insert('tasks.attachments', uuid(), { tab_id: TAB, project_id: OPEN, task_id: T_OPEN, name: 'x.webp', mime: 'image/webp', size: mine.size, sha256: mine.sha, file_id: mine.id, position: 1 })], open)), '403 FORBIDDEN');
});

const scopesOf = async (token: string) => (await rows(`select role, scopes, revision from core.memberships where app = 'tasks' and user_id = $1`, [users.get(token)]))[0];
/** C24: `POST members {userId, role: 'outsider', scopes}`, como lo llama la interfaz. */
const setScopes = (userId: string | undefined, scopes: unknown, token = app.tokens.owner) => app.call('/api/v1/members', { body: { userId, role: 'outsider', scopes }, token });
const sees = async (token: string, projectId: string) => {
  const snap = await app.call('/api/v1/snapshot', { token });
  return snap.data.tables.find((t: any) => t.table === 'tasks.projects').rows.some((r: any) => r.id === projectId);
};

test('O1 · paso 4 (dominio): «Abrir a…» abre y cierra un proyecto en los ámbitos; nunca «toda la app»', () => {
  const P = uuid(), Q = uuid(), A = uuid(), B = uuid();
  assert.deepEqual(outsiderScopes(null), { tabs: [], projects: {} }, 'nulo es nada para él');
  assert.deepEqual(outsiderScopes('*'), { tabs: [], projects: {} });
  assert.deepEqual(outsiderScopes([A]), { tabs: [A], projects: {} }, 'la forma de lista son áreas completas');
  assert.deepEqual(outsiderScopesWith(null, { tabId: A, projectId: P, open: true }), { tabs: [], projects: { [A]: [P] } });
  assert.deepEqual(outsiderScopesWith({ tabs: [], projects: { [A]: [P] } }, { tabId: A, projectId: Q, open: true }), { tabs: [], projects: { [A]: [P, Q] } });
  assert.deepEqual(outsiderScopesWith({ tabs: [], projects: { [A]: [P] } }, { tabId: A, projectId: P, open: true }), { tabs: [], projects: { [A]: [P] } }, 'sin repetir');
  assert.deepEqual(outsiderScopesWith({ tabs: [], projects: { [A]: [P, Q] } }, { tabId: A, projectId: P, open: false }), { tabs: [], projects: { [A]: [Q] } });
  assert.deepEqual(outsiderScopesWith({ tabs: [], projects: { [A]: [P] } }, { tabId: A, projectId: P, open: false }), { tabs: [], projects: {} }, 'sin listas vacías');
  assert.deepEqual(outsiderScopesWith({ tabs: [A], projects: {} }, { tabId: A, projectId: P, open: true }), { tabs: [A], projects: {} }, 'ya la tiene entera');
  assert.throws(() => outsiderScopesWith({ tabs: [A], projects: {} }, { tabId: A, projectId: P, open: false }), (e: unknown) => e instanceof DomainError && e.code === 'TAB_OPEN');
  // Cuentas de personas: un proyecto suelto de un área abierta entera no se guarda aparte.
  assert.deepEqual(outsiderScopesFrom([A], { [A]: [P], [B]: [Q, Q] }), { tabs: [A], projects: { [B]: [Q] } });
  assert.deepEqual(outsiderScopesFrom([], {}), { tabs: [], projects: {} });
});

test('O1 · paso 4: «Abrir a…» con POST members (C24) abre y cierra un proyecto, y el outsider pasa a verlo', async () => {
  assert.equal(await sees(open, SECOND), false);
  const before = await scopesOf(open);
  const res = await setScopes(users.get(open), outsiderScopesWith(before.scopes, { tabId: TAB, projectId: SECOND, open: true }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = await scopesOf(open);
  assert.deepEqual(after.scopes, { tabs: [], projects: { [TAB]: [OPEN, SECOND] } });
  assert.equal(Number(after.revision), Number(before.revision) + 1);
  assert.equal(after.role, 'outsider', 'el rol no se toca');
  assert.equal(await sees(open, SECOND), true);
  // Ya puede proponer ahí.
  assert.equal((await suggest(open, 'tarea', 'Ventilar', newTaskOps(SECOND, 'Ventilar'))).status, 200);
  // Cerrar.
  assert.equal((await setScopes(users.get(open), outsiderScopesWith(after.scopes, { tabId: TAB, projectId: SECOND, open: false }))).status, 200);
  assert.deepEqual((await scopesOf(open)).scopes, { tabs: [], projects: { [TAB]: [OPEN] } });
  assert.equal(await sees(open, SECOND), false);
  // Al de sin nada se le abre su primer proyecto (su `scopes` nulo, que era nada, pasa a objeto).
  assert.equal((await setScopes(users.get(none), outsiderScopesWith((await scopesOf(none)).scopes, { tabId: TAB, projectId: OPEN, open: true }))).status, 200);
  assert.deepEqual((await scopesOf(none)).scopes, { tabs: [], projects: { [TAB]: [OPEN] } });
});

test('O1 · paso 4: Cuentas de personas fija áreas y proyectos con POST members; nunca toda la app, y solo la propietaria', async () => {
  const userId = users.get(none);
  assert.equal((await setScopes(userId, outsiderScopesFrom([TAB], {}))).status, 200);
  assert.deepEqual((await scopesOf(none)).scopes, { tabs: [TAB], projects: {} });
  assert.equal(await sees(none, CLOSED), true);
  // Nulo o «*» serían toda la app: el núcleo no los admite para un outsider.
  assert.equal(status(await setScopes(userId, null)), '422 INVALID_OPERATION');
  assert.equal(status(await setScopes(userId, '*')), '422 INVALID_OPERATION');
  assert.equal((await scopesOf(none)).role, 'outsider');
  assert.equal(status(await setScopes(userId, { tabs: [] }, app.tokens.editor)), '403 FORBIDDEN');
  assert.equal(status(await setScopes(userId, { tabs: [] }, open)), '403 FORBIDDEN');
  // A quien no es outsider no se le da el rol por aquí (lo da el nivel de casa).
  assert.equal(status(await setScopes(app.users.reader, { tabs: [] })), '422 INVALID_ROLE');
  // «No abrirle nada».
  assert.equal((await setScopes(userId, outsiderScopesFrom([], {}))).status, 200);
  assert.equal(await sees(none, CLOSED), false);
  assert.equal((await setScopes(userId, outsiderScopesFrom([TAB], {}))).status, 200);
  // GET members los lista con su rol.
  const members = await app.call('/api/v1/members', { token: app.tokens.owner });
  assert.equal(members.data.find((m: any) => m.userId === userId)?.role, 'outsider');
});

test('O1 · suggestionVisible (dominio): el destino de cada insert y la tarea de un añadido, en los ámbitos', () => {
  const A = uuid(), P = uuid(), Q = uuid(), T = uuid(), S = uuid();
  const onlyP = { tabs: [], projects: { [A]: [P] } };
  const task = (project: string, extra: Record<string, unknown> = {}) => insert('tasks.tasks', S, { tab_id: A, project_id: project, title: 'x', ...extra });
  assert.equal(suggestionVisibleFor({ operations: [task(Q)] }, '*'), true, 'con todo, todas');
  assert.equal(suggestionVisibleFor({ operations: [task(Q)] }, null), true);
  assert.equal(suggestionVisibleFor({ operations: [task(P)] }, onlyP), true);
  assert.equal(suggestionVisibleFor({ operations: [task(Q)] }, onlyP), false);
  assert.equal(suggestionVisibleFor({ operations: [task(Q)] }, { tabs: [A] }), true, 'el área entera');
  assert.equal(suggestionVisibleFor({ operations: [task(P), insert('tasks.task_labels', uuid(), { tab_id: A, project_id: Q, task_id: S, label_id: uuid() })] }, onlyP), false, 'todo el lote');
  assert.equal(suggestionVisibleFor({ operations: [insert('tasks.tasks', S, { title: 'sin claves' })] }, onlyP), false);
  // Añadido: la nota, por la tarea que nombra detail; el paso reabre a su madre.
  const note: Operation = { op: 'update', table: 'tasks.tasks', id: T, expectedRevision: 1, fields: { note: 'y' } };
  assert.equal(suggestionVisibleFor({ operations: [note], detail: { taskId: T, projectId: P, tabId: A } }, onlyP), true);
  assert.equal(suggestionVisibleFor({ operations: [note], detail: { taskId: T, projectId: Q, tabId: A } }, onlyP), false);
  assert.equal(suggestionVisibleFor({ operations: [note], detail: { taskId: uuid(), projectId: P, tabId: A } }, onlyP), false, 'otra tarea');
  assert.equal(suggestionVisibleFor({ operations: [note] }, onlyP), false, 'sin detail');
  assert.equal(suggestionVisibleFor({ operations: [task(P, { parent_id: T }), { ...note, fields: { done: false } }] }, onlyP), true);
  assert.equal(suggestionVisibleFor({ operations: [{ op: 'delete', table: 'tasks.tasks', id: T, expectedRevision: 1 }] }, onlyP), false);
  assert.equal(suggestionVisibleFor({ operations: [] }, onlyP), false);
});

test('O1 · suggestionVisible: un editor de un solo proyecto no ve ni decide las propuestas de otro; las suyas, sí', async () => {
  const brisa = await outsider({ tabs: [], projects: { [TAB]: [OPEN, SECOND] } }, 'Voluntaria Brisa');
  const editorId = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'editor', $2::jsonb)`, [editorId, JSON.stringify({ tabs: [], projects: { [TAB]: [OPEN] } })]);
  const scoped = app.supabase.tokenFor(editorId);
  const mine = await suggest(brisa, 'tarea', 'Recoger lechugas', newTaskOps(OPEN, 'Recoger lechugas'), { kind: 'tarea', projectId: OPEN, tabId: TAB, title: 'Recoger lechugas' });
  const other = await suggest(brisa, 'tarea', 'Abrir el invernadero', newTaskOps(SECOND, 'Abrir el invernadero'), { kind: 'tarea', projectId: SECOND, tabId: TAB, title: 'Abrir el invernadero' });
  const task = await row('tasks.tasks', T_OPEN);
  const line = await suggest(brisa, 'anadido', 'Una línea', [{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: Number(task.revision), fields: { note: task.note + '\nCon cuidado.' } } as Operation], about(T_OPEN));
  for (const r of [mine, other, line]) assert.equal(r.status, 200, JSON.stringify(r.data));

  // Listas y contador: solo lo de su proyecto.
  const pending = await app.call('/api/v1/suggestions?scope=pending&limit=100', { token: scoped });
  assert.equal(pending.status, 200, JSON.stringify(pending.data));
  const ids = pending.data.items.map((s: any) => s.id);
  assert.ok(ids.includes(mine.data.id) && ids.includes(line.data.id), 've las suyas, también el añadido');
  assert.equal(ids.includes(other.data.id), false, 'no ve la del otro proyecto');
  assert.ok(pending.data.items.every((s: any) => suggestionVisibleFor(s, { tabs: [], projects: { [TAB]: [OPEN] } })));
  assert.equal(pending.data.pendingCount, pending.data.items.length, 'el contador tampoco la cuenta');
  const all = await app.call('/api/v1/suggestions?scope=all&limit=100', { token: scoped });
  assert.equal(all.data.items.some((s: any) => s.id === other.data.id), false);
  const ownerPending = await app.call('/api/v1/suggestions?scope=pending&limit=100', { token: app.tokens.owner });
  assert.ok(ownerPending.data.items.some((s: any) => s.id === other.data.id), 'la propietaria la ve');
  assert.ok(ownerPending.data.pendingCount > pending.data.pendingCount, 'y la cuenta');

  // Previsualizar, aprobar o descartar la otra: 404, como si no existiera.
  assert.equal(status(await app.call(`/api/v1/suggestions/${other.data.id}/preview`, { body: {}, token: scoped })), '404 NOT_FOUND');
  assert.equal(status(await decide(other.data.id, 'approve', {}, scoped)), '404 NOT_FOUND');
  assert.equal(status(await decide(other.data.id, 'reject', { comment: 'No' }, scoped)), '404 NOT_FOUND');
  // Ni llevarse la suya a otro proyecto con el lote corregido.
  assert.equal(status(await decide(mine.data.id, 'approve', { operations: newTaskOps(SECOND, 'Recoger lechugas') }, scoped)), '404 NOT_FOUND');

  // Las suyas: previsualiza y aprueba.
  assert.equal((await app.call(`/api/v1/suggestions/${mine.data.id}/preview`, { body: {}, token: scoped })).status, 200);
  const approved = await decide(mine.data.id, 'approve', {}, scoped);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal((await row('tasks.tasks', mine.data.operations[0].id)).updated_by, editorId);
  assert.equal((await decide(line.data.id, 'approve', {}, scoped)).status, 200);
  // La otra sigue pendiente para la propietaria.
  assert.equal((await decide(other.data.id, 'reject', { comment: 'Más adelante' }, app.tokens.owner)).status, 200);
});

/** El espejo de quien propone, leído de su snapshot (lo que tiene la interfaz). */
async function mirror(token: string): Promise<Dataset> {
  const snap = await app.call('/api/v1/snapshot', { token });
  const data: any = {};
  for (const t of snap.data.tables) data[t.table] = t.rows;
  for (const name of ['tasks.tasks', 'tasks.projects', 'tasks.project_labels', 'tasks.project_spaces', 'tasks.project_trades', 'tasks.project_people']) data[name] ??= [];
  return data as Dataset;
}

test('O1 · paso 3: los lotes que construye la interfaz (dominio) pasan la comprobación del servidor', async () => {
  const data = await mirror(open);
  const task = suggestTaskOps(data, { projectId: OPEN, title: 'Desbrozar', note: 'Junto al pozo' });
  assert.deepEqual(task.map((o) => o.table), ['tasks.tasks', 'tasks.task_labels']);
  assert.equal((await suggest(open, 'tarea', 'Desbrozar', task)).status, 200);
  assert.equal((await suggest(open, 'anadido', 'Paso', suggestStepOps(data, { taskId: T_OPEN, title: 'Afilar la azada' }), about(T_OPEN))).status, 200);
  assert.equal((await suggest(open, 'anadido', 'Nota', suggestNoteOps(data, { taskId: T_OPEN, line: 'Con guantes.' }), about(T_OPEN))).status, 200);
  assert.throws(() => suggestTaskOps(data, { projectId: OPEN, title: '   ' }), /título/);
});
