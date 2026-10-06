/**
 * Ikisai Tasks · aceptación V1, incidencia 2: los colores de las áreas sobreviven a «Nueva versión disponible».
 * Se pone color a dos áreas, se publica un service worker nuevo, se actualiza desde el botón y, tras la recarga, los
 * colores siguen en el modelo, en el servidor y en las pestañas.
 */
import { expect, test, type BrowserContext } from 'playwright/test';
import { build } from 'vite';
import { VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const Sync: any;
declare let state: any;
declare const manageTab: any, closeSheet: any, setMode: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
const errors: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
  server = await startE2EServer();
  ID = await seedDemo(server);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('colores de las áreas: se guardan y sobreviven a la actualización de la app', async ({ browser }) => {
  test.setTimeout(120_000);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await openApp(context, server, { aliases: ID, errors });
  await page.waitForFunction(async () => !!navigator.serviceWorker.controller || !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 20_000 });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await page.waitForFunction(() => typeof Sync !== 'undefined' && Sync.ready && state.tabs.length > 0 && !!navigator.serviceWorker.controller, null, { timeout: 20_000 });
  }
  const tabs = await page.evaluate(() => state.tabs.filter((t: any) => !t.deleted).map((t: any) => t.id));
  const colors: Record<string, string> = {};
  for (const [i, id] of tabs.slice(0, 2).entries()) {
    await page.evaluate((tab) => manageTab(tab), id);
    const swatch = page.locator('#sheet .colorfield [data-color]').nth(i + 1);
    colors[id] = (await swatch.getAttribute('data-color'))!;
    await swatch.click();
    await settled(page);
  }
  await page.evaluate(() => closeSheet());
  for (const [id, color] of Object.entries(colors)) expect((await server.rows('tasks.tabs')).find((r) => r.id === id)?.color).toBe(color);

  server.swGeneration = 2;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, null, { timeout: 20_000 });
  await page.evaluate(() => { (window as any).__antes = true; setMode(Sync.mode); });
  await page.locator('#appUpdate').click();
  await page.waitForFunction(() => typeof Sync !== 'undefined' && !(window as any).__antes && Sync.ready && state.tabs.length > 0, null, { timeout: 20_000 });
  await settled(page);

  for (const [id, color] of Object.entries(colors)) {
    expect(await page.evaluate((tab) => state.tabs.find((t: any) => t.id === tab).color, id), 'modelo').toBe(color);
    expect((await server.rows('tasks.tabs')).find((r) => r.id === id)?.color, 'servidor').toBe(color);
    await expect(page.locator(`.tabpill[data-tab="${id}"]`)).toHaveAttribute('style', new RegExp(`--item-color:${color}`));
  }
  expect(errors).toEqual([]);
});
