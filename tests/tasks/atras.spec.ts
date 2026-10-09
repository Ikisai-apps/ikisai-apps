/**
 * Ikisai Tasks · «atrás» del navegador o del móvil (FB_2026_025, kit 0.26): cierra la hoja abierta y el menú lateral,
 * vuelve al Inicio desde otra pantalla y, desde el Inicio, pregunta «¿Cerrar la app?».
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, type Aliases } from './e2e-helpers.ts';

declare const state: any, navigateView: any, areasSheet: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const back = () => page.evaluate(() => history.back());
const view = () => page.evaluate(() => state.view);

test('desde otra pantalla, «atrás» vuelve al Inicio', async () => {
  await page.evaluate(() => navigateView('home'));
  await page.evaluate(() => navigateView('projects'));
  await expect.poll(view).toBe('projects');
  await back();
  await expect.poll(view).toBe('home');
});

test('«atrás» cierra la hoja abierta y no cambia de pantalla', async () => {
  await page.evaluate(() => navigateView('projects'));
  await page.evaluate(() => areasSheet());
  await expect(page.locator('#sheet')).toBeVisible();
  await back();
  await expect(page.locator('#sheet')).toHaveCount(0);
  expect(await view()).toBe('projects');
  // El siguiente «atrás» ya vuelve al Inicio.
  await back();
  await expect.poll(view).toBe('home');
});

test('«atrás» cierra el menú lateral', async () => {
  await page.locator('#moreBtn').click();
  await expect(page.locator('#kebab')).toHaveClass(/\bshow\b/);
  await back();
  await expect(page.locator('#kebab')).not.toHaveClass(/\bshow\b/);
  expect(await view()).toBe('home');
});

test('desde el Inicio, «atrás» pregunta «¿Cerrar la app?» y «Cancelar» se queda', async () => {
  await back();
  const dialog = page.getByRole('alertdialog').filter({ hasText: '¿Cerrar la app?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await view()).toBe('home');
  // Sigue funcionando: otra pantalla y «atrás» vuelve al Inicio.
  await page.evaluate(() => navigateView('tasks'));
  await back();
  await expect.poll(view).toBe('home');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
