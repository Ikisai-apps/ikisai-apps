import { expect, test, type Page } from 'playwright/test';

/** Mide el aviso visible: alto y ancho en px. */
async function toastBox(page: Page): Promise<{ w: number; h: number; inLayer: boolean }> {
  await expect(page.locator('.toast.show')).toBeVisible();
  return page.evaluate(() => {
    const t = document.querySelector('.toast.show') as HTMLElement;
    const r = t.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), inLayer: !!t.closest('#testKitLayer') };
  });
}

for (const size of [{ name: 'escritorio 1280×800', width: 1280, height: 800 }, { name: 'móvil 390×844', width: 390, height: 844 }]) {
  test.describe(`ui-kit v0.24 · avisos con su tamaño (${size.name})`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: size.width, height: size.height }); });

    test('app normal @smoke: «Enviado · FB_…» con una hoja abierta tiene su tamaño', async ({ page }) => {
      await page.goto('/#overlays');
      await page.evaluate(() => {
        const kit = (window as any).ikisaiKit;
        kit.openSheet({ title: 'Regla nueva', body: kit.el('p', null, 'Contenido') });
        kit.toast('Enviado · FB_2026_015');
      });
      const box = await toastBox(page);
      expect(box.h).toBeLessThan(80);
      expect(box.w).toBeLessThanOrEqual(520);
    });

    test('app con CSS heredado y capa del kit (como Tasks): el aviso no se estira', async ({ page }) => {
      await page.goto('/#overlays');
      await page.evaluate(() => {
        const kit = (window as any).ikisaiKit;
        // La regla heredada de Tasks (index.html) que, con el `top` en línea del kit, estiraba el aviso en columna.
        const legacy = document.createElement('style');
        legacy.textContent = '.toast{position:fixed;z-index:100;left:50%;bottom:85px;transform:translateX(-50%);background:#2f382f;color:#fff;padding:10px 14px;border-radius:14px}';
        document.head.appendChild(legacy);
        const layer = document.createElement('div');
        layer.id = 'testKitLayer';
        layer.className = 'ikisai-kit';
        document.body.appendChild(layer);
        kit.setKitLayer(() => layer);
        kit.openSheet({ title: 'Regla nueva', body: kit.el('p', null, 'Contenido') });
        kit.toast('Enviado · FB_2026_015');
      });
      const box = await toastBox(page);
      expect(box.inLayer).toBe(true);
      expect(box.h).toBeLessThan(80);
      // La hoja también va a la capa global.
      expect(await page.evaluate(() => !!document.querySelector('#testKitLayer .sheetback.show'))).toBe(true);
      await page.evaluate(() => (window as any).ikisaiKit.setKitLayer(null));
    });
  });
}
