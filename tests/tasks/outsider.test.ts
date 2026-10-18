/**
 * Ikisai Tasks · O1 (RECURSOS.md §14.2, docs/tasks/API.md §31). Paso 1: el outsider no ve nada por defecto. Su pertenencia
 * nace del nivel de casa con `scopes` vacío, y para él vacío o «*» es nada. Solo ve las áreas o proyectos que se le abren
 * en sus ámbitos; nunca compras, Entrada ni vistas guardadas. Paso 2: ahí marca hecha (solo `done`) y comenta, con una foto;
 * los comentarios son para todos (el lector no escribe), cada uno toca los suyos y la propietaria borra cualquiera.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { addCommentOps, createTabOps, moveTaskOps, type Dataset, type Operation } from '../../packages/domain-tasks/src/index.ts';
import { effectiveScopes, visible } from '../../supabase/functions/_domain/tasks/mod.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const insert = (table: string, id: string, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });

let app: TestApp;
let sequence = 0;
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `o1-${++sequence}`, operations }, ...(token ? { token } : {}) });
async function ok(operations: Operation[]) {
  const result = await commit(operations);
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
const userOf = new Map<string, string>();
/** Un outsider como lo deja `core.apply_house_level`: pertenencia `outsider` con los ámbitos que se le den. */
async function outsider(scopes: unknown): Promise<string> {
  const id = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'outsider', $2::jsonb)`, [id, scopes === null ? null : JSON.stringify(scopes)]);
  await app.t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Voluntaria Lúa')`, [id]);
  const token = app.supabase.tokenFor(id);
  userOf.set(token, id);
  return token;
}

const TAB = uuid(), INBOX = uuid(), OTHER = uuid(), OPEN = uuid(), CLOSED = uuid(), T_OPEN = uuid(), T_CLOSED = uuid(), T_OTHER = uuid(), VIEW = uuid(), SUPPLY = uuid();
let none: string, star: string, project: string, area: string;

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024, inboxId: INBOX }));
  await ok(createTabOps({ id: OTHER, name: 'Gestiones', position: 2048 }));
  const otherProject = uuid();
  await ok([
    insert('tasks.projects', OPEN, { tab_id: TAB, title: 'Jardín', position: 2048 }),
    insert('tasks.projects', CLOSED, { tab_id: TAB, title: 'Cuentas', position: 3072 }),
    insert('tasks.projects', otherProject, { tab_id: OTHER, title: 'Papeles', position: 2048 }),
    insert('tasks.saved_views', VIEW, { tab_id: TAB, name: 'Pendientes', filters: { _state: ['pending'] } }),
    insert('tasks.supply_items', SUPPLY, { tab_id: TAB, name: 'Cloro', category: 'pool', unit: 'kg', position: 1024 }),
  ]);
  await ok([
    insert('tasks.tasks', T_OPEN, { tab_id: TAB, project_id: OPEN, title: 'Podar el seto', position: 1024 }),
    insert('tasks.tasks', T_CLOSED, { tab_id: TAB, project_id: CLOSED, title: 'Pagar al gestor en secreto', position: 1024 }),
    insert('tasks.tasks', T_OTHER, { tab_id: OTHER, project_id: otherProject, title: 'Renovar el seguro en secreto', position: 1024 }),
  ]);
  none = await outsider(null);
  star = await outsider('*');
  project = await outsider({ tabs: [], projects: { [TAB]: [OPEN] } });
  area = await outsider({ tabs: [TAB], projects: {} });
});
test.after(async () => { await app.close(); });

const snapshot = async (token: string) => {
  const snap = await app.call('/api/v1/snapshot', { token });
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return (table: string) => (snap.data.tables.find((t: any) => t.table === table)?.rows ?? []) as any[];
};
const everything = async (token: string) => JSON.stringify([
  (await app.call('/api/v1/snapshot', { token })).data,
  (await app.call('/api/v1/changes?after=0', { token })).data,
  (await app.call('/api/v1/history', { token })).data,
]);

