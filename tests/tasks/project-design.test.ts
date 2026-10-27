/**
 * Tasks · «Proyectos y producción», 7.4: la entrevista de diseño (`POST projects/design`, migración 0359, docs/tasks/API.md
 * §54), de extremo a extremo contra el núcleo y los hooks reales: el ejemplo de los marcos acústicos completo (fases,
 * madres con fase, pasos en orden, oficio, material y dependencia), repetir no duplica, un oficio que no existe, un ciclo,
 * claves y forma, y un editor de otra área. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OTHER = uuid(), CARPINTERIA = uuid(), TABLERO = uuid();
let app: TestApp;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`)).data.tables[0].rows as any[];
const design = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/projects/design', { token, body });
const marcos = (designId: string, extra: Record<string, unknown> = {}) => ({
  designId, tabId: TAB, title: 'Marcos acústicos', objective: 'Cuatro marcos para la sala grande.', due: '2026-12-15',
  phases: [{ key: 'cortar', name: 'Cortar' }, { key: 'montar', name: 'Montar', due: '2026-12-10' }],
  tasks: [
    { key: 'listones', phase: 'cortar', title: 'Cortar listones', trades: [CARPINTERIA], materials: [{ itemId: TABLERO, quantity: 4 }] },
    { key: 'bastidor', phase: 'montar', title: 'Montar bastidor', inOrder: true, dependsOn: ['listones'],
      steps: [{ title: 'Encolar' }, { title: 'Grapar' }, { title: 'Lijar', free: true }] },
    { key: 'tela', phase: 'montar', title: 'Tensar la tela', priority: 'high', dependsOn: ['bastidor'] },
  ],
  ...extra,
});

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  for (const [id, name, position] of [[TAB, 'Taller', 1024], [OTHER, 'Eventos', 2048]] as const) {
    assert.equal((await app.call('/api/v1/commands', { body: { requestId: `tab-${id}`, operations: createTabOps({ id, name, position }) } })).status, 200);
  }
  await app.t.db.query(`insert into central.trades (id, name) values ($1, 'Carpintería Prueba')`, [CARPINTERIA]);
  await app.t.db.query(`insert into resources.items (id, name, kind, base_unit) values ($1, 'Tablero DM Prueba', 'material', 'ud')`, [TABLERO]);
});
test.after(async () => { await app.close(); });

test('los marcos acústicos: proyecto, fases, madres con fase, pasos en orden, oficio, material y dependencias en un lote', async () => {
  const designId = uuid();
  const out = await design(marcos(designId));
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual([out.data.created, out.data.phases, out.data.tasks, out.data.steps], [true, 2, 3, 3]);
  const projectId = out.data.projectId;
  const project = (await rows('tasks.projects')).find((p) => p.id === projectId);
  assert.deepEqual([project.title, project.note, project.due, project.tab_id], ['Marcos acústicos', 'Cuatro marcos para la sala grande.', '2026-12-15', TAB]);
  const phases = (await rows('tasks.project_phases')).filter((p) => p.project_id === projectId).sort((a, b) => a.position - b.position);
  assert.deepEqual(phases.map((p) => [p.name, p.due]), [['Cortar', null], ['Montar', '2026-12-10']]);
  const tasks = (await rows('tasks.tasks')).filter((t) => t.project_id === projectId);
  const by = (title: string) => tasks.find((t) => t.title === title);
  assert.equal(by('Cortar listones').phase_id, phases[0].id);
  assert.deepEqual([by('Montar bastidor').phase_id, by('Montar bastidor').steps_in_order], [phases[1].id, true]);
  assert.deepEqual(tasks.filter((t) => t.parent_id === by('Montar bastidor').id).sort((a, b) => a.position - b.position).map((t) => [t.title, t.step_free]),
    [['Encolar', false], ['Grapar', false], ['Lijar', true]]);
  assert.equal(by('Tensar la tela').priority, 'high');
  assert.deepEqual((await rows('tasks.task_trades')).filter((r) => r.task_id === by('Cortar listones').id).map((r) => r.trade_id), [CARPINTERIA]);
  assert.deepEqual((await rows('tasks.task_materials')).filter((r) => r.task_id === by('Cortar listones').id).map((r) => [r.item_id, Number(r.quantity)]), [[TABLERO, 4]]);
  const deps = (await rows('tasks.task_dependencies')).filter((d) => d.project_id === projectId);
  assert.deepEqual(deps.map((d) => [tasks.find((t) => t.id === d.task_id).title, tasks.find((t) => t.id === d.depends_on_id).title]).sort(),
    [['Montar bastidor', 'Cortar listones'], ['Tensar la tela', 'Montar bastidor']]);
  // La producción ya lo lee: la siguiente acción de «Cortar» son los listones.
  const prod = (await app.call(`/api/v1/projects/production?projectId=${projectId}`)).data;
  assert.equal(prod.phases[0].nextTaskId, by('Cortar listones').id);

  // Repetir no duplica.
  const again = await design(marcos(designId.toUpperCase()));
  assert.deepEqual([again.status, again.data.projectId, again.data.created], [200, projectId, false]);
  assert.equal((await rows('tasks.projects')).filter((p) => p.title === 'Marcos acústicos').length, 1);
});

test('un oficio que no existe, un ciclo, una fase o dependencia desconocida y la forma: 422 sin crear nada', async () => {
  const before = (await rows('tasks.projects')).length;
  const bad = async (extra: Record<string, unknown>) => (await design(marcos(uuid(), extra))).status;
  const tasks = marcos(uuid()).tasks as any[];
  assert.equal(await bad({ tasks: [{ ...tasks[0], trades: [uuid()] }] }), 422, 'oficio que no existe');
  assert.equal(await bad({ tasks: [{ key: 'a', title: 'A', dependsOn: ['b'] }, { key: 'b', title: 'B', dependsOn: ['a'] }] }), 422, 'ciclo');
  assert.equal(await bad({ tasks: [{ key: 'a', title: 'A', phase: 'pintar' }] }), 422, 'fase desconocida');
  assert.equal(await bad({ tasks: [{ key: 'a', title: 'A', dependsOn: ['z'] }] }), 422, 'dependencia desconocida');
  assert.equal(await bad({ tasks: [{ key: 'a', title: 'A' }, { key: 'a', title: 'B' }] }), 422, 'clave repetida');
  assert.equal(await bad({ tasks: [{ key: 'a b', title: 'A' }] }), 422, 'clave mal formada');
  assert.equal(await bad({ tasks: [{ key: 'a', title: '  ' }] }), 422, 'sin título');
  assert.equal(await bad({ tasks: [{ key: 'a', title: 'A', materials: [{ itemId: TABLERO, quantity: 'cuatro' }] }] }), 422, 'cantidad');
  assert.equal(await bad({ tasks: [{ key: 'a', title: 'A', people: [{}] }] }), 422, 'persona vacía');
  assert.equal(await bad({ phases: [{ key: 'p', name: 'P', due: '2026-02-31' }], tasks: [] }), 422, 'fecha');
  assert.equal(await bad({ tasks: [{ key: 'a', title: 'A', color: 'rojo' }] }), 422, 'campo no admitido');
  assert.equal(await bad({ tasks: Array.from({ length: 201 }, (_, i) => ({ key: `t${i}`, title: 'T' })) }), 422, 'más de 200 tareas');
  assert.equal((await rows('tasks.projects')).length, before, 'nada a medias');
});

test('quién: editor u owner con el área entera; quien solo lee o tiene otra área, 403', async () => {
  assert.equal((await design(marcos(uuid()), app.tokens.reader)).status, 403);
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [OTHER], projects: {} }), app.users.editor]);
  try {
    assert.equal((await design(marcos(uuid()), app.tokens.editor)).status, 403, 'otra área');
    assert.equal((await design(marcos(uuid(), { tabId: OTHER, tasks: [{ key: 'a', title: 'Montar la barra' }], phases: [] }), app.tokens.editor)).status, 200, 'la suya');
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
});
