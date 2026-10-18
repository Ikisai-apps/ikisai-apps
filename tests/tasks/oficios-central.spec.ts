/**
 * Ikisai Tasks · P2, PR 2: la caracterización de `personas.spec.ts` pasada en modo oficios (docs/tasks/API.md §32). Misma
 * siembra, más los oficios de Central (`central.trades`, con `source_label_id` en las etiquetas de la acción) y la ida real
 * (`actions/to-trades`) antes de abrir la app. Se espera lo mismo que hoy salvo lo decidido: la chip dice «Fontanería › ACS»
 * (la ruta de Central), hay una chip por oficio (sin juntar en la madre) y la madre del filtro incluye lo de dentro (el
 * hallazgo de la caracterización: tras la ida, la tarea solo guarda la hija y la madre la sigue encontrando). Además: buscar,
 * tablero, vistas guardadas, texto legible, la herencia del proyecto, la pantalla «Oficios» y los nombres sin red.
 * Capturas («después») en `coordinacion/tasks/p2-despues/`.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const Sync: any, state: any, render: any, filteredTasks: any, project: any, openTaskEditor: any, openProjectEditor: any, navigateView: any, startInlineNew: any, savedViewsSheet: any, readableExport: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), RET = id(), PINTURA = id(), OTONO = id();
const ACCION = id(), FONT = id(), ACS = id(), FRIA = id(), ELEC = id(), CUADRO = id(), PINT = id();
const STAFF = id(), VG = id(), AN = id(), OUT = id(), MARTA = id(), RET_VG = id();
const T_GRIFO = id(), T_CUADRO = id(), T_PARED = id(), T_NADA = id(), T_RET = id();
const TR_FONT = id(), TR_ACS = id(), TR_FRIA = id(), TR_ELEC = id(), TR_CUADRO = id(), TR_PINT = id();
let PERSON = '', RET_PERSON = '', PHASE = '', REPASO = '', seq = 0;

async function seedPeople(ok: (ops: any[]) => Promise<void>) {
  await server.app.t.db.query(`update tasks.families set name = 'Grupo: Persona' where id = any($1)`, [[PERSON, RET_PERSON]]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: STAFF, fields: { tab_id: MANT, family_id: PERSON, name: 'Staff', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: OUT, fields: { tab_id: MANT, family_id: PERSON, name: 'Outsiders', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: RET_VG, fields: { tab_id: RET, family_id: RET_PERSON, name: 'VG', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: MANT, family_id: PERSON, parent_id: STAFF, name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: AN, fields: { tab_id: MANT, family_id: PERSON, parent_id: STAFF, name: 'AN', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: MARTA, fields: { tab_id: MANT, family_id: PERSON, parent_id: OUT, name: 'Marta', position: 1024 } },
  ]);
}
async function seedActions(ok: (ops: any[]) => Promise<void>) {
  await ok([{ op: 'insert', table: 'tasks.families', id: ACCION, fields: { tab_id: null, name: 'Tipo: Acción', color: '#5a7a8a', position: 2 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: FONT, fields: { tab_id: null, family_id: ACCION, name: 'Fontanería', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: ELEC, fields: { tab_id: null, family_id: ACCION, name: 'Electricidad', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: PINT, fields: { tab_id: null, family_id: ACCION, name: 'Pintura', position: 3072 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: ACS, fields: { tab_id: null, family_id: ACCION, parent_id: FONT, name: 'ACS', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: FRIA, fields: { tab_id: null, family_id: ACCION, parent_id: FONT, name: 'Agua fría', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: CUADRO, fields: { tab_id: null, family_id: ACCION, parent_id: ELEC, name: 'Cuadro', position: 1024 } },
  ]);
}
/** En P2: el árbol de oficios de Central, que nombra la etiqueta de la que viene cada uno (como lo deja la importación). */
async function seedTrades() {
  const trade = (tid: string, name: string, parent: string | null, label: string, position: number) =>
    server.app.t.db.query(`insert into central.trades (id, parent_id, name, source_label_id, position) values ($1, $2, $3, $4, $5)`, [tid, parent, name, label, position]);
  await trade(TR_FONT, 'Fontanería', null, FONT, 1);
  await trade(TR_ELEC, 'Electricidad', null, ELEC, 2);
  await trade(TR_PINT, 'Pintura', null, PINT, 3);
  await trade(TR_ACS, 'ACS', TR_FONT, ACS, 1);
  await trade(TR_FRIA, 'Agua fría', TR_FONT, FRIA, 2);
  await trade(TR_CUADRO, 'Cuadro', TR_ELEC, CUADRO, 1);
}
const tl = (tab: string, p: string, task: string, label: string) => ({ op: 'insert', table: 'tasks.task_labels', id: id(), fields: { tab_id: tab, project_id: p, task_id: task, label_id: label } });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  const mant = createTabOps({ id: MANT, name: 'Mantenimiento', position: 90_000 });
  const ret = createTabOps({ id: RET, name: 'Retiros', position: 91_000 });
  PERSON = mant.find((o) => o.fields?.system_key === 'person')!.id!;
  PHASE = mant.find((o) => o.fields?.system_key === 'phase')!.id!;
  RET_PERSON = ret.find((o) => o.fields?.system_key === 'person')!.id!;
  await ok(mant);
  await ok(ret);
  await seedPeople(ok);
  await seedActions(ok);
  REPASO = id();
  await ok([
    { op: 'insert', table: 'tasks.projects', id: PINTURA, fields: { tab_id: MANT, title: 'Puesta a punto', position: 2048, owner_label_id: VG } },
    { op: 'insert', table: 'tasks.projects', id: OTONO, fields: { tab_id: RET, title: 'Retiro de otoño', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: REPASO, fields: { tab_id: MANT, family_id: PHASE, name: 'Repaso', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_GRIFO, fields: { tab_id: MANT, project_id: PINTURA, title: 'Cambiar el grifo del ACS', position: 1024, owner_label_id: VG } },
    { op: 'insert', table: 'tasks.tasks', id: T_CUADRO, fields: { tab_id: MANT, project_id: PINTURA, title: 'Revisar el cuadro', position: 2048, owner_label_id: MARTA } },
    { op: 'insert', table: 'tasks.tasks', id: T_PARED, fields: { tab_id: MANT, project_id: PINTURA, title: 'Pintar la pared', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: T_NADA, fields: { tab_id: MANT, project_id: PINTURA, title: 'Comprar material', position: 4096 } },
    { op: 'insert', table: 'tasks.tasks', id: T_RET, fields: { tab_id: RET, project_id: OTONO, title: 'Purgar el agua fría', position: 1024, owner_label_id: RET_VG } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: PINTURA, label_id: STAFF } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: PINTURA, label_id: VG } },
  ]);
  await ok([
    tl(MANT, PINTURA, T_GRIFO, REPASO), tl(MANT, PINTURA, T_GRIFO, ACS), tl(MANT, PINTURA, T_GRIFO, FONT), tl(MANT, PINTURA, T_GRIFO, VG), tl(MANT, PINTURA, T_GRIFO, STAFF),
    tl(MANT, PINTURA, T_CUADRO, ELEC), tl(MANT, PINTURA, T_CUADRO, CUADRO), tl(MANT, PINTURA, T_CUADRO, OUT), tl(MANT, PINTURA, T_CUADRO, MARTA),
    tl(MANT, PINTURA, T_PARED, PINT), tl(MANT, PINTURA, T_PARED, AN),
    tl(RET, OTONO, T_RET, FONT), tl(RET, OTONO, T_RET, FRIA), tl(RET, OTONO, T_RET, RET_VG),
  ]);
  await seedTrades();
  // La ida real, como la hace el botón (oficios-boton.spec.ts).
  const done = await server.app.call('/api/v1/actions/to-trades', { body: { requestId: `tr-${++seq}` } });
  expect(done.status, JSON.stringify(done.data)).toBe(200);
  expect(done.data.source).toBe('central');
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
  await expect.poll(() => page.evaluate(() => (window as any).eval('Sync.core.tradeSource()+":"+Sync.core.trades.length'))).toBe('central:6');
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

// --- Conductor en modo oficios ----------------------------------------------------------------------------------------
const openProject = (tab: string, p: string) => page.evaluate(([t, pr]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = pr; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [tab, p]);
const shown = () => page.evaluate(() => filteredTasks(project()).map((t: any) => t.text).sort());
const option = (trade: string) => page.locator(`.facet.open .facetpanel [data-facet-value="${trade}"]`);
const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/p2-despues/${name}.png` }).catch(() => {}); };
const serverTrades = async (table: 'tasks.task_trades' | 'tasks.project_trades', key: 'task_id' | 'project_id', owner: string) =>
  (await server.rows(table)).filter((r) => r[key] === owner && !r.deleted_at).map((r) => r.trade_id).sort();
const taskTrades = (task: string) => serverTrades('tasks.task_trades', 'task_id', task);
const quick = (name: string) => page.locator('#sheet .space-quick-chip', { hasText: new RegExp(`^${name}$`) });

test('chips: «Fontanería › ACS» donde iba la acción (antes que la persona), una por oficio; en la tarjeta del proyecto y en el tablero', async () => {
  await openProject(MANT, PINTURA);
  await expect(chipsOf(T_GRIFO)).toHaveText(['Fontanería › ACS', 'Staff: VG', 'Repaso']);
  // Una chip por oficio, sin compactar en la madre: «Cuadro» ya no se queda en «Electricidad».
  await expect(chipsOf(T_CUADRO)).toHaveText(['Electricidad › Cuadro', 'Outsiders']);
  await expect(chipsOf(T_PARED)).toHaveText(['Pintura', 'Staff: AN']);
  // El color de la familia «Tipo: Acción» (archivada), el que la chip tenía antes (taller-ui.js lo pasa a pastel con --chip).
  expect(await chipsOf(T_GRIFO).first().evaluate((n: HTMLElement) => n.style.getPropertyValue('--chip'))).toBe('rgb(90, 122, 138)');
  await shot('1-tarjetas-de-tarea');
  await page.locator('[data-board-mode="board"]').click();
  await expect(page.locator(`[data-board-task="${T_GRIFO}"] .chips .chip`).first()).toHaveText('Fontanería › ACS');
  await shot('10-tablero');
  await page.locator('[data-board-mode="list"]').click();
  await page.evaluate((t) => { state.activeTab = t; state.view = 'projects'; render(); }, MANT);
  await expect(page.locator(`.project:has([data-open-project="${PINTURA}"]) .chip`)).toHaveText(['Fontanería › ACS', 'Electricidad › Cuadro', 'Pintura', 'Staff', 'Outsiders', 'Repaso']);
  await shot('2-tarjeta-de-proyecto');
});

test('filtro de oficio en árbol: la madre incluye lo de dentro, la hija sola y los tres estados', async () => {
  // Tras la ida, la tarea solo guarda la hija (lo más hondo)...
  expect(await taskTrades(T_GRIFO)).toEqual([TR_ACS]);
  await openProject(MANT, PINTURA);
  await page.locator('[data-facet="_trade"]').click();
  await expect(page.locator('.facet.open .facetpanel')).toContainText('Fontanería');
  // ...y la madre la encuentra igual (el hallazgo de la caracterización, arreglado).
  await option(TR_FONT).click();
  expect(await shown()).toEqual(['Cambiar el grifo del ACS']);
  await option(TR_FONT).click();
  await expect(option(TR_FONT)).toHaveClass(/excluded/);
  expect(await shown()).toEqual(['Comprar material', 'Pintar la pared', 'Revisar el cuadro']);
  await option(TR_FONT).click();
  expect(await shown()).toEqual(['Cambiar el grifo del ACS', 'Comprar material', 'Pintar la pared', 'Revisar el cuadro']);
  await option(TR_CUADRO).click();
  expect(await shown()).toEqual(['Revisar el cuadro']);
  await shot('4-filtro-accion');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { state.filters = {}; render(); });
});

test('buscar: el nombre del oficio encuentra sus tareas, sin mirar tildes', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate(() => { state.search = 'fontaneria'; render(); });
  expect(await shown()).toEqual(['Cambiar el grifo del ACS']);
  await page.evaluate(() => { state.search = 'electricidad'; render(); });
  expect(await shown()).toEqual(['Revisar el cuadro']);
  await page.evaluate(() => { state.search = ''; render(); });
});

test('agrupar por oficio: cada tarea una sola vez, en lo más hondo', async () => {
  await page.evaluate(() => { state.view = 'tasks'; state.groupBy = '_trade'; state.filters = {}; render(); });
  await expect(page.locator('#groupBy option[value="_trade"]')).toHaveCount(1);
  const sectionOf = (task: string) => page.locator('main section', { has: page.locator(`[data-toggle-task="${task}"]`) });
  await expect(sectionOf(T_GRIFO)).toHaveCount(1);
  await expect(sectionOf(T_GRIFO).locator('h2')).toContainText('Fontanería › ACS');
  await expect(sectionOf(T_CUADRO).locator('h2')).toContainText('Electricidad › Cuadro');
  await expect(sectionOf(T_PARED).locator('h2')).toContainText('Pintura');
  await expect(sectionOf(T_NADA).locator('h2')).toContainText('Sin oficio');
  await shot('6-agrupar-por-accion');
  await page.evaluate(() => { state.groupBy = 'project'; render(); });
});

test('ficha: el oficio se marca de un toque (los más usados) y se guarda', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  await expect(page.locator('#sheet [data-feedback-id="tasks.editor_tarea.oficio"]')).toBeVisible();
  await shot('7-ficha-cerrada');
  await quick('ACS').click();
  await expect(quick('ACS')).toHaveClass(/on/);
  await shot('8-ficha-oficio');
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  expect(await taskTrades(T_NADA)).toEqual([TR_ACS]);
  await expect(chipsOf(T_NADA)).toHaveText(['Fontanería › ACS']);
});

test('ficha: la búsqueda por ruta encuentra la hija por el nombre de la madre', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((t) => openTaskEditor(t), T_GRIFO);
  await page.locator('#sheet .tradefield .space-search').fill('fontaneria agua');
  await expect(page.locator('#sheet .tradefield .space-result:not(.empty)')).toHaveCount(1);
  await expect(page.locator('#sheet .tradefield .space-result-name')).toHaveText('Agua fría');
  await page.locator('#sheet .tradefield .space-search').fill('zzz');
  await expect(page.locator('#sheet .tradefield .space-result.empty')).toContainText('Ningún oficio coincide');
  await page.evaluate(() => (window as any).closeSheet?.());
});

test('selección múltiple: «Oficio» › el oficio › Aplicar, a varias tareas a la vez', async () => {
  await openProject(MANT, PINTURA);
  await page.locator('#batchToggle').click();
  for (const t of [T_PARED, T_NADA]) await page.locator(`[data-select="${t}"]`).click();
  await page.locator('#batchTrade').click();
  await quick('Cuadro').click();
  await shot('9-lote-elegir-oficio');
  await page.locator('#batchTradeDone').click();
  await settled(page);
  expect(await taskTrades(T_PARED)).toEqual([TR_PINT, TR_CUADRO].sort());
  expect(await taskTrades(T_NADA)).toEqual([TR_ACS, TR_CUADRO].sort());
  await expect(chipsOf(T_NADA)).toHaveText(['Fontanería › ACS', 'Electricidad › Cuadro']);
  await expect(chipsOf(T_PARED)).toHaveText(['Electricidad › Cuadro', 'Pintura', 'Staff: AN']);
  if (await page.locator('#batchCancel').count()) await page.locator('#batchCancel').click();
});

test('arrastre: reordenar con el asa no toca oficios, personas ni responsable', async () => {
  await openProject(MANT, PINTURA);
  const before = await taskTrades(T_CUADRO);
  expect(before).toEqual([TR_CUADRO]);
  const from = (await page.locator(`.task:has([data-toggle-task="${T_CUADRO}"]) [data-drag]`).boundingBox())!;
  const to = (await page.locator(`.task:has([data-toggle-task="${T_GRIFO}"])`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
  await settled(page);
  const order = (await server.rows('tasks.tasks')).filter((t) => t.project_id === PINTURA && !t.deleted_at).sort((a, b) => a.position - b.position).map((t) => t.title);
  expect(order[0]).toBe('Revisar el cuadro');
  expect(await taskTrades(T_CUADRO)).toEqual(before);
  expect((await server.rows('tasks.tasks')).find((r) => r.id === T_CUADRO)!.owner_label_id).toBe(MARTA);
  await expect(chipsOf(T_CUADRO)).toHaveText(['Electricidad › Cuadro', 'Outsiders']);
});

test('herencia: el oficio del proyecto pasa a sus tareas nuevas (ficha y alta en línea)', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((p) => openProjectEditor(p), PINTURA);
  await expect(page.locator('#sheet [data-feedback-id="tasks.editor_proyecto.oficio"]')).toBeVisible();
  await quick('Pintura').click();
  await page.locator('#saveProjectBtn').click();
  await settled(page);
  expect(await serverTrades('tasks.project_trades', 'project_id', PINTURA)).toEqual([TR_PINT]);
  await openProject(MANT, PINTURA);
  await page.evaluate(() => openTaskEditor(null));
  await expect(page.locator('#sheet .tradefield .space-picked .chip')).toHaveText(['Pintura']);
  await page.locator('#teText').fill('Lijar la puerta');
  await page.locator('#saveTaskBtn').click();
  await page.evaluate((p) => startInlineNew(p), PINTURA);
  await page.locator('.newinput').fill('Comprar rodillos');
  await page.locator('.newinput').press('Enter');
  await settled(page);
  const tasks = (await server.rows('tasks.tasks')).filter((t) => t.project_id === PINTURA && !t.deleted_at);
  for (const title of ['Lijar la puerta', 'Comprar rodillos']) {
    const task = tasks.find((t) => t.title === title);
    expect(task, title).toBeTruthy();
    expect(await taskTrades(task.id), title).toEqual([TR_PINT]);
  }
});

test('General frente a un área: el oficio es uno solo en todas las áreas y en la vista General junta las dos', async () => {
  await openProject(RET, OTONO);
  await expect(chipsOf(T_RET)).toHaveText(['Fontanería › Agua fría', 'VG']);
  await expect(page.locator('[data-facet="_trade"]')).toHaveCount(1);
  await page.evaluate(() => { state.taskScope = 'all'; state.view = 'tasks'; state.groupBy = 'project'; state.search = ''; render(); });
  const titles = () => page.evaluate(() => [...document.querySelectorAll('main .task[data-row] .tasktext')].map((n) => n.textContent!.trim()).sort());
  await page.evaluate((f) => { state.filters = { _trade: [f] }; render(); }, TR_FONT);
  await expect.poll(titles).toEqual(['Cambiar el grifo del ACS', 'Comprar material', 'Purgar el agua fría']);
  await page.evaluate(() => { state.taskScope = 'area'; state.filters = {}; render(); });
});

test('vistas guardadas con `_trade` y texto legible con «Oficio:»', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((f) => { state.view = 'tasks'; state.currentProject = null; state.filters = { _trade: [f] }; state.groupBy = '_trade'; render(); savedViewsSheet(); }, TR_FONT);
  await page.locator('#viewName').fill('Fontanería');
  await page.locator('#saveView').click();
  await settled(page);
  const view = (await server.rows('tasks.saved_views')).find((v) => v.name === 'Fontanería' && !v.deleted_at);
  expect(view.filters).toEqual({ _trade: [TR_FONT] });
  expect(view.group_by).toBe('_trade');
  await page.evaluate(() => { state.filters = {}; state.groupBy = 'project'; render(); savedViewsSheet(); });
  await page.locator(`[data-load-view="${view.id}"]`).click();
  await expect.poll(() => page.evaluate(() => [state.groupBy, (state.filters._trade || []).length].join(':'))).toBe('_trade:1');
  await page.evaluate(() => { state.filters = {}; state.groupBy = 'project'; render(); });

  const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => readableExport())]);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text).toMatch(/- \[ \] Cambiar el grifo del ACS\n(?: {2}.*\n)*? {2}Oficio: Fontanería › ACS\n/);
  expect(text).toMatch(/- \[ \] Comprar material\n(?: {2}.*\n)*? {2}Oficio: Fontanería › ACS, Electricidad › Cuadro\n/);
});

test('pantalla «Oficios»: el árbol de Central, de solo lectura, con «Gestionar en Central»', async () => {
  await page.evaluate(() => navigateView('trades'));
  await expect(page.locator('.tradetree')).toContainText('Fontanería');
  await expect(page.locator('.tradetree .tradenode')).toHaveCount(6);
  await expect(page.locator('.trades-screen a', { hasText: 'Gestionar en Central' })).toHaveAttribute('href', 'https://central.ikisai.com');
  await shot('11-pantalla-oficios');
  await page.evaluate(() => navigateView('projects'));
});

test('sin red: los nombres de los oficios salen de lo guardado en el dispositivo', async () => {
  await page.evaluate(() => { (window as any).antesDeRecargar = true; });
  await context.setOffline(true);
  // La recarga sin red la sirve el service worker; la lectura de Central falla y la app arranca con lo guardado.
  await page.reload().catch(() => undefined);
  await page.waitForFunction(() => typeof Sync !== 'undefined' && Sync.core && state.tabs.length > 0, null, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as any).antesDeRecargar)).toBeUndefined();
  // Central no se puede leer ahora, y aun así el catálogo está ahí.
  expect(await page.evaluate(() => (window as any).eval('Sync.core.refreshTrades()'))).toBe(false);
  expect(await page.evaluate(() => (window as any).eval('Sync.core.trades.length'))).toBe(6);
  await openProject(MANT, PINTURA);
  await expect(chipsOf(T_GRIFO)).toHaveText(['Fontanería › ACS', 'Staff: VG', 'Repaso']);
  await shot('12-sin-red');
  await context.setOffline(false);
  await page.evaluate(() => (window as any).eval('syncNow()'));
  await settled(page);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
