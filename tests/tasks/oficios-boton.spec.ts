/**
 * Ikisai Tasks · P2, PR 2: el botón «Pasar las acciones a oficios», su vista previa y «Volver a las acciones» (docs/tasks/API.md
 * §32). Solo la propietaria humana con acceso a todo lo ve, en «Trabajo» justo después de «Etiquetas». Sin oficios en Central
 * avisa con el enlace; si Central no responde, lo dice. Una acción en uso sin oficio bloquea hasta marcarla «Quitar»; tras
 * pulsar, la app pasa sola a modo oficios (chips «Fontanería › ACS»), y al volver, a las etiquetas que guardaba el servidor.
 * Capturas en `coordinacion/tasks/p2-despues/`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, EDITOR, type E2EServer } from './e2e-server.ts';
import { menuRow, menuRows, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, navigationGroups: any, handleTopAction: any, syncNow: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), PUESTA = id(), ACCION = id(), FONT = id(), ACS = id(), JARDIN = id();
const T_ACS = id(), T_JARD = id(), TR_FONT = id(), TR_ACS = id(), TR_ALB = id();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ id: MANT, name: 'Mantenimiento', position: 90_000 }));
  await ok([{ op: 'insert', table: 'tasks.families', id: ACCION, fields: { tab_id: null, name: 'Tipo: Acción', color: '#5a7a8a', position: 2 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: FONT, fields: { tab_id: null, family_id: ACCION, name: 'Fontanería', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: JARDIN, fields: { tab_id: null, family_id: ACCION, name: 'Jardinería', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PUESTA, fields: { tab_id: MANT, title: 'Puesta a punto', position: 2048 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: ACS, fields: { tab_id: null, family_id: ACCION, parent_id: FONT, name: 'ACS', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_ACS, fields: { tab_id: MANT, project_id: PUESTA, title: 'Cambiar el grifo del ACS', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_JARD, fields: { tab_id: MANT, project_id: PUESTA, title: 'Podar el seto', position: 2048 } },
  ]);
  const tl = (task: string, label: string) => ({ op: 'insert', table: 'tasks.task_labels', id: id(), fields: { tab_id: MANT, project_id: PUESTA, task_id: task, label_id: label } });
  await ok([tl(T_ACS, FONT), tl(T_ACS, ACS), tl(T_JARD, JARDIN)]);
  // Central, todavía sin oficios (como hoy en producción): los siembra la segunda prueba.
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const source = () => page.evaluate(() => (window as any).eval('Sync.core.tradeSource()'));
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/p2-despues/${name}.png` }).catch(() => {}); };
const openProject = () => page.evaluate(([t, p]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; state.filters = {}; state.search = ''; render(); }, [MANT, PUESTA]);
const menuItems = (p: Page) => p.evaluate(() => navigationGroups().flatMap((g: any) => g.items.map((i: any) => i[0])));
const sheet = () => page.locator('#sheet');
const sql = (text: string, params: unknown[] = []) => server.app.t.db.query(text, params);

test('sin oficios en Central, el aviso con el enlace; y si Central no responde, lo dice', async () => {
  await page.evaluate(() => handleTopAction('actionsToTrades'));
  await expect(sheet()).toContainText('Central no tiene oficios: impórtalos primero en Central › Oficios');
  await expect(sheet().locator('a', { hasText: 'Central › Oficios' })).toHaveAttribute('href', 'https://central.ikisai.com');
  await expect(page.locator('#tradesApply')).toHaveCount(0);
  await shot('16-central-sin-oficios');
  await page.locator('#tradesClose').click();

  const saved = (await sql(`select * from core.allowed_reads where app = 'tasks' and name = 'central.trade_options'`)).rows[0] as any;
  await sql(`delete from core.allowed_reads where app = 'tasks' and name = 'central.trade_options'`);
  try {
    await page.evaluate(() => handleTopAction('actionsToTrades'));
    await expect(sheet()).toContainText('No se ha podido leer Central');
    await expect(page.locator('#tradesApply')).toHaveCount(0);
    await page.locator('#tradesClose').click();
  } finally {
    await sql(`insert into core.allowed_reads (app, name, kind, roles) values ($1, $2, $3, $4)`, [saved.app, saved.name, saved.kind, saved.roles]);
  }
});

test('el botón solo lo ve la propietaria, en «Trabajo» tras «Etiquetas»; la vista previa bloquea hasta resolver la acción sin oficio', async () => {
  const trade = (tid: string, name: string, parent: string | null, label: string | null, position: number) =>
    sql(`insert into central.trades (id, parent_id, name, source_label_id, position) values ($1, $2, $3, $4, $5)`, [tid, parent, name, label, position]);
  await trade(TR_FONT, 'Fontanería', null, FONT, 1);
  await trade(TR_ACS, 'ACS', TR_FONT, ACS, 1);
  // Un oficio de Central que no viene de ninguna acción (servirá para «Se perderían» al volver).
  await trade(TR_ALB, 'Albañilería', null, null, 2);

  expect(await menuItems(page)).toContain('actionsToTrades');
  const editorContext = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
  const editor = await openApp(editorContext, server, { user: EDITOR, aliases: ID });
  expect(await menuItems(editor)).not.toContain('actionsToTrades');
  // Etiquetas está en la barra de abajo (el menú común no la repite) y el botón no sale en el menú.
  await expect(editor.locator('#shellBottom [data-nav="labels"]')).toBeVisible();
  expect(await menuRows(editor, 'work')).not.toContain('tasks.menu.acciones_a_oficios');
  await editorContext.close();

  // Escritorio: a la vista desde el menú real.
  const desktopContext = await page.context().browser()!.newContext({ viewport: { width: 1280, height: 900 } });
  const desktop = await openApp(desktopContext, server, { aliases: ID });
  // En la columna del menú, en «Trabajo», donde iba Etiquetas (antes de «Mis tareas»).
  const deskWork = await menuRows(desktop, 'work', 'column');
  expect(deskWork).toContain('tasks.menu.acciones_a_oficios');
  expect(deskWork.indexOf('tasks.menu.acciones_a_oficios')).toBeLessThan(deskWork.indexOf('tasks.menu.mis_tareas'));
  const deskItem = await menuRow(desktop, 'tasks.menu.acciones_a_oficios', 'work', 'column');
  await expect(deskItem).toBeVisible();
  await deskItem.click();
  await expect(desktop.locator('#sheet')).toContainText('ACS → Fontanería › ACS · 1 tarea');
  await desktopContext.close();

  // Móvil.
  const work = await menuRows(page, 'work');
  expect(work.indexOf('tasks.menu.acciones_a_oficios')).toBeGreaterThanOrEqual(0);
  expect(work.indexOf('tasks.menu.acciones_a_oficios')).toBeLessThan(work.indexOf('tasks.menu.mis_tareas'));
  const item = await menuRow(page, 'tasks.menu.acciones_a_oficios', 'work');
  await expect(item).toBeVisible();
  await shot('13-menu-trabajo');
  await item.click();
  await expect(page.locator('#appLauncher')).toHaveAttribute('aria-expanded', 'false');
  await expect(sheet()).toContainText('ACS → Fontanería › ACS · 1 tarea');
  await expect(sheet()).toContainText('Por resolver (1)');
  await expect(sheet()).toContainText('Jardinería · sin oficio en Central · 1 tarea');
  // Las cifras van en renderStats (MUELA-090 §3): «se queda sin oficio», en rojo si es más de 0; el botón bloqueado dice por qué.
  await expect(sheet().locator('.zonecounts .stat-item[data-tone="alert"] .stat-label')).toHaveText('se queda sin oficio');
  await expect(sheet().locator('.zonecounts .stat-item[data-tone="alert"] .stat-value')).toHaveText('1');
  await expect(page.locator('#tradesApply')).toHaveAttribute('aria-describedby', 'tradesDoubtful tradesBlocked');
  await expect(page.locator('#tradesDoubtful')).toHaveText('Por resolver (1)');
  await expect(page.locator('#tradesBlocked')).toHaveText('Resuelve antes las que faltan.');
  await expect(page.locator('#tradesApply')).toBeDisabled();
  await shot('14-vista-previa-por-resolver');
  await page.locator(`[data-trade-remove="${JARDIN}"]`).check();
  await expect(sheet()).toContainText('Se quitan (1)');
  await expect(sheet()).toContainText('Jardinería · 1 tarea · 1 se queda sin oficio');
  await expect(page.locator('#tradesApply')).toBeEnabled();
  await shot('15-vista-previa-lista');
});

test('al pulsar, la app pasa sola a oficios; y «Volver a las acciones» la deja con las etiquetas del servidor', async () => {
  await page.locator('#tradesApply').click();
  await expect.poll(source).toBe('central');
  await openProject();
  await expect(chipsOf(T_ACS)).toHaveText(['Fontanería › ACS']);
  await expect(chipsOf(T_JARD)).toHaveCount(0);
  expect(await menuItems(page)).not.toContain('actionsToTrades');
  expect(await menuItems(page)).toContain('trades');

  // Un oficio puesto en modo central que no viene de ninguna acción: al volver, se perdería.
  const res = await server.commit([{ op: 'insert', table: 'tasks.task_trades', id: id(), fields: { tab_id: MANT, project_id: PUESTA, task_id: T_JARD, trade_id: TR_ALB } }]);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  await page.evaluate(() => syncNow());
  await settled(page);
  await expect(chipsOf(T_JARD)).toHaveText(['Albañilería']);

  // «Oficios», a la vista en «Trabajo», tras «Etiquetas».
  const trades = await menuRow(page, 'tasks.menu.oficios', 'work');
  await expect(trades).toBeVisible();
  await trades.click();
  // Las baldosas de MUELA-090 (tanda 31, zona 4): un grupo por oficio principal.
  await expect(page.locator('.trades-screen .tko-groups')).toContainText('Albañilería');
  await page.locator('#tradesToActions').click();
  await expect(sheet()).toContainText('Los oficios vuelven a ser etiquetas');
  await expect(sheet()).toContainText('Se perderían (1)');
  await expect(sheet()).toContainText('Albañilería · 1 tarea');
  await expect(page.locator('#tradesBackApply')).toBeDisabled();
  await page.locator('#tradesDrop').check();
  await expect(page.locator('#tradesBackApply')).toBeEnabled();
  await shot('17-volver-a-las-acciones');
  await page.locator('#tradesBackApply').click();
  await expect.poll(source).toBe('labels');
  await settled(page);
  await openProject();
  // Como antes de pasar: la madre y la hija, que el servidor guardaba (y, al ser su única hija, la chip dice la madre, FB_2026_021).
  const labels = (await server.rows('tasks.task_labels')).filter((r) => r.task_id === T_ACS && !r.deleted_at).map((r) => r.label_id).sort();
  expect(labels).toEqual([FONT, ACS].sort());
  await expect(chipsOf(T_ACS)).toHaveText(['Fontanería']);
  expect((await server.rows('tasks.task_trades')).filter((r) => !r.deleted_at)).toEqual([]);
  expect(await menuItems(page)).toContain('actionsToTrades');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
