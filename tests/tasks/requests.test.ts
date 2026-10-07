/**
 * Tasks · trabajo pedido desde otras apps (`POST requests/task`, docs/tasks/API.md §19), de extremo a extremo contra el
 * núcleo y el hook reales: idempotencia por referencia, papelera, alcance, procedencia protegida y lectura de varias.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { requestTaskId } from '../../supabase/functions/tasks-api/requests.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid(), OBRA = uuid(), PRIVADO = uuid(), LABEL = uuid(), PL = uuid();
let app: TestApp;
let limited = '';
let seq = 0;

const ask = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/requests/task', { token, body });
const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `seed-${++seq}`, operations } });
const targets = (args: Record<string, unknown>, token?: string) => app.call('/api/v1/read/tasks.targets', { token, body: args });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const tabOps = createTabOps({ id: TAB, name: 'Casa', position: 1024, inboxId: INBOX });
  const phase = tabOps.find((o) => o.fields?.system_key === 'phase')!.id!;
  await commit(tabOps);
  await commit([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Licencias', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PRIVADO, fields: { tab_id: TAB, title: 'Privado', position: 3072 } },
    { op: 'insert', table: 'tasks.labels', id: LABEL, fields: { tab_id: TAB, family_id: phase, name: 'Cumplimiento' } },
  ]);
  await commit([{ op: 'insert', table: 'tasks.project_labels', id: PL, fields: { tab_id: TAB, project_id: OBRA, label_id: LABEL } }]);
  // Una persona con acceso a un solo proyecto (un agente necesitaría aprobación para cualquier `call`).
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [OBRA] } }), app.users.editor]);
  limited = app.tokens.editor;
});
test.after(async () => { await app.close(); });

test('pedir una tarea: se crea una vez, con procedencia y las etiquetas del proyecto; repetir la devuelve sin tocarla', async () => {
  const first = await ask({ source: 'central', external_ref: 'LEG_2026_004', title: 'Renovar licencia de piscina', note: 'Vence en noviembre', due: '2026-11-15', priority: 'high', project_id: OBRA });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.created, true);
  const task = first.data.task;
  assert.equal(task.id, await requestTaskId('central:LEG_2026_004'));
  assert.deepEqual([task.kind, task.projectId, task.externalRef, task.done, task.deleted], ['task', OBRA, 'central:LEG_2026_004', false, false]);
  const row = (await rows('tasks.tasks')).find((t) => t.id === task.id);
  assert.deepEqual([row.title, row.note, row.due, row.priority], ['Renovar licencia de piscina', 'Vence en noviembre', '2026-11-15', 'high']);
  assert.deepEqual((await rows('tasks.task_labels')).filter((l) => l.task_id === task.id).map((l) => l.label_id), [LABEL], 'lleva las etiquetas del proyecto');

  const again = await ask({ source: 'central', external_ref: 'LEG_2026_004', title: 'Otro título', project_id: PRIVADO });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.created, false);
  assert.equal(again.data.task.id, task.id);
  const after = (await rows('tasks.tasks')).filter((t) => t.external_ref === 'central:LEG_2026_004');
  assert.equal(after.length, 1);
  assert.deepEqual([after[0].title, after[0].project_id], ['Renovar licencia de piscina', OBRA], 'una petición repetida no cambia nada');
  // La misma referencia de otra app es otra tarea.
  const other = await ask({ source: 'booking', external_ref: 'LEG_2026_004', title: 'Otra', tab_id: TAB });
  assert.equal(other.data.created, true);
  assert.equal(other.data.task.projectId, INBOX, 'sin proyecto va a la Entrada del área');
});

test('a la vez desde dos sitios: una sola tarea', async () => {
  const body = { source: 'central', external_ref: 'A_LA_VEZ', title: 'Revisar extintores', tab_id: TAB };
  const [a, b] = await Promise.all([ask(body), ask(body)]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal([a.data.created, b.data.created].filter(Boolean).length, 1);
  assert.equal((await rows('tasks.tasks')).filter((t) => t.external_ref === 'central:A_LA_VEZ').length, 1);
});

test('en la papelera se devuelve como borrada y no se resucita', async () => {
  const made = (await ask({ source: 'central', external_ref: 'BORRADA', title: 'Se borrará', tab_id: TAB })).data.task;
  assert.equal((await commit([{ op: 'delete', table: 'tasks.tasks', id: made.id, expectedRevision: made.revision }])).status, 200);
  const again = await ask({ source: 'central', external_ref: 'BORRADA', title: 'Se borrará', tab_id: TAB });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual([again.data.created, again.data.task.deleted], [false, true]);
  assert.ok((await rows('tasks.tasks')).find((t) => t.id === made.id).deleted_at, 'sigue en la papelera');
});

test('alcance: fuera de sus proyectos no crea; una referencia de una tarea que no ve da 409', async () => {
  const outside = await ask({ source: 'central', external_ref: 'FUERA', title: 'x', project_id: PRIVADO }, limited);
  assert.equal(outside.status, 403, JSON.stringify(outside.data));
  const inbox = await ask({ source: 'central', external_ref: 'FUERA', title: 'x', tab_id: TAB }, limited);
  assert.equal(inbox.status, 403, 'la Entrada es del área entera');
  await ask({ source: 'central', external_ref: 'PRIVADA', title: 'Privada', project_id: PRIVADO });
  const hidden = await ask({ source: 'central', external_ref: 'PRIVADA', title: 'Privada', project_id: OBRA }, limited);
  assert.equal(hidden.status, 409, JSON.stringify(hidden.data));
  assert.equal(hidden.data.error.code, 'EXTERNAL_REF_IN_USE');
  assert.equal(JSON.stringify(hidden.data).includes('Privada'), false, 'no revela la tarea');
  const reader = await ask({ source: 'central', external_ref: 'LECTOR', title: 'x', tab_id: TAB }, app.tokens.reader);
  assert.equal(reader.status, 403);
});

test('entradas inválidas y procedencia protegida fuera de la ruta', async () => {
  for (const body of [
    { external_ref: 'X', title: 'x', tab_id: TAB },
    { source: 'Central', external_ref: 'X', title: 'x', tab_id: TAB },
    { source: 'central', title: 'x', tab_id: TAB },
    { source: 'central', external_ref: 'X', title: '  ', tab_id: TAB },
    { source: 'central', external_ref: 'X', title: 'x' },
    { source: 'central', external_ref: 'X', title: 'x', tab_id: TAB, due: '15/11/2026' },
    { source: 'central', external_ref: 'X', title: 'x', tab_id: 'no' },
  ]) {
    const res = await ask(body);
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  // Por `commands` no se fija ni se cambia la procedencia.
  const id = uuid();
  const set = await commit([{ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: INBOX, title: 'x', position: 99, external_ref: 'central:FALSA' } }]);
  assert.equal(set.status, 422, JSON.stringify(set.data));
  const made = (await rows('tasks.tasks')).find((t) => t.external_ref === 'central:LEG_2026_004');
  const change = await commit([{ op: 'update', table: 'tasks.tasks', id: made.id, expectedRevision: made.revision, fields: { external_ref: 'central:OTRA' } }]);
  assert.equal(change.status, 422, JSON.stringify(change.data));
});

test('tasks.targets con lista de ids: las visibles (papelera incluida) y las que faltan', async () => {
  const all = await rows('tasks.tasks');
  const licencia = all.find((t) => t.external_ref === 'central:LEG_2026_004'), borrada = all.find((t) => t.external_ref === 'central:BORRADA');
  const privada = all.find((t) => t.external_ref === 'central:PRIVADA'), nadie = uuid();
  const out = await targets({ kind: 'task', ids: [licencia.id, borrada.id, privada.id, nadie] });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data.items.map((t: any) => t.id).sort(), [licencia.id, borrada.id, privada.id].sort());
  assert.equal(out.data.items.find((t: any) => t.id === borrada.id).deleted, true);
  assert.deepEqual(out.data.missing, [nadie]);
  const seen = await targets({ kind: 'task', ids: [licencia.id, privada.id] }, limited);
  assert.deepEqual(seen.data.items.map((t: any) => t.id), [licencia.id]);
  assert.deepEqual(seen.data.missing, [privada.id], 'lo que no ve sale como que falta');
  assert.equal((await targets({ kind: 'task', ids: ['no'] })).status, 422);
  assert.equal((await targets({ kind: 'task', id: licencia.id })).data.externalRef, 'central:LEG_2026_004');
});
