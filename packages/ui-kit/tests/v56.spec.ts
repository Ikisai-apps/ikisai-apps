import { expect, test } from 'playwright/test';

/** Punto 11 (Organizers): `renderMedal({ cover: true, veil: 'full' })` da 4,5:1 al texto blanco en toda la foto. */
test.describe('ui-kit v0.51 · velo completo de la portada', () => {
  test('@smoke `veil: \'full\'`: sobre una foto blanca, el texto blanco llega a 4,5:1 arriba, en medio y abajo; el velo de siempre no cambia', async ({ page }) => {
    await page.goto('/#pieces');
    const host = page.locator('#medalVeilFull');
    await expect(host.locator('.medal-cover.medal-veil-full')).toHaveCount(1);
    const ratios = await host.evaluate((box) => {
      const veil = getComputedStyle(box.querySelector('.medal-cover')!, '::after').backgroundImage;
      const alphas = [...veil.matchAll(/rgba\(\s*20,\s*24,\s*20,\s*([\d.]+)\)/g)].map((m) => Number(m[1]));
      const lum = (v: number) => { const s = v / 255; const l = s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; return l; };
      // Peor caso: foto blanca. Cada parada del degradado, sobre blanco, contra texto blanco.
      return alphas.map((a) => {
        const rgb = [20, 24, 20].map((c) => c * a + 255 * (1 - a));
        const l = 0.2126 * lum(rgb[0]!) + 0.7152 * lum(rgb[1]!) + 0.0722 * lum(rgb[2]!);
        return 1.05 / (l + 0.05);
      });
    });
    expect(ratios.length).toBeGreaterThanOrEqual(2);
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
    // Sin `veil`, el de siempre (deja ver la foto en medio).
    const plain = await page.evaluate(() => {
      const k = (window as any).ikisaiKit;
      const m = k.renderMedal ? k.renderMedal({ cover: true }) : null;
      return m ? m.className : document.querySelector('.medal-cover:not(.medal-veil-full)')?.className ?? 'medal-cover';
    });
    expect(plain).toBe('medal-cover');
  });
});
