/**
 * Ikisai Tasks · actualización del service worker (portado de `tests/updates.cjs` del repo antiguo): borradores y colas
 * pendientes, propios o de otra pestaña, vetan la activación del worker nuevo; con todas las pestañas de acuerdo se recarga.
 * La segunda pestaña comparte contexto (y sesión) con la primera, así que queda como pestaña secundaria.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

// Globales de la interfaz heredada (scripts clásicos), visibles dentro de page.evaluate.
declare const Sync: any;
declare let state: any;
declare const closeSheet: any, openTaskEditor: any, navigateView: any, startInlineProject: any, startInlineNew: any, setMode: any, render: any, save: any, syncNow: any, openPalette: any, closePalette: any;

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
test.afterAll(async () => {
  await context?.close(); await server?.close();
});

const waiting = (page: Page) => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
const clickUpdate = (page: Page) => page.evaluate(() => (document.getElementById('appUpdate') as HTMLElement).click());

test('actualización del service worker: borradores y colas vetan la activación', async ({ browser }) => {
  test.setTimeout(120_000);
  context = await browser.newContext();
  const first = await openApp(context, server, { aliases: ID, errors });
  const controlled = () => first.waitForFunction(async () => !!navigator.serviceWorker.controller && !!(await caches.match('/updates.js')), null, { timeout: 20_000 });
  try { await controlled(); } catch {
    await first.reload();
    await first.waitForFunction(() => typeof Sync !== 'undefined' && Sync.ready && state.tabs.length > 0, null, { timeout: 20_000 });
    await controlled();
  }
  const second = await context.newPage();
  second.on('pageerror', (error) => errors.push(error.message));
  await second.addInitScript(`window.ID = ${JSON.stringify(ID)};`);
  await second.goto(server.url + '/');
  await second.waitForFunction(() => typeof Sync !== 'undefined' && Sync.secondary === true && state.tabs.length > 0, null, { timeout: 20_000 });
  await second.evaluate(() => { if (document.getElementById('sheetBack')?.classList.contains('show')) closeSheet(); });
  await first.waitForFunction((id) => state.tabs.some((x: any) => x.projects.some((p: any) => p.id === id)), ID.p1);

  await test.step('[1] un editor abierto conserva su borrador y bloquea la actualización', async () => {
    await first.evaluate(() => { state.currentProject = (window as any).ID.p1; openTaskEditor((window as any).ID.t2); });
    await first.locator('#teNote').fill('Borrador sin guardar');
    server.swGeneration = 2;
    await first.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r!.update(); });
    await first.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, null, { timeout: 20_000 });
    await first.evaluate(() => setMode(Sync.mode));
    await first.locator('#appUpdate').waitFor({ state: 'attached' });
    await clickUpdate(first);
    await first.waitForTimeout(300); // comprobar que NO ocurre nada
    await expect(first.locator('#teNote')).toHaveValue('Borrador sin guardar');
    expect(await waiting(first)).toBe(true);
  });

  await test.step('[2] un borrador de proyecto en línea bloquea la actualización antes de entrar en la cola', async () => {
    await first.locator('#closeDialog').click();
    await first.evaluate(() => { navigateView('projects'); startInlineProject((window as any).ID.ikisai); });
    await first.locator('.inlineedit').fill('Proyecto sin guardar');
    await clickUpdate(first);
    await first.waitForTimeout(300); // comprobar que NO ocurre nada
    await expect(first.locator('.inlineedit')).toHaveValue('Proyecto sin guardar');
    expect(await waiting(first)).toBe(true);
    await first.locator('.inlineedit').press('Escape');
    await expect(first.locator('.inlineedit')).toHaveCount(0);
  });

  await test.step('[2b] la paleta abierta y una selección múltiple también bloquean la actualización', async () => {
    await first.evaluate(() => openPalette());
    await first.locator('#paletteInput').fill('pint');
    await clickUpdate(first);
    await first.waitForTimeout(300); // comprobar que NO ocurre nada
    await expect(first.locator('#paletteInput')).toHaveValue('pint');
    expect(await waiting(first)).toBe(true);
    await first.evaluate(() => closePalette());

    await first.evaluate(() => { state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
    await first.locator('#batchToggle').click();
    await first.locator('.selectbox').first().click();
    await expect(first.locator('.task.selected')).toHaveCount(1);
    await clickUpdate(first);
    await first.waitForTimeout(300); // comprobar que NO ocurre nada
    await expect(first.locator('.task.selected')).toHaveCount(1);
    expect(await waiting(first)).toBe(true);
    await first.locator('#batchToggle').click();
    await expect(first.locator('.task.selected')).toHaveCount(0);
  });

  await test.step('[3] otra pestaña con un editor abierto veta la activación coordinada', async () => {
    await second.evaluate(() => { state.currentProject = (window as any).ID.p1; openTaskEditor((window as any).ID.t2); });
    await expect(second.locator('#teNote')).toBeVisible();
    await first.locator('#appUpdate').click();
    await first.waitForFunction(() => !Sync.updateLocked);
    expect(await waiting(first)).toBe(true);
    await second.locator('#closeDialog').click();
  });

  await test.step('[4] un borrador en línea en otra pestaña veta la activación y conserva su texto', async () => {
    await second.evaluate(() => {
      const secondary = Sync.secondary; Sync.secondary = false;
      state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); startInlineNew((window as any).ID.p1);
      Sync.secondary = secondary;
    });
    await second.locator('.inlineedit').fill('Borrador de la otra pestaña');
    await first.locator('#appUpdate').click();
    await first.waitForFunction(() => !Sync.updateLocked);
    await expect(second.locator('.inlineedit')).toHaveValue('Borrador de la otra pestaña');
    expect(await waiting(first)).toBe(true);
    await second.locator('.inlineedit').press('Escape');
    await expect(second.locator('.inlineedit')).toHaveCount(0);
  });

  await test.step('[5] una cola pendiente bloquea la actualización sin descartar la cola', async () => {
    await context.setOffline(true);
    await first.evaluate(() => {
      const t = state.tabs.flatMap((x: any) => x.projects.flatMap((p: any) => p.tasks)).find((x: any) => x.id === (window as any).ID.t2);
      t.note = 'pendiente'; save(); render();
    });
    await first.waitForFunction(() => Sync.record.queue.length === 1, null, { timeout: 20_000 });
    await clickUpdate(first);
    await first.waitForTimeout(300); // comprobar que NO ocurre nada
    expect(await waiting(first)).toBe(true);
    expect(await first.evaluate(() => Sync.record.queue.length)).toBe(1);
    await context.setOffline(false);
    await first.evaluate(() => syncNow());
    await settled(first);
  });

  await test.step('[6] con todas las pestañas de acuerdo, se recarga en el worker nuevo conservando actor y tareas', async () => {
    const actor = await first.evaluate(() => Sync.actor.id);
    await first.evaluate(() => { (window as any).__antes = true; }); // la marca desaparece al recargar
    await first.locator('#appUpdate').click();
    await first.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration())?.waiting, null, { timeout: 20_000 });
    await first.waitForFunction(() => typeof Sync !== 'undefined' && !(window as any).__antes && Sync.ready && !!Sync.actor && state.tabs.length > 0, null, { timeout: 20_000 });
    expect(await first.evaluate(() => Sync.actor.id)).toBe(actor);
    expect(await first.evaluate(() => Sync.record.queue.length)).toBe(0);
    expect(await first.evaluate((id) => state.tabs.some((x: any) => x.projects.some((p: any) => p.tasks.some((t: any) => t.id === id))), ID.t2)).toBe(true);
  });

  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
