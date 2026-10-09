import { expect, test, type Page } from 'playwright/test';

const back = (page: Page) => page.evaluate(() => new Promise<void>((r) => { addEventListener('popstate', () => setTimeout(r, 80), { once: true }); history.back(); }));

test.describe('ui-kit v0.26 · triaje del 9-10 (FB_2026_012, 004, 025 y 011)', () => {
  test('FB_2026_012 @smoke: con el Revisor activo, su barra va encima de la navegación (5 entradas, 360×740) y se puede navegar', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/#feedback');
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const root = document.createElement('div');
      root.id = 'fullShell';
      document.body.prepend(root);
      (window as any).routed = '';
      kit.createAppShell(root, {
        appName: 'Prueba', backNavigation: false, navigate: (h: string) => { (window as any).routed = h; },
        nav: [{ hash: '#/a', label: 'Inicio', icon: 'home' }, { hash: '#/b', label: 'Reservas', icon: 'calendar' }, { hash: '#/c', label: 'Huéspedes', icon: 'people' }, { hash: '#/d', label: 'Espacios', icon: 'bed' }, { hash: '#/e', label: 'Más', icon: 'more' }],
      });
      (window as any).ikisaiFeedback.review.mode.set(true);
    });
    const nav = page.locator('#fullShell nav.nav');
    const review = page.locator('.fb-review');
    await expect(nav).toBeVisible();
    await expect(review).toBeVisible();
    const [n, r] = [await nav.boundingBox(), await review.boundingBox()];
    expect(r!.y + r!.height).toBeLessThanOrEqual(n!.y + 1);
    // La navegación recibe el toque.
    await nav.locator('.navbtn', { hasText: 'Huéspedes' }).click();
    expect(await page.evaluate(() => (window as any).routed)).toBe('#/c');
    await page.evaluate(() => (window as any).ikisaiFeedback.review.mode.set(false));
  });

  test('FB_2026_004: el interruptor del Revisor se ve en oscuro y vuelve tras un fallo pasajero', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/#launcher');
    await page.locator('#demoLauncher').click();
    const sw = page.locator('.launcher-review input');
    await expect(sw).toBeVisible();
    const contrast = await sw.evaluate((node) => {
      const lum = (c: string) => { const [r, g, b] = (c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
      const border = getComputedStyle(node).borderTopColor;
      const paper = getComputedStyle(node.closest('.sheet')!).backgroundColor;
      const [a, b] = [lum(border), lum(paper)].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    });
    expect(contrast).toBeGreaterThan(3);
    await page.keyboard.press('Escape');
    const states = await page.evaluate(async () => {
      let calls = 0;
      const api = async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('sin red'), { status: 0 }); return { items: [] }; };
      const r = (window as any).ikisaiKit.createFeedbackReview({ api, app: 'demo', storageKey: 'test-review-avail' });
      const first = await r.available();
      const second = await r.available();
      r.destroy();
      return [first, second];
    });
    expect(states).toEqual([false, true]);
  });

  test('FB_2026_025 @smoke: «atrás» vuelve a la anterior, cierra hojas y diálogos, y en el inicio pregunta antes de salir', async ({ page }) => {
    await page.goto('/#/');
    await page.evaluate(() => (window as any).ikisaiKit.installBackNavigation());
    await page.evaluate(() => { location.hash = '#/reservas'; });
    await page.evaluate(() => { location.hash = '#/reservas/ficha'; });
    // Una hoja abierta: «atrás» la cierra sin navegar.
    await page.evaluate(() => { const kit = (window as any).ikisaiKit; kit.openSheet({ title: 'Ficha', body: kit.el('p', null, 'x') }); });
    await expect(page.locator('.sheetback.show')).toHaveCount(1);
    await back(page);
    await expect(page.locator('.sheetback.show')).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('#/reservas/ficha');
    // Pantalla anterior, y luego el inicio.
    await back(page);
    expect(new URL(page.url()).hash).toBe('#/reservas');
    await back(page);
    expect(new URL(page.url()).hash).toBe('#/');
    // En el inicio: «¿Cerrar la app?». Cancelar se queda; otra vez «atrás», otra vez la pregunta.
    await back(page);
    const dialog = page.locator('.dialog');
    await expect(dialog).toContainText('¿Cerrar la app?');
    await page.locator('#dialogCancel').click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(new URL(page.url()).hash).toBe('#/');
    await back(page);
    await expect(dialog).toContainText('¿Cerrar la app?');
    // «Atrás» con el diálogo abierto lo cierra (como Cancelar).
    await back(page);
    await expect(dialog).toHaveCount(0);
  });

  test('FB_2026_025: entrando directamente a una pantalla, «atrás» lleva al inicio', async ({ page }) => {
    await page.goto('/#/espacios/nuevo');
    await page.evaluate(() => (window as any).ikisaiKit.installBackNavigation());
    expect(new URL(page.url()).hash).toBe('#/espacios/nuevo');
    await back(page);
    expect(new URL(page.url()).hash).toBe('#/');
    await back(page);
    await expect(page.locator('.dialog')).toContainText('¿Cerrar la app?');
  });

  test('FB_2026_025: «atrás» con el composer abierto lo cierra y guarda el borrador', async ({ page }) => {
    await page.goto('/#feedback');
    await page.evaluate(async () => { const w = window as any; await w.ikisaiFeedback.feedback.clear('demo-user'); w.ikisaiKit.installBackNavigation({ home: '#feedback' }); });
    await page.locator('#fbOpen').click();
    await page.locator('.fb-composer .fb-message').fill('A medias');
    await back(page);
    await expect(page.locator('.fb-composer')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).ikisaiFeedback.feedback.drafts().then((d: unknown[]) => d.length))).toBe(1);
  });

  test('FB_2026_011: la categoría «Idea» se llama «Duda» (valor interno `idea`)', async ({ page }) => {
    await page.goto('/#feedback');
    await page.locator('#fbOpen').click();
    await expect(page.locator('.fb-composer [data-intent="idea"]')).toHaveText('Duda');
    await expect(page.locator('.fb-composer .fb-intents')).not.toContainText('Idea');
  });
});
