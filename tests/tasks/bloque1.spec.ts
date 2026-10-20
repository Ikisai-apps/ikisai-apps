/**
 * Ikisai Tasks · fallos de la tanda de feedback del 13-10-2026: FB_2026_036 = 040 (en Proyectos, una chip por madre como
 * en Tareas), FB_2026_038 (chips ordenadas por familia), FB_2026_043 (al agrupar, la tarea solo en el grupo de su hija) y
 * FB_2026_034 (en la vista General de «Etiquetas», lo General una sola vez y en cada área solo lo suyo).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, openLabelCatalog, seedDemo, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const TAB = crypto.randomUUID(), P = crypto.randomUUID(), T = crypto.randomUUID(), STAFF = crypto.randomUUID(), VG = crypto.randomUUID(), PODA = crypto.randomUUID();
const GFAM = crypto.randomUUID(), GLAB = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ops = createTabOps({ id: TAB, name: 'Mejoras', position: 90_000 });
  const fam = (k: string) => ops.find((o) => o.fields?.system_key === k)!.id!;
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(ops);
  await ok([
    { op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Baños', position: 2048 } },
    // Fase antes en la lista de la tarea, pero Persona va antes en el orden de familias.
    { op: 'insert', table: 'tasks.labels', id: PODA, fields: { tab_id: TAB, family_id: fam('phase'), name: 'Poda', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: STAFF, fields: { tab_id: TAB, family_id: fam('person'), name: 'Staff', position: 1024 } },
    { op: 'insert', table: 'tasks.families', id: GFAM, fields: { tab_id: null, name: 'Tipo: Acción', color: '#5a7a8a', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: TAB, family_id: fam('person'), parent_id: STAFF, name: 'VG', position: 2048 } },
    // Una segunda hija: con todas las hijas, la chip diría solo «Staff» (FB_2026_021).
    { op: 'insert', table: 'tasks.labels', id: crypto.randomUUID(), fields: { tab_id: TAB, family_id: fam('person'), parent_id: STAFF, name: 'AN', position: 3072 } },
    { op: 'insert', table: 'tasks.labels', id: GLAB, fields: { tab_id: null, family_id: GFAM, name: 'Revisar', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T, fields: { tab_id: TAB, project_id: P, title: 'Limpiar', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.task_labels', id: crypto.randomUUID(), fields: { tab_id: TAB, project_id: P, task_id: T, label_id: PODA } },
    { op: 'insert', table: 'tasks.task_labels', id: crypto.randomUUID(), fields: { tab_id: TAB, project_id: P, task_id: T, label_id: VG } },
    { op: 'insert', table: 'tasks.task_labels', id: crypto.randomUUID(), fields: { tab_id: TAB, project_id: P, task_id: T, label_id: STAFF } },
  ]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('FB_2026_036/040 y 038: en Proyectos y en Tareas, «Staff: VG» sin «Staff» suelta, y por orden de familias', async () => {
  await page.evaluate((id) => { state.taskScope = 'area'; state.activeTab = id; state.search = ''; state.filters = {}; state.view = 'projects'; render(); }, TAB);
  const card = page.locator(`.project:has([data-open-project="${P}"])`).first();
  // Proyectos con portada (MUELA-041, tanda 31): la tarjeta solo lleva la fila de espacio y oficio (hasta la n.º 7); la persona
  // va en las caras. En Tareas, las chips de siempre.
  await expect(card.locator('.chip')).toHaveCount(0);
  await expect(card.locator('.tkp-people .medal-initials')).toHaveText(['VG']);
  await page.evaluate((p) => { state.view = 'project'; state.currentProject = p; render(); }, P);
  await expect(page.locator(`.task:has([data-toggle-task="${T}"]) .taskchips .chip`)).toHaveText(['Staff: VG', 'Poda']);
});

test('FB_2026_043: agrupar por Persona pone la tarea solo en el grupo de VG', async () => {
  const person = await page.evaluate(() => (window as any).tab().families.find((f: any) => f.system === 'person' && !f.general).id);
  await page.evaluate((g) => { state.view = 'tasks'; state.groupBy = g; render(); }, person);
  const sections = page.locator('main section', { has: page.locator(`[data-toggle-task="${T}"]`) });
  await expect(sections).toHaveCount(1);
  await expect(sections.locator('h2')).toContainText('Staff: VG');
  await page.evaluate(() => { state.groupBy = 'project'; render(); });
});

test('FB_2026_034: en la vista General de «Etiquetas», lo General una sola vez arriba y en cada área solo lo suyo', async () => {
  await page.evaluate(() => { state.taskScope = 'all'; state.view = 'labels'; render(); });
  await openLabelCatalog(page);
  await expect(page.locator('#catalogGeneral')).toContainText('Revisar');
  await expect(page.locator('main')).toContainText('Revisar');
  expect(await page.locator('main .chip', { hasText: 'Revisar' }).count()).toBe(1);
  await expect(page.locator(`[data-area-block="${TAB}"]`)).toContainText('Staff');
  await expect(page.locator(`[data-area-block="${TAB}"]`)).not.toContainText('Revisar');
  await page.evaluate(() => { state.taskScope = 'area'; render(); });
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