test('O1 · dominio: para el outsider, ámbitos vacíos o «*» son nada; para los demás roles, toda la app como siempre', () => {
  assert.deepEqual(effectiveScopes({ role: 'outsider', scopes: null }), { tabs: [], projects: {} });
  assert.deepEqual(effectiveScopes({ role: 'outsider', scopes: '*' }), { tabs: [], projects: {} });
  assert.deepEqual(effectiveScopes({ role: 'outsider', scopes: { tabs: [TAB] } }), { tabs: [TAB] });
  assert.equal(effectiveScopes({ role: 'editor', scopes: null }), null);
  const row = { id: T_OPEN, tab_id: TAB, project_id: OPEN };
  assert.equal(visible('tasks.tasks', row, { membership: { role: 'outsider', scopes: null } }), false);
  assert.equal(visible('tasks.tasks', row, { membership: { role: 'reader', scopes: null } }), true);
  // Ni el catálogo General (tab_id nulo) ni los ajustes dejan pasar a un outsider sin nada abierto… salvo los ajustes, que no dicen nada de nadie.
  assert.equal(visible('tasks.labels', { id: uuid(), tab_id: null }, { membership: { role: 'outsider', scopes: null } }), true);
});

test('O1 · sin nada abierto (como nace del nivel de casa) no ve ninguna tarea, proyecto ni área, ni por cambios ni por historial', async () => {
  for (const token of [none, star]) {
    const rows = await snapshot(token);
    for (const table of ['tasks.tabs', 'tasks.projects', 'tasks.tasks', 'tasks.task_labels', 'tasks.attachments']) assert.deepEqual(rows(table), [], table);
    const all = await everything(token);
    for (const secret of ['Podar el seto', 'Pagar al gestor', 'Renovar el seguro', 'Mantenimiento', 'Jardín']) assert.equal(all.includes(secret), false, secret);
  }
});

test('O1 · con un proyecto abierto ve ese proyecto y sus tareas, y nada más del área', async () => {
  const rows = await snapshot(project);
  assert.deepEqual(rows('tasks.tabs').map((r) => r.id), [TAB]);
  assert.deepEqual(rows('tasks.projects').map((r) => r.id), [OPEN]);
  assert.deepEqual(rows('tasks.tasks').map((r) => r.id), [T_OPEN]);
  const all = await everything(project);
  for (const secret of ['Pagar al gestor', 'Renovar el seguro', 'Gestiones']) assert.equal(all.includes(secret), false, secret);
});

test('O1 · con el área abierta ve sus proyectos, pero nunca compras, almacén ni vistas guardadas', async () => {
  const rows = await snapshot(area);
  assert.deepEqual(rows('tasks.projects').map((r) => r.id).sort(), [INBOX, OPEN, CLOSED].sort());
  assert.deepEqual(rows('tasks.supply_items'), []);
  assert.deepEqual(rows('tasks.saved_views'), []);
  assert.deepEqual(rows('tasks.request_routes'), []);
  assert.equal((await everything(area)).includes('Renovar el seguro'), false);
});

const status = (result: { status: number; data: any }) => `${result.status} ${result.data?.error?.code ?? ''}`.trim();
const row = async (table: string, id: string) => (await app.t.db.query<any>(`select * from ${table} where id = $1`, [id])).rows[0];
const setDone = async (id: string, done: boolean, token: string) =>
  commit([{ op: 'update', table: 'tasks.tasks', id, expectedRevision: (await row('tasks.tasks', id)).revision, fields: { done } }], token);
const comment = (taskId: string, project: string, body: string, extra: Record<string, unknown> = {}, id = uuid()) =>
  insert('tasks.task_comments', id, { tab_id: TAB, project_id: project, task_id: taskId, body, ...extra });
/** Lote directo a `core.commit`, sin el dominio de la Edge: lo que tiene que parar el SQL por sí solo. */
const sqlCommit = (actor: string, operations: Operation[]) =>
  app.t.db.query(`select core.commit('tasks', $1, $2, 'sin-digest', null, $3::jsonb)`, [actor, `o1-sql-${++sequence}`, JSON.stringify(operations)]).then(() => 'ok', (error: Error) => error.message);
async function upload(token: string, bytes: Uint8Array, mime: string, filename: string): Promise<string> {
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename, mime, size: bytes.byteLength, sha256: sha }, token });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {}, token })).data.verified, true);
  return ticket.data.id;
}
const photo = (id: string, token: string) => app.handler(new Request(`${app.supabase.url}/functions/v1/tasks-api/api/v1/comments/${id}/photo`, { headers: { Origin: origin, Authorization: 'Bearer ' + token } }));

test('O1 · paso 2: con un proyecto abierto, el outsider marca y desmarca hecha una tarea de ese proyecto', async () => {
  assert.equal(status(await setDone(T_OPEN, true, project)), '200');
  assert.equal((await row('tasks.tasks', T_OPEN)).done, true);
  assert.equal(status(await setDone(T_OPEN, false, project)), '200');
  assert.equal((await row('tasks.tasks', T_OPEN)).done, false);
  // Con el área entera abierta, también las del resto de proyectos del área.
  assert.equal(status(await setDone(T_CLOSED, true, area)), '200');
  assert.equal(status(await setDone(T_CLOSED, false, area)), '200');
});

