import { expect, test } from 'playwright/test';
import { setMode } from '../testing/feedback-smoke.ts';

/** Tanda 29, puntos 8 y 9: inventario en baldosas y los ayudantes de feedback con el menú lateral. */
test.describe('ui-kit v0.50 · baldosas del inventario y ayudantes con menú', () => {
  test('@smoke inventario en baldosas: cifra, relleno hasta el mínimo con el nivel escrito, abre la ficha y «Pedir» debajo', async ({ page }) => {
    await page.goto('/#inventory');
    const tiles = page.locator('#invTiles');
    const espelta = tiles.locator('.stk-tilecell[data-item-id="harina-espelta"]');
    await expect(espelta).toHaveClass(/low/);
    const tile = espelta.locator('.tile-box');
    await expect(tile).toHaveAttribute('data-tone', 'alert');
    await expect(tile.locator('.tile-level')).toHaveText('Bajo mínimo');
    await expect(tile.locator('.tile-min')).toHaveAttribute('style', 'bottom:50%');
    await expect(espelta.getByRole('button', { name: 'Pedir: Harina de espelta' })).toBeVisible();
    expect((await espelta.getByRole('button', { name: /Pedir/ }).boundingBox())!.height).toBeGreaterThanOrEqual(46);
    // Sin mínimo, sin relleno: el nivel dice dónde está.
    const yogur = tiles.locator('.stk-tilecell[data-item-id="yogur"] .tile-box');
    await expect(yogur.locator('.tile-level')).toHaveText('caduca mañana');
    // La lista de siempre no cambia.
    await expect(page.locator('#invCatalog .stk-row[data-item-id="harina-espelta"]')).toHaveCount(1);
    await expect(page.locator('#invCatalog .stk-tilecell')).toHaveCount(0);
    await tile.click();
    await expect(page.locator('#invSheetHost .stk-sheet')).toBeVisible();
  });

  test('@smoke P11: `setMode` enciende «Señalar para comentar» en el cajón aunque la columna repita los interruptores', async ({ page }, info) => {
    test.skip(info.project.name !== 'escritorio', 'la columna es del ordenador');
    await page.goto('/#tokens');
    await page.evaluate(() => { document.querySelector('#app')!.setAttribute('hidden', ''); scrollTo(0, 0); (window as any).ikisaiMenuDemo({ column: true }); });
    await expect(page.locator('.launcher-signal input')).toHaveCount(1);
    await page.locator('#appLauncher').click();
    await expect(page.locator('.launcher-signal input')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await setMode(page, '#appLauncher', true);
    expect(await page.evaluate(() => (window as any).menuLog)).toContain('signal:true');
    await expect(page.locator('.appmenu-drawer')).toHaveCount(0);
  });
  test('@smoke tanda 30: el no elegido de `.segmented` llega a 4,5:1 sobre crema y papel-2 y el botón mide 46 px', async ({ page }) => {
    await page.goto('/#proposals');
    const off = page.locator('#showMine');
    expect((await off.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    const ratios = await off.evaluate((b) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, bb]: number[]) => [r, g, bb].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const mix = (fg: number[], bg: number[]) => { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
      const ink = rgb(getComputedStyle(b).color);
      const group = rgb(getComputedStyle(b.parentElement!).backgroundColor);
      const css = getComputedStyle(document.documentElement);
      const tmp = document.createElement('i'); document.body.append(tmp);
      const out = ['--paper', '--paper-2', '--bg'].filter((v) => css.getPropertyValue(v).trim()).map((v) => {
        tmp.style.color = `var(${v})`; const base = rgb(getComputedStyle(tmp).color);
        const bg = mix(group, base); const [l1, l2] = [lum(ink), lum(bg)].sort((x, y) => y - x);
        return (l1 + 0.05) / (l2 + 0.05);
      });
      tmp.remove();
      return out;
    });
    expect(ratios.length).toBeGreaterThan(0);
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
  });
});
