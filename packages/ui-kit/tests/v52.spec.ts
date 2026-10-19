import { expect, test, type Page } from 'playwright/test';
import { filterPaletteItems } from '../src/palette.ts';

const back = (page: Page) => page.evaluate(() => new Promise<void>((r) => { addEventListener('popstate', () => setTimeout(r, 80), { once: true }); history.back(); }));
const mountMenu = (page: Page, opts: Record<string, unknown> = {}) => page.evaluate((o) => {
  document.querySelector('#app')!.setAttribute('hidden', '');
  scrollTo(0, 0);
  (window as any).menuShell = (window as any).ikisaiMenuDemo(o);
}, opts);
const log = (page: Page) => page.evaluate(() => (window as any).menuLog as string[]);

/** Tanda 28 (MUELA-013): cáscara con menú lateral común. Todo opcional. */
test.describe('ui-kit v0.47 · paleta, señalar y marca (K1, K2, K10, K11)', () => {
  test('@smoke K1: con `keepOrder`, la paleta respeta el orden de la app', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'función pura: una vez basta');
    const run = () => undefined;
    const items = [{ group: 'Obligaciones', text: 'Seguro vigente: extintores', run }, { group: 'Obligaciones', text: 'Extintores (cumplida)', run }];
    expect(filterPaletteItems(items, 'ext').map((i) => i.text)).toEqual(['Extintores (cumplida)', 'Seguro vigente: extintores']);
    expect(filterPaletteItems(items, 'ext', 16, [], true).map((i) => i.text)).toEqual(['Seguro vigente: extintores', 'Extintores (cumplida)']);
  });

  test('@smoke K10: «atrás» cierra la paleta sin navegar la pantalla de debajo', async ({ page }) => {
    await page.goto('/#/');
    await page.evaluate(() => (window as any).ikisaiKit.installBackNavigation());
    await page.evaluate(() => { location.hash = '#/reservas'; });
    await page.evaluate(() => { (window as any).pal = (window as any).ikisaiKit.createCommandPalette({ items: () => [], hotkey: false }); (window as any).pal.open(); });
    await expect(page.locator('#palette')).toHaveCount(1);
    await back(page);
    await expect(page.locator('#palette')).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('#/reservas');
    // Cerrada con Escape, el siguiente «atrás» navega como siempre.
    await page.evaluate(() => (window as any).pal.open());
    await page.keyboard.press('Escape');
    await back(page);
    expect(new URL(page.url()).hash).toBe('#/');
  });

  test('@smoke K2: con `delay: 0`, un toque señala (y la barra lo dice)', async ({ page }) => {
    await page.goto('/#feedback');
    await page.evaluate(() => { (window as any).picked = null; void (window as any).ikisaiKit.captureFeedbackTarget({ delay: 0 }).then((n: any) => { (window as any).picked = n?.id ?? 'nada'; }); });
    await expect(page.locator('.fb-capture-bar')).toContainText('Toca el lugar al que te refieres');
    await page.locator('[data-feedback-id]:visible').first().click();
    await expect.poll(() => page.evaluate(() => (window as any).picked)).not.toBeNull();
    await expect(page.locator('.fb-capture-bar')).toHaveCount(0);
  });

  test('K11: la marca que abre algo mide 46 px', async ({ page }) => {
    await page.goto('/#tokens');
    await mountMenu(page);
    const box = (await page.locator('#appLauncher').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(46);
    expect(box.height).toBeGreaterThanOrEqual(46);
  });
});

