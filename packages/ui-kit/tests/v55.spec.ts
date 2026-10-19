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
});
