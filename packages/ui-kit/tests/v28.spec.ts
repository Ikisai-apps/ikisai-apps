import { expect, test, type Page } from 'playwright/test';

/** Simula el teclado virtual de Android: la vista visual se queda con `visible` px de alto. */
async function keyboard(page: Page, visible: number): Promise<void> {
  await page.evaluate((h) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  }, visible);
}

test.describe('ui-kit v0.22 · arreglos del QA del usuario en Android', () => {
  test('teclado @smoke: la hoja queda encima del teclado y el campo enfocado se ve, a 390×844', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#overlays');
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const fields = Array.from({ length: 14 }, (_, i) => kit.el('label', { class: 'field' }, kit.el('span', null, `Campo ${i + 1}`), kit.el('input', { id: i === 13 ? 'kbLast' : `kb${i}` })));
      kit.openSheet({ title: 'Persona', body: kit.el('div', null, ...fields) });
    });
    expect(await page.evaluate(() => document.querySelector('meta[name="viewport"]')!.getAttribute('content'))).toContain('interactive-widget=resizes-content');
    await keyboard(page, 544);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb').trim())).toBe('300px');
    // La hoja se apoya encima del teclado.
    // (tras la animación de entrada de la hoja)
    await expect.poll(() => page.evaluate(() => document.querySelector('.sheetback.show .sheet')!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(545);
    // El último campo, al enfocarlo, queda a la vista por encima del teclado.
    await page.locator('#kbLast').focus();
    await expect.poll(() => page.evaluate(() => document.querySelector('#kbLast')!.getBoundingClientRect().bottom), { timeout: 3000 }).toBeLessThanOrEqual(544);
    // Al cerrar el teclado todo vuelve a su sitio.
    await keyboard(page, 844);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb').trim())).toBe('0px');
  });

  test('el Revisor abre reportes de otra app aunque la app aún no tenga el catálogo', async ({ page }) => {
    await page.goto('/#feedback');
    const url = await page.evaluate(async () => {
      const w = window as any;
      localStorage.removeItem('ikisai-launcher-apps');
      let opened = '';
      const api = async (path: string) => {
        if (path === '/apps') return { items: [{ id: 'booking', domain: 'booking.ikisai.com' }] };
        if (path.startsWith('/feedback?review=true')) return { items: [] };
        throw Object.assign(new Error('no'), { status: 404 });
      };
      const review = w.ikisaiFeedback.createFeedbackReview({ api, app: 'central', storageKey: 'test-review-central', openUrl: (u: string) => { opened = u; } });
      await review.goTo({ code: 'FB_2026_0007', originApp: 'booking' });
      review.destroy();
      return opened;
    });
    expect(url).toBe('https://booking.ikisai.com/?fb=FB_2026_0007&qa=1');
  });

  test('el lanzador monta su hoja en el contenedor de la app (Tasks: #kitLayer)', async ({ page }) => {
    await page.goto('/#launcher');
    const inside = await page.evaluate(async () => {
      const w = window as any;
      const layer = document.createElement('div');
      layer.id = 'kitLayerTest';
      layer.className = 'ikisai-kit';
      document.body.appendChild(layer);
      const launcher = w.ikisaiFeedback.createAppLauncher({ fetchApps: async () => ({ items: [] }), container: () => layer });
      await launcher.open();
      return !!layer.querySelector('.sheetback .launcher');
    });
    expect(inside).toBe(true);
  });
});
