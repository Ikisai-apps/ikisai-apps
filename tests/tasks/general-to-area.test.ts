/**
 * Tasks · «Solo de un área» (FB_2026_035, migración 0343): una etiqueta General vuelve a ser de un área con
 * `POST labels/general/to-area`, de extremo a extremo contra el núcleo y el hook reales. Las demás áreas que la usan se
 * quedan con su copia (la archivada que dejó «Hacer General», desarchivada, o una nueva), con sus tareas, proyectos,
 * responsables, reglas, hijas y vistas. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const A = uuid(), B = uuid(), C = uuid(), A_IN = uuid(), B_IN = uuid(), C_IN = uuid(), PA = uuid(), PB = uuid(), PC = uuid();
const PODA_A = uuid(), PODA_B = uuid(), VG_A = uuid(), VG_B = uuid(), T_A = uuid(), T_B = uuid(), T_C = uuid(), ROUTE = uuid(), VIEW_B = uuid(), PL_B = uuid();
let app: TestApp;
let seq = 0;
let fam: Record<string, Record<string, string>> = {};

const rows = async (t: string) => (await app.call(`/api/v1/snapshot?tables=${t}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const row = async (t: string, id: string) => (await rows(t)).find((r) => r.id === id);
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `seed-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); };
const toArea = (labelId: string, tabId: string, token?: string) => app.call('/api/v1/labels/general/to-area', { token, body: { requestId: `to-area-${++seq}`, labelId, tabId } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const a = createTabOps({ id: A, name: 'Casa', position: 1024, inboxId: A_IN }), b = createTabOps({ id: B, name: 'Finca', position: 2048, inboxId: B_IN }), c = createTabOps({ id: C, name: 'Taller', position: 3072, inboxId: C_IN });
  const keys = (ops: Operation[]) => Object.fromEntries(ops.filter((o) => o.table === 'tasks.families').map((o) => [o.fields!.system_key as string, o.id!]));
  fam = { A: keys(a), B: keys(b), C: keys(c) };
  await ok([...a, ...b, ...c]);
  await ok([
    { op: 'insert', table: 'tasks.projects', id: PA, fields: { tab_id: A, title: 'Jardín', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PB, fields: { tab_id: B, title: 'Huerta', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PC, fields: { tab_id: C, title: 'Bancos', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: PODA_A, fields: { tab_id: A, family_id: fam.A!.phase!, name: 'Poda' } },
    { op: 'insert', table: 'tasks.labels', id: PODA_B, fields: { tab_id: B, family_id: fam.B!.phase!, name: 'Poda' } },
    { op: 'insert', table: 'tasks.labels', id: VG_A, fields: { tab_id: A, family_id: fam.A!.person!, name: 'VG' } },
    { op: 'insert', table: 'tasks.labels', id: VG_B, fields: { tab_id: B, family_id: fam.B!.person!, name: 'VG' } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_A, fields: { tab_id: A, project_id: PA, title: 'Podar el seto', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_B, fields: { tab_id: B, project_id: PB, title: 'Podar los frutales', position: 1024, owner_label_id: VG_B } },
    { op: 'insert', table: 'tasks.request_routes', id: ROUTE, fields: { kind: 'feedback.space.garden', tab_id: B, project_id: PB, owner_label_id: VG_B } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: A, project_id: PA, task_id: T_A, label_id: PODA_A } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: B, project_id: PB, task_id: T_B, label_id: PODA_B } },
    { op: 'insert', table: 'tasks.project_labels', id: PL_B, fields: { tab_id: B, project_id: PB, label_id: PODA_B } },
    { op: 'insert', table: 'tasks.saved_views', id: VIEW_B, fields: { tab_id: B, name: 'Poda', filters: { [fam.B!.phase!]: [PODA_B], _state: ['pending'] } } },
  ]);
  // «Hacer General» con Poda y VG de las dos áreas (las copias de cada área quedan archivadas).
  const merged = await app.call('/api/v1/labels/general/merge', { body: { requestId: 'merge-1', groups: [[PODA_A, PODA_B], [VG_A, VG_B]] } });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
});
test.after(async () => { await app.close(); });

test('una General vuelve a ser de un área: se queda en ella, y la otra área recupera su copia con todo lo suyo', async () => {
  const poda = (await rows('tasks.labels')).find((l) => l.tab_id === null && l.name === 'Poda' && !l.deleted_at)!;
  // También se usa en Taller, que nunca tuvo copia: allí nace una.
  await ok([{ op: 'insert', table: 'tasks.tasks', id: T_C, fields: { tab_id: C, project_id: PC, title: 'Podar el olivo', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: C, project_id: PC, task_id: T_C, label_id: poda.id } }]);

  const res = await toArea(poda.id, A);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.labelId, poda.id, 'la propia General pasa a Casa');
  const moved = await row('tasks.labels', poda.id);
  assert.deepEqual([moved.tab_id, moved.archived, moved.family_id], [A, false, poda.family_id]);
  assert.equal(res.data.copies[B], PODA_B, 'Finca recupera su copia archivada');
  assert.equal((await row('tasks.labels', PODA_B)).archived, false);
  const tallerCopy = res.data.copies[C];
  assert.ok(tallerCopy && tallerCopy !== poda.id);
  const nueva = await row('tasks.labels', tallerCopy);
  assert.deepEqual([nueva.tab_id, nueva.name, nueva.family_id], [C, 'Poda', poda.family_id]);
  assert.deepEqual([res.data.counts.copies, res.data.counts.restored], [1, 1]);

  const live = (await rows('tasks.task_labels')).filter((l) => !l.deleted_at);
  assert.deepEqual(live.filter((l) => l.task_id === T_A).map((l) => l.label_id), [poda.id]);
  assert.deepEqual(live.filter((l) => l.task_id === T_B).map((l) => l.label_id), [PODA_B]);
  assert.deepEqual(live.filter((l) => l.task_id === T_C).map((l) => l.label_id), [tallerCopy]);
  assert.equal((await row('tasks.project_labels', PL_B)).label_id, PODA_B);
  const view = (await row('tasks.saved_views', VIEW_B)).filters;
  assert.deepEqual(view, { [(await row('tasks.labels', PODA_B)).family_id]: [PODA_B], _state: ['pending'] });
});

test('responsables y reglas de otra área pasan a su copia; las hijas General lo impiden; solo la propietaria con toda la app', async () => {
  const vg = (await rows('tasks.labels')).find((l) => l.tab_id === null && l.name === 'VG' && !l.deleted_at)!;
  // Con una hija General, no (otra General de la misma familia, con su hija; las etiquetas se archivan, no se borran).
  const grupo = uuid(), hija = uuid();
  await ok([{ op: 'insert', table: 'tasks.labels', id: grupo, fields: { tab_id: null, family_id: vg.family_id, name: 'Turno de tarde' } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: hija, fields: { tab_id: null, family_id: vg.family_id, parent_id: grupo, name: 'Tarde de sábado' } }]);
  const blocked = await toArea(grupo, A);
  assert.equal(blocked.status, 422, JSON.stringify(blocked.data));
  assert.equal(blocked.data.error.code, 'LABEL_HAS_GENERAL_CHILDREN');

  // Quien no es propietaria con toda la app, no.
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [A], projects: {} }), app.users.editor]);
  assert.equal((await toArea(vg.id, A, app.tokens.editor)).status, 403);
  assert.equal((await toArea(vg.id, 'no')).status, 422);
  assert.equal((await toArea(PODA_B, A)).status, 422, 'una etiqueta de área no es General');

  const res = await toArea(vg.id, A);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.copies[B], VG_B);
  assert.equal((await row('tasks.tasks', T_B)).owner_label_id, VG_B);
  assert.equal((await row('tasks.request_routes', ROUTE)).owner_label_id, VG_B);
  assert.equal((await row('tasks.labels', vg.id)).tab_id, A);
  // Ya no es General: otra vez no.
  assert.equal((await toArea(vg.id, B)).status, 422);
});
