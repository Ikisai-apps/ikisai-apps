/** Tasks · migraciones `tasks.*` y hook `tasks.validate_batch` sobre PGlite, a través de `core.commit`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TABLES, WRITABLE, archiveFamilyOps, createTaskOps, deleteTaskOps, moveTaskOps, restoreTaskOps, setDependenciesOps, setTaskDoneOps, setTaskLabelsOps,
} from '../../packages/domain-tasks/src/index.ts';
import { createTasksDb, insert, newId, rejects, remove, restore, update, type TasksDb } from './db.ts';

let db: TasksDb;
test.before(async () => { db = await createTasksDb(); });
test.after(async () => { await db.close(); });

const project = (tab: string, id: string, extra: Record<string, unknown> = {}) => insert('tasks.projects', id, { tab_id: tab, title: 'Proyecto', position: 2048, ...extra });
const taskOp = (tab: string, projectId: string, id: string, extra: Record<string, unknown> = {}) => insert('tasks.tasks', id, { tab_id: tab, project_id: projectId, title: 'Tarea', position: 1024, ...extra });
const dep = (tab: string, projectId: string, taskId: string, dependsOn: string, id = newId()) => insert('tasks.task_dependencies', id, { tab_id: tab, project_id: projectId, task_id: taskId, depends_on_id: dependsOn, position: 1024 });
const rev = async (table: keyof Awaited<ReturnType<TasksDb['data']>>, id: string) => (await db.data())[table].find((r) => r.id === id)!.revision;

test('registro: diez tablas con las columnas escribibles del dominio, hook, procedimiento y lectura', async () => {
  const rows = (await db.t.db.query<{ table_name: string; writable_columns: string[]; writable_roles: string[] }>(
    `select table_name, writable_columns, writable_roles from core.synced_tables where app = 'tasks'`)).rows;
  assert.equal(rows.length, TABLES.length);
  for (const table of TABLES) {
    const row = rows.find((r) => `tasks.${r.table_name}` === table)!;
    assert.deepEqual([...row.writable_columns].sort(), [...WRITABLE[table]].sort(), table);
    assert.deepEqual(row.writable_roles, table === 'tasks.tabs' ? ['owner'] : ['editor', 'owner'], table);
  }
  const count = async (sql: string) => Number((await db.t.db.query<{ n: number }>(sql)).rows[0]!.n);
  assert.equal(await count(`select count(*) n from core.validate_hooks where app = 'tasks' and procedure = 'tasks.validate_batch'`), 1);
  assert.equal(await count(`select count(*) n from core.allowed_procedures where app = 'tasks' and procedure = 'tasks.import_rows'`), 1);
  assert.equal(await count(`select count(*) n from core.allowed_reads where app = 'tasks' and name = 'tasks.targets'`), 1);
});

test('áreas: se crean con Entrada y familias; Entrada protegida; inmutables; solo el propietario', async () => {
  const { tab, inbox, families } = await db.area('Obra');
  const data = await db.data();
  assert.equal(data['tasks.projects'].find((p) => p.id === inbox)!.system, 'inbox');
  assert.equal(data['tasks.families'].filter((f) => f.tab_id === tab).length, 5);

  await rejects(db.commit([insert('tasks.tabs', newId(), { name: 'Sin entrada', position: 1 })]), 'INBOX_PROTECTED');
  await rejects(db.commit([update('tasks.projects', inbox, 1, { title: 'Bandeja' })]), 'INBOX_PROTECTED');
  await rejects(db.commit([update('tasks.projects', inbox, 1, { status: 'archived' })]), 'INBOX_PROTECTED');
  await rejects(db.commit([remove('tasks.projects', inbox, 1)]), 'INBOX_PROTECTED');
  await rejects(db.commit([project(tab, newId(), { system: 'inbox', title: 'Entrada' })]), 'INBOX_PROTECTED');
  await rejects(db.commit([insert('tasks.families', newId(), { tab_id: tab, name: 'Otra persona', color: '#112233', system_key: 'person' })]), 'INVALID_FAMILY');
  await rejects(db.commit([update('tasks.projects', inbox, 1, { system: null })]), 'IMMUTABLE_FIELD');
  await rejects(db.commit([update('tasks.families', families.person!, 1, { system_key: 'trade' })]), 'IMMUTABLE_FIELD');

  const editor = await db.member('editor');
  await rejects(db.commit([update('tasks.tabs', tab, 1, { name: 'Renombrada' })], editor), 'FORBIDDEN');
  await db.commit([update('tasks.tabs', tab, 1, { name: 'Renombrada', color: '#aabbcc' })]);
  // Restricción no prevista por el dominio: llega como violación de check (422 definitivo en la API).
  await assert.rejects(db.commit([update('tasks.tabs', tab, 2, { color: 'rojo' })]), (e: any) => e.sqlstate === '23514');
});

test('áreas: la última área viva no se borra; el contenido de un área en papelera no se toca', async () => {
  const solo = await createTasksDb();
  try {
    const a = await solo.area('Única');
    await rejects(solo.commit([remove('tasks.tabs', a.tab, 1)]), 'LAST_ACTIVE_TAB');
    const b = await solo.area('Segunda');
    await solo.commit([remove('tasks.tabs', a.tab, 1)]);
    await rejects(solo.commit([taskOp(a.tab, a.inbox, newId())]), 'TAB_DELETED');
    // Restaurar el área y editar su contenido en el mismo lote sí vale.
    await solo.commit([restore('tasks.tabs', a.tab, 2), taskOp(a.tab, a.inbox, newId())]);
    assert.ok(b.tab);
  } finally { await solo.close(); }
});

test('jerarquía: un nivel de hijas en el mismo proyecto; borrar y restaurar por lote; done_at', async () => {
  const { tab, inbox } = await db.area();
  const p2 = newId(), parent = newId(), child = newId();
  await db.commit([project(tab, p2), taskOp(tab, inbox, parent), taskOp(tab, inbox, child, { parent_id: parent, position: 2048 })]);
  await rejects(db.commit([taskOp(tab, inbox, newId(), { parent_id: child })]), 'INVALID_PARENT');
  await rejects(db.commit([taskOp(tab, p2, newId(), { parent_id: parent })]), 'INVALID_PARENT');
  await rejects(db.commit([remove('tasks.tasks', parent, 1)]), 'INVALID_PARENT');
  await rejects(db.commit([update('tasks.tasks', parent, 1, { project_id: p2 })]), 'INVALID_PARENT');

  await db.commit(deleteTaskOps(await db.data(), parent));
  let data = await db.data();
  const deleted = data['tasks.tasks'].filter((t) => [parent, child].includes(t.id));
  assert.ok(deleted.every((t) => t.deleted_at) && deleted[0]!.deleted_at === deleted[1]!.deleted_at, 'el lote comparte deleted_at');
  await rejects(db.commit([restore('tasks.tasks', child, 2)]), 'INVALID_PARENT');
  await db.commit(restoreTaskOps(data, child));
  data = await db.data();
  assert.ok(data['tasks.tasks'].filter((t) => [parent, child].includes(t.id)).every((t) => !t.deleted_at));

  await db.commit(setTaskDoneOps(data, parent, true));
  data = await db.data();
  const done = data['tasks.tasks'].find((t) => t.id === child)!;
  assert.ok(done.done && done.done_at, 'completar el padre completa a la hija y fecha la finalización');
  assert.equal(data['tasks.tasks'].find((t) => t.id === parent)!.done, false, 'el padre no se escribe');
  await db.commit(setTaskDoneOps(data, parent, false));
  assert.equal((await db.data())['tasks.tasks'].find((t) => t.id === child)!.done_at, null);
});

test('mover: la tarea arrastra hijas y puentes; claves incoherentes y proyecto no disponible se rechazan', async () => {
  const { tab, inbox, families } = await db.area();
  const p2 = newId(), archived = newId(), parent = newId(), child = newId(), other = newId(), lab = newId();
  await db.commit([
    project(tab, p2), project(tab, archived, { status: 'archived' }),
    insert('tasks.labels', lab, { tab_id: tab, family_id: families.phase, name: 'Estructura' }),
    taskOp(tab, inbox, parent), taskOp(tab, inbox, child, { parent_id: parent }), taskOp(tab, inbox, other),
  ]);
  let data = await db.data();
  await db.commit([...setTaskLabelsOps(data, child, [lab]), ...setDependenciesOps(data, parent, [other])]);
  data = await db.data();
  // Mover solo la tarea, sin sus puentes ni su hija, deja claves incoherentes.
  const full = moveTaskOps(data, parent, { project_id: p2 });
  assert.equal(full.length, 4);
  await rejects(db.commit(full.filter((o) => o.table === 'tasks.tasks')), 'INCONSISTENT_KEYS');
  await db.commit(full);
  data = await db.data();
  assert.ok(data['tasks.tasks'].filter((t) => [parent, child].includes(t.id)).every((t) => t.project_id === p2));
  assert.equal(data['tasks.task_labels'].find((l) => l.task_id === child)!.project_id, p2);
  assert.equal(data['tasks.task_dependencies'].find((d) => d.task_id === parent)!.project_id, p2);
  await rejects(db.commit(moveTaskOps(data, other, { project_id: archived })), 'PROJECT_UNAVAILABLE');
  await rejects(db.commit([taskOp(tab, archived, newId())]), 'PROJECT_UNAVAILABLE');
  const elsewhere = await db.area('Otra');
  await rejects(db.commit([taskOp(elsewhere.tab, inbox, newId())]), 'INCONSISTENT_KEYS');
});

test('dependencias: bloqueo, condiciones heredadas, cascada de un padre y reapertura', async () => {
  const { tab, inbox } = await db.area();
  const p2 = newId(), enfoscar = newId(), pintar = newId(), obra = newId(), h1 = newId(), h2 = newId();
  await db.commit([
    project(tab, p2), taskOp(tab, inbox, enfoscar, { title: 'Enfoscar' }), taskOp(tab, p2, pintar, { title: 'Pintar' }),
    taskOp(tab, inbox, obra, { title: 'Obra' }), taskOp(tab, inbox, h1, { parent_id: obra }), taskOp(tab, inbox, h2, { parent_id: obra }),
    dep(tab, p2, pintar, enfoscar), dep(tab, inbox, obra, enfoscar),
  ]);
  let details = await rejects(db.commit([update('tasks.tasks', pintar, 1, { done: true })]), 'TASK_BLOCKED');
  assert.deepEqual(details, { taskId: pintar, blockedBy: [enfoscar] });
  details = await rejects(db.commit([update('tasks.tasks', h1, 1, { done: true })]), 'TASK_BLOCKED');
  assert.deepEqual(details.blockedBy, [enfoscar], 'la hija hereda la condición del padre');
  // Completar la condición y lo que dependía de ella en un mismo lote: se evalúa el estado final.
  await db.commit([update('tasks.tasks', enfoscar, 1, { done: true }), update('tasks.tasks', pintar, 1, { done: true })]);
  await db.commit(setTaskDoneOps(await db.data(), obra, true));
  // Reabrir la condición no reabre lo terminado, pero impide volver a completar.
  await db.commit([update('tasks.tasks', enfoscar, 2, { done: false })]);
  let data = await db.data();
  assert.equal(data['tasks.tasks'].find((t) => t.id === pintar)!.done, true);
  await db.commit([update('tasks.tasks', pintar, 2, { done: false })]);
  await rejects(db.commit([update('tasks.tasks', pintar, 3, { done: true })]), 'TASK_BLOCKED');
  // Borrar la condición no la cumple; quitar la dependencia sí desbloquea.
  await db.commit([update('tasks.tasks', enfoscar, 3, { done: true })]);
  await db.commit([remove('tasks.tasks', enfoscar, 4)]);
  await rejects(db.commit([update('tasks.tasks', pintar, 3, { done: true })]), 'TASK_BLOCKED');
  data = await db.data();
  await db.commit([...setDependenciesOps(data, pintar, []), update('tasks.tasks', pintar, 3, { done: true })]);
  // Depender de un padre exige todas sus hijas hechas.
  const cond = newId(), c1 = newId(), sigue = newId();
  await db.commit([taskOp(tab, inbox, cond), taskOp(tab, inbox, c1, { parent_id: cond }), taskOp(tab, inbox, sigue), dep(tab, inbox, sigue, cond)]);
  await rejects(db.commit([update('tasks.tasks', sigue, 1, { done: true })]), 'TASK_BLOCKED');
  await db.commit([update('tasks.tasks', c1, 1, { done: true })]);
  await db.commit([update('tasks.tasks', sigue, 1, { done: true })]);
});

test('dependencias: ciclos directos, de varios pasos, heredados y por jerarquía; referencias inválidas', async () => {
  const { tab, inbox } = await db.area();
  const a = newId(), b = newId(), c = newId(), parent = newId(), child = newId(), x = newId();
  await db.commit([taskOp(tab, inbox, a), taskOp(tab, inbox, b), taskOp(tab, inbox, c), taskOp(tab, inbox, parent), taskOp(tab, inbox, child, { parent_id: parent }), taskOp(tab, inbox, x)]);
  const ab = newId();
  await db.commit([dep(tab, inbox, a, b, ab), dep(tab, inbox, b, c)]);
  await rejects(db.commit([dep(tab, inbox, b, a)]), 'DEPENDENCY_CYCLE');
  const details = await rejects(db.commit([dep(tab, inbox, c, a)]), 'DEPENDENCY_CYCLE');
  assert.deepEqual([...details.taskIds].sort(), [a, b, c].sort());
  await rejects(db.commit([dep(tab, inbox, parent, child)]), 'DEPENDENCY_CYCLE');
  await rejects(db.commit([dep(tab, inbox, child, parent)]), 'DEPENDENCY_CYCLE');
  await db.commit([dep(tab, inbox, parent, x)]);
  await rejects(db.commit([dep(tab, inbox, x, child)]), 'DEPENDENCY_CYCLE');
  // Un cambio de nivel también revalida el grafo: `a` depende de `b`; colgar `b` de `a` cierra el ciclo.
  await rejects(db.commit([update('tasks.tasks', b, 1, { parent_id: a })]), 'DEPENDENCY_CYCLE');
  // Quitar una arista y volver a ponerla restaurando la fila.
  await db.commit([remove('tasks.task_dependencies', ab, 1)]);
  await db.commit([dep(tab, inbox, c, a)]);
  await rejects(db.commit([restore('tasks.task_dependencies', ab, 2)]), 'DEPENDENCY_CYCLE');
  await rejects(db.commit([dep(tab, inbox, b, c)]), 'INVALID_DEPENDENCIES');
  const other = await db.area('Otra');
  const far = newId();
  await db.commit([taskOp(other.tab, other.inbox, far)]);
  await rejects(db.commit([dep(tab, inbox, x, far)]), 'INVALID_DEPENDENCIES');
});

test('catálogo: familias archivadas, responsables, etiquetas de otra área, vistas y etiquetas en uso', async () => {
  const { tab, inbox, families } = await db.area();
  const other = await db.area('Otra');
  const ana = newId(), fase = newId(), ajena = newId(), t1 = newId();
  await db.commit([
    insert('tasks.labels', ana, { tab_id: tab, family_id: families.person, name: 'Ana' }),
    insert('tasks.labels', fase, { tab_id: tab, family_id: families.phase, name: 'Estructura' }),
    insert('tasks.labels', ajena, { tab_id: other.tab, family_id: other.families.person, name: 'Luis' }),
    taskOp(tab, inbox, t1, { owner_label_id: ana }),
  ]);
  await rejects(db.commit([insert('tasks.labels', newId(), { tab_id: tab, family_id: other.families.phase, name: 'Cruzada' })]), 'INVALID_LABEL');
  await rejects(db.commit([update('tasks.tasks', t1, 1, { owner_label_id: fase })]), 'INVALID_OWNER');
  await rejects(db.commit([update('tasks.tasks', t1, 1, { owner_label_id: ajena })]), 'INVALID_OWNER');
  await rejects(db.commit([insert('tasks.task_labels', newId(), { tab_id: tab, project_id: inbox, task_id: t1, label_id: ajena })]), 'INVALID_LABELS');
  await rejects(db.commit([update('tasks.labels', fase, 1, { parent_id: ajena })]), 'INVALID_LABEL_PARENT');
  const sub = newId();
  await db.commit([insert('tasks.labels', sub, { tab_id: tab, family_id: families.phase, name: 'Cimentación', parent_id: fase })]);
  await rejects(db.commit([update('tasks.labels', fase, 1, { parent_id: sub })]), 'INVALID_LABEL_PARENT');

  let data = await db.data();
  await db.commit(setTaskLabelsOps(data, t1, [fase]));
  await rejects(db.commit([insert('tasks.task_labels', newId(), { tab_id: tab, project_id: inbox, task_id: t1, label_id: fase })]), 'INVALID_LABELS');
  await rejects(db.commit([remove('tasks.labels', fase, 1)]), 'LABEL_IN_USE');

  await rejects(db.commit([update('tasks.families', families.phase!, 1, { archived: true })]), 'FAMILY_ARCHIVED');
  data = await db.data();
  await db.commit(archiveFamilyOps(data, families.phase!, true));
  data = await db.data();
  assert.ok(data['tasks.labels'].filter((l) => l.family_id === families.phase).every((l) => l.archived && l.archived_before_family === false));
  await rejects(db.commit([update('tasks.labels', sub, 2, { archived: false })]), 'FAMILY_ARCHIVED');
  await db.commit(archiveFamilyOps(data, families.phase!, false));

  const view = (fields: Record<string, unknown>) => db.commit([insert('tasks.saved_views', newId(), { tab_id: tab, name: 'Vista', ...fields })]);
  await view({ filters: { _state: ['pending'], _project: [inbox], [families.phase!]: [fase, sub] }, group_by: families.phase });
  await rejects(view({ filters: { _project: [other.inbox] } }), 'INVALID_VIEW');
  await rejects(view({ filters: { [families.phase!]: [ana] } }), 'INVALID_VIEW');
  await rejects(view({ group_by: other.families.phase }), 'INVALID_VIEW');
});

test('ámbitos: un acceso por proyecto escribe en su proyecto y en nada más', async () => {
  const { tab, inbox, families } = await db.area();
  const mine = newId(), secret = newId(), tMine = newId(), tSecret = newId(), lab = newId();
  await db.commit([
    project(tab, mine), project(tab, secret), taskOp(tab, mine, tMine), taskOp(tab, secret, tSecret),
    insert('tasks.labels', lab, { tab_id: tab, family_id: families.phase, name: 'Fase 1' }),
  ]);
  const guest = await db.member('editor', { tabs: [], projects: { [tab]: [mine] } });
  const nueva = newId();
  await db.commit([taskOp(tab, mine, nueva, { title: 'Del invitado' }), insert('tasks.task_labels', newId(), { tab_id: tab, project_id: mine, task_id: nueva, label_id: lab })], guest);
  await db.commit([update('tasks.projects', mine, 1, { note: 'Editado por el invitado' })], guest);
  await rejects(db.commit([taskOp(tab, secret, newId())], guest), 'FORBIDDEN');
  await rejects(db.commit([update('tasks.tasks', tSecret, 1, { note: 'x' })], guest), 'FORBIDDEN');
  await rejects(db.commit([update('tasks.tasks', tMine, 1, { project_id: secret })], guest), 'FORBIDDEN');
  await rejects(db.commit([update('tasks.tasks', tSecret, 1, { project_id: mine })], guest), 'FORBIDDEN');
  await rejects(db.commit([project(tab, newId())], guest), 'FORBIDDEN');
  await rejects(db.commit([insert('tasks.labels', newId(), { tab_id: tab, family_id: families.phase, name: 'No' })], guest), 'FORBIDDEN');
  await rejects(db.commit([insert('tasks.saved_views', newId(), { tab_id: tab, name: 'No' })], guest), 'FORBIDDEN');
  await rejects(db.commit([dep(tab, mine, tMine, tSecret)], guest), 'FORBIDDEN');
  await rejects(db.commit([update('tasks.projects', inbox, 1, { note: 'x' })], guest), 'FORBIDDEN');
  // El propietario crea la dependencia hacia el proyecto privado: el invitado no puede completar y no ve qué lo bloquea.
  await db.commit([dep(tab, mine, tMine, tSecret)]);
  const details = await rejects(db.commit([update('tasks.tasks', tMine, 1, { done: true })], guest), 'TASK_BLOCKED');
  assert.deepEqual(details, { taskId: tMine, blockedBy: [] });
  // Área completa: administra catálogo y proyectos de esa área, no de otra.
  const other = await db.area('Otra');
  const lead = await db.member('editor', [tab]);
  await db.commit([project(tab, newId()), insert('tasks.labels', newId(), { tab_id: tab, family_id: families.phase, name: 'Sí' })], lead);
  await rejects(db.commit([taskOp(other.tab, other.inbox, newId())], lead), 'FORBIDDEN');
  // Ámbitos mal formados equivalen a no tener acceso; un lector nunca escribe.
  const broken = await db.member('editor', { tabs: 'todas' });
  await rejects(db.commit([taskOp(tab, mine, newId())], broken), 'FORBIDDEN');
  const reader = await db.member('reader');
  await rejects(db.commit([taskOp(tab, mine, newId())], reader), 'FORBIDDEN');
  // Un propietario limitado a un área no crea áreas nuevas.
  const limitedOwner = await db.member('owner', [tab]);
  await rejects(db.commit([insert('tasks.tabs', newId(), { name: 'Nueva', position: 1 })], limitedOwner), 'FORBIDDEN');
});

test('deshacer: el plan inverso de un borrado por lote restaura; fuera de ámbito se rechaza', async () => {
  const { tab, inbox } = await db.area();
  const parent = newId(), child = newId();
  await db.commit([taskOp(tab, inbox, parent), taskOp(tab, inbox, child, { parent_id: parent })]);
  const deleted = await db.commit(deleteTaskOps(await db.data(), parent));
  const plan = (await db.t.rpc('core_undo_plan', { p_app: 'tasks', p_cursor: deleted.cursor })) as { operations: any[] };
  assert.deepEqual(plan.operations.map((o) => o.op), ['restore', 'restore']);
  const guest = await db.member('editor', { projects: { [tab]: [newId()] } });
  await rejects(db.commit(plan.operations, guest), 'FORBIDDEN');
  await db.commit(plan.operations);
  assert.ok((await db.data())['tasks.tasks'].filter((t) => [parent, child].includes(t.id)).every((t) => !t.deleted_at));
});

test('adjuntos: solo con un archivo verificado de la app que coincida con lo declarado', async () => {
  const { tab, inbox } = await db.area();
  const sha = 'ab'.repeat(32), file = newId(), pending = newId();
  await db.t.db.query(
    `insert into core.files (id, app, bucket, path, filename, mime, size, sha256, status) values
       ($1, 'tasks', 'ikisai-files', 'tasks/2026/a/plano.pdf', 'plano.pdf', 'application/pdf', 1200, $3, 'verified'),
       ($2, 'tasks', 'ikisai-files', 'tasks/2026/b/plano.pdf', 'plano.pdf', 'application/pdf', 1200, $3, 'pending')`, [file, pending, sha]);
  const attach = (fileId: string, extra: Record<string, unknown> = {}) => db.commit([insert('tasks.attachments', newId(), {
    tab_id: tab, project_id: inbox, name: 'plano.pdf', mime: 'application/pdf', size: 1200, sha256: sha, file_id: fileId, ...extra })]);
  await attach(file);
  await rejects(attach(pending), 'FILE_NOT_UPLOADED');
  await rejects(attach(file, { size: 99 }), 'FILE_NOT_UPLOADED');
  await assert.rejects(attach(newId()), (e: any) => e.sqlstate === '23503');
});

test('importación: tasks.import_rows inserta en orden, admite estados históricos y pasa por el hook', async () => {
  const tab = newId(), inbox = newId(), person = newId(), cond = newId(), done = newId(), gone = newId();
  const rows = {
    'tasks.tabs': [{ id: tab, fields: { name: 'Importada', position: 4096 } }],
    'tasks.families': [{ id: person, fields: { tab_id: tab, name: 'Persona', color: '#6f5a8f', system_key: 'person' } }],
    'tasks.projects': [{ id: inbox, fields: { tab_id: tab, title: 'Entrada', system: 'inbox', position: 1024 } }],
    'tasks.tasks': [
      { id: cond, fields: { tab_id: tab, project_id: inbox, title: 'Condición reabierta', position: 1024 } },
      { id: done, fields: { tab_id: tab, project_id: inbox, title: 'Terminada antes', done: true, position: 2048 } },
      { id: gone, fields: { tab_id: tab, project_id: inbox, title: 'En papelera', position: 3072 }, deleted: true },
    ],
    'tasks.task_dependencies': [{ id: newId(), fields: { tab_id: tab, project_id: inbox, task_id: done, depends_on_id: cond, position: 1024 } }],
  };
  const call = (r: unknown) => db.commit([{ op: 'call', procedure: 'tasks.import_rows', args: { mode: 'portable', rows: r } }]);
  const result = await call(rows);
  assert.deepEqual(result.results[0].result.inserted, { 'tasks.tabs': 1, 'tasks.families': 1, 'tasks.projects': 1, 'tasks.tasks': 3, 'tasks.task_dependencies': 1 });
  const data = await db.data();
  assert.ok(data['tasks.tasks'].find((t) => t.id === gone)!.deleted_at);
  assert.equal(data['tasks.tasks'].find((t) => t.id === done)!.done, true);
  // Fuera de la importación la misma situación se rechaza.
  await db.commit([update('tasks.tasks', done, 1, { done: false })]);
  await rejects(db.commit([update('tasks.tasks', done, 2, { done: true })]), 'TASK_BLOCKED');
  await rejects(call({ 'tasks.tabs': [{ id: newId(), fields: { name: 'Sin entrada', position: 1 } }] }), 'INBOX_PROTECTED');
  await rejects(call({ 'tasks.otra': [] }), 'INVALID_IMPORT');
  await rejects(call({}), 'INVALID_IMPORT');
  const editor = await db.member('editor');
  await rejects(db.commit([{ op: 'call', procedure: 'tasks.import_rows', args: { rows: { 'tasks.tabs': [{ id: newId(), fields: { name: 'X', position: 1 } }] } } }], editor), 'FORBIDDEN');
});

test('lectura tasks.targets: árbol visible para el usuario y validación de un destino', async () => {
  const { tab, inbox } = await db.area('Destinos');
  const mine = newId(), secret = newId(), archived = newId(), t1 = newId(), t2 = newId(), child = newId(), hidden = newId();
  await db.commit([
    project(tab, mine, { title: 'Reforma' }), project(tab, secret, { title: 'Privado' }), project(tab, archived, { title: 'Cerrado' }),
    taskOp(tab, mine, t1, { title: 'Pintar' }), taskOp(tab, mine, t2, { title: 'Contenedor', position: 2048 }), taskOp(tab, mine, child, { parent_id: t2, done: true, position: 3072 }),
    taskOp(tab, secret, hidden),
  ]);
  await db.commit([update('tasks.projects', archived, 1, { status: 'archived' })]);
  const all = await db.read('tasks.targets', { tabId: tab });
  assert.deepEqual(all.tabs.map((t: any) => t.name), ['Destinos']);
  assert.deepEqual(all.tabs[0].projects.map((p: any) => p.title).sort(), ['Entrada', 'Privado', 'Reforma']);
  const reforma = all.tabs[0].projects.find((p: any) => p.id === mine);
  assert.deepEqual(reforma.tasks.map((t: any) => [t.title, t.done, t.parentId]), [['Pintar', false, null], ['Contenedor', true, null], ['Tarea', true, t2]]);
  assert.equal((await db.read('tasks.targets', { tabId: tab, includeArchived: true })).tabs[0].projects.length, 4);

  const guest = await db.member('reader', { projects: { [tab]: [mine] } });
  const seen = await db.read('tasks.targets', {}, guest);
  assert.deepEqual(seen.tabs.map((t: any) => t.id), [tab]);
  assert.deepEqual(seen.tabs[0].projects.map((p: any) => p.id), [mine]);

  const one = await db.read('tasks.targets', { kind: 'task', id: t1 }, guest);
  assert.deepEqual(one, { kind: 'task', id: t1, tabId: tab, projectId: mine, title: 'Pintar', revision: 1, deleted: false, archived: false, done: false });
  assert.equal((await db.read('tasks.targets', { kind: 'project', id: archived })).archived, true);
  assert.equal((await db.read('tasks.targets', { kind: 'tab', id: tab }, guest)).title, 'Destinos');
  await rejects(db.read('tasks.targets', { kind: 'task', id: hidden }, guest), 'NOT_FOUND');
  await rejects(db.read('tasks.targets', { kind: 'project', id: secret }, guest), 'NOT_FOUND');
  await rejects(db.read('tasks.targets', { kind: 'cosa', id: t1 }), 'INVALID_OPERATION');
  assert.ok(inbox);
});

test('operaciones del dominio contra la base: crear tarea hereda etiquetas del proyecto', async () => {
  const { tab, inbox, families } = await db.area();
  const p = newId(), lab = newId();
  await db.commit([project(tab, p), insert('tasks.labels', lab, { tab_id: tab, family_id: families.trade, name: 'Albañilería' }),
    insert('tasks.project_labels', newId(), { tab_id: tab, project_id: p, label_id: lab })]);
  const id = newId();
  await db.commit(createTaskOps(await db.data(), { id, project_id: p, title: 'Levantar tabique' }));
  const data = await db.data();
  assert.deepEqual(data['tasks.task_labels'].filter((l) => l.task_id === id).map((l) => l.label_id), [lab]);
  assert.equal(await rev('tasks.tasks', id), 1);
  assert.ok(inbox);
});
