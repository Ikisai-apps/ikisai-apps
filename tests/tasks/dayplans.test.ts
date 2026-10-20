/**
 * Tasks · «Plan de hoy» (MUELA-095, migración 0339): `tasks.day_plans` sobre la `tasks-api` real en PGlite.
 * Privado (solo lo recibe su dueño por snapshot, changes e history), nadie escribe el de otro, quien solo lee apunta solo
 * texto, una tarea que no se ve no entra, el outsider no tiene plan, uno por persona y día, y la tarea no cambia.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import {
  createTabOps, linkPlanItem, planInOrder, planWithTask, planWithText, planWithTextDone, planWithout, saveDayPlanOps, validateOperations, visible,
  emptyDataset, type DayPlanItem, type Operation,
} from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const insert = (table: string, id: string, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });
const DAY = '2026-10-20';

let app: TestApp;
let sequence = 0;
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `plan-${++sequence}`, operations }, ...(token ? { token } : {}) });
const code = async (operations: Operation[], token?: string) => { const r = await commit(operations, token); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
async function ok(operations: Operation[], token?: string) {
  const result = await commit(operations, token);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function member(role: string, scopes: unknown): Promise<{ id: string; token: string }> {
  const id = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, $2, $3::jsonb)`, [id, role, JSON.stringify(scopes)]);
  return { id, token: app.supabase.tokenFor(id) };
}
const userId = async (token?: string): Promise<string> => (await app.call('/api/v1/bootstrap', token ? { token } : {})).data.profile.userId;
const plan = (id: string, actor: string, items: DayPlanItem[], day = DAY): Operation => insert('tasks.day_plans', id, { actor_id: actor, day, items, reviewed: false });
const taskItem = (taskId: string, position = 1024): DayPlanItem => ({ id: uuid(), task_id: taskId, tab_id: TAB, position });
const textItem = (text: string, position = 1024): DayPlanItem => ({ id: uuid(), text, tab_id: null, position, done: false });

const TAB = uuid(), INBOX = uuid(), MINE = uuid(), SECRET = uuid(), T_MINE = uuid(), T_SECRET = uuid();
let ownerId = '';
let editor: { id: string; token: string };
let guest: { id: string; token: string };
let reader: { id: string; token: string };
let outsider: { id: string; token: string };
const OWNER_PLAN = uuid();

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Casa', position: 1024, inboxId: INBOX }));
  await ok([
    insert('tasks.projects', MINE, { tab_id: TAB, title: 'Jardín', position: 2048 }),
    insert('tasks.projects', SECRET, { tab_id: TAB, title: 'Reservado', position: 3072 }),
    insert('tasks.tasks', T_MINE, { tab_id: TAB, project_id: MINE, title: 'Junta de la puerta', position: 1024, due: '2026-10-25' }),
    insert('tasks.tasks', T_SECRET, { tab_id: TAB, project_id: SECRET, title: 'Cosa reservada', position: 1024 }),
  ]);
  ownerId = await userId();
  editor = await member('editor', '*');
  guest = await member('editor', { tabs: [], projects: { [TAB]: [MINE] } });
  reader = await member('reader', '*');
  outsider = await member('outsider', { tabs: [TAB], projects: {} });
});
test.after(async () => { await app.close(); });

test('plan de hoy · el dueño lo escribe y la tarea no cambia (ni fecha ni revisión)', async () => {
  const before = (await app.call('/api/v1/snapshot?tables=tasks.tasks')).data.tables[0].rows.find((t: any) => t.id === T_MINE);
  await ok([plan(OWNER_PLAN, ownerId, [taskItem(T_MINE), textItem('Llamar al fontanero', 2048)])]);
  const after = (await app.call('/api/v1/snapshot?tables=tasks.tasks')).data.tables[0].rows.find((t: any) => t.id === T_MINE);
  assert.equal(after.revision, before.revision);
  assert.equal(after.due, '2026-10-25');
  const mine = (await app.call('/api/v1/snapshot?tables=tasks.day_plans')).data.tables[0].rows;
  assert.deepEqual(mine.map((p: any) => p.id), [OWNER_PLAN]);
  assert.equal(mine[0].items.length, 2);
});

test('plan de hoy · privado: otra persona no lo recibe por snapshot, changes ni history, y no puede escribirlo', async () => {
  for (const token of [editor.token, guest.token, reader.token]) {
    const snap = await app.call('/api/v1/snapshot?tables=tasks.day_plans', { token });
    assert.equal(snap.status, 200);
    assert.deepEqual(snap.data.tables[0].rows, [], 'snapshot');
    const changes = await app.call('/api/v1/changes?after=0', { token });
    assert.equal(changes.data.items.some((c: any) => c.table === 'tasks.day_plans'), false, 'changes');
    const history = await app.call('/api/v1/history', { token });
    assert.equal(JSON.stringify(history.data).includes('Llamar al fontanero'), false, 'history');
    assert.equal(history.data.items.some((i: any) => i.changes.some((c: any) => c.table === 'tasks.day_plans')), false, 'history');
  }
  // La dueña sí lo ve en su historial.
  const own = await app.call('/api/v1/history');
  assert.ok(JSON.stringify(own.data).includes('Llamar al fontanero'));
  // Nadie toca el plan de otro: ni cambiándolo ni creando uno a su nombre.
  assert.equal(await code([{ op: 'update', table: 'tasks.day_plans', id: OWNER_PLAN, expectedRevision: 1, fields: { items: [] } }], editor.token), '403 FORBIDDEN');
  assert.equal(await code([{ op: 'delete', table: 'tasks.day_plans', id: OWNER_PLAN, expectedRevision: 1 }], editor.token), '403 FORBIDDEN');
  assert.equal(await code([plan(uuid(), ownerId, [textItem('Suplantar')], '2026-10-21')], editor.token), '403 FORBIDDEN');
  const still = (await app.call('/api/v1/snapshot?tables=tasks.day_plans')).data.tables[0].rows;
  assert.equal(still[0].items.length, 2);
  // Su propio plan, cada cual el suyo.
  await ok([plan(uuid(), editor.id, [taskItem(T_MINE)])], editor.token);
});

test('plan de hoy · quien solo lee tiene plan con texto; con una tarea, rechazado', async () => {
  const id = uuid();
  await ok([plan(id, reader.id, [textItem('Revisar el correo')])], reader.token);
  const snap = await app.call('/api/v1/snapshot?tables=tasks.day_plans', { token: reader.token });
  assert.deepEqual(snap.data.tables[0].rows.map((p: any) => p.id), [id]);
  assert.equal(await code([{ op: 'update', table: 'tasks.day_plans', id, expectedRevision: 1, fields: { items: [textItem('Revisar el correo'), taskItem(T_MINE, 2048)] } }], reader.token), '403 FORBIDDEN');
  // El hook SQL también lo rechaza (sin pasar por la Edge).
  await assert.rejects(app.t.rpc('core_commit', { p_app: 'tasks', p_actor: reader.id, p_request_id: 'plan-sql-reader', p_digest: 'x', p_expected_cursor: null,
    p_operations: [{ op: 'update', table: 'tasks.day_plans', id, expectedRevision: 1, fields: { items: [taskItem(T_MINE)] } }] }),
    (e: any) => e.message === 'FORBIDDEN' && JSON.stringify(e.details).includes('a reader plans only text items'));
  // Y nada más que su plan: una tarea, no.
  assert.equal(await code([insert('tasks.tasks', uuid(), { tab_id: TAB, project_id: MINE, title: 'x', position: 1 })], reader.token), '403 FORBIDDEN');
});

test('plan de hoy · una tarea que esa persona no ve no entra en su plan', async () => {
  assert.equal(await code([plan(uuid(), guest.id, [taskItem(T_SECRET)])], guest.token), '422 TASK_UNAVAILABLE');
  await ok([plan(uuid(), guest.id, [taskItem(T_MINE)])], guest.token);
});

test('plan de hoy · el outsider no tiene plan: ni lo lee ni lo escribe', async () => {
  const boot = await app.call('/api/v1/bootstrap', { token: outsider.token });
  const row = boot.data.tables.find((t: any) => t.table === 'tasks.day_plans');
  assert.ok(!row || (!row.readable && !row.writable));
  assert.equal(await code([plan(uuid(), outsider.id, [textItem('Algo')])], outsider.token), '403 FORBIDDEN');
  assert.equal(visible('tasks.day_plans', { actor_id: outsider.id }, { user: { id: outsider.id }, membership: { role: 'outsider', scopes: '*' } }), false);
});

test('plan de hoy · uno por persona y día, y elementos bien formados', async () => {
  assert.equal(await code([plan(uuid(), ownerId, [textItem('Otra vez hoy')])]), '422 DUPLICATE_PLAN');
  assert.equal(await code([plan(uuid(), ownerId, [{ id: uuid(), position: 1 } as DayPlanItem], '2026-10-22')]), '422 INVALID_PLAN');
  assert.equal(await code([plan(uuid(), ownerId, [{ id: uuid(), task_id: T_MINE, text: 'las dos', position: 1 } as DayPlanItem], '2026-10-22')]), '422 INVALID_PLAN');
  assert.equal(await code([plan(uuid(), ownerId, [{ ...taskItem(T_MINE), done: true } as DayPlanItem], '2026-10-22')]), '422 INVALID_PLAN');
  assert.equal(await code([plan(uuid(), ownerId, Array.from({ length: 101 }, (_, i) => textItem('x', i)), '2026-10-22')]), '422 INVALID_PLAN');
  assert.equal(await code([{ op: 'update', table: 'tasks.day_plans', id: OWNER_PLAN, expectedRevision: 1, fields: { day: '2026-10-21' } }]), '422 IMMUTABLE_FIELD');
});

test('plan de hoy · operaciones puras: poner, quitar, ordenar, «solo hoy» y «Llevar a…»; solo escriben el plan', () => {
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  let items = planWithTask([], { id: T_MINE, tab_id: TAB }, id);
  items = planWithTask(items, { id: T_MINE, tab_id: TAB }, id);
  assert.equal(items.length, 1, 'la misma tarea no entra dos veces');
  items = planWithText(items, '  Comprar   pan ', id);
  assert.deepEqual(items.map((i) => i.text ?? i.task_id), [T_MINE, 'Comprar pan']);
  items = planInOrder(items, [items[1]!.id, items[0]!.id]);
  assert.deepEqual(items.map((i) => i.position), [1024, 2048]);
  assert.equal(items[0]!.text, 'Comprar pan');
  items = planWithTextDone(items, items[0]!.id, true);
  assert.equal(items[0]!.done, true);
  const created = uuid();
  const linked = linkPlanItem(items, items[0]!.id, { id: created, tab_id: TAB });
  assert.deepEqual(linked[0], { id: items[0]!.id, task_id: created, tab_id: TAB, position: 1024 });
  assert.equal(planWithout(linked, linked[0]!.id).length, 1);
  const data = emptyDataset();
  const ops = saveDayPlanOps(data, ownerId, DAY, linked);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.table, 'tasks.day_plans');
  assert.doesNotThrow(() => validateOperations(ops, { role: 'editor', scopes: '*' }));
  assert.throws(() => validateOperations(ops, { role: 'reader', scopes: '*' }), /solo lo que apuntas/);
  assert.throws(() => validateOperations(ops, { role: 'outsider', scopes: '*' }), /Solo puedes marcar/);
  assert.deepEqual(saveDayPlanOps(data, ownerId, DAY, []), [], 'sin plan y sin nada, no se crea');
});
