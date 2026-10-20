/**
 * Ikisai Tasks · tanda 31, zona 2: las fichas «Portada y foco» (MUELA-083 §1 y MUELA-048 con lo que añade el 073) y
 * Proyectos con portada (MUELA-041). Las PRUEBAS de los traspasos:
 * - ficha de tarea: «Hecha» con «Deshacer» (staff), el lápiz de la portada guarda el título, las baldosas se abren en foco y
 *   vuelven a la portada, y la lectora sin controles activos que no guardan;
 * - ficha de proyecto: «Hecha» en la pila, «Siguiente ›» sin escritura, la lectora sin «Hecha», la baldosa «Quién» lleva al
 *   editor y la baldosa «Coste» con «excedido» solo para quien ve importes;
 * - Proyectos: marcar desde la tarjeta, el orden (Entrada, fijado, atención) con la banda que filtra, y la lectora sin controles.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { fichaBloque, fichaPortada, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const state: any, render: any, openTaskEditor: any, taskLocation: any, status: any, Sync: any, activeProjects: any, tab: any;

let server: E2EServer;
let ID: Aliases;
let ownerContext: BrowserContext, readerContext: BrowserContext;
let owner: Page, reader: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  readerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  owner = await openApp(ownerContext, server, { aliases: ID, errors });
  reader = await openApp(readerContext, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await ownerContext?.close(); await readerContext?.close(); await server?.close(); });

const openProject = (page: Page, p = ID.p1!) => page.evaluate(([t, id]) => { state.taskScope = 'area'; state.activeTab = t; state.filters = {}; state.search = ''; state.view = 'project'; state.currentProject = id; render(); }, [ID.ikisai!, p]);
const openProjects = (page: Page) => page.evaluate((t) => { state.taskScope = 'area'; state.activeTab = t; state.filters = {}; state.search = ''; state.view = 'projects'; render(); }, ID.ikisai!);
const isDone = (page: Page, id: string) => page.evaluate((x) => { const loc = taskLocation(x); return status(loc.p, loc.t) === 'done'; }, id);
const undo = (page: Page, message: string) => page.locator('.ikisai-toast span', { hasText: message }).locator('xpath=following-sibling::button');
/** Lo que un lector o un outsider podría tocar en la ficha sin que se guarde (debe estar vacío). */
const activeControls = (page: Page) => page.evaluate(() => [...document.querySelectorAll('#sheet .tkf-portada :is(button,input,select,textarea), #sheet .tkf-store :is(button,input,select,textarea)')]
  .filter((c: any) => !c.disabled && !c.closest('#taskComments') && c.id !== 'outsiderDone' && !c.matches('[data-child-toggle], [data-child-open], .tkf-tile'))
  .map((c: any) => c.id || c.getAttribute('data-feedback-id') || c.className));