test('O1 · paso 2: no cambia el título ni la nota, ni crea ni borra tareas (tampoco saltándose la Edge)', async () => {
  const revision = (await row('tasks.tasks', T_OPEN)).revision;
  for (const fields of [{ title: 'Otra cosa' }, { note: 'Nota intrusa' }, { done: true, title: 'Otra cosa' }]) {
    assert.equal(status(await commit([{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: revision, fields }], project)), '403 FORBIDDEN', JSON.stringify(fields));
  }
  assert.equal(status(await commit([insert('tasks.tasks', uuid(), { tab_id: TAB, project_id: OPEN, title: 'Intrusa', position: 9 })], project)), '403 FORBIDDEN');
  assert.equal(status(await commit([{ op: 'delete', table: 'tasks.tasks', id: T_OPEN, expectedRevision: revision }], project)), '403 FORBIDDEN');
  assert.equal(status(await commit([insert('tasks.attachments', uuid(), { tab_id: TAB, project_id: OPEN, task_id: T_OPEN, name: 'x.png', mime: 'image/png', size: 1, sha256: 'a'.repeat(64), file_id: uuid() })], project)), '403 FORBIDDEN');
  // El SQL es la autoridad: directo a core.commit, ni el título ni borrar.
  const actor = userOf.get(project)!;
  assert.match(await sqlCommit(actor, [{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: revision, fields: { title: 'Por SQL' } }]), /FORBIDDEN/);
  assert.match(await sqlCommit(actor, [{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: revision, fields: { done: true, note: 'Por SQL' } }]), /FORBIDDEN/);
  assert.match(await sqlCommit(actor, [{ op: 'delete', table: 'tasks.tasks', id: T_OPEN, expectedRevision: revision }]), /FORBIDDEN/);
  const task = await row('tasks.tasks', T_OPEN);
  assert.equal(task.title, 'Podar el seto');
  assert.equal(task.note, '');
  assert.equal(task.deleted_at, null);
});

test('O1 · paso 2: no marca una tarea de otro proyecto, ni nada sin lo abierto (ni con «*»)', async () => {
  assert.equal(status(await setDone(T_CLOSED, true, project)), '403 FORBIDDEN');
  assert.equal(status(await setDone(T_OTHER, true, area)), '403 FORBIDDEN');
  for (const token of [none, star]) assert.equal(status(await setDone(T_OPEN, true, token)), '403 FORBIDDEN');
  for (const id of [T_CLOSED, T_OTHER, T_OPEN]) assert.equal((await row('tasks.tasks', id)).done, false);
});

test('O1 · paso 2: las reglas de «hecha» siguen igual para el outsider: una tarea bloqueada no se marca', async () => {
  const blocked = uuid();
  await ok([insert('tasks.tasks', blocked, { tab_id: TAB, project_id: OPEN, title: 'Barnizar el banco', position: 4096 })]);
  await ok([insert('tasks.task_dependencies', uuid(), { tab_id: TAB, project_id: OPEN, task_id: blocked, depends_on_id: T_CLOSED, position: 1024 })]);
  const result = await setDone(blocked, true, project);
  assert.equal(status(result), '422 TASK_BLOCKED');
  // La condición está fuera de su ámbito: no se revela cuál es.
  assert.equal(JSON.stringify(result.data).includes(T_CLOSED), false);
});

let ownComment = '';
test('O1 · paso 2: comenta en una tarea de lo abierto y no en otra; el autor lo pone el servidor', async () => {
  ownComment = uuid();
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'He podado la mitad; mañana sigo.', {}, ownComment)], project)), '200');
  const saved = await row('tasks.task_comments', ownComment);
  assert.equal(saved.author_id, userOf.get(project));
  assert.equal(saved.author_name, 'Voluntaria Lúa');
  assert.equal(status(await commit([comment(T_CLOSED, CLOSED, 'Aquí no')], project)), '403 FORBIDDEN');
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'Sin nada abierto')], none)), '403 FORBIDDEN');
  // Ni con las claves de su proyecto colgando de una tarea de otro (el SQL lo para).
  assert.equal(status(await commit([comment(T_CLOSED, OPEN, 'Disfrazado')], project)), '422 INCONSISTENT_KEYS');
  assert.equal(status(await commit([comment(T_OPEN, OPEN, '')], project)), '422 INVALID_COMMENT');
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'x'.repeat(2001))], project)), '422 INVALID_COMMENT');
  // El autor no se elige.
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'Suplantación', { author_id: app.users.owner })], project)), '422 INVALID_FIELDS');
});

