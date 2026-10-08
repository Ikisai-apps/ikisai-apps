import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.18 · «Sugerencias y QA» en el panel del lanzador', () => {
  test('la entrada abre el centro y cierra el lanzador; los interruptores siguen debajo', async ({ page }) => {
    await page.goto('/#launcher');
    await page.evaluate(() => (window as any).ikisaiFeedback.review.mode.set(false));
    await page.locator('#demoLauncher').click();
    const entry = page.locator('.launcher-center');
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('Sugerencias y QA');
    // Orden: entrada, «Señalar para comentar» y, para el dueño, «Revisor de QA» (el revisor se pasa tal cual).
    await expect(page.locator('.launcher-review')).toBeVisible();
    const order = await page.evaluate(() => [...document.querySelectorAll('.launcher-center, .launcher-signal, .launcher-review')].map((n) => n.classList[1]));
    expect(order).toEqual(['launcher-center', 'launcher-signal', 'launcher-review']);
    // Cabe a 390 px sin desbordar.
    const overflow = await page.evaluate(() => { const b = document.querySelector('.launcher-center')!.getBoundingClientRect(); return b.right <= innerWidth + 1; });
    expect(overflow).toBe(true);
    await entry.click();
    await expect(page.locator('.launcher')).toHaveCount(0);
    await expect(page.locator('.fb-center .fb-tabs')).toBeVisible();
  });

  test('el centro se monta en el contenedor de la app y las reglas de <html> van en una hoja global propia', async ({ page }) => {
    await page.goto('/#feedback');
    const inLayer = await page.evaluate(async () => {
      const kit = (window as any).ikisaiFeedback;
      const layer = document.createElement('div');
      layer.id = 'appKitLayer';
      layer.className = 'ikisai-kit';
      document.body.appendChild(layer);
      kit.openFeedbackCenter({ api: async () => ({ nodes: [] }), app: 'demo', container: () => layer });
      return !!layer.querySelector('.sheetback .fb-center');
    });
    expect(inLayer).toBe(true);
    const global = await page.evaluate(() => document.getElementById('ikisai-kit-feedback-global')?.textContent ?? '');
    expect(global).toContain('html.fb-mode #appLauncher::after');
    expect(global).toContain('html.fb-pressing');
    await expect(page.locator('#appKitLayer [data-fb-tab="map"]')).toBeVisible();
  });

  test('centerLabel: los portales llaman a la entrada «Ayuda y sugerencias»', async ({ page }) => {
    await page.goto('/#launcher');
    await page.evaluate(() => {
      const w = window as any;
      const launcher = w.ikisaiFeedback.createAppLauncher({ fetchApps: async () => ({ items: [] }), center: () => undefined, centerLabel: 'Ayuda y sugerencias' });
      void launcher.open();
    });
    await expect(page.locator('.launcher-center strong')).toHaveText('Ayuda y sugerencias');
    await expect(page.locator('.launcher-center small')).toContainText('qué falla');
  });

  test('con el Revisor activo, su barra no tapa el interruptor del lanzador (fallo del usuario, 390×844)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#launcher');
    await page.evaluate(() => (window as any).ikisaiFeedback.review.mode.set(true));
    await expect(page.locator('.fb-review')).toBeVisible();
    await page.locator('#demoLauncher').click();
    // Con la hoja abierta, la barra del Revisor se aparta.
    await expect(page.locator('.fb-review')).toBeHidden();
    const toggle = page.locator('.launcher-review');
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeInViewport();
    // Lo que hay en el centro del interruptor es el propio interruptor (nada encima).
    const onTop = await toggle.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && node.contains(hit);
    });
    expect(onTop).toBe(true);
    await toggle.click();
    await expect(page.locator('.launcher-review input')).not.toBeChecked();
    expect(await page.evaluate(() => (window as any).ikisaiFeedback.review.mode.get())).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('.fb-review')).toHaveCount(0);
  });
});
