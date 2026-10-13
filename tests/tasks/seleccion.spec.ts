/**
 * Ikisai Tasks · incidencia del usuario del 13-10-2026: la selección múltiple ya no se encontraba y el asa de arrastrar era
 * pequeña para el dedo. «Seleccionar varias» es un icono en la fila de facetas (Todas las tareas, vista General y proyecto),
 * también por pulsación larga sobre una tarea (salvo con «Señalar para comentar» activo), y el asa tiene una zona táctil
 * de al menos 44×44 en tareas, proyectos y áreas.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, navigateView: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const TAB = crypto.randomUUID(), P = crypto.randomUUID(), T1 = crypto.randomUUID(), T2 = crypto.randomUUID(), T3 = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ id: TAB, name: 'Casa', position: 90_000 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Jardín', position: 2048 } }]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T1, fields: { tab_id: TAB, project_id: P, title: 'Regar', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T2, fields: { tab_id: TAB, project_id: P, title: 'Podar', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: T3, fields: { tab_id: TAB, project_id: P, title: 'Abonar', position: 3072 } },
  ]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('el icono «Seleccionar varias» está en la fila de facetas: Todas las tareas, vista General y proyecto', async () => {
  for (const setup of [
    (tab: string) => { state.taskScope = 'area'; state.activeTab = tab; state.filters = {}; navigateView('tasks'); },
    () => { state.taskScope = 'all'; state.filters = {}; navigateView('tasks'); },
    (tab: string, p: string) => { state.taskScope = 'area'; state.activeTab = tab; state.view = 'project'; state.currentProject = p; render(); },
  ]) {
    await page.evaluate(`(${setup.toString()})(${JSON.stringify(TAB)}, ${JSON.stringify(P)})`);
    await expect(page.locator('.facetbar .facettools #batchToggle')).toBeVisible();
  }
});

test('entrar en selección, marcar dos tareas y completarlas', async () => {
  await page.locator('#batchToggle').click();
  await expect(page.locator('#batchBar')).toBeVisible();
  for (const id of [T1, T2]) await page.locator(`[data-select="${id}"]`).click();
  await expect(page.locator('.task.selected')).toHaveCount(2);
  await page.locator('#batchDone').click();
  await settled(page);
  const done = (await server.rows('tasks.tasks')).filter((t) => [T1, T2, T3].includes(t.id)).map((t) => [t.title, t.done]);
  expect(Object.fromEntries(done)).toEqual({ Regar: true, Podar: true, Abonar: false });
});

test('la pulsación larga sobre una tarea entra en selección con ella marcada (no con «Señalar para comentar»)', async () => {
  await page.evaluate(() => { (window as any).eval('batchMode=false;batchSelection.clear()'); render(); });
  const row = page.locator(`.task[data-row="${T3}"] .tasktext`).first();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator('#batchBar')).toBeVisible();
  await expect(page.locator(`.task.selected[data-row="${T3}"]`)).toHaveCount(1);
  await page.locator('#batchCancel').click();
  await expect(page.locator('#batchBar')).toHaveCount(0);
  // Con «Señalar para comentar» activo, la pulsación larga es la del feedback: no entra en selección.
  await page.evaluate(() => (window as any).eval('tasksFeedback()').feedback.mode.set(true));
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator('#batchBar')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).eval('tasksFeedback()').feedback.mode.set(false));
});

test('el asa de arrastrar tiene una zona táctil de al menos 44×44 en tareas, proyectos y áreas', async () => {
  const hit = (sel: string) => page.locator(sel).first().evaluate((h) => { const b = h.getBoundingClientRect(), a = getComputedStyle(h, '::after');
    const extra = a.content && a.content !== 'none' ? { l: -parseFloat(a.left || '0') || 0, r: -parseFloat(a.right || '0') || 0, t: -parseFloat(a.top || '0') || 0, bo: -parseFloat(a.bottom || '0') || 0 } : { l: 0, r: 0, t: 0, bo: 0 };
    return [Math.round(b.width + Math.max(0, extra.l) + Math.max(0, extra.r)), Math.round(b.height + Math.max(0, extra.t) + Math.max(0, extra.bo))]; });
  const big = ([w, h]: number[]) => { expect(w).toBeGreaterThanOrEqual(44); expect(h).toBeGreaterThanOrEqual(44); };
  big(await hit('.task [data-drag]'));
  await page.evaluate(() => { navigateView('projects'); });
  big(await hit('[data-project-drag]'));
  await page.evaluate(() => (window as any).areasSheet());
  big(await hit('[data-area-drag]'));
  await page.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