test('O1 · paso 2: el editor comenta y el lector no', async () => {
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'Gracias, lo reviso.')], app.tokens.editor)), '200');
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'Yo también')], app.tokens.reader)), '403 FORBIDDEN');
  assert.match(await sqlCommit(app.users.reader, [comment(T_OPEN, OPEN, 'Por SQL')]), /FORBIDDEN/);
});

test('O1 · paso 2: cada uno edita o borra solo lo suyo; la propietaria borra cualquiera', async () => {
  const theirs = uuid();
  await ok([comment(T_OPEN, OPEN, 'Comentario de la propietaria', {}, theirs)]);
  const edit = async (id: string, body: string, token: string) =>
    commit([{ op: 'update', table: 'tasks.task_comments', id, expectedRevision: (await row('tasks.task_comments', id)).revision, fields: { body } }], token);
  const remove = async (id: string, token: string) =>
    commit([{ op: 'delete', table: 'tasks.task_comments', id, expectedRevision: (await row('tasks.task_comments', id)).revision }], token);
  assert.equal(status(await edit(ownComment, 'He podado todo el seto.', project)), '200');
  assert.equal((await row('tasks.task_comments', ownComment)).body, 'He podado todo el seto.');
  assert.equal(status(await edit(theirs, 'Cambiado por la voluntaria', project)), '403 FORBIDDEN');
  assert.equal(status(await remove(theirs, project)), '403 FORBIDDEN');
  assert.equal(status(await edit(ownComment, 'Cambiado por el editor', app.tokens.editor)), '403 FORBIDDEN');
  assert.equal(status(await remove(ownComment, app.tokens.editor)), '403 FORBIDDEN');
  // La propietaria no reescribe lo ajeno, pero sí lo borra.
  assert.equal(status(await edit(ownComment, 'Cambiado por la propietaria', app.tokens.owner)), '403 FORBIDDEN');
  const mine = uuid();
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'Para borrar', {}, mine)], project)), '200');
  assert.equal(status(await remove(mine, project)), '200');
  assert.equal(status(await remove(ownComment, app.tokens.owner)), '200');
  assert.notEqual((await row('tasks.task_comments', ownComment)).deleted_at, null);
});

test('O1 · paso 2: un comentario de una tarea que no ve no le llega por snapshot ni por cambios', async () => {
  await ok([comment(T_CLOSED, CLOSED, 'Comentario secreto de las cuentas')]);
  const rows = await snapshot(project);
  assert.ok(rows('tasks.task_comments').length > 0);
  assert.ok(rows('tasks.task_comments').every((c) => c.project_id === OPEN));
  const all = await everything(project);
  assert.equal(all.includes('Comentario secreto'), false);
  assert.equal((await everything(none)).includes('Comentario'), false);
  // Con el área entera, sí.
  assert.equal((await everything(area)).includes('Comentario secreto'), true);
});

test('O1 · paso 2: la foto del outsider solo vale para comentarios, es una imagen suya y se descarga como su tarea', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const file = await upload(project, png, 'image/png', 'seto.png');
  const sha = (await row('core.files', file)).sha256;
  const attachment = () => insert('tasks.attachments', uuid(), { tab_id: TAB, project_id: OPEN, task_id: T_OPEN, name: 'seto.png', mime: 'image/png', size: png.byteLength, sha256: sha, file_id: file });
  // No como adjunto de la tarea…
  assert.equal(status(await commit([attachment()], project)), '403 FORBIDDEN');
  assert.match(await sqlCommit(userOf.get(project)!, [attachment()]), /FORBIDDEN/);
  // …sí en un comentario.
  const withPhoto = uuid();
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'Así ha quedado', { file_id: file }, withPhoto)], project)), '200');
  // Un PDF, o una foto subida por otra persona, no valen como foto.
  const pdf = await upload(project, new TextEncoder().encode('%PDF-1.4 no es una foto'), 'application/pdf', 'nota.pdf');
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'PDF', { file_id: pdf })], project)), '422 FILE_NOT_UPLOADED');
  const foreign = await upload(app.tokens.owner, new Uint8Array([9, 9, 9]), 'image/webp', 'ajena.webp');
  assert.equal(status(await commit([comment(T_OPEN, OPEN, 'Ajena', { file_id: foreign })], project)), '422 FILE_NOT_UPLOADED');
  // Descarga: la ve quien ve la tarea (también la propietaria y el lector); no quien no la ve.
  for (const token of [project, area, app.tokens.owner, app.tokens.reader]) {
    const response = await photo(withPhoto, token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  }
  const hidden = uuid();
  await ok([comment(T_CLOSED, CLOSED, 'Foto de las cuentas', { file_id: foreign }, hidden)]);
  assert.equal((await photo(hidden, project)).status, 404);
  assert.equal((await photo(withPhoto, none)).status, 404);
  assert.equal((await photo(uuid(), app.tokens.owner)).status, 404);
  assert.equal((await photo('no-es-uuid', app.tokens.owner)).status, 404);
});

