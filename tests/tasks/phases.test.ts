/**
 * Tasks · «Proyectos y producción», 7.1: fases del proyecto (migración 0356, docs/tasks/API.md §51), de extremo a extremo
 * contra el núcleo y el hook reales: la fase es de su proyecto y solo de una madre; cerrar con tareas abiertas pide nota;
 * una fase con tareas no se borra; mover una tarea de proyecto suelta la fase; el modelo de la interfaz las lleva y las
 * trae; vaciar la papelera las purga con su proyecto. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { TABLES, compose, createTabOps, decompose, emptyDataset, visibleRow, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OBRA = uuid(), OTRA = uuid();
const CORTAR = uuid(), MONTAR = uuid(), AJENA = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string, token?: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=2000`, { token })).data.tables[0].rows as any[];
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `phases-${++seq}`, operations } });
const code = async (operations: Operation[], token?: string) => { const r = await commit(operations, token); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
const data = async () => { const d: any = emptyDataset(); for (const t of TABLES) d[t] = await rows(t); return d; };
const phase = (id: string, project: string, name: string, position: number, extra: Record<string, unknown> = {}): Operation =>
  ({ op: 'insert', table: 'tasks.project_phases', id, fields: { tab_id: TAB, project_id: project, name, position, ...extra } });
const task = (id: string, project: string, extra: Record<string, unknown> = {}): Operation =>
  ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: project, title: 'Marco acústico', position: 1024, ...extra } });
const update = async (table: string, id: string, fields: Record<string, unknown>): Promise<Operation> =>
  ({ op: 'update', table, id, expectedRevision: (await row(table, id)).revision, fields });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal(await code(createTabOps({ id: TAB, name: 'Taller', position: 1024 })), '200 OK');
  assert.equal(await code([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Marcos acústicos', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: OTRA, fields: { tab_id: TAB, title: 'Otra obra', position: 4096 } },
    phase(CORTAR, OBRA, 'Cortar', 1024), phase(MONTAR, OBRA, 'Montar', 2048), phase(AJENA, OTRA, 'Pintar', 1024),
  ]), '200 OK');
});
test.after(async () => { await app.close(); });

test('una fase es de su proyecto, con nombre y estado válidos; la ve quien ve el proyecto', async () => {
  const list = (await rows('tasks.project_phases', app.tokens.reader)).filter((p) => p.project_id === OBRA);
  assert.deepEqual(list.map((p) => [p.name, p.status, p.closed_note]).sort(), [['Cortar', 'pending', ''], ['Montar', 'pending', '']]);
  assert.equal(await code([phase(uuid(), OBRA, '   ', 3072)]), '422 INVALID_PHASE');
  assert.equal(await code([phase(uuid(), OBRA, 'Acabar', 3072, { status: 'cerrada' })]), '422 INVALID_PHASE');
  assert.equal(await code([phase(uuid(), OBRA, 'Acabar', 3072, { start: '2026-11-10', due: '2026-11-01' })]), '422 INVALID_PHASE', 'empieza después de acabar');
  assert.equal(await code([phase(uuid(), OBRA, 'Acabar', 3072)], app.tokens.reader), '403 FORBIDDEN');
  // Otra área (o un proyecto de otra área) no cuadra con su proyecto.
  const lejos = uuid();
  assert.equal(await code([...createTabOps({ id: lejos, name: 'Eventos', position: 2048 })]), '200 OK');
  const cruzada = phase(uuid(), OBRA, 'Acabar', 3072);
  assert.equal(await code([{ ...cruzada, fields: { ...cruzada.fields, tab_id: lejos } }]), '422 INCONSISTENT_KEYS');
  // La visibilidad es la de su proyecto.
  const scopes = { tabs: [], projects: { [TAB]: [OBRA] } };
  assert.equal(visibleRow('tasks.project_phases', { tab_id: TAB, project_id: OBRA }, scopes), true);
  assert.equal(visibleRow('tasks.project_phases', { tab_id: TAB, project_id: OTRA }, scopes), false);
});

test('la fase de una tarea: una viva de su mismo proyecto y solo en una madre', async () => {
  const madre = uuid(), paso = uuid();
  assert.equal(await code([task(uuid(), OBRA, { phase_id: AJENA })]), '422 INVALID_PHASE', 'fase de otro proyecto');
  assert.equal(await code([task(madre, OBRA, { phase_id: CORTAR })]), '200 OK');
  assert.equal(await code([task(paso, OBRA, { parent_id: madre, phase_id: CORTAR })]), '422 INVALID_PHASE', 'un paso no lleva fase');
  assert.equal(await code([task(paso, OBRA, { parent_id: madre })]), '200 OK');
  assert.equal(await code([await update('tasks.tasks', madre, { phase_id: MONTAR })]), '200 OK');
  assert.equal((await row('tasks.tasks', madre)).phase_id, MONTAR);
});

test('mover una tarea a otro proyecto suelta su fase (trigger), también por una operación directa', async () => {
  const id = uuid();
  assert.equal(await code([task(id, OBRA, { phase_id: CORTAR })]), '200 OK');
  assert.equal(await code([await update('tasks.tasks', id, { project_id: OTRA })]), '200 OK');
  const moved = await row('tasks.tasks', id);
  assert.deepEqual([moved.project_id, moved.phase_id], [OTRA, null]);
  // Escribir a propósito una fase que no es de su proyecto sigue sin valer.
  assert.equal(await code([await update('tasks.tasks', id, { phase_id: CORTAR })]), '422 INVALID_PHASE');
});

test('cerrar una fase con tareas abiertas pide nota; sin abiertas, no', async () => {
  const fase = uuid(), a = uuid(), b = uuid(), paso = uuid();
  assert.equal(await code([phase(fase, OBRA, 'Acabar', 4096), task(a, OBRA, { phase_id: fase }), task(b, OBRA, { phase_id: fase, done: true })]), '200 OK');
  assert.equal(await code([task(paso, OBRA, { parent_id: b })]), '200 OK', 'la madre hecha tiene un paso sin hacer: está abierta');
  const sinNota = await commit([await update('tasks.project_phases', fase, { status: 'done' })]);
  assert.equal(`${sinNota.status} ${sinNota.data.error?.code}`, '422 PHASE_OPEN_TASKS');
  assert.equal(sinNota.data.error.details.open, 2);
  assert.equal(await code([await update('tasks.project_phases', fase, { status: 'done', closed_note: 'El barniz se hace en la fase siguiente.' })]), '200 OK');
  // Reabierta y con todo hecho, se cierra sin nota.
  assert.equal(await code([await update('tasks.project_phases', fase, { status: 'active', closed_note: '' })]), '200 OK');
  assert.equal(await code([await update('tasks.tasks', a, { done: true }), await update('tasks.tasks', paso, { done: true })]), '200 OK');
  assert.equal(await code([await update('tasks.project_phases', fase, { status: 'done' })]), '200 OK');
});

test('una fase con tareas vivas no se borra; soltándolas en el mismo lote, sí', async () => {
  const fase = uuid(), t = uuid();
  assert.equal(await code([phase(fase, OBRA, 'Lijar', 5120), task(t, OBRA, { phase_id: fase })]), '200 OK');
  const del = async (): Promise<Operation> => ({ op: 'delete', table: 'tasks.project_phases', id: fase, expectedRevision: (await row('tasks.project_phases', fase)).revision });
  assert.equal(await code([await del()]), '422 PHASE_NOT_EMPTY');
  assert.equal(await code([await update('tasks.tasks', t, { phase_id: null }), await del()]), '200 OK');
  assert.equal(await row('tasks.project_phases', fase), undefined, 'en la papelera (snapshot no la trae)');
});

test('el modelo de la interfaz: fases calculadas, los pasos heredan la de su madre y quitar una fase suelta sus tareas', async () => {
  const fase = uuid(), madre = uuid(), paso = uuid();
  assert.equal(await code([phase(fase, OBRA, 'Barnizar', 6144), task(madre, OBRA, { phase_id: fase }), task(paso, OBRA, { parent_id: madre, done: true })]), '200 OK');
  let tabs = compose(await data());
  let obra = tabs.find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!;
  const barnizar = obra.phases!.find((p) => p.id === fase)!;
  assert.deepEqual([barnizar.name, barnizar.total, barnizar.open, barnizar.done], ['Barnizar', 1, 0, true], 'la madre está hecha porque lo está su paso');
  assert.equal(obra.tasks.find((t) => t.id === paso)!.phaseId, fase, 'el paso hereda la fase al leer');
  assert.equal((await row('tasks.tasks', paso)).phase_id, null, 'pero no la guarda');
  // Guardar el modelo tal cual no toca fases ni la fase de ninguna tarea.
  const same = decompose(await data(), tabs).flat();
  assert.deepEqual(same.filter((o) => o.table === 'tasks.project_phases' || (o.fields && 'phase_id' in o.fields)), []);
  // Una fase nueva desde el modelo y una tarea a ella.
  const nueva = uuid();
  obra.phases!.push({ id: nueva, name: 'Embalar', order: 7168, status: 'pending', start: '', due: '2026-12-01', closedNote: '', version: 0 });
  obra.tasks.find((t) => t.id === madre)!.phaseId = nueva;
  for (const batch of decompose(await data(), tabs)) assert.equal(await code(batch), '200 OK');
  assert.equal((await row('tasks.tasks', madre)).phase_id, nueva);
  assert.equal((await row('tasks.project_phases', nueva)).due, '2026-12-01');
  // Quitar la fase del modelo la manda a la papelera y suelta su tarea, en el mismo guardado.
  tabs = compose(await data());
  obra = tabs.find((t) => t.id === TAB)!.projects.find((p) => p.id === OBRA)!;
  obra.phases = obra.phases!.filter((p) => p.id !== nueva);
  for (const batch of decompose(await data(), tabs)) assert.equal(await code(batch), '200 OK');
  assert.equal(await row('tasks.project_phases', nueva), undefined, 'en la papelera');
  assert.equal((await row('tasks.tasks', madre)).phase_id, null);
});

test('vaciar la papelera purga las fases de un proyecto borrado', async () => {
  const proyecto = uuid(), fase = uuid(), t = uuid();
  assert.equal(await code([
    { op: 'insert', table: 'tasks.projects', id: proyecto, fields: { tab_id: TAB, title: 'Prototipo', position: 8192 } },
    phase(fase, proyecto, 'Probar', 1024), task(t, proyecto, { phase_id: fase }),
  ]), '200 OK');
  assert.equal(await code([{ op: 'delete', table: 'tasks.projects', id: proyecto, expectedRevision: (await row('tasks.projects', proyecto)).revision }]), '200 OK');
  const emptied = await app.call('/api/v1/trash/empty', { body: { requestId: `phases-trash-${++seq}` } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.equal(await row('tasks.project_phases', fase), undefined);
  assert.equal(await row('tasks.projects', proyecto), undefined);
});
