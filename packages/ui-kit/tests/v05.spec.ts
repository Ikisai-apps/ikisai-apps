import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.4.1', () => {
  test('el aviso se coloca bajo la cabecera de la hoja abierta y vuelve abajo al cerrarla', async ({ page }) => {
    await page.goto('/#overlays');
    await page.locator('#openSheet').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet).toBeVisible();
    await page.locator('#sheetToast').click();
    const toast = page.locator('.toast.show');
    await expect(toast).toHaveClass(/top/);
    // Desde 0.7.2 va justo bajo la cabecera de la hoja (dentro de ella), sin tapar el título ni el cierre.
    const [toastBox, sheetBox, headBox] = await Promise.all([toast.boundingBox(), sheet.boundingBox(), page.locator('.sheetback.show .sheet-head').boundingBox()]);
    expect(toastBox!.y).toBeGreaterThanOrEqual(headBox!.y + headBox!.height);
    expect(toastBox!.y).toBeLessThan(sheetBox!.y + sheetBox!.height);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheetback')).toHaveCount(0);
    await page.locator('#openAlert').click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    await page.goto('/#status');
    await page.getByRole('button', { name: 'Toast', exact: true }).click();
    await expect(page.locator('.toast.show')).not.toHaveClass(/top/);
  });
});
