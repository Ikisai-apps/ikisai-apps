/**
 * Ikisai Tasks · cáscara con estado (docs/tasks/UI_KIT.md §6, ronda 19): la cáscara se monta una vez y render() solo repinta
 * #view. Las dos pruebas que pidió Tasks: el menú abierto y sus grupos plegados sobreviven a una sincronización, y un área
 * creada en otro dispositivo aparece en la tira sin recargar.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const syncNow: any, render: any, newAreaSheet: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let a: Page, b: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
  server = await startE2EServer();
  ID = await seedDemo(server);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  a = await openApp(contextA, server, { aliases: ID, errors });
  b = await openApp(contextB, server, { aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('el menú abierto y sus grupos plegados sobreviven a una sincronización y a un repintado', async () => {
  await settled(a);
  // La cáscara es la misma antes y después: se marca un nodo y se comprueba que sigue ahí.
  await a.evaluate(() => { (document.getElementById('kebab') as any).__marca = 'cáscara'; });
  await a.locator('#moreBtn').click();
  await expect(a.locator('#kebab')).toHaveClass(/show/);
  await expect(a.locator('#moreBtn')).toHaveAttribute('aria-expanded', 'true');
  // Se abre un grupo que estaba plegado y se pliega uno abierto.
  await a.locator('[data-menu-group="transfer"] > summary').click();
  await a.locator('[data-menu-group="work"] > summary').click();
  const groups = () => a.evaluate(() => [...document.querySelectorAll<HTMLDetailsElement>('#kebab details[data-menu-group]')].map((d) => `${d.dataset.menuGroup}:${d.open ? 'abierto' : 'plegado'}`));
  const before = await groups();
  expect(before).toContain('transfer:abierto');
  expect(before).toContain('work:plegado');
  await a.evaluate(() => syncNow());
  await settled(a);
  await a.evaluate(() => render());
  await expect(a.locator('#kebab')).toHaveClass(/show/);
  await expect(a.locator('#menuBackdrop')).toHaveClass(/show/);
  await expect(a.locator('#moreBtn')).toHaveAttribute('aria-expanded', 'true');
  expect(await groups()).toEqual(before);
  expect(await a.evaluate(() => (document.getElementById('kebab') as any).__marca)).toBe('cáscara');
  // Navegar sigue cerrando el menú en móvil.
  await a.locator('[data-menu-group="work"] > summary').click();
  await a.locator('#kebab [data-menu-view="tasks"]').click();
  await expect(a.locator('#kebab')).not.toHaveClass(/show/);
  await expect(a.locator('#moreBtn')).toHaveAttribute('aria-expanded', 'false');
});

test('un área creada en otro dispositivo aparece en la tira sin recargar', async () => {
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
