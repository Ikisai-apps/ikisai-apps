/**
 * Ikisai Tasks · «Plan de hoy» (MUELA-095, migración 0339): las PRUEBAS del traspaso, de extremo a extremo con la
 * `tasks-api` real. El sol (pone y quita con «Deshacer», no cambia la tarea, se llena en todas partes y el foco se queda),
 * buscar o apuntar, «Para coger», Hecha, quitar y «Llevar a…» con «Deshacer», «De ayer…», un solo aviso a la vez, sin red
 * a la cola, la lectora (solo «solo hoy») y el outsider (sin plan, tampoco por la vista).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, settled } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, syncNow: any, Sync: any;

let server: E2EServer;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const TAB = id(), JARDIN = id(), TALLER = id();
const HUERTO = id(), TALLER_SPACE = id();
const JUNTA = id(), PERSIANA = id(), VALLA = id(), PASO1 = id(), PASO2 = id(), PASO3 = id(), PASO4 = id(), ESTANTE = id(), SETO = id(), RIEGO = id(), BANCO = id();
/** El día en Madrid (como la app), con desplazamiento en días. */
const madrid = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  const ok = async (operations: any[], token?: string) => { const res = await server.commit(operations, token); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  const t = (taskId: string, project: string, title: string, position: number, extra: Record<string, unknown> = {}) => ({ op: 'insert', table: 'tasks.tasks', id: taskId, fields: { tab_id: TAB, project_id: project, title, position, ...extra } });
  await ok(createTabOps({ id: TAB, name: 'Casa', position: 1024 }));
  await ok([
    { op: 'insert', table: 'tasks.projects', id: JARDIN, fields: { tab_id: TAB, title: 'Jardín', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: TALLER, fields: { tab_id: TAB, title: 'Taller', position: 3072 } },
  ]);
  await ok([
    t(JUNTA, TALLER, 'Cambiar la junta de la puerta', 1024, { due: madrid(5), priority: 'high' }),
    t(VALLA, JARDIN, 'Pintar la valla', 2048),
    t(PASO1, JARDIN, 'Comprar la pintura', 1024, { parent_id: VALLA, done: true }),
    t(PASO2, JARDIN, 'Lijar la valla', 2048, { parent_id: VALLA, done: true }),
    t(PASO3, JARDIN, 'Dar la primera mano', 3072, { parent_id: VALLA }),
    t(PASO4, JARDIN, 'Dar la segunda mano', 4096, { parent_id: VALLA }),
    t(ESTANTE, TALLER, 'Montar el estante', 2048),
    t(SETO, JARDIN, 'Podar el seto', 3072, { due: madrid(-1) }),
    t(RIEGO, JARDIN, 'Revisar el riego', 4096),
    t(BANCO, TALLER, 'Barnizar el banco', 3072),
  ]);
  await ok([{ op: 'insert', table: 'tasks.task_dependencies', id: id(), fields: { tab_id: TAB, project_id: TALLER, task_id: ESTANTE, depends_on_id: JUNTA, position: 1024 } }]);
  // «Juan» (la cuenta de edición) tocó el riego ayer.
  const q = (sql: string, args: unknown[] = []) => server.app.t.db.query(sql, args);
  await q(`insert into core.profiles (user_id, display_name) values ($1, 'Juan') on conflict (user_id) do update set display_name = 'Juan'`, [server.app.users.editor]);
  await ok([{ op: 'update', table: 'tasks.tasks', id: RIEGO, expectedRevision: 1, fields: { note: 'Mirar los goteros' } }], server.app.tokens.editor);
  await q(`set session_replication_role = replica`);
  await q(`update tasks.tasks set updated_at = now() - interval '1 day' where id = $1`, [RIEGO]);
  await q(`set session_replication_role = origin`);
  // La propietaria tocó la persiana lo último (lo primero de «Lo último que tocaste»).
  await ok([t(PERSIANA, TALLER, 'Arreglar la persiana', 4096)]);
  // Su plan de ayer: el seto y una llamada sin hacer.
  await ok([{ op: 'insert', table: 'tasks.day_plans', id: id(), fields: { actor_id: server.app.users.owner, day: madrid(-1), reviewed: false,
    items: [{ id: id(), task_id: SETO, tab_id: TAB, position: 1024 }, { id: id(), text: 'Llamar al cerrajero', tab_id: null, position: 2048, done: false }] } }]);
  // Filtro por espacio (encargo de VG, 27-10): la casa usa los espacios de Recursos; dos de una palabra, en cuatro tareas.
  const altura = (await q(`select id from resources.spaces where name = 'Altura 1'`)).rows[0] as { id: string };
  await q(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $3, 'edificio', 'Huerto', 1), ($2, $3, 'edificio', 'Taller', 2)`, [HUERTO, TALLER_SPACE, altura.id]);
  await q(`insert into tasks.settings (key, value) values ('zone_source', to_jsonb('spaces'::text))`);
  const sp = (task: string, project: string, space: string) => ({ op: 'insert', table: 'tasks.task_spaces', id: id(), fields: { tab_id: TAB, project_id: project, task_id: task, space_id: space } });
  await ok([sp(SETO, JARDIN, HUERTO), sp(RIEGO, JARDIN, HUERTO), sp(BANCO, TALLER, TALLER_SPACE), sp(ESTANTE, TALLER, TALLER_SPACE)]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { errors });
  await page.evaluate((tab) => { state.taskScope = 'area'; state.activeTab = tab; state.view = 'today'; render(); }, TAB);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const plan = async (actor = server.app.users.owner, day = madrid()) => (await server.rows('tasks.day_plans')).find((p) => p.actor_id === actor && p.day === day && !p.deleted_at);
const planTasks = async () => ((await plan())?.items ?? []).map((i: any) => i.task_id ?? i.text);
const localPlan = () => page.evaluate(() => IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))).map((i: any) => i.task_id ?? i.text)) as Promise<string[]>;
declare const IkisaiTasks: any, isoDay: any;
const undoButton = (message: string) => page.locator('.ikisai-toast span', { hasText: message }).locator('xpath=following-sibling::button');
const sync = async () => { await page.evaluate(() => syncNow()); await settled(page); };
const go = (view: string, project?: string) => page.evaluate(([v, p]) => { state.view = v; state.currentProject = p || null; render(); }, [view, project ?? null]);

test('buscar: «persi» entra y luego dice «ya en tu plan»; «junta» entra y el foco vuelve a la línea; Intro apunta «solo hoy»', async () => {
  const input = page.locator('#tkhInput');
  await input.fill('persi');
  await expect(page.locator('#tkhCount')).toHaveText('1 tarea encaja');
  await page.locator(`[data-tkh-pick="${PERSIANA}"]`).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await input.fill('PERSÍ');
  await expect(page.locator('.tkh-already')).toHaveText('ya en tu plan: «Arreglar la persiana»');
  await input.fill('junta');
  await expect(page.locator('.tkh-result', { hasText: 'Apuntar «junta» · solo para hoy' })).toBeVisible();
  await page.locator(`[data-tkh-pick="${JUNTA}"]`).click();
  await expect(input).toBeFocused();
  await input.fill('Llamar al vecino');
  await input.press('Enter');
  await expect(input).toBeFocused();
  expect(await localPlan()).toEqual([PERSIANA, JUNTA, 'Llamar al vecino']);
  await expect(page.locator('.tkh-row.solo .tkh-meta')).toHaveText('solo hoy');
  await sync();
  expect(await planTasks()).toEqual([PERSIANA, JUNTA, 'Llamar al vecino']);
});

test('el sol en una fila: quita y pone con «Deshacer», se llena en todas partes y la tarea no cambia', async () => {
  const before = (await server.rows('tasks.tasks')).find((x) => x.id === JUNTA);
  await go('project', TALLER);
  const sun = page.locator(`[data-tkh-sun="${JUNTA}"][data-tkh-where="row"]`);
  await expect(sun).toHaveAttribute('aria-pressed', 'true');
  await expect(sun).toHaveText('En hoy');
  await expect(page.locator('#shellBottom .navbtn[data-nav="today"] .badge')).toHaveText('3');
  await sun.click();
  await expect(sun).toHaveAttribute('aria-pressed', 'false');
  await expect(sun).toBeFocused();
  await expect(page.locator('.ikisai-toast')).toContainText('Fuera de tu plan de hoy. La tarea sigue donde estaba.');
  await expect(page.locator('#shellBottom .navbtn[data-nav="today"] .badge')).toHaveText('2');
  await undoButton('Fuera de tu plan de hoy').click();
  await expect(sun).toHaveAttribute('aria-pressed', 'true');
  await sun.click();
  await expect(page.locator('.ikisai-toast')).toContainText('Fuera de tu plan');
  await sun.click();
  await expect(page.locator('.ikisai-toast')).toContainText('Para hoy: Cambiar la junta de la puerta. Su fecha no cambia.');
  await expect(sun).toBeFocused();
  // La ficha también lo dice, y quitar desde ella lo cambia en la fila de detrás.
  await page.locator(`[data-task-menu="${JUNTA}"]`).click();
  const ficha = page.locator('#tkhFichaSun');
  await expect(ficha).toHaveAttribute('aria-pressed', 'true');
  await ficha.click();
  await expect(ficha).toHaveAttribute('aria-pressed', 'false');
  await expect(ficha).toBeFocused();
  await expect(page.locator(`[data-tkh-sun="${JUNTA}"][data-tkh-where="row"]`)).toHaveAttribute('aria-pressed', 'false');
  await ficha.click();
  await expect(ficha).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  // Lo bloqueado también lleva sol (se puede planear a mano), pero no sale en «Para coger» (más abajo).
  await sync();
  const after = (await server.rows('tasks.tasks')).find((x) => x.id === JUNTA);
  for (const key of ['revision', 'due', 'owner_label_id', 'owner_person_id', 'done', 'priority', 'updated_at']) expect(after[key], key).toEqual(before[key]);
  expect((await server.rows('tasks.task_labels')).filter((l) => l.task_id === JUNTA)).toEqual([]);
});

test('Inicio: «☀ Para hoy» en «Lo primero» y el foco pasa a «☀ En tu plan» de la misma tarjeta, que lleva al plan', async () => {
  await go('home');
  const taskId = await page.locator('#homeLead .lead-card [data-tkh-lead]').first().getAttribute('data-tkh-lead');
  const wasIn = (await localPlan()).includes(taskId!);
  if (wasIn) { await page.evaluate((x) => { (window as any).tkhWrite(IkisaiTasks.dayPlans.planWithoutTask(IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))), x)); render(); }, taskId); }
  const fresh = page.locator(`[data-tkh-lead="${taskId}"]`);
  await expect(fresh).toHaveText('Para hoy');
  const box = await fresh.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(46);
  await fresh.click();
  await expect(page.locator(`[data-tkh-lead="${taskId}"]`)).toHaveText('En tu plan');
  await expect(page.locator(`[data-tkh-lead="${taskId}"]`)).toBeFocused();
  await page.locator(`[data-tkh-lead="${taskId}"]`).click();
  await expect(page.locator('main.tkh')).toBeVisible();
  expect(await localPlan()).toContain(taskId);
  // Se deja como estaba para seguir con el plan de las pruebas de antes.
  if (!wasIn) await page.evaluate((x) => { (window as any).tkhWrite(IkisaiTasks.dayPlans.planWithoutTask(IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))), x)); render(); }, taskId);
  else await page.evaluate((x) => { (window as any).tkhWrite(IkisaiTasks.dayPlans.planWithTask(IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))), { id: x, tab_id: state.activeTab })); render(); }, taskId);
});

test('«Para coger»: lo último que tocaste es lo mío y en orden, «En marcha» enseña «2 de 4 pasos» y «Juan, ayer», sin bloqueadas ni madres; al añadir, el foco pasa a la siguiente', async () => {
  await go('today');
  const take = page.locator('.tkh-take');
  await expect(take).toBeVisible();
  // Lo bloqueado y las madres nunca salen; tampoco lo que ya está en el plan.
  for (const x of [ESTANTE, VALLA, PERSIANA, JUNTA]) await expect(take.locator(`[data-tkh-take="${x}"]`)).toHaveCount(0);
  const touched = await take.locator('[data-tkh-strip="touched"]').evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset.tkhTake));
  const mine = await page.evaluate(() => { const out: Record<string, any> = {}; for (const a of state.tabs) for (const p of a.projects) for (const t of p.tasks) out[t.id] = { by: t.updatedBy, at: t.updatedAt }; return out; });
  expect(touched.length).toBeGreaterThan(0);
  for (const x of touched) expect(mine[x!].by).toBe(server.app.users.owner);
  const times = touched.map((x) => mine[x!].at);
  expect([...times].sort().reverse()).toEqual(times);
  const going = take.locator('[data-tkh-strip="going"]');
  await expect(going.filter({ hasText: 'Dar la primera mano' })).toContainText('2 de 4 pasos');
  await expect(going.filter({ hasText: 'Revisar el riego' })).toContainText('Juan, ayer');
  await expect(take.locator('[data-tkh-strip="dated"]').filter({ hasText: 'Podar el seto' })).toContainText('vencida');
  // Al añadir una, el foco pasa a la siguiente de su tira.
  const first = await going.first().getAttribute('data-tkh-take');
  const second = await going.nth(1).getAttribute('data-tkh-take');
  await going.first().click();
  await expect(page.locator(`[data-tkh-take="${second}"][data-tkh-strip="going"]`)).toBeFocused();
  expect(await localPlan()).toContain(first);
});

test('en el plan: Hecha (toggleTask), quitar y «Llevar a…», cada uno con «Deshacer»', async () => {
  await go('today');
  // Hecha de una tarea: la de siempre, con su «Deshacer».
  const item = await page.evaluate((x) => IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))).find((i: any) => i.task_id === x).id, PERSIANA);
  await page.locator(`[data-tkh-check="${item}"]`).click();
  await expect(page.locator(`[data-tkh-check="${item}"]`)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator(`[data-tkh-check="${item}"]`)).toBeFocused();
  await undoButton('Tarea completada').click();
  await expect(page.locator(`[data-tkh-check="${item}"]`)).toHaveAttribute('aria-checked', 'false');
  // Quitar del plan, y «Deshacer» la devuelve en su sitio.
  const order = await localPlan();
  await page.locator(`[data-tkh-remove="${item}"]`).click();
  expect(await localPlan()).not.toContain(PERSIANA);
  await undoButton('Fuera de tu plan de hoy').click();
  expect(await localPlan()).toEqual(order);
  // «Llevar a…»: el texto pasa a ser una tarea de verdad (Casa → Taller, aquí), y «Deshacer» lo deja como estaba.
  const note = await page.evaluate(() => IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))).find((i: any) => i.text === 'Llamar al vecino').id);
  await page.locator(`[data-tkh-carry="${note}"]`).click();
  await page.locator('[data-tkh-carry-area]', { hasText: 'Casa' }).click();
  await page.locator('[data-tkh-carry-project]', { hasText: 'Taller' }).click();
  await page.locator('.tkh-carryhere', { hasText: 'Ponerla aquí · Taller' }).click();
  await expect(page.locator('.ikisai-toast')).toContainText('Ahora es una tarea: Llamar al vecino');
  const linked = await page.evaluate((n) => IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))).find((i: any) => i.id === n), note);
  expect(linked.task_id).toBeTruthy();
  await sync();
  const created = (await server.rows('tasks.tasks')).find((x) => x.id === linked.task_id);
  expect(created).toMatchObject({ title: 'Llamar al vecino', project_id: TALLER, deleted_at: null });
  expect((await plan()).items.find((i: any) => i.id === note).task_id).toBe(linked.task_id);
  // Con un solo aviso a la vez: «Deshacer» de «Llevar a…» sigue siendo el único.
  await expect(page.locator('.ikisai-toast button', { hasText: 'Deshacer' })).toHaveCount(1);
  await undoButton('Ahora es una tarea').click();
  const back = await page.evaluate((n) => IkisaiTasks.dayPlans.dayPlanItems(Sync.core.dayPlan(isoDay(0))).find((i: any) => i.id === n), note);
  expect(back).toMatchObject({ text: 'Llamar al vecino' });
  expect(back.task_id).toBeUndefined();
  await sync();
  expect((await server.rows('tasks.tasks')).find((x) => x.id === linked.task_id).deleted_at).not.toBeNull();
});

test('«De ayer quedaron…»: «Traer a hoy» trae lo que quedó, con «Deshacer»', async () => {
  await go('today');
  const box = page.locator('.tkh-yesterday');
  await expect(box).toContainText('De ayer quedaron 2 cosas sin hacer');
  await page.locator('#tkhBring').click();
  await expect(box).toHaveCount(0);
  const now = await localPlan();
  expect(now).toContain(SETO);
  expect(now).toContain('Llamar al cerrajero');
  await sync();
  expect((await plan()).reviewed).toBe(true);
});

test('un solo aviso a la vez: el «Deshacer» nuevo sustituye al anterior', async () => {
  await go('project', TALLER);
  await page.locator(`[data-tkh-sun="${BANCO}"][data-tkh-where="row"]`).click();
  await page.locator(`[data-toggle-task="${BANCO}"]`).click();
  await expect(page.locator('.ikisai-toast')).toContainText('Tarea completada');
  await expect(page.locator('.ikisai-toast button', { hasText: 'Deshacer' })).toHaveCount(1);
  await expect(page.locator('.ikisai-toast')).not.toContainText('Para hoy');
  await undoButton('Tarea completada').click();
});

test('sin red, el plan se guarda en este dispositivo y se manda al volver', async () => {
  await sync();
  await go('project', TALLER);
  await context.setOffline(true);
  const sun = page.locator(`[data-tkh-sun="${BANCO}"][data-tkh-where="row"]`);
  const was = await sun.getAttribute('aria-pressed');
  await sun.click();
  await expect(sun).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
  expect((await plan()).items.some((i: any) => i.task_id === BANCO)).toBe(was === 'true');
  await context.setOffline(false);
  await sync();
  expect((await plan()).items.some((i: any) => i.task_id === BANCO)).toBe(was !== 'true');
  expect(errors).toEqual([]);
});

test('la lectora: sin sol, sin línea de buscar ni «Para coger»; apunta «solo hoy», se guarda, y «Dejarlo»', async ({ browser }) => {
  const readerId = server.app.users.reader;
  const res = await server.commit([{ op: 'insert', table: 'tasks.day_plans', id: id(), fields: { actor_id: readerId, day: madrid(-1), reviewed: false, items: [{ id: id(), text: 'Leer el parte', tab_id: null, position: 1024, done: false }] } }], server.app.tokens.reader);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  const readerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const readerErrors: string[] = [];
  const reader = await openApp(readerContext, server, { user: READER, errors: readerErrors });
  await reader.evaluate(([tab, p]) => { state.taskScope = 'area'; state.activeTab = tab; state.view = 'project'; state.currentProject = p; render(); }, [TAB, TALLER]);
  await expect(reader.locator('.task')).not.toHaveCount(0);
  await expect(reader.locator('[data-tkh-sun]')).toHaveCount(0);
  await reader.evaluate(() => { state.view = 'home'; render(); });
  await expect(reader.locator('[data-tkh-lead]')).toHaveCount(0);
  await reader.locator('#shellBottom .navbtn[data-nav="today"]').click();
  await expect(reader.locator('main.tkh.small')).toBeVisible();
  await expect(reader.locator('[role="search"]')).toHaveCount(0);
  await expect(reader.locator('.tkh-take')).toHaveCount(0);
  await expect(reader.locator('.tkh-yesterday')).toContainText('De ayer quedó 1 cosa sin hacer');
  await reader.locator('#tkhLeave').click();
  await expect(reader.locator('.tkh-yesterday')).toHaveCount(0);
  await reader.locator('#tkhInput').fill('Ordenar los papeles');
  await reader.locator('#tkhInput').press('Enter');
  await expect(reader.locator('.tkh-row.solo')).toContainText('Ordenar los papeles');
  await expect(reader.locator('[data-tkh-carry]')).toHaveCount(0);
  await reader.evaluate(() => syncNow());
  await settled(reader);
  const mine = await plan(readerId);
  expect(mine.items.map((i: any) => i.text)).toEqual(['Ordenar los papeles']);
  expect(mine.reviewed).toBe(true);
  expect(readerErrors).toEqual([]);
  await readerContext.close();
  // La propietaria no ve el plan de la lectora.
  expect(await page.evaluate(() => (Sync.core.data['tasks.day_plans'] || []).filter((p: any) => p.actor_id !== Sync.actor.id).length)).toBe(0);
});

test('el outsider no tiene plan: ni la pestaña «Hoy» ni la pantalla, tampoco pidiéndola', async ({ browser }) => {
  await server.app.t.db.query(`update core.memberships set role = 'outsider', scopes = $2::jsonb where app = 'tasks' and user_id = $1`, [server.app.users.reader, JSON.stringify({ tabs: [TAB], projects: {} })]);
  const outsiderContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const outsider = await openApp(outsiderContext, server, { user: READER, errors: [] });
  await expect(outsider.locator('#shellBottom .navbtn[data-nav="today"]')).toHaveCount(0);
  await outsider.evaluate(() => { state.view = 'today'; render(); });
  await expect(outsider.locator('main.tkh')).toHaveCount(0);
  expect(await outsider.evaluate(() => state.view)).toBe('home');
  await expect(outsider.locator('[data-tkh-sun],[data-tkh-lead]')).toHaveCount(0);
  await outsiderContext.close();
});

test('filtro por espacio arriba: un toque marca y otro desmarca, varios suman, ninguno o todos es todo, y se recuerda', async () => {
  await go('today');
  await settled(page);
  const chips = page.locator('#tkhSpaces [data-tkh-space]');
  const huerto = page.locator(`[data-tkh-space="${HUERTO}"]`), taller = page.locator(`[data-tkh-space="${TALLER_SPACE}"]`);
  await expect(chips).toHaveCount(2);
  // La fila lleva la pista del kit (installScrollHints la vigila: pone data-more-start/end cuando hace falta).
  expect(await page.evaluate(() => document.getElementById('view')?.dataset.tkhHints)).toBe('1');
  await expect(huerto).toContainText('Huerto');
  await expect(huerto.locator('.tkh-space-n')).toHaveText(/^[1-9]\d*$/);
  const take = page.locator('.tkh-take');
  await expect(take).toContainText('Barnizar el banco');
  // Huerto: solo lo del huerto.
  await huerto.click();
  await expect(huerto).toHaveAttribute('aria-pressed', 'true');
  await expect(huerto).toContainText('✓');
  await expect(huerto).toBeFocused();
  await expect(page.locator('.tkh-filtering[role="status"]')).toContainText('Solo Huerto');
  await expect(take).toContainText('Revisar el riego');
  await expect(take).not.toContainText('Barnizar el banco');
  // Se recuerda en el dispositivo.
  await page.reload();
  await settled(page);
  await go('today');
  await settled(page);
  await expect(huerto).toHaveAttribute('aria-pressed', 'true');
  await expect(take).not.toContainText('Barnizar el banco');
  // Los dos marcados: se ve todo (son todos).
  await taller.click();
  await expect(take).toContainText('Barnizar el banco');
  await expect(take).toContainText('Revisar el riego');
  // «Quitar filtro» deja ninguno marcado; volvemos a marcar los dos para probar quitarlos a mano.
  await taller.click();
  await expect(page.locator('.tkh-filtering')).toHaveCount(1);
  await page.locator('.tkh-filtering [data-tkh-clear]').click();
  await expect(page.locator('.tkh-filtering')).toHaveCount(0);
  await expect(huerto).toHaveAttribute('aria-pressed', 'false');
  await huerto.click();
  await taller.click();
  // Ninguno: todo.
  await huerto.click();
  await expect(take).not.toContainText('Revisar el riego');
  await taller.click();
  await expect(huerto).toHaveAttribute('aria-pressed', 'false');
  await expect(taller).toHaveAttribute('aria-pressed', 'false');
  await expect(take).toContainText('Revisar el riego');
  await expect(take).toContainText('Barnizar el banco');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
