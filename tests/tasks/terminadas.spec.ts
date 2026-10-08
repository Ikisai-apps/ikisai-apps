/**
 * Ikisai Tasks · tareas terminadas en un plegable al final de cada lista, como Google Keep (petición del usuario,
 * 8-10-2026): «N tareas terminadas» plegado por defecto y recordado por dispositivo y lista; desplegado, las hechas
 * tachadas y con su casilla; marcar sube el contador y «Deshacer» la devuelve; desmarcar la devuelve a su sitio.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const TAB = crypto.randomUUID(), PROJECT = crypto.randomUUID(), A = crypto.randomUUID(), B = crypto.randomUUID(), HECHA = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ name: 'Casa nueva', id: TAB, position: 90_000 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: PROJECT, fields: { tab_id: TAB, title: 'Cocina', position: 2048 } }]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: A, fields: { tab_id: TAB, project_id: PROJECT, title: 'Medir la encimera', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: B, fields: { tab_id: TAB, project_id: PROJECT, title: 'Pedir presupuesto', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: HECHA, fields: { tab_id: TAB, project_id: PROJECT, title: 'Quitar azulejos', position: 3072, done: true } },
  ]);
});
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases: ID, errors });
  await page.evaluate(([tab, project]) => { state.activeTab = tab; state.view = 'project'; state.currentProject = project; render(); }, [TAB, PROJECT]);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const fold = () => page.locator('.tasklist .donefold');
const pendingRow = (id: string) => page.locator(`.tasklist > .task:has([data-toggle-task="${id}"])`);

test('al final de la lista, una fila plegada «1 tarea terminada»; desplegada, la hecha tachada', async () => {
  await expect(fold().locator('summary')).toHaveText('1 tarea terminada');
  await expect(fold()).not.toHaveAttribute('open', /.*/);
  await expect(page.locator(`[data-toggle-task="${HECHA}"]`)).toBeHidden();
  await expect(pendingRow(A)).toBeVisible();
  await fold().locator('summary').click();
  const done = page.locator(`.donefold .task:has([data-toggle-task="${HECHA}"])`);
  await expect(done).toBeVisible();
  await page.screenshot({ path: '../coordinacion/tasks/terminadas-plegable-movil.png' }).catch(() => {});
  expect(await done.locator('.tasktext').first().evaluate((n) => getComputedStyle(n).textDecorationLine)).toContain('line-through');
  // Recordado por dispositivo y lista: sigue abierto tras repintar, y la lista de otra vista empieza plegada.
  await page.evaluate(() => render());
  await expect(fold()).toHaveAttribute('open', '');
  await page.evaluate(() => { state.view = 'tasks'; render(); });
  const other = page.locator('.donefold').first();
  await expect(other).toBeVisible();
  await expect(other).not.toHaveAttribute('open', /.*/);
  await page.evaluate(([project]) => { state.view = 'project'; state.currentProject = project; render(); }, [PROJECT]);
  await fold().locator('summary').click();
  await expect(fold()).not.toHaveAttribute('open', /.*/);
});

test('marcar una tarea la lleva al plegable y sube el contador; «Deshacer» la devuelve', async () => {
  await page.locator(`[data-toggle-task="${A}"]`).click();
  await expect(fold().locator('summary')).toHaveText('2 tareas terminadas');
  await expect(pendingRow(A)).toHaveCount(0);
  await settled(page);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === A).done).toBe(true);
  await page.locator('#undoNow').click({ timeout: 15_000 });
  await page.locator('#confirmUndo').click();
  await settled(page);
  await page.evaluate(() => (window as any).closeSheet?.());
  await expect(pendingRow(A)).toBeVisible();
  await expect(fold().locator('summary')).toHaveText('1 tarea terminada');
  expect((await server.rows('tasks.tasks')).find((t) => t.id === A).done).toBe(false);
});

test('desmarcar una terminada desde el plegable la devuelve a su sitio', async () => {
  await fold().locator('summary').click();
  await page.locator(`.donefold [data-toggle-task="${HECHA}"]`).click();
  await expect(pendingRow(HECHA)).toBeVisible();
  await expect(fold()).toHaveCount(0);
  await settled(page);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === HECHA).done).toBe(false);
  // Su sitio: después de las otras dos, por su posición.
  const order = await page.locator('.tasklist > .task [data-toggle-task]').evaluateAll((n) => n.map((x) => (x as HTMLElement).dataset.toggleTask));
  expect(order.slice(-3)).toEqual([A, B, HECHA]);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
