/**
 * Ikisai Tasks · la revisión de apertura en la app (revision-ui.js, docs/tasks/API.md §46): la banda del proyecto con los
 * críticos, la comprobación en la ficha de un ítem (una lectura fuera de rango es un fallo y crea «Arreglar» y «Volver a
 * comprobar»), abrir con pendientes solo con nota, y la lectora sin controles que guarden. Datos sintéticos.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const state: any, render: any, openTaskEditor: any, syncNow: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, reader: Page;
const errors: string[] = [];
let projectId = '', reviewId = '';

test.describe.configure({ mode: 'serial' });

const showProject = async (page: Page) => {
  await page.evaluate(async ([t, p]) => { await syncNow(); state.taskScope = 'area'; state.activeTab = t; state.filters = {}; state.search = ''; state.view = 'project'; state.currentProject = p; render(); }, [ID.ikisai, projectId]);
  await settled(page);
};
const item = async (zone: string) => (await server.rows('tasks.review_items')).find((i: any) => i.review_id === reviewId && i.zone === zone);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const house = (await server.rows('tasks.review_templates')).find((t: any) => t.name === 'Revisión de apertura')!;
  const out = await server.app.call('/api/v1/reviews', { body: { templateId: house.id, tabId: ID.ikisai, title: 'Apertura de prueba' } });
  expect(out.status, JSON.stringify(out.data)).toBe(200);
  projectId = out.data.projectId; reviewId = out.data.reviewId;
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  reader = await openApp(contextB, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('la banda del proyecto: aún no se puede abrir, con los críticos sin verificar', async () => {
  await showProject(owner);
  const band = owner.locator('#tkrBand');
  await expect(band).toContainText('Revisión de apertura');
  await expect(band).toContainText('Aún no se puede abrir');
  await expect(band).toContainText('0 de 6 críticos verificados');
});

test('la comprobación: 45 °C con «Está bien» es un fallo; crea «Arreglar» y «Volver a comprobar»', async () => {
  const acs = await item('duchas_acs');
  await owner.evaluate((id) => openTaskEditor(id), acs.task_id);
  const check = owner.locator('#tkrCheck');
  await expect(check).toContainText('Crítico');
  await expect(check).toContainText('esperado: 50 o más °C');
  await check.locator('#tkrValue').fill('45');
  await check.locator('#tkrOk').click();
  await expect.poll(async () => (await item('duchas_acs')).state).toBe('failed');
  await expect(owner.locator('#tkrCheck .tkr-links')).toContainText('Arreglar');
  await expect(owner.locator('#tkrCheck .tkr-links')).toContainText('Volver a comprobar');
  await owner.evaluate(() => (window as any).closeSheet());
  await showProject(owner);
  await expect(owner.locator('#tkrBand')).toContainText('1 falla');
});

test('abrir con críticos pendientes: la lista de lo que falta, y solo con nota', async () => {
  await owner.locator('#tkrOpen').click();
  const sheet = owner.locator('#sheet');
  await expect(sheet).toContainText('Faltan críticos por verificar');
  await sheet.locator('#tkrForce').click();
  await expect.poll(async () => (await server.rows('tasks.reviews')).find((r: any) => r.id === reviewId).status).toBe('open');
  await sheet.locator('#tkrNote').fill('El técnico viene mañana');
  await sheet.locator('#tkrForce').click();
  await expect.poll(async () => (await server.rows('tasks.reviews')).find((r: any) => r.id === reviewId).status).toBe('opened');
  await showProject(owner);
  await expect(owner.locator('#tkrBand')).toContainText('Abierta con pendientes');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('la lectora ve la comprobación sin controles que guarden', async () => {
  await showProject(reader);
  await expect(reader.locator('#tkrBand')).toContainText('Revisión de apertura');
  await expect(reader.locator('#tkrOpen')).toHaveCount(0);
  const puertas = await item('puertas');
  await reader.evaluate((id) => openTaskEditor(id), puertas.task_id);
  await expect(reader.locator('#tkrCheck')).toBeVisible();
  await expect(reader.locator('#tkrOk, #tkrFail')).toHaveCount(0);
});

test('plantillas: la de la casa con sus ítems; una nueva del área con un ítem de lectura', async () => {
  await owner.evaluate(async ([t]) => { await syncNow(); state.activeTab = t; state.view = 'projects'; render(); }, [ID.ikisai]);
  await settled(owner);
  await owner.locator('#tkrTpls').click();
  const sheet = owner.locator('#sheet');
  await expect(sheet).toContainText('Revisión de apertura');
  await sheet.locator('[data-tkr-tpl]', { hasText: 'Revisión de apertura' }).click();
  await expect(sheet).toContainText('Agua caliente en las duchas');
  await expect(sheet).toContainText('crítico');
  await sheet.locator('#tkrTplBack').click();
  await sheet.locator('#tkrTplNew').click();
  await expect.poll(async () => (await server.rows('tasks.review_templates')).some((t: any) => t.name === 'Plantilla nueva' && t.tab_id === ID.ikisai)).toBe(true);
  await expect(sheet.locator('#tkrItemNew')).toBeVisible();
  await sheet.locator('#tkrItemNew').click();
  await sheet.locator('#tkrIZone').selectOption('cocina');
  await sheet.locator('#tkrITitle').fill('Temperatura del lavavajillas');
  await sheet.locator('#tkrIAnswer').selectOption('reading');
  await sheet.locator('#tkrIUnit').fill('°C');
  await sheet.locator('#tkrIMin').fill('80');
  await sheet.locator('#tkrISave').click();
  await expect.poll(async () => (await server.rows('tasks.review_template_items')).find((i: any) => i.title === 'Temperatura del lavavajillas')?.expected).toEqual({ unit: '°C', min: 80 });
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
