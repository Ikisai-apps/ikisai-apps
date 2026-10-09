/**
 * Tasks · catálogo General de etiquetas (FB_2026_023, migración 0317), de extremo a extremo contra el núcleo y el hook
 * reales: fusionar en General las etiquetas repetidas entre áreas (`POST labels/general/merge`), con madres e hijas,
 * responsables, etiquetas de proyecto, reglas y vistas; y después usar lo General en cualquier área.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const A = uuid(), A_IN = uuid(), B = uuid(), B_IN = uuid(), PA = uuid(), PB = uuid();
const VG_A = uuid(), VG_B = uuid(), PODA_A = uuid(), PODA_B = uuid(), ZONA_A = uuid(), ZONA_B = uuid(), PATIO_A = uuid(), PATIO_B = uuid(), HUERTO_B = uuid(), SOLO_A = uuid();
const T_A = uuid(), T_B = uuid(), T_HUERTO = uuid(), ROUTE = uuid(), VIEW = uuid(), PL = uuid();
let app: TestApp;
let seq = 0;
let fam: Record<string, Record<string, string>> = {};

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const POSITIONED = new Set(['tasks.tasks', 'tasks.labels', 'tasks.request_routes', 'tasks.saved_views']);
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `seed-${++seq}`,
  operations: operations.map((o) => (o.op === 'insert' && POSITIONED.has(o.table ?? '') && o.fields?.position === undefined ? { ...o, fields: { ...o.fields, position: ++seq * 1024 } } : o)) } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; };
const merge = (groups: string[][], token?: string) => app.call('/api/v1/labels/general/merge', { token, body: { requestId: `merge-${++seq}`, groups } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const a = createTabOps({ id: A, name: 'Casa', position: 1024, inboxId: A_IN }), b = createTabOps({ id: B, name: 'Finca', position: 2048, inboxId: B_IN });
  const keys = (ops: Operation[]) => Object.fromEntries(ops.filter((o) => o.table === 'tasks.families').map((o) => [o.fields!.system_key as string, o.id!]));
  fam = { A: keys(a), B: keys(b) };
  await ok([...a, ...b]);
  await ok([
    { op: 'insert', table: 'tasks.projects', id: PA, fields: { tab_id: A, title: 'Jardín', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PB, fields: { tab_id: B, title: 'Huerta', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: VG_A, fields: { tab_id: A, family_id: fam.A!.person!, name: 'VG' } },
    { op: 'insert', table: 'tasks.labels', id: VG_B, fields: { tab_id: B, family_id: fam.B!.person!, name: 'vg' } },
    { op: 'insert', table: 'tasks.labels', id: PODA_A, fields: { tab_id: A, family_id: fam.A!.phase!, name: 'Poda' } },
    { op: 'insert', table: 'tasks.labels', id: PODA_B, fields: { tab_id: B, family_id: fam.B!.phase!, name: 'Poda ' } },
    { op: 'insert', table: 'tasks.labels', id: ZONA_A, fields: { tab_id: A, family_id: fam.A!.space!, name: 'Zona' } },
    { op: 'insert', table: 'tasks.labels', id: ZONA_B, fields: { tab_id: B, family_id: fam.B!.space!, name: 'Zona' } },
    { op: 'insert', table: 'tasks.labels', id: SOLO_A, fields: { tab_id: A, family_id: fam.A!.phase!, name: 'Solo de Casa' } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: PATIO_A, fields: { tab_id: A, family_id: fam.A!.space!, parent_id: ZONA_A, name: 'Patio' } },
    { op: 'insert', table: 'tasks.labels', id: PATIO_B, fields: { tab_id: B, family_id: fam.B!.space!, parent_id: ZONA_B, name: 'Patio' } },
    { op: 'insert', table: 'tasks.labels', id: HUERTO_B, fields: { tab_id: B, family_id: fam.B!.space!, parent_id: ZONA_B, name: 'Huerto' } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_A, fields: { tab_id: A, project_id: PA, title: 'Podar el seto', owner_label_id: VG_A } },
    { op: 'insert', table: 'tasks.tasks', id: T_B, fields: { tab_id: B, project_id: PB, title: 'Regar el patio', owner_label_id: VG_B } },
    { op: 'insert', table: 'tasks.tasks', id: T_HUERTO, fields: { tab_id: B, project_id: PB, title: 'Abonar el huerto' } },
    { op: 'insert', table: 'tasks.project_labels', id: PL, fields: { tab_id: A, project_id: PA, label_id: PODA_A } },
    { op: 'insert', table: 'tasks.request_routes', id: ROUTE, fields: { kind: 'feedback.space.garden', tab_id: B, project_id: PB, owner_label_id: VG_B } },
    { op: 'insert', table: 'tasks.saved_views', id: VIEW, fields: { tab_id: A, name: 'De VG', filters: { [fam.A!.person!]: [VG_A], _state: ['pending'] } } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: A, project_id: PA, task_id: T_A, label_id: VG_A } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: A, project_id: PA, task_id: T_A, label_id: PODA_A } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: B, project_id: PB, task_id: T_B, label_id: ZONA_B } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: B, project_id: PB, task_id: T_B, label_id: PATIO_B } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: B, project_id: PB, task_id: T_HUERTO, label_id: ZONA_B } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: B, project_id: PB, task_id: T_HUERTO, label_id: HUERTO_B } },
  ]);
});
test.after(async () => { await app.close(); });

test('la fusión solo la hace la propietaria con acceso completo, y rechaza grupos que no son la misma etiqueta', async () => {
  assert.equal((await merge([[VG_A, VG_B]], app.tokens.editor)).status, 403);
  const bad = async (groups: string[][], reason: string) => { const res = await merge(groups); assert.equal(res.status, 422, JSON.stringify(res.data)); assert.equal(res.data.error.code === 'INVALID_MERGE' || res.data.error.code === 'INVALID_OPERATION', true, reason); };
  await bad([[VG_A, PODA_A]], 'de la misma área');
  await bad([[VG_A, PODA_B]], 'otro nombre y otra familia');
  await bad([[PATIO_A, PATIO_B]], 'una hija sin su madre');
  assert.equal((await row('tasks.labels', VG_A)).archived, false, 'nada cambia si se rechaza');
});

test('fusionar: General con madres e hijas; tareas, responsables, proyecto, regla y vista apuntan a lo General; copias archivadas', async () => {
  const res = await merge([[PATIO_A, PATIO_B], [VG_A, VG_B], [PODA_A, PODA_B], [ZONA_A, ZONA_B]]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const g = res.data.generals as Record<string, string>;
  assert.equal(g[VG_A], g[VG_B]);
  assert.deepEqual(res.data.counts, { groups: 4, labels: 8, familiesCreated: 3, taskLabels: 5, projectLabels: 1, owners: 2, routes: 1, children: 1, views: 1 });

  const labels = await rows('tasks.labels'), families = await rows('tasks.families');
  const general = (id: string) => labels.find((l) => l.id === g[id]);
  assert.deepEqual([general(VG_A).tab_id, general(VG_A).name], [null, 'VG']);
  assert.equal(general(PODA_A).name, 'Poda');
  const famOf = (id: string) => families.find((f) => f.id === general(id).family_id);
  assert.deepEqual([famOf(VG_A).tab_id, famOf(VG_A).system_key], [null, 'person']);
  assert.deepEqual([famOf(ZONA_A).system_key, general(PATIO_A).parent_id], ['space', g[ZONA_A]]);
  // Copias archivadas, no borradas.
  for (const id of [VG_A, VG_B, PODA_A, PODA_B, ZONA_A, ZONA_B, PATIO_A, PATIO_B]) assert.deepEqual([(await row('tasks.labels', id)).archived, (await row('tasks.labels', id)).deleted_at], [true, null], id);
  // La hija solo de Finca se queda en su área, colgando de la Zona General y en su familia.
  const huerto = await row('tasks.labels', HUERTO_B);
  assert.deepEqual([huerto.tab_id, huerto.parent_id, huerto.family_id, huerto.archived], [B, g[ZONA_A], famOf(ZONA_A).id, false]);
  // Lo de un área que no se fusiona, igual.
  assert.deepEqual([(await row('tasks.labels', SOLO_A)).tab_id, (await row('tasks.labels', SOLO_A)).archived], [A, false]);

  const live = (await rows('tasks.task_labels')).filter((l) => !l.deleted_at);
  assert.deepEqual(live.filter((l) => l.task_id === T_A).map((l) => l.label_id).sort(), [g[VG_A], g[PODA_A]].sort());
  assert.deepEqual(live.filter((l) => l.task_id === T_B).map((l) => l.label_id).sort(), [g[ZONA_A], g[PATIO_A]].sort());
  assert.deepEqual(live.filter((l) => l.task_id === T_HUERTO).map((l) => l.label_id).sort(), [g[ZONA_A], HUERTO_B].sort());
  assert.deepEqual([(await row('tasks.tasks', T_A)).owner_label_id, (await row('tasks.tasks', T_B)).owner_label_id], [g[VG_A], g[VG_A]]);
  assert.equal((await row('tasks.project_labels', PL)).label_id, g[PODA_A]);
  assert.equal((await row('tasks.request_routes', ROUTE)).owner_label_id, g[VG_A]);
  assert.deepEqual((await row('tasks.saved_views', VIEW)).filters, { [famOf(VG_A).id]: [g[VG_A]], _state: ['pending'] });
});

test('lo General vale en cualquier área; solo quien tiene toda la app crea General', async () => {
  const labels = await rows('tasks.labels');
  const vg = labels.find((l) => l.tab_id === null && l.name === 'VG'), personGeneral = vg.family_id;
  // En una tarea nueva de cualquier área, como etiqueta y como responsable.
  const t = uuid();
  await ok([{ op: 'insert', table: 'tasks.tasks', id: t, fields: { tab_id: B, project_id: B_IN, title: 'Nueva', owner_label_id: vg.id } }]);
  await ok([{ op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: B, project_id: B_IN, task_id: t, label_id: vg.id } }]);
  // Una etiqueta solo de un área dentro de una familia General.
  await ok([{ op: 'insert', table: 'tasks.labels', id: uuid(), fields: { tab_id: A, family_id: personGeneral, name: 'Solo en Casa' } }]);
  // Una etiqueta General nueva: la propietaria sí; quien tiene un área, no. Una General en una familia de área, no.
  await ok([{ op: 'insert', table: 'tasks.labels', id: uuid(), fields: { tab_id: null, family_id: personGeneral, name: 'AN' } }]);
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [A], projects: {} }), app.users.editor]);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.labels', id: uuid(), fields: { tab_id: null, family_id: personGeneral, name: 'XX' } }], app.tokens.editor)).status, 403);
  const wrong = await commit([{ op: 'insert', table: 'tasks.labels', id: uuid(), fields: { tab_id: null, family_id: fam.A!.phase!, name: 'YY' } }]);
  assert.equal(wrong.status, 422, JSON.stringify(wrong.data));
  // Quien tiene solo un área ve lo General.
  const seen = (await app.call('/api/v1/snapshot?tables=tasks.labels&limit=2000', { token: app.tokens.editor })).data.tables[0].rows as any[];
  assert.ok(seen.some((l) => l.id === vg.id));
  assert.ok(!seen.some((l) => l.tab_id === B));
  // Una tarea de un área no puede llevar una etiqueta de otra área (sigue igual).
  const cross = await commit([{ op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: B, project_id: B_IN, task_id: t, label_id: SOLO_A } }]);
  assert.equal(cross.status, 422, JSON.stringify(cross.data));
});

test('convertir un área en proyecto de otra conserva sus etiquetas General', async () => {
  const vg = (await rows('tasks.labels')).find((l) => l.tab_id === null && l.name === 'VG');
  const res = await app.call(`/api/v1/tabs/${A}/convert`, { body: { requestId: `convert-${++seq}`, targetTabId: B, title: 'Casa' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const live = (await rows('tasks.task_labels')).filter((l) => !l.deleted_at && l.task_id === T_A);
  assert.ok(live.some((l) => l.label_id === vg.id && l.tab_id === B), 'la General sigue en la tarea, ya en Finca');
  assert.equal((await row('tasks.tasks', T_A)).owner_label_id, vg.id);
});
