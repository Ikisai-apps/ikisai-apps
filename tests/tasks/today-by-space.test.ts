/**
 * Tasks · «Hoy» por espacio, también para Central (migración 0366, docs/tasks/API.md §60), contra el núcleo y Recursos
 * reales: `today/projection?spaceId=` filtra por un espacio con todo lo de dentro, o por «none» (sin espacio); y la vista
 * tasks.central_blocked_by_space cuenta por espacio de primer nivel (la altura o lo único que tiene) las pendientes y las
 * bloqueadas, con la misma regla que el indicador tasks.blocked. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const TAB = uuid(), OBRA = uuid(), ALBERGUE = uuid(), HAB3 = uuid();
const EN_HAB = uuid(), EN_ALBERGUE = uuid(), SIN = uuid(), ANTES = uuid();
let app: TestApp;

const ins = (table: string, fields: Record<string, unknown>, id = uuid()): Operation => ({ op: 'insert', table, id, fields: { tab_id: TAB, ...fields } });
const today = (query: string) => app.call(`/api/v1/today/projection?date=${TODAY}&projectId=${OBRA}${query}`);
const ids = async (query: string) => (await today(query)).data.items.map((i: any) => i.id).sort();

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await app.call('/api/v1/commands', { body: { requestId: 'tab', operations: createTabOps({ id: TAB, name: 'Casa', position: 1024 }) } })).status, 200);
  // La altura 3 tiene una sola cosa (el Albergue), con la Hab 3 dentro.
  const alt3 = ((await app.t.db.query(`select id from resources.spaces where name = 'Altura 3'`)).rows[0] as { id: string }).id;
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $2, 'edificio', 'Albergue Prueba', 1)`, [ALBERGUE, alt3]);
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $2, 'habitacion', 'Hab 3 Prueba', 1)`, [HAB3, ALBERGUE]);
  const out = await app.call('/api/v1/commands', { body: { requestId: 'seed', operations: [
    ins('tasks.projects', { title: 'Apertura', position: 2048 }, OBRA),
    ins('tasks.tasks', { project_id: OBRA, title: 'Hacer las camas', position: 1024, due: TODAY }, EN_HAB),
    ins('tasks.tasks', { project_id: OBRA, title: 'Revisar el albergue', position: 2048, due: TODAY }, EN_ALBERGUE),
    ins('tasks.tasks', { project_id: OBRA, title: 'Llamar al proveedor', position: 3072, due: TODAY }, SIN),
    ins('tasks.tasks', { project_id: OBRA, title: 'Pedir las sábanas', position: 4096, due: TODAY }, ANTES),
    ins('tasks.task_spaces', { project_id: OBRA, task_id: EN_HAB, space_id: HAB3 }),
    ins('tasks.task_spaces', { project_id: OBRA, task_id: EN_ALBERGUE, space_id: ALBERGUE }),
    ins('tasks.task_spaces', { project_id: OBRA, task_id: ANTES, space_id: HAB3 }),
    // Las camas esperan a las sábanas: bloqueada.
    ins('tasks.task_dependencies', { project_id: OBRA, task_id: EN_HAB, depends_on_id: ANTES, position: 1024 }),
  ] } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
});
test.after(async () => { await app.close(); });

test('«Hoy» por espacio: el Albergue con lo de dentro, la Hab 3 sola, y «none» lo que no tiene espacio', async () => {
  assert.deepEqual(await ids(`&spaceId=${ALBERGUE}`), [EN_HAB, EN_ALBERGUE, ANTES].sort());
  assert.deepEqual(await ids(`&spaceId=${HAB3}`), [EN_HAB, ANTES].sort());
  assert.deepEqual(await ids('&spaceId=none'), [SIN]);
  assert.equal((await today('&spaceId=sala')).status, 422);
});

test('Central: por espacio de primer nivel (lo único de la altura 3: el Albergue), pendientes y bloqueadas; nulo, sin espacio', async () => {
  const rows = (await app.t.db.query(`select space_id, open, blocked from tasks.central_blocked_by_space`)).rows as Array<{ space_id: string | null; open: number; blocked: number }>;
  const albergue = rows.find((r) => r.space_id === ALBERGUE);
  assert.deepEqual([albergue?.open, albergue?.blocked], [3, 1], 'tres en el albergue (dos en la Hab 3) y una bloqueada');
  assert.equal(rows.some((r) => r.space_id === HAB3), false, 'la Hab 3 cuenta en su primer nivel, no aparte');
  const none = rows.find((r) => r.space_id === null);
  assert.ok(none && none.open >= 1);
});
