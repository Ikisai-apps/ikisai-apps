/**
 * Ikisai Tasks · filtros de la tanda de feedback del 13-10-2026: FB_2026_037 (en el móvil, cada faceta abre su
 * desplegable), FB_2026_042 (etiquetas con tres estados: la tiene, no la tiene, nada) y FB_2026_045 (prioridad); y una
 * vista guardada con esos filtros (migración 0319).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, filteredTasks: any, project: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const TAB = crypto.randomUUID(), P = crypto.randomUUID(), ALTA = crypto.randomUUID(), NORMAL = crypto.randomUUID(), VG = crypto.randomUUID();
let personFamily = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ops = createTabOps({ id: TAB, name: 'Filtros', position: 90_000 });
  personFamily = ops.find((o) => o.fields?.system_key === 'person')!.id!;
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(ops);
  await ok([
    { op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Obra', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: TAB, family_id: personFamily, name: 'VG', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: ALTA, fields: { tab_id: TAB, project_id: P, title: 'Urgente de VG', priority: 'high', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: NORMAL, fields: { tab_id: TAB, project_id: P, title: 'Normal sin etiqueta', position: 2048 } },
  ]);
  await ok([{ op: 'insert', table: 'tasks.task_labels', id: crypto.randomUUID(), fields: { tab_id: TAB, project_id: P, task_id: ALTA, label_id: VG } }]);
  context = await browser.newContext({ viewport: { width: 484, height: 1008 } });
  page = await openApp(context, server, { aliases: ID, errors });
  await page.evaluate(([t, p]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; state.filters = {}; state.search = ''; render(); }, [TAB, P]);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const shown = () => page.evaluate(() => filteredTasks(project()).map((t: any) => t.text).sort());

test('FB_2026_037: en el móvil, cada faceta abre su desplegable con sus opciones (no la hoja de filtros)', async () => {
  await page.locator('[data-facet="_state"]').click();
  await expect(page.locator('.facet.open .facetpanel')).toBeVisible();
  await expect(page.locator('.facet.open .facetpanel')).toContainText('Pendientes');
  await expect(page.locator('#sheet')).toHaveCount(0);
  await page.locator(`[data-facet="${personFamily}"]`).click();
  await expect(page.locator('.facet.open .facetpanel')).toContainText('VG');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '../coordinacion/tasks/facetas-desplegable-movil.png' }).catch(() => {});
  // Por encima de la lista: lo que hay en el centro del desplegable es el propio desplegable.
  expect(await page.locator('.facet.open .facetpanel').evaluate((panel) => { const r = panel.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 30)); return !!hit && panel.contains(hit); })).toBe(true);
});

test('FB_2026_042: una etiqueta pasa por «la tiene», «no la tiene» (tachada) y nada', async () => {
  const option = () => page.locator('.facet.open .facetpanel [data-facet-toggle]', { hasText: 'VG' });
  // El desplegable sigue abierto tras cada toque.
  await option().click();
  expect(await shown()).toEqual(['Urgente de VG']);
  await option().click();
  expect(await shown()).toEqual(['Normal sin etiqueta']);
  await expect(option()).toHaveClass(/excluded/);
  expect(await option().evaluate((n) => getComputedStyle(n).textDecorationLine)).toContain('line-through');
  await expect(page.locator('.activefilters .excludedchip')).toContainText('Sin VG');
  await option().click();
  expect(await shown()).toEqual(['Normal sin etiqueta', 'Urgente de VG']);
  await page.evaluate(() => { state.filters = {}; render(); });
});

test('FB_2026_045: filtrar por prioridad, en el desplegable y en la hoja de filtros', async () => {
  await page.locator('[data-facet="_priority"]').click();
  await page.locator('.facet.open .facetpanel [data-facet-toggle="_priority"]', { hasText: 'Alta' }).click();
  expect(await shown()).toEqual(['Urgente de VG']);
  await page.evaluate(() => { state.filters = {}; render(); });
  await page.locator('#filterBtn').click();
  await expect(page.locator('#sheet [data-priority="high"]')).toBeVisible();
  await page.locator('#sheet [data-priority="normal"]').click();
  // En la hoja, la etiqueta también tiene tres estados.
  const chip = page.locator(`#sheet [data-filter="${personFamily}|${VG}"]`);
  await chip.click();
  await chip.click();
  await expect(chip).toHaveClass(/excluded/);
  await page.locator('#applyFilterSheet').click();
  expect(await shown()).toEqual(['Normal sin etiqueta']);
  expect(await page.evaluate(() => state.filters)).toEqual({ _priority: ['normal'], _exclude: [VG] });
});

test('una vista guardada con prioridad y «sin» se guarda en el servidor', async () => {
  await page.evaluate(() => (window as any).savedViewsSheet());
  await page.locator('#viewName').fill('Normales sin VG');
  await page.locator('#saveView').click();
  await settled(page);
  const view = (await server.rows('tasks.saved_views')).find((v) => v.name === 'Normales sin VG');
  expect(view?.filters).toEqual({ _priority: ['normal'], _exclude: [VG] });
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
