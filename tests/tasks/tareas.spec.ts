/**
 * Ikisai Tasks · tanda de feedback del 13-10-2026, bloque 2: FB_2026_039 (reordenar proyectos arrastrando también en la
 * vista General), FB_2026_044 (las hijas en el editor de la madre, con «+ Nueva hija») y FB_2026_041 («Pasos en orden»).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, openTaskEditor: any, navigateView: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const TAB = crypto.randomUUID(), P1 = crypto.randomUUID(), P2 = crypto.randomUUID(), P3 = crypto.randomUUID(), MADRE = crypto.randomUUID(), A = crypto.randomUUID(), B = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ id: TAB, name: 'Obra', position: 90_000 }));
  await ok([
    { op: 'insert', table: 'tasks.projects', id: P1, fields: { tab_id: TAB, title: 'Baño', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: P2, fields: { tab_id: TAB, title: 'Cocina', position: 3072 } },
    { op: 'insert', table: 'tasks.projects', id: P3, fields: { tab_id: TAB, title: 'Tejado', position: 4096 } },
  ]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: MADRE, fields: { tab_id: TAB, project_id: P1, title: 'Alicatar', position: 1024 } }]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: A, fields: { tab_id: TAB, project_id: P1, parent_id: MADRE, title: 'Quitar azulejos', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: B, fields: { tab_id: TAB, project_id: P1, parent_id: MADRE, title: 'Nivelar', position: 2048 } },
  ]);
  context = await browser.newContext({ viewport: { width: 484, height: 1008 } });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('FB_2026_039: en la vista General también se reordenan los proyectos arrastrando con el asa', async () => {
  await page.evaluate(() => { state.taskScope = 'all'; state.filters = {}; state.search = ''; navigateView('projects'); });
  const block = page.locator(`[data-area-block="${TAB}"]`);
  const titles = () => block.locator('.project .projecttitle').allTextContents();
  await expect.poll(titles).toEqual(expect.arrayContaining(['Baño', 'Cocina', 'Tejado']));
  const handle = block.locator(`[data-project-drag="${P3}"]`), target = block.locator(`[data-drop-project="${P1}"]`).first();
  await block.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!, to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 6, { steps: 10 });
  await page.mouse.up();
  await settled(page);
  const order = (await server.rows('tasks.projects')).filter((p) => [P1, P2, P3].includes(p.id)).sort((a, b) => a.position - b.position).map((p) => p.title);
  expect(order).toEqual(['Tejado', 'Baño', 'Cocina']);
  await page.evaluate(() => { state.taskScope = 'area'; render(); });
});

test('FB_2026_044: al editar la madre, sus hijas y «+ Nueva hija»', async () => {
  await page.evaluate(([t, p]) => { state.activeTab = t; state.view = 'project'; state.currentProject = p; render(); }, [TAB, P1]);
  await page.evaluate((id) => openTaskEditor(id), MADRE);
  const section = page.locator('#taskChildren');
  await expect(section.locator('.childtext')).toHaveText(['Quitar azulejos', 'Nivelar']);
  await page.locator('#newChildText').fill('Poner azulejos');
  await page.locator('#newChildText').press('Enter');
  await expect(section.locator('.childtext')).toHaveText(['Quitar azulejos', 'Nivelar', 'Poner azulejos']);
  await settled(page);
  const kid = (await server.rows('tasks.tasks')).find((t) => t.title === 'Poner azulejos');
  expect(kid.parent_id).toBe(MADRE);
  await page.screenshot({ path: '../coordinacion/tasks/hijas-en-editor-movil.png' }).catch(() => {});
});

test('FB_2026_041: «Pasos en orden» bloquea cada hija por la de arriba; soltar una de la cadena', async () => {
  await page.locator('#stepsInOrder').check();
  await settled(page);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === MADRE).steps_in_order).toBe(true);
  await expect(page.locator('#taskChildren .childtext', { hasText: 'Nivelar' })).toContainText('espera al paso anterior');
  await page.evaluate(() => (window as any).closeSheet());
  // En la lista, «Nivelar» aparece bloqueada por «Quitar azulejos».
  expect(await page.evaluate((b) => (window as any).dependencyBlockers((window as any).taskLocation(b).t, (window as any).project()), B)).toEqual([A]);
  // En el editor de la hija: paso anterior y «Soltar de la cadena».
  await page.evaluate((id) => openTaskEditor(id), B);
  await expect(page.locator('#stepInfo')).toContainText('Paso anterior: Quitar azulejos');
  await page.locator('#stepFreeToggle').click();
  await settled(page);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === B).step_free).toBe(true);
  await expect(page.locator('#stepInfo')).toContainText('Fuera de la cadena');
  expect(await page.evaluate((b) => (window as any).dependencyBlockers((window as any).taskLocation(b).t, (window as any).project()), B)).toEqual([]);
  await page.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