test('ficha de tarea: portada, baldosas en foco, el lápiz guarda el título y «Hecha» con «Deshacer»', async () => {
  await openProject(owner);
  await owner.evaluate((id) => openTaskEditor(id), ID.t1);
  const sheet = owner.locator('#sheet');
  await expect(sheet.locator('.tkf-cover .cover-box')).toBeVisible();
  await expect(sheet.locator('.tkf-state')).toContainText('Lo lleva');
  // Una baldosa por bloque; cada una abre su nodo de siempre y «‹ Portada» vuelve.
  for (const key of ['quien', 'nota', 'comentarios', 'pasos', 'material', 'etiquetas', 'depende', 'adjuntos', 'mas']) await expect(sheet.locator(`[data-tkf-tile="${key}"]`)).toHaveCount(1);
  await fichaBloque(owner, 'nota');
  await expect(owner.locator('#teNote')).toBeVisible();
  await expect(sheet.locator('.tkf-cover')).toBeHidden();
  await fichaPortada(owner);
  await expect(owner.locator('#teNote')).toBeHidden();
  // El lápiz edita el título en el sitio (#teText) y «Guardar» lo guarda.
  await owner.locator('#tkfTitleEdit').click();
  await owner.locator('#teText').fill('Sustituir la puerta del patio');
  await owner.locator('#teText').press('Enter');
  await expect(owner.locator('#teText')).toBeHidden();
  await expect(sheet.locator('.tkf-cover .cover-title')).toHaveText('Sustituir la puerta del patio');
  await owner.locator('#saveTaskBtn').click();
  await settled(owner);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === ID.t1)?.title).toBe('Sustituir la puerta del patio');
  // «Hecha» arriba (staff), a un toque, y «Deshacer» la reabre.
  await owner.evaluate((id) => openTaskEditor(id), ID.t1);
  const done = owner.locator('.tkf-portada #tkfDone');
  await expect(done).not.toBeChecked();
  await done.check();
  expect(await isDone(owner, ID.t1!)).toBe(true);
  await expect(sheet.locator('.tkf-cover .cover-pill')).toHaveText('Hecha');
  await undo(owner, 'Tarea completada').click();
  await expect.poll(() => isDone(owner, ID.t1!)).toBe(false);
  await expect(done).not.toBeChecked();
  await expect(sheet.locator('.tkf-cover .cover-pill')).not.toHaveText('Hecha');
  await owner.evaluate(() => (window as any).closeSheet());
  await settled(owner);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === ID.t1)?.done).toBe(false);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('ficha de proyecto: portada, «Siguiente ›» sin escritura, «Hecha» en la pila, «Quién» y «Coste» con «excedido»', async () => {
  await openProject(owner);
  // Los ids de siempre (MUELA-048) siguen en la página.
  for (const sel of ['#backBtn', 'h1.title.editable', `[data-edit-project="${ID.p1}"]`, '[data-board-mode="list"]', '[data-board-mode="board"]', '#quickAdd', `[data-add-task="${ID.p1}"]`, '.rootdrop']) await expect(owner.locator(sel)).toHaveCount(1);
  await expect(owner.locator('#projectCover .cover-box')).toBeVisible();
  await expect(owner.locator('#projectCover .cover-stats')).toContainText('% hecho');
  const focus = owner.locator('#projectFocus');
  await expect(focus.locator('.focus-card')).toBeVisible();
  const first = await focus.locator('.focus-card').getAttribute('data-id');
  const before = await owner.evaluate(() => JSON.stringify(tab().projects.find((p: any) => p.id === (window as any).ID.p1).tasks));
  await focus.locator('.focus-next').click();
  await expect(focus.locator('.focus-card')).not.toHaveAttribute('data-id', first!);
  await expect(focus.locator('.focus-count')).toContainText('2 de');
  expect(await owner.evaluate(() => JSON.stringify(tab().projects.find((p: any) => p.id === (window as any).ID.p1).tasks))).toBe(before);
  expect(await owner.evaluate(() => Sync.record.queue.length)).toBe(0);
  // «✓ Hecha» en la pila marca la tarea de verdad, con «Deshacer».
  const shown = (await focus.locator('.focus-card').getAttribute('data-id'))!;
  await focus.locator('.focus-card [role="checkbox"]').click();
  await expect.poll(() => isDone(owner, shown)).toBe(true);
  await undo(owner, 'Tarea completada').click();
  await expect.poll(() => isDone(owner, shown)).toBe(false);
  await settled(owner);
  // «Quién» lleva al editor del proyecto.
  await owner.locator(`[data-project-quien="${ID.p1}"]`).click();
  await expect(owner.locator('#saveProjectBtn')).toBeVisible();
  await owner.evaluate(() => (window as any).closeSheet());
  // «Coste»: lo gastado frente al presupuesto, con «excedido», para quien ve importes.
  await owner.evaluate(() => { const p = tab().projects.find((x: any) => x.id === (window as any).ID.p1), t = p.tasks.find((x: any) => x.id === (window as any).ID.t1); p.budget = 10; t.cost = 50; (window as any).touch(p); (window as any).touch(t); (window as any).save(); render(); });
  await settled(owner);
  await expect(owner.locator('#projectTiles .tkf-costtile')).toContainText('excedido');
  await expect(owner.locator('#projectTiles .tkf-costtile')).toContainText('50');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('Proyectos: portadas en orden (Entrada, fijado, atención), la banda filtra y se marca desde la tarjeta', async () => {
  await openProjects(owner);
  await expect(owner.locator('.tkp-band .stat-item')).toHaveCount(3);
  const pinned = await owner.evaluate(() => activeProjects().find((p: any) => !p.system)?.id === activeProjects()[0]?.id ? activeProjects()[0].id : null);
  if (pinned) await expect(owner.locator('.project:not(.system)').first()).toHaveAttribute('data-drop-project', pinned);
  const order = await owner.locator('.project-grid > .tkp-wrap').evaluateAll((els) => els.map((e) => e.getAttribute('data-tkp-health')));
  if (order.includes('entrada')) expect(order[0]).toBe('entrada');
  // La banda: «Con vencidas» deja solo esos (y la Entrada); otro toque lo quita.
  const late = owner.locator('.tkp-band [data-tkp-focus="atencion"]');
  await late.click();
  await expect(owner.locator('.tkp-band [data-tkp-focus="atencion"]')).toHaveAttribute('aria-pressed', 'true');
  const shown = await owner.locator('.project-grid > .tkp-wrap').evaluateAll((els) => els.map((e) => e.getAttribute('data-tkp-health')));
  expect(shown.filter((h) => h !== 'entrada' && h !== 'atencion')).toEqual([]);
  await owner.locator('.tkp-band [data-tkp-focus="atencion"]').click();
  await expect(owner.locator('.tkp-band [data-tkp-focus="atencion"]')).toHaveAttribute('aria-pressed', 'false');
  // Marcar la siguiente tarea sin entrar.
  const card = owner.locator(`.project[data-drop-project="${ID.p1}"]`);
  const id = (await card.locator('.tkp-check').first().getAttribute('data-toggle-task'))!;
  await card.locator('.tkp-check').first().click();
  await expect.poll(() => isDone(owner, id)).toBe(true);
  await settled(owner);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === id)?.done).toBe(true);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('la lectora: sin controles que no guardan en Proyectos, la ficha del proyecto ni la de la tarea', async () => {
  await reader.evaluate(() => (window as any).syncNow?.());
  await settled(reader);
  await openProjects(reader);
  await expect(reader.locator('.tkp-card').first()).toBeVisible();
  await expect(reader.locator('[data-project-drag], [data-project-pin], [data-project-order], .tkp-check')).toHaveCount(0);
  await openProject(reader);
  await expect(reader.locator('#projectFocus .focus-card')).toBeVisible();
  await expect(reader.locator('#projectFocus [role="checkbox"]')).toHaveCount(0);
  await expect(reader.locator('#projectFocus .focus-btn', { hasText: 'Abrir' })).toBeVisible();
  await expect(reader.locator('#projectTiles .tkf-costtile')).toHaveCount(0);
  await reader.evaluate((id) => openTaskEditor(id), ID.t1);
  await expect(reader.locator('#tkfReadOnly')).toHaveText('Solo lectura: lo cambian staff o dirección.');
  await expect(reader.locator('#tkfTitleEdit, #tkfDone')).toHaveCount(0);
  expect(await activeControls(reader), 'controles activos que no guardan').toEqual([]);
  // Sin importes: ninguna baldosa lleva euros.
  await expect(reader.locator('#sheet .tkf-tiles')).not.toContainText('€');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