test.describe('ui-kit v0.47 · menú lateral (K7, K8, K12)', () => {
  test('@smoke la marca abre el cajón: diálogo modal, foco dentro, Escape, fondo y «atrás» lo cierran', async ({ page }) => {
    await page.goto('/#tokens');
    await page.evaluate(() => (window as any).ikisaiKit.installBackNavigation());
    await mountMenu(page);
    const markBtn = page.locator('#appLauncher');
    await expect(markBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(markBtn).toHaveAttribute('aria-label', 'Abrir el menú de Central');
    await markBtn.click();
    const drawer = page.getByRole('dialog', { name: 'Menú de Central' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(markBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer.locator('.appmenu-body a').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(markBtn).toBeFocused();
    await markBtn.click();
    await page.locator('.appmenu-backdrop').click({ position: { x: page.viewportSize()!.width - 10, y: 400 } });
    await expect(page.locator('.appmenu-drawer')).toHaveCount(0);
    await markBtn.click();
    const before = page.url();
    await back(page);
    await expect(page.locator('.appmenu-drawer')).toHaveCount(0);
    expect(page.url()).toBe(before);
  });

  test('@smoke contenido: perfil, sincronización, recientes, azulejos que despliegan, apps sin la actual, ayuda y salir', async ({ page }) => {
    await page.goto('/#tokens');
    await mountMenu(page, { status: { pendingCommands: 2 } });
    await page.locator('#appLauncher').click();
    const d = page.locator('.appmenu-drawer');
    await expect(d.locator('.appmenu-profile')).toHaveAttribute('aria-label', 'Tu cuenta: Marga, Administras Central');
    await expect(d.locator('.appmenu-sync')).toHaveText('2 cambios pendientes · sincronizado hace 5 min');
    await expect(d.locator('.appmenu-sync')).not.toHaveClass(/error/);
    await expect(d.locator('.appmenu-recientes .appmenu-row')).toHaveCount(2);
    const tile = d.getByRole('button', { name: /Obligaciones/ });
    await expect(tile).toHaveAttribute('aria-expanded', 'false');
    await tile.click();
    await expect(tile).toHaveAttribute('aria-expanded', 'true');
    await expect(tile).toBeFocused();
    const panel = d.getByRole('region', { name: 'Obligaciones' });
    await expect(panel).toContainText('Revisión técnica');
    await expect(panel.locator('.appmenu-count.alert')).toHaveText('1 vencida');
    // Solo un azulejo abierto a la vez.
    await d.getByRole('button', { name: /La entidad/ }).click();
    await expect(d.locator('.appmenu-panel')).toHaveCount(1);
    await expect(d.getByRole('region', { name: 'La entidad' })).toBeVisible();
    // Apps, sin la actual, y los bloques de feedback con sus clases de siempre.
    await expect(d.locator('.appmenu-apps .launcher-app')).toHaveCount(3);
    await expect(d.locator('.appmenu-apps [data-app="central"]')).toHaveCount(0);
    await expect(d.locator('.appmenu-ayuda .launcher-center')).toBeVisible();
    await expect(d.locator('.appmenu-ayuda .launcher-signal input[role="switch"]')).toHaveCount(1);
    await expect(d.locator('[data-feedback-id="central.menu.secciones.oblig"]')).toHaveCount(1);
    // Una fila navega y cierra.
    await d.getByRole('button', { name: /La entidad/ }).click();
    await d.getByRole('button', { name: /Obligaciones/ }).click();
    await d.locator('.appmenu-panel a', { hasText: 'Seguro' }).click();
    await expect(page.locator('.appmenu-drawer')).toHaveCount(0);
    expect(await log(page)).toContain('nav:#/cumplimiento/requisitos?tipo=seguro');
    await page.locator('#appLauncher').click();
    await page.locator('.appmenu-drawer').getByRole('button', { name: 'Cerrar sesión' }).click();
    expect(await log(page)).toContain('logout');
  });

  test('@smoke la línea de sincronización dice lo más urgente y actúa', async ({ page }) => {
    await page.goto('/#tokens');
    await mountMenu(page, { status: { network: 'offline', pendingCommands: 2 } });
    await page.locator('#appLauncher').click();
    const sync = page.locator('.appmenu-drawer .appmenu-sync');
    await expect(sync).toHaveText('Sin conexión · 2 sin enviar');
    await expect(sync).toHaveClass(/error/);
    await page.evaluate(() => (window as any).menuShell.setStatus({ network: 'online', cursor: 1, pendingCommands: 0, pendingBlobs: 0, conflicts: 1, lastPullAt: null, lastError: null, autoMerged: 0, rejected: 0 }));
    await expect(sync).toHaveText('1 conflicto · toca para resolver');
    await expect(sync).toHaveAttribute('aria-label', '1 conflicto · toca para resolver. Resolver');
    await sync.click();
    await expect(page.locator('.appmenu-drawer')).toHaveCount(0);
    expect(await log(page)).toContain('conflicts');
  });

  test('@smoke búsqueda en la cabecera: lupa en el móvil, caja con Ctrl K en el ordenador', async ({ page }, info) => {
    await page.goto('/#tokens');
    await mountMenu(page);
    const search = page.locator('#menuShell .appmenu-search');
    await expect(search).toHaveAttribute('aria-label', 'Buscar en Central…');
    const box = (await search.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(46);
    if (info.project.name === 'escritorio') {
      await expect(search.locator('.appmenu-searchkey')).toBeVisible();
      expect(box.width).toBeGreaterThan(200);
    } else {
      await expect(search.locator('.appmenu-searchtext')).toBeHidden();
    }
    await search.click();
    expect(await log(page)).toContain('search');
  });

  test('@smoke en el móvil, «sin red» y los conflictos se ven en la cabecera sin abrir el cajón', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'solo en el móvil');
    await page.goto('/#tokens');
    await mountMenu(page, { status: { conflicts: 1 } });
    const chip = page.locator('#menuShell .statuschip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-conflicts', 'true');
    await expect(chip).toHaveAttribute('aria-label', /1 conflicto/);
    expect((await chip.boundingBox())!.width).toBeLessThanOrEqual(30);
  });

  test('@smoke en el ordenador: columna fija del menú y la barra de pestañas abajo, horizontal', async ({ page }, info) => {
    test.skip(info.project.name !== 'escritorio', 'solo en el ordenador');
    await page.goto('/#tokens');
    await mountMenu(page, { column: true });
    const col = page.locator('#menuShell .appmenu-column');
    await expect(col).toBeVisible();
    const c = (await col.boundingBox())!;
    expect(Math.round(c.width)).toBe(316);
    expect(c.y).toBe(0);
    await expect(col.locator('.appmenu-close')).toHaveCount(0);
    const nav = (await page.locator('#menuShell nav.nav').boundingBox())!;
    expect(nav.y + nav.height).toBeGreaterThan(page.viewportSize()!.height - 2);
    expect(nav.x).toBeGreaterThanOrEqual(315);
    const tabs = await page.locator('#menuShell nav.nav .navbtn').evaluateAll((n) => n.map((x) => Math.round(x.getBoundingClientRect().top)));
    expect(new Set(tabs).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test('sin `menu`, `search` ni `navLayout`, la cáscara no cambia', async ({ page }) => {
    await page.goto('/#tokens');
    const html = await page.evaluate(() => {
      const root = document.createElement('div');
      document.body.prepend(root);
      (window as any).ikisaiKit.createAppShell(root, { appName: 'Prueba', backNavigation: false, nav: [{ hash: '#/a', label: 'Inicio', icon: 'home' }] });
      const shell = root.querySelector('.shell')!;
      return { cls: shell.className, kids: [...shell.children].map((n) => `${n.tagName}.${n.className}`), mark: !!root.querySelector('button.mark'), search: !!root.querySelector('.appmenu-search') };
    });
    expect(html).toEqual({ cls: 'shell', kids: ['HEADER.topbar', 'NAV.nav', 'DIV.'], mark: false, search: false });
  });
});