test('O1 · paso 2: los comentarios siguen a su tarea al moverla, sean de quien sean', async () => {
  const task = uuid(), note = uuid();
  await ok([insert('tasks.tasks', task, { tab_id: TAB, project_id: OPEN, title: 'Regar los geranios', position: 8192 })]);
  assert.equal(status(await commit([comment(task, OPEN, 'Los riego yo los martes', {}, note)], project)), '200');
  const data: Record<string, unknown[]> = { 'tasks.tasks': [await row('tasks.tasks', task)], 'tasks.projects': [await row('tasks.projects', CLOSED)], 'tasks.task_comments': [await row('tasks.task_comments', note)] };
  for (const table of ['tasks.task_labels', 'tasks.task_spaces', 'tasks.task_trades', 'tasks.task_people', 'tasks.task_dependencies', 'tasks.attachments']) data[table] = [];
  const dataset = data as unknown as Dataset;
  const operations = moveTaskOps(dataset, task, { project_id: CLOSED });
  assert.ok(operations.some((op) => op.table === 'tasks.task_comments'));
  // Sin mover el comentario, el lote no pasa.
  assert.equal(status(await commit(operations.filter((op) => op.table !== 'tasks.task_comments'), app.tokens.editor)), '422 INCONSISTENT_KEYS');
  assert.equal(status(await commit(operations, app.tokens.editor)), '200');
  assert.equal((await row('tasks.task_comments', note)).project_id, CLOSED);
  // Ya no está en lo que la voluntaria tiene abierto (el historial conserva lo que vio cuando sí lo estaba).
  assert.equal((await snapshot(project))('tasks.task_comments').some((c) => c.id === note), false);
  // Y addCommentOps toma las claves de la tarea.
  const [op] = addCommentOps(dataset, task, '  Hola  ', null, () => 'id-fijo');
  assert.deepEqual(op!.fields, { tab_id: TAB, project_id: OPEN, task_id: task, body: 'Hola', file_id: null });
});

test('O1 · paso 2: los comentarios pasan con su tarea al convertir un área y van a la papelera con ella al vaciarla', async () => {
  const source = uuid(), sourceInbox = uuid(), live = uuid(), gone = uuid(), onLive = uuid(), onGone = uuid();
  await ok(createTabOps({ id: source, name: 'Huerto', position: 4096, inboxId: sourceInbox }));
  await ok([insert('tasks.tasks', live, { tab_id: source, project_id: sourceInbox, title: 'Plantar tomates', position: 1024 }),
    insert('tasks.tasks', gone, { tab_id: source, project_id: sourceInbox, title: 'Quitar malas hierbas', position: 2048 })]);
  await ok([comment(live, sourceInbox, 'Semillas en el cobertizo', { tab_id: source }, onLive), comment(gone, sourceInbox, 'Ya no hace falta', { tab_id: source }, onGone)]);
  await ok([{ op: 'delete', table: 'tasks.tasks', id: gone, expectedRevision: (await row('tasks.tasks', gone)).revision }]);
  const converted = await app.call(`/api/v1/tabs/${source}/convert`, { body: { requestId: `o1-convert-${++sequence}`, targetTabId: TAB, title: 'Huerto' } });
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  const moved = await row('tasks.task_comments', onLive);
  assert.deepEqual([moved.tab_id, moved.project_id, moved.body], [TAB, converted.data.projectId, 'Semillas en el cobertizo']);
  const emptied = await app.call('/api/v1/trash/empty', { body: { requestId: `o1-trash-${++sequence}` } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.equal(await row('tasks.task_comments', onGone), undefined);
  assert.equal(await row('tasks.tasks', gone), undefined);
  assert.equal((await row('tasks.task_comments', onLive)).deleted_at, null);
});
