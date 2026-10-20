/**
 * Ikisai Tasks · cáscara con estado (docs/tasks/UI_KIT.md §6, ronda 19): la cáscara se monta una vez y render() solo repinta
 * #view. Las dos pruebas que pidió Tasks: el menú abierto y sus grupos plegados sobreviven a una sincronización, y un área
 * creada en otro dispositivo aparece en la tira sin recargar.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { menuRow, menuRows, openApp, openMenu, openMenuSection, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const syncNow: any, render: any, newAreaSheet: any, closeSheet: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let a: Page, b: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  a = await openApp(contextA, server, { aliases: ID, errors });
  b = await openApp(contextB, server, { aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('el menú común abierto y su sección desplegada sobreviven a una sincronización y a un repintado', async () => {
  await settled(a);
  // Sin ☰ ni menú propio: la marca abre el menú común del kit.
  await expect(a.locator('#moreBtn, #kebab')).toHaveCount(0);
  const mark = a.locator('#appLauncher');
  await expect(mark).toHaveAttribute('aria-haspopup', 'dialog');
  const drawer = await openMenu(a);
  await expect(mark).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer).toHaveAttribute('aria-label', 'Menú de Tasks');
  // El cajón es el mismo antes y después: se marca el nodo y se comprueba que sigue ahí.
  await a.evaluate(() => { (document.querySelector('.appmenu-drawer') as any).__marca = 'menú'; });
  await openMenuSection(a, 'transfer');
  await a.evaluate(() => syncNow());
  await settled(a);
  await a.evaluate(() => render());
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.appmenu-tile[data-feedback-id="tasks.menu.secciones.transfer"]')).toHaveAttribute('aria-expanded', 'true');
  expect(await a.evaluate(() => (document.querySelector('.appmenu-drawer') as any).__marca)).toBe('menú');
  // Escape cierra y devuelve el foco a la marca.
  await a.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(mark).toHaveAttribute('aria-expanded', 'false');
  expect(await a.evaluate(() => document.activeElement?.id)).toBe('appLauncher');
  // Cada fila hace lo de su botón de antes y cierra el menú: «Archivados» abre su hoja.
  await (await menuRow(a, 'tasks.menu.archivados', 'work')).click();
  await expect(a.locator('.appmenu-drawer')).toBeHidden();
  await expect(a.locator('#sheet')).toBeVisible();
  await a.evaluate(() => closeSheet());
});

test('el menú común conserva las filas de hoy, sin repetir la barra de abajo, con la pista del área, y el foco atrapado', async () => {
  const work = await menuRows(a, 'work');
  // Lo que ya está en la barra de pestañas no se repite.
  for (const gone of ['tasks.menu.inicio', 'tasks.menu.proyectos', 'tasks.menu.tareas', 'tasks.menu.etiquetas', 'tasks.menu.filtros']) expect(work).not.toContain(gone);
  for (const kept of ['tasks.menu.mis_tareas', 'tasks.menu.vistas', 'tasks.menu.archivados', 'tasks.menu.papelera', 'tasks.menu.areas']) expect(work).toContain(kept);
  expect(await menuRows(a, 'transfer')).toEqual(expect.arrayContaining(['tasks.menu.importar_keep', 'tasks.menu.exportar_json', 'tasks.menu.exportar_csv', 'tasks.menu.exportar_texto']));
  expect(await menuRows(a, 'system')).toEqual(expect.arrayContaining(['tasks.menu.sugerencias', 'tasks.menu.sincronizacion', 'tasks.menu.historial']));
  expect(await menuRows(a, 'people')).toContain('tasks.menu.mi_cuenta');
  expect(await menuRows(a, 'purchases')).toEqual(['tasks.menu.compras', 'tasks.menu.suministros', 'tasks.menu.planes']);
  const drawer = await openMenu(a);
  await expect(drawer.locator('.appmenu-tile[data-feedback-id="tasks.menu.secciones.organize"]')).toHaveCount(0);
  await expect(drawer.locator('.tasks-menuhint')).toContainText(/Área actual|General/);
  await expect(drawer.locator('.appmenu-profile')).toBeVisible();
  await expect(drawer.locator('.appmenu-sync')).toBeVisible();
  // Tab no se escapa del cajón.
  for (let i = 0; i < 40; i++) await a.keyboard.press('Tab');
  expect(await a.evaluate(() => !!document.activeElement?.closest('.appmenu-drawer'))).toBe(true);
  await a.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('en el ordenador: columna del menú de 316 px a la izquierda y la barra de pestañas abajo', async () => {
  await b.setViewportSize({ width: 1440, height: 1000 });
  await settled(b);
  const column = b.locator('#shellTop .appmenu-column');
  await expect(column).toBeVisible();
  const box = (await column.boundingBox())!;
  expect(box.x).toBe(0);
  expect(Math.round(box.width)).toBe(316);
  const bar = b.locator('#shellBottom .bottomnav');
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  expect(barBox.x).toBeGreaterThanOrEqual(316);
  expect(barBox.y + barBox.height).toBeGreaterThan(990);
  const content = (await b.locator('#view .screen').first().boundingBox())!;
  expect(content.x).toBeGreaterThanOrEqual(316);
  expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  // Las filas de la columna hacen lo mismo que las del cajón.
  await (await menuRow(b, 'tasks.menu.papelera', 'work', 'column')).click();
  await expect(b.locator('#sheet')).toBeVisible();
  await b.evaluate(() => closeSheet());
});

test('un área creada en otro dispositivo aparece en la tira sin recargar @smoke', async () => {
  await a.evaluate(() => { (window as any).__sinRecargar = true; });
  const tabs = () => a.locator('.tabstrip .tabpill[data-tab]');
  const count = await tabs().count();
  await b.evaluate(() => newAreaSheet());
  await b.locator('#tabName').fill('Huerto');
  await b.locator('#createTab').click();
  await settled(b);
  await b.evaluate(() => syncNow());
  await settled(b);
  await a.evaluate(() => syncNow());
  await settled(a);
  await expect(tabs()).toHaveCount(count + 1, { timeout: 20_000 });
  await expect(a.locator('.tabstrip .tabpill', { hasText: 'Huerto' })).toHaveCount(1);
  expect(await a.evaluate(() => (window as any).__sinRecargar)).toBe(true);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('la marca de la cabecera abre el menú común con las apps de Ikisai y «Comentarios y ayuda» dentro @smoke', async () => {
  await a.locator('#appLauncher').click();
  const menu = a.getByRole('dialog', { name: 'Menú de Tasks' });
  await expect(menu).toBeVisible();
  await expect(menu).toBeInViewport();
  // Las apps (sin Tasks: es la de aquí) y los interruptores de feedback.
  await expect(menu.getByRole('region', { name: 'Apps de Ikisai' })).toBeVisible();
  await expect(menu.getByRole('switch', { name: /Señalar para comentar/ })).toBeVisible();
  await expect(menu.getByText('Sugerencias y QA').first()).toBeVisible();
  // La marca lleva el icono de Tasks del kit, no el glifo genérico.
  expect(await a.locator('#appLauncher').textContent()).not.toContain('•||•');
  await a.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
