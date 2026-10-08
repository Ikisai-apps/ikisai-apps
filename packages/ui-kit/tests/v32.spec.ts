import { expect, test } from 'playwright/test';

/** Fallo del usuario (Tasks en Android): «Me bloquea» del composer con el texto montado por la `.check` de Tasks. */
test.describe('ui-kit v0.25.4 · casillas del kit frente a una `.check` de la app', () => {
  for (const legacy of [false, true]) {
    test(`«Me bloquea» se lee en una línea, a 390 px ${legacy ? 'con la `.check` heredada de Tasks' : 'en una app normal'}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/#feedback');
      if (legacy) {
        await page.evaluate(() => {
          const s = document.createElement('style');
          // Las dos reglas de Tasks (index.html y taller.css).
          s.textContent = '.check{margin:0;width:38px;min-width:38px;height:44px;border:0;border-radius:0;background:transparent!important;position:relative;font-size:17px;color:#46513b!important;z-index:1}.check:before{content:"";position:absolute;left:9px;top:12px;width:19px;height:19px;border:1.6px solid #9c998a;border-radius:5px;z-index:-1}';
          document.head.appendChild(s);
        });
      }
      await page.locator('#fbOpen').click();
      const row = page.locator('.fb-composer .fb-blocking');
      await expect(row).toBeVisible();
      const m = await row.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const text = node.querySelector('span')!.getBoundingClientRect();
        const box = node.querySelector('input')!.getBoundingClientRect();
        return { w: r.width, textH: text.height, textW: text.width, overlap: text.left < box.right - 1, before: getComputedStyle(node, '::before').content };
      });
      expect(m.w).toBeGreaterThan(200);
      expect(m.textH).toBeLessThan(30);
      expect(m.overlap).toBe(false);
      expect(['none', 'normal']).toContain(m.before);
    });
  }
});
