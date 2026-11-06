/**
 * Tasks · «Etapa» como fase (migración 0367, docs/tasks/API.md §61), contra el núcleo y los hooks reales: las etiquetas de
 * etapa pasan a ser fases de cada proyecto, cada madre toma la suya (o la actual) y las etiquetas van a la papelera con su
 * familia archivada; la tarea nueva recibe la fase actual; una sola actual por proyecto. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { TABLES, compose, createTabOps, emptyDataset, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OBRA = uuid(), JARDIN = uuid(), SUELTO = uuid();
const MVP = uuid(), FASE1 = uuid();
const A = uuid(), B = uuid(), PASO = uuid(), C = uuid(), D = uuid(), E = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`)).data.tables[0].rows as any[];
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `stages-${++seq}`, operations } });
const code = async (operations: Operation[]) => { const r = await commit(operations); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
const phasesOf = async (project: string) => (await rows('tasks.project_phases')).filter((p) => p.project_id === project).sort((a, b) => Number(a.position) - Number(b.position));
const task = (id: string, project: string, extra: Record<string, unknown> = {}): Operation =>
  ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: project, title: 'Tarea de prueba', position: 1024, ...extra } });
const update = async (table: string, id: string, fields: Record<string, unknown>): Promise<Operation> =>
  ({ op: 'update', table, id, expectedRevision: (await row(table, id)).revision, fields });
const convert = async () => Number(((await app.t.db.query('select tasks.stage_labels_to_phases() as n')).rows[0] as { n: number }).n);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal(await code(createTabOps({ id: TAB, name: 'Casa', position: 1024 })), '200 OK');
  const family = ((await app.t.db.query(`select id from tasks.families where tab_id = $1 and system_key = 'phase'`, [TAB])).rows[0] as { id: string }).id;
  assert.equal(await code([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Obra', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: JARDIN, fields: { tab_id: TAB, title: 'Jardín', position: 3072 } },
    { op: 'insert', table: 'tasks.projects', id: SUELTO, fields: { tab_id: TAB, title: 'Sin etapas', position: 4096 } },
    { op: 'insert', table: 'tasks.labels', id: MVP, fields: { tab_id: TAB, family_id: family, name: 'MVP', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: FASE1, fields: { tab_id: TAB, family_id: family, name: 'Fase 1', position: 2048 } },
    task(A, OBRA), task(B, OBRA, { position: 2048 }), task(PASO, OBRA, { parent_id: B }), task(C, OBRA, { position: 3072 }),
    task(D, JARDIN), task(E, SUELTO),
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: A, label_id: MVP } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PASO, label_id: FASE1 } },
    { op: 'insert', table: 'tasks.project_labels', id: uuid(), fields: { tab_id: TAB, project_id: JARDIN, label_id: FASE1 } },
  ]), '200 OK');
});
test.after(async () => { await app.close(); });

test('las etiquetas de etapa pasan a ser fases de cada proyecto, con su tarea y la actual', async () => {
  const cursor = async () => Number(((await app.t.db.query(`select cursor from core.app_state where app = 'tasks'`)).rows[0] as { cursor: string }).cursor);
  const before = await cursor();
  assert.ok(await convert() > 0);
  assert.ok(await cursor() > before, 'en lotes del núcleo: se sincroniza');
  const obra = await phasesOf(OBRA);
  assert.deepEqual(obra.map((p) => [p.name, p.is_current]), [['MVP', true], ['Fase 1', false]]);
  const [mvp, fase1] = obra;
  assert.equal((await row('tasks.tasks', A)).phase_id, mvp.id, 'su etiqueta');
  assert.equal((await row('tasks.tasks', B)).phase_id, fase1.id, 'la etiqueta de su paso');
  assert.equal((await row('tasks.tasks', PASO)).phase_id, null, 'un paso no la guarda');
  assert.equal((await row('tasks.tasks', C)).phase_id, mvp.id, 'sin etiqueta: la actual');
  const jardin = await phasesOf(JARDIN);
  assert.deepEqual(jardin.map((p) => [p.name, p.is_current]), [['Fase 1', true]], 'la etiqueta del proyecto');
  assert.equal((await row('tasks.tasks', D)).phase_id, jardin[0].id);
  assert.deepEqual([(await phasesOf(SUELTO)).length, (await row('tasks.tasks', E)).phase_id], [0, null], 'sin etapas, sin fases');
  // Las etiquetas salen de tareas y proyectos y van a la papelera; la familia queda archivada.
  assert.equal((await rows('tasks.task_labels')).filter((l) => [MVP, FASE1].includes(l.label_id)).length, 0);
  assert.equal((await rows('tasks.project_labels')).filter((l) => l.label_id === FASE1).length, 0);
  assert.deepEqual([await row('tasks.labels', MVP), await row('tasks.labels', FASE1)], [undefined, undefined]);
  assert.equal((await rows('tasks.families')).find((f) => f.tab_id === TAB && f.system_key === 'phase').archived, true);
  // El modelo de la interfaz trae la actual.
  const d: any = emptyDataset(); for (const t of TABLES) d[t] = await rows(t);
  const model = compose(d).find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!;
  assert.deepEqual(model.phases!.map((p) => [p.name, !!p.current]), [['MVP', true], ['Fase 1', false]]);
  assert.equal(await convert(), 0, 'repetirla no hace nada');
});

test('la tarea nueva recibe la fase actual; un paso, no', async () => {
  const [mvp, fase1] = await phasesOf(OBRA);
  const nueva = uuid(), paso = uuid();
  assert.equal(await code([task(nueva, OBRA), task(paso, OBRA, { parent_id: nueva })]), '200 OK');
  assert.deepEqual([(await row('tasks.tasks', nueva)).phase_id, (await row('tasks.tasks', paso)).phase_id], [mvp.id, null]);
  // Cambiar la actual (en cualquier orden dentro del lote) y la siguiente tarea nueva va a la nueva actual.
  assert.equal(await code([await update('tasks.project_phases', fase1.id, { is_current: true }), await update('tasks.project_phases', mvp.id, { is_current: false })]), '200 OK');
  const otra = uuid();
  assert.equal(await code([task(otra, OBRA)]), '200 OK');
  assert.equal((await row('tasks.tasks', otra)).phase_id, fase1.id);
  // Soltar la fase a propósito no deja la madre sin fase: vuelve la actual.
  assert.equal(await code([await update('tasks.tasks', A, { phase_id: null })]), '200 OK');
  assert.equal((await row('tasks.tasks', A)).phase_id, fase1.id);
});

test('una sola fase actual por proyecto', async () => {
  const [mvp] = await phasesOf(OBRA);
  assert.equal(await code([await update('tasks.project_phases', mvp.id, { is_current: true })]), '422 INVALID_PHASE');
  assert.equal(await code([{ op: 'insert', table: 'tasks.project_phases', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, name: 'Fase 2', position: 9000, is_current: true } }]), '422 INVALID_PHASE');
  assert.equal(await code([{ op: 'insert', table: 'tasks.project_phases', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, name: 'Fase 2', position: 9000 } }]), '200 OK');
});
