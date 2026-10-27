/**
 * Tasks · «Proyectos y producción», 7.2: la proyección de producción (`GET projects/production`, migración 0357,
 * docs/tasks/API.md §52), de extremo a extremo contra el núcleo real: fases con sus recuentos y la siguiente acción, los
 * pasos en orden y las dependencias como bloqueo, los carriles por oficio, espacio, persona y fase, y el ámbito de quien lee
 * (404 si no ve el proyecto). Datos sintéticos (los marcos acústicos del diseño).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), OBRA = uuid(), OTRA = uuid();
const CORTAR = uuid(), MONTAR = uuid();
const LISTONES = uuid(), BASTIDOR = uuid(), B1 = uuid(), B2 = uuid(), B3 = uuid(), TELA = uuid(), SUELTA = uuid();
const CARPINTERIA = uuid(), TALLER = uuid(), PERSONA = uuid();
let app: TestApp;
let seq = 0;

const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `prod-${++seq}`, operations } });
const ins = (table: string, fields: Record<string, unknown>, id = uuid()): Operation => ({ op: 'insert', table, id, fields: { tab_id: TAB, ...fields } });
const task = (id: string, title: string, fields: Record<string, unknown> = {}): Operation => ins('tasks.tasks', { project_id: OBRA, title, position: ++seq * 1024, ...fields }, id);
const production = (projectId: string, token?: string) => app.call(`/api/v1/projects/production?projectId=${projectId}`, { token });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Taller', position: 1024 }))).status, 200);
  // Lo de Central y Recursos que se pone en las tareas, sintético.
  const sql = (q: string, v: unknown[]) => app.t.db.query(q, v);
  await sql(`insert into central.trades (id, name) values ($1, 'Carpintería Prueba')`, [CARPINTERIA]);
  await sql(`insert into central.people (id, display_name, relation, house_level) values ($1, 'Lucía Prueba', 'equipo', 'staff')`, [PERSONA]);
  const altura = (await sql(`select id from resources.spaces where name = 'Altura 3' and deleted_at is null`, [])).rows[0] as { id: string };
  await sql(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $2, 'edificio', 'Taller Prueba', 1)`, [TALLER, altura.id]);
  const out = await commit([
    ins('tasks.projects', { title: 'Marcos acústicos', position: 2048 }, OBRA),
    ins('tasks.projects', { title: 'Otra obra', position: 4096 }, OTRA),
    ins('tasks.project_phases', { project_id: OBRA, name: 'Cortar', position: 1024 }, CORTAR),
    ins('tasks.project_phases', { project_id: OBRA, name: 'Montar', position: 2048 }, MONTAR),
    task(LISTONES, 'Cortar listones', { phase_id: CORTAR, done: true }),
    task(BASTIDOR, 'Montar bastidor', { phase_id: MONTAR, steps_in_order: true }),
    task(B1, 'Encolar', { parent_id: BASTIDOR }),
    task(B2, 'Grapar', { parent_id: BASTIDOR }),
    task(B3, 'Lijar', { parent_id: BASTIDOR, step_free: true }),
    task(TELA, 'Tensar la tela', { phase_id: MONTAR }),
    task(SUELTA, 'Pedir presupuesto de tela'),
    ins('tasks.task_dependencies', { project_id: OBRA, task_id: TELA, depends_on_id: SUELTA, position: 1024 }),
    ins('tasks.task_trades', { project_id: OBRA, task_id: B1, trade_id: CARPINTERIA }),
    ins('tasks.task_trades', { project_id: OBRA, task_id: LISTONES, trade_id: CARPINTERIA }),
    ins('tasks.task_spaces', { project_id: OBRA, task_id: B1, space_id: TALLER }),
    ins('tasks.task_people', { project_id: OBRA, task_id: TELA, person_id: PERSONA }),
  ]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
});
test.after(async () => { await app.close(); });

test('fases con sus madres hechas y abiertas, sus bloqueos y la siguiente acción', async () => {
  const out = await production(OBRA, app.tokens.reader);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual([out.data.project.id, out.data.project.title], [OBRA, 'Marcos acústicos']);
  const [cortar, montar] = out.data.phases;
  assert.deepEqual([cortar.name, cortar.total, cortar.open, cortar.done, cortar.nextTaskId], ['Cortar', 1, 0, true, null]);
  // Montar: el bastidor (con pasos) y la tela, abiertos. Grapar espera a Encolar; la tela espera al presupuesto.
  assert.deepEqual([montar.name, montar.total, montar.open, montar.done, montar.blocked], ['Montar', 2, 2, false, 2]);
  assert.equal(montar.nextTaskId, B1, 'el primer paso de la cadena');
  assert.deepEqual(out.data.next, [{ phaseId: MONTAR, taskId: B1 }]);
});

test('las tareas: fase heredada por los pasos, contenedor, bloqueo con su motivo y sus ids', async () => {
  const out = await production(OBRA);
  const by = (id: string) => out.data.tasks.find((t: any) => t.id === id);
  assert.deepEqual([by(BASTIDOR).container, by(BASTIDOR).done, by(BASTIDOR).phaseId], [true, false, MONTAR]);
  assert.equal(by(B2).phaseId, MONTAR, 'el paso hereda la fase de su madre');
  assert.deepEqual(by(B1).blocked, { by: null, ids: [] });
  assert.deepEqual(by(B2).blocked, { by: 'step', ids: [B1] });
  assert.deepEqual(by(B3).blocked, { by: null, ids: [] }, 'fuera de la cadena');
  assert.deepEqual(by(TELA).blocked, { by: 'dependency', ids: [SUELTA] });
  assert.deepEqual(by(LISTONES).blocked, { by: null, ids: [] }, 'lo hecho no está bloqueado');
  assert.deepEqual([by(B1).trades, by(B1).spaces], [[CARPINTERIA], [TALLER]]);
  assert.deepEqual(by(TELA).people, [{ personId: PERSONA, houseLevel: null }]);
  assert.equal(by(SUELTA).phaseId, null);
  // En orden: madre y después sus pasos.
  const ids = out.data.tasks.map((t: any) => t.id);
  assert.ok(ids.indexOf(BASTIDOR) < ids.indexOf(B1) && ids.indexOf(B1) < ids.indexOf(B2));
});

test('los carriles cuentan trabajo (no contenedores) por oficio, espacio, persona y fase', async () => {
  const { lanes } = (await production(OBRA)).data;
  assert.deepEqual(lanes.byTrade[CARPINTERIA], { open: 1, done: 1 });
  assert.deepEqual(lanes.bySpace[TALLER], { open: 1, done: 0 });
  assert.deepEqual(lanes.byPerson[PERSONA], { open: 1, done: 0 });
  assert.deepEqual(lanes.byPhase[MONTAR], { open: 4, done: 0 }, 'tres pasos y la tela');
  assert.deepEqual(lanes.byPhase[CORTAR], { open: 0, done: 1 });
  assert.deepEqual(lanes.byPhase.none, { open: 1, done: 0 });
});

test('al hacer el primer paso, la siguiente acción pasa al segundo', async () => {
  const rev = (await app.call(`/api/v1/snapshot?tables=tasks.tasks&limit=2000`)).data.tables[0].rows.find((t: any) => t.id === B1).revision;
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: B1, expectedRevision: rev, fields: { done: true } }])).status, 200);
  const out = await production(OBRA);
  assert.equal(out.data.phases[1].nextTaskId, B2);
});

test('el ámbito: quien no ve el proyecto recibe 404, y el projectId es un uuid', async () => {
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [OTRA] } }), app.users.editor]);
  try {
    assert.equal((await production(OBRA, app.tokens.editor)).status, 404);
    assert.equal((await production(OTRA, app.tokens.editor)).status, 200);
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
  assert.equal((await production(uuid())).status, 404);
  assert.equal((await app.call('/api/v1/projects/production?projectId=nope')).status, 422);
});
