/**
 * Tasks · «Proyectos y producción», 7.3: el material bloquea (migración 0358, docs/tasks/API.md §53), de extremo a extremo
 * contra el núcleo y Recursos reales: lo que falta se calcula con el stock y lo que piden antes otras tareas (por
 * vencimiento); bloquea aunque no haya compra (VG, vg-37) y lo dicen la producción, «hoy» y el indicador de Central; los
 * equipos no bloquean; al entrar stock deja de bloquear; «Pedir» con `task_id` deja la compra ligada a la tarea. Datos
 * sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const madrid = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000));
const TODAY = madrid(), YESTERDAY = madrid(-1);
const TAB = uuid(), OBRA = uuid(), OTRA = uuid();
const PRIMERO = uuid(), SEGUNDO = uuid(), HECHA = uuid();
const TABLERO = uuid(), TALADRO = uuid(), ALMACEN = uuid();
const M_PRIMERO = uuid(), M_SEGUNDO = uuid(), M_TALADRO = uuid(), M_HECHA = uuid();
const WORKER_KEY = 'clave-de-worker-de-prueba';
let app: TestApp;
let seq = 0;

const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `mat-${++seq}`, operations } });
const ins = (table: string, fields: Record<string, unknown>, id = uuid()): Operation => ({ op: 'insert', table, id, fields: { tab_id: TAB, ...fields } });
const production = async () => (await app.call(`/api/v1/projects/production?projectId=${OBRA}`)).data;
const byTask = (out: any, id: string) => out.tasks.find((t: any) => t.id === id);
const sql = (q: string, v: unknown[] = []) => app.t.db.query(q, v);
const entrada = (item: string, quantity: number) =>
  sql(`insert into resources.movements (item_id, space_id, quantity, kind) values ($1, $2, $3, 'entrada_manual')`, [item, ALMACEN, quantity]);
const kpi = async () => Number((await sql(`select value from tasks.central_kpi_projection where kpi = 'tasks.blocked'`)).rows[0]!.value);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin], workerKey: WORKER_KEY }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Taller', position: 1024 }))).status, 200);
  await sql(`insert into resources.items (id, name, kind, base_unit) values ($1, 'Tablero DM Prueba', 'material', 'ud'), ($2, 'Taladro Prueba', 'herramienta', 'ud')`, [TABLERO, TALADRO]);
  await entrada(TABLERO, 5);
  // El segundo vence antes: se lleva primero el stock (3 de 5). Al primero le quedan 2 de los 4 que necesita.
  const out = await commit([
    ins('tasks.projects', { title: 'Marcos acústicos', position: 2048 }, OBRA),
    ins('tasks.projects', { title: 'Otra obra', position: 4096 }, OTRA),
    ins('tasks.tasks', { project_id: OBRA, title: 'Montar bastidores', position: 1024, due: TODAY }, PRIMERO),
    ins('tasks.tasks', { project_id: OBRA, title: 'Cortar tableros', position: 2048, due: YESTERDAY }, SEGUNDO),
    ins('tasks.tasks', { project_id: OBRA, title: 'Muestra', position: 3072, done: true }, HECHA),
    ins('tasks.task_materials', { project_id: OBRA, task_id: PRIMERO, item_id: TABLERO, quantity: 4, position: 1024 }, M_PRIMERO),
    ins('tasks.task_materials', { project_id: OBRA, task_id: PRIMERO, item_id: TALADRO, quantity: 1, position: 2048 }, M_TALADRO),
    ins('tasks.task_materials', { project_id: OBRA, task_id: SEGUNDO, item_id: TABLERO, quantity: 3, position: 1024 }, M_SEGUNDO),
    ins('tasks.task_materials', { project_id: OBRA, task_id: HECHA, item_id: TABLERO, quantity: 50, position: 1024 }, M_HECHA),
  ]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
});
test.after(async () => { await app.close(); });

test('lo que falta: stock menos lo que piden antes las tareas que vencen antes; el equipo y lo hecho no cuentan', async () => {
  const out = await production();
  const primero = byTask(out, PRIMERO), segundo = byTask(out, SEGUNDO);
  assert.deepEqual(segundo.blocked, { by: null, ids: [] }, 'vence antes: tiene su stock');
  assert.deepEqual(primero.blocked, { by: 'material', ids: [TABLERO] }, 'bloquea aunque no haya compra');
  const tablero = primero.materials.find((m: any) => m.id === M_PRIMERO);
  assert.deepEqual([Number(tablero.need), Number(tablero.stock), Number(tablero.missing), tablero.purchaseOpen], [4, 5, 2, false]);
  const taladro = primero.materials.find((m: any) => m.id === M_TALADRO);
  assert.equal(Number(taladro.missing), 0, 'un equipo no bloquea');
  assert.deepEqual(byTask(out, HECHA).blocked, { by: null, ids: [] });
});

test('«hoy» y el indicador de Central dicen lo mismo', async () => {
  const today = (await app.call(`/api/v1/today/projection?date=${TODAY}&projectId=${OBRA}`)).data.items;
  assert.equal(today.find((i: any) => i.id === PRIMERO).blocked, true);
  assert.equal(today.find((i: any) => i.id === SEGUNDO).blocked, false);
  assert.equal(await kpi(), 1);
});

test('«Pedir» con task_id liga la compra a la tarea; sigue bloqueada hasta que entra el stock', async () => {
  const body = { source: 'flow', external_ref: 'pedir-tablero-1', title: 'Tablero DM', project_id: OBRA, task_id: PRIMERO, item_id: TABLERO, quantity: 2 };
  const res = await app.call('/api/v1/requests/purchase', { token: app.tokens.editor, body, headers: { 'X-Ikisai-Worker-Key': WORKER_KEY, 'X-Ikisai-Caller': 'flow' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual([res.data.purchase.taskId, res.data.purchase.itemId], [PRIMERO, TABLERO]);
  let primero = byTask(await production(), PRIMERO);
  assert.equal(primero.materials.find((m: any) => m.id === M_PRIMERO).purchaseOpen, true);
  assert.equal(primero.blocked.by, 'material');
  assert.deepEqual(primero.purchases.map((p: any) => p.itemId), [TABLERO]);
  await entrada(TABLERO, 2);
  primero = byTask(await production(), PRIMERO);
  assert.deepEqual(primero.blocked, { by: null, ids: [] }, 'con el stock que entra, deja de bloquear');
  assert.equal(await kpi(), 0);
});

test('task_id: una tarea de otro proyecto o que no existe no vale', async () => {
  const other = uuid();
  assert.equal((await commit([ins('tasks.tasks', { project_id: OTRA, title: 'Ajena', position: 1024 }, other)])).status, 200);
  const ask = (taskId: string, ref: string) => app.call('/api/v1/requests/purchase', { token: app.tokens.editor,
    body: { source: 'flow', external_ref: ref, title: 'Tablero DM', project_id: OBRA, task_id: taskId }, headers: { 'X-Ikisai-Worker-Key': WORKER_KEY, 'X-Ikisai-Caller': 'flow' } });
  assert.equal((await ask(other, 'pedir-ajena')).status, 404);
  assert.equal((await ask(uuid(), 'pedir-nada')).status, 404);
  assert.equal((await ask('nope', 'pedir-mal')).status, 422);
});
