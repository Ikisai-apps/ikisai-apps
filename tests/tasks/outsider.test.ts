/**
 * Ikisai Tasks · O1, paso 1 (RECURSOS.md §14.2, docs/tasks/API.md §31): el outsider no ve nada por defecto. Su pertenencia
 * nace del nivel de casa con `scopes` vacío, y para él vacío o «*» es nada. Solo ve las áreas o proyectos que se le abren
 * en sus ámbitos; nunca compras, Entrada ni vistas guardadas; y de momento no escribe nada.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';
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
/** Un outsider como lo deja `core.apply_house_level`: pertenencia `outsider` con los ámbitos que se le den. */
async function outsider(scopes: unknown): Promise<string> {
  const id = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'outsider', $2::jsonb)`, [id, scopes === null ? null : JSON.stringify(scopes)]);
  return app.supabase.tokenFor(id);
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

test('O1 · de momento no escribe nada: ni marcar hecha ni crear', async () => {
  const done = await commit([{ op: 'update', table: 'tasks.tasks', id: T_OPEN, expectedRevision: 1, fields: { done: true } }], project);
  assert.equal(done.status, 403, JSON.stringify(done.data));
  const created = await commit([insert('tasks.tasks', uuid(), { tab_id: TAB, project_id: OPEN, title: 'Intrusa', position: 9 })], area);
  assert.equal(created.status, 403, JSON.stringify(created.data));
  const task = (await app.t.db.query<{ done: boolean }>('select done from tasks.tasks where id = $1', [T_OPEN])).rows[0]!;
  assert.equal(task.done, false);
});
