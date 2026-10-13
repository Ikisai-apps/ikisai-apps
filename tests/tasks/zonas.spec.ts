/**
 * Ikisai Tasks · caracterización de las zonas antes de la fase R2 (coordinacion/ampliacion/RECURSOS.md §17). Fija lo que ve
 * y hace hoy la persona con la familia General «Zona: Espacio» (madre › hija): chips, filtro con descendientes y tres
 * estados, agrupar sin duplicar, la ficha, la selección múltiple, el arrastre, y General frente a un área.
 * En R2 la zona pasa a ser un espacio de Recursos: solo cambiará la fuente del dato (la siembra de `seedZones` y el
 * «conductor» de abajo), no lo que estas pruebas esperan ver.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, filteredTasks: any, project: any, openTaskEditor: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), RET = id(), MEJ = id(), PINTURA = id(), SALAS_P = id(), OTONO = id();
const ZONA = id(), ALBERGUE = id(), SALAS = id(), HAB3 = id(), BANO = id(), ROBLE = id(), PINO = id(), MEJ_ZONA = id(), MEJ_ALB = id();
const T_HAB = id(), T_ALB = id(), T_ROBLE = id(), T_NADA = id(), T_RET = id(), T_SOLO = id();
let VG = '', PHASE = '';

/** Hoy: etiquetas de la familia General «Zona: Espacio». En R2: espacios de Recursos con su árbol. */
async function seedZones(ok: (ops: any[]) => Promise<void>) {
  await ok([{ op: 'insert', table: 'tasks.families', id: ZONA, fields: { tab_id: null, name: 'Zona: Espacio', color: '#9c744e', position: 1 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: ALBERGUE, fields: { tab_id: null, family_id: ZONA, name: 'Albergue', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: SALAS, fields: { tab_id: null, family_id: ZONA, name: 'Salas', position: 2048 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: HAB3, fields: { tab_id: null, family_id: ZONA, parent_id: ALBERGUE, name: 'Hab 3', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: BANO, fields: { tab_id: null, family_id: ZONA, parent_id: ALBERGUE, name: 'Baño Hombres', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: ROBLE, fields: { tab_id: null, family_id: ZONA, parent_id: SALAS, name: 'Sala Roble', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: PINO, fields: { tab_id: null, family_id: ZONA, parent_id: SALAS, name: 'Sala Pino', position: 2048 } },
  ]);
  // La copia de área archivada (Mejoras): no sale en ningún sitio y R2 no la migra.
  await ok([{ op: 'insert', table: 'tasks.families', id: MEJ_ZONA, fields: { tab_id: MEJ, name: 'Zona: Espacio', color: '#9c744e', position: 50 } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: MEJ_ALB, fields: { tab_id: MEJ, family_id: MEJ_ZONA, name: 'Albergue viejo', position: 1024, archived: true } }]);
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
  const fam = (k: string) => mant.find((o) => o.fields?.system_key === k)!.id!;
  PHASE = fam('phase');
  await ok(mant);
  await ok(createTabOps({ id: RET, name: 'Retiros', position: 91_000 }));
  await ok(createTabOps({ id: MEJ, name: 'Mejoras', position: 92_000 }));
  await seedZones(ok);
  VG = id();
  const REPASO = id();
  await ok([
    { op: 'insert', table: 'tasks.projects', id: PINTURA, fields: { tab_id: MANT, title: 'Pintura', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: SALAS_P, fields: { tab_id: MANT, title: 'Salas', position: 3072 } },
    { op: 'insert', table: 'tasks.projects', id: OTONO, fields: { tab_id: RET, title: 'Retiro de otoño', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: MANT, family_id: fam('person'), name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: REPASO, fields: { tab_id: MANT, family_id: PHASE, name: 'Repaso', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_HAB, fields: { tab_id: MANT, project_id: PINTURA, title: 'Pintar Hab 3', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_ALB, fields: { tab_id: MANT, project_id: PINTURA, title: 'Revisar el albergue', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: T_ROBLE, fields: { tab_id: MANT, project_id: PINTURA, title: 'Pintar Sala Roble', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: T_NADA, fields: { tab_id: MANT, project_id: PINTURA, title: 'Comprar pintura', position: 4096 } },
    { op: 'insert', table: 'tasks.tasks', id: T_RET, fields: { tab_id: RET, project_id: OTONO, title: 'Preparar el baño', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_SOLO, fields: { tab_id: RET, project_id: OTONO, title: 'Arreglar la ventana', position: 2048 } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: SALAS_P, label_id: SALAS } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: SALAS_P, label_id: ROBLE } },
  ]);
  await ok([
    // La fase va antes en la lista de la tarea, pero la zona (General) y la persona van antes en el orden de familias.
    tl(MANT, PINTURA, T_HAB, REPASO), tl(MANT, PINTURA, T_HAB, HAB3), tl(MANT, PINTURA, T_HAB, ALBERGUE), tl(MANT, PINTURA, T_HAB, VG),
    tl(MANT, PINTURA, T_ALB, ALBERGUE),
    tl(MANT, PINTURA, T_ROBLE, SALAS), tl(MANT, PINTURA, T_ROBLE, ROBLE),
    tl(RET, OTONO, T_RET, ALBERGUE), tl(RET, OTONO, T_RET, BANO),
    // Solo la hija, sin la madre guardada (como quedará un espacio en R2): el filtro por la madre también la encuentra.
    tl(RET, OTONO, T_SOLO, HAB3),
  ]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

// --- Conductor: cómo se llega hoy a cada cosa (en R2 cambia esto, no lo que se espera) -------------------------------
const openProject = (tab: string, p: string) => page.evaluate(([t, pr]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = pr; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [tab, p]);
const shown = () => page.evaluate(() => filteredTasks(project()).map((t: any) => t.text).sort());
const zoneFacet = () => page.evaluate(() => (window as any).tab().families.find((f: any) => f.name === 'Zona: Espacio' && !f.archived)?.id as string | undefined);
const zoneOption = (label: string) => page.locator(`.facet.open .facetpanel [data-facet-value="${label}"]`);
const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/r2-hoy/${name}.png` }).catch(() => {}); };
const serverLabels = async (task: string) => (await server.rows('tasks.task_labels')).filter((r) => r.task_id === task && !r.deleted_at).map((r) => r.label_id).sort();

test('chips: «Albergue: Hab 3», sin la madre suelta, en el orden de las familias; y en la tarjeta del proyecto', async () => {
  await openProject(MANT, PINTURA);
  await expect(chipsOf(T_HAB)).toHaveText(['Albergue: Hab 3', 'VG', 'Repaso']);
  await expect(chipsOf(T_ALB)).toHaveText(['Albergue']);
  await shot('1-tarjetas-de-tarea');
  await page.evaluate((t) => { state.activeTab = t; state.view = 'projects'; render(); }, MANT);
  await expect(page.locator(`.project:has([data-open-project="${SALAS_P}"]) .chip`)).toHaveText(['Salas: Sala Roble']);
  await shot('2-tarjeta-de-proyecto');
});

test('filtro: la madre incluye a sus hijas; la hija sola; y los tres estados (la tiene, no la tiene, nada)', async () => {
  await openProject(MANT, PINTURA);
  const facet = (await zoneFacet())!;
  expect(facet, 'la familia General de zona sale como faceta en el área').toBeTruthy();
  await page.locator(`[data-facet="${facet}"]`).click();
  await expect(page.locator('.facet.open .facetpanel')).toContainText('Albergue');
  await expect(page.locator('.facet.open .facetpanel')).not.toContainText('Albergue viejo');
  await zoneOption(ALBERGUE).click();
  expect(await shown()).toEqual(['Pintar Hab 3', 'Revisar el albergue']);
  await zoneOption(ALBERGUE).click();
  expect(await shown()).toEqual(['Comprar pintura', 'Pintar Sala Roble']);
  await zoneOption(ALBERGUE).click();
  expect(await shown()).toEqual(['Comprar pintura', 'Pintar Hab 3', 'Pintar Sala Roble', 'Revisar el albergue']);
  await shot('3-filtro-zona');
  await zoneOption(HAB3).click();
  expect(await shown()).toEqual(['Pintar Hab 3']);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { state.filters = {}; render(); });
});

test('agrupar por zona: cada tarea una sola vez, en el grupo de su hija', async () => {
  const facet = (await zoneFacet())!;
  await page.evaluate((g) => { state.view = 'tasks'; state.groupBy = g; state.filters = {}; render(); }, facet);
  const sectionOf = (task: string) => page.locator('main section', { has: page.locator(`[data-toggle-task="${task}"]`) });
  await expect(sectionOf(T_HAB)).toHaveCount(1);
  await expect(sectionOf(T_HAB).locator('h2')).toContainText('Albergue: Hab 3');
  await expect(sectionOf(T_ALB)).toHaveCount(1);
  await expect(sectionOf(T_ALB).locator('h2')).toContainText('Albergue');
  await expect(sectionOf(T_ROBLE).locator('h2')).toContainText('Salas: Sala Roble');
  await shot('4-agrupar-por-zona');
  await page.evaluate(() => { state.groupBy = 'project'; render(); });
});

test('ficha: la zona se marca de un toque; elegir la hija marca también su madre', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  const chip = page.locator(`#sheet [data-inline-label="${HAB3}"]`);
  await shot('5-ficha-cerrada');
  // Hoy la familia está plegada en la ficha: un toque para abrirla y otro en la zona.
  if (!(await chip.isVisible())) await page.locator('#sheet details:has([data-inline-label="' + HAB3 + '"]) > summary').click();
  await chip.click();
  await expect(chip).toHaveClass(/on/);
  await shot('6-ficha-zona-marcada');
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  expect(await serverLabels(T_NADA)).toEqual([ALBERGUE, HAB3].sort());
  await expect(chipsOf(T_NADA)).toHaveText(['Albergue: Hab 3']);
});

test('selección múltiple: «Etiquetas» › zona › Aplicar, a varias tareas a la vez', async () => {
  await openProject(MANT, PINTURA);
  await page.locator('#batchToggle').click();
  for (const t of [T_ALB, T_NADA]) await page.locator(`[data-select="${t}"]`).click();
  await page.locator('#batchLabels').click();
  // Toques de hoy: «Etiquetas» › la madre (abre sus hijas) › la hija › Aplicar.
  await page.locator(`#sheet [data-pick-mother="${ALBERGUE}"]`).click();
  await page.locator(`#sheet [data-pick-kid="${BANO}"]`).click();
  await shot('7-lote-elegir-zona');
  await page.locator('#labelsDone').click();
  await settled(page);
  expect(await serverLabels(T_ALB)).toEqual([ALBERGUE, BANO].sort());
  expect(await serverLabels(T_NADA)).toEqual([ALBERGUE, BANO, HAB3].sort());
  // Con todas las hijas de la madre, la chip dice solo la madre (FB_2026_021).
  await expect(chipsOf(T_NADA)).toHaveText(['Albergue']);
  await expect(chipsOf(T_ALB)).toHaveText(['Albergue: Baño Hombres']);
  if (await page.locator('#batchCancel').count()) await page.locator('#batchCancel').click();
});

test('arrastre: reordenar con el asa no toca las zonas de la tarea', async () => {
  await openProject(MANT, PINTURA);
  const before = await serverLabels(T_ROBLE);
  const from = (await page.locator(`.task:has([data-toggle-task="${T_ROBLE}"]) [data-drag]`).boundingBox())!;
  const to = (await page.locator(`.task:has([data-toggle-task="${T_HAB}"])`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
  await settled(page);
  const order = (await server.rows('tasks.tasks')).filter((t) => t.project_id === PINTURA && !t.deleted_at).sort((a, b) => a.position - b.position).map((t) => t.title);
  expect(order[0]).toBe('Pintar Sala Roble');
  expect(await serverLabels(T_ROBLE)).toEqual(before);
  await expect(chipsOf(T_ROBLE)).toHaveText(['Salas: Sala Roble']);
});

test('General frente a un área: la zona General vale en todas las áreas y en la vista General junta las dos', async () => {
  await openProject(RET, OTONO);
  await expect(chipsOf(T_RET)).toHaveText(['Albergue: Baño Hombres']);
  expect(await zoneFacet(), 'la misma familia General en Retiros').toBe(ZONA);
  await page.evaluate(() => { state.taskScope = 'all'; state.view = 'tasks'; state.groupBy = 'project'; state.filters = {}; state.search = ''; render(); });
  await page.evaluate(([f, l]) => { state.filters = { [f as string]: [l] }; render(); }, [ZONA, BANO]);
  const titles = () => page.evaluate(() => [...document.querySelectorAll('main .task[data-row] .tasktext')].map((n) => n.textContent!.trim()).sort());
  await expect.poll(titles).toEqual(['Comprar pintura', 'Preparar el baño', 'Revisar el albergue']);
  await page.evaluate(([f, l]) => { state.filters = { [f as string]: [l] }; render(); }, [ZONA, ALBERGUE]);
  await expect.poll(titles).toEqual(['Arreglar la ventana', 'Comprar pintura', 'Pintar Hab 3', 'Preparar el baño', 'Revisar el albergue']);
  await page.evaluate(() => { state.taskScope = 'area'; state.filters = {}; render(); });
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
