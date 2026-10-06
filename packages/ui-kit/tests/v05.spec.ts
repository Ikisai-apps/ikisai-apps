import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.4.1', () => {
  test('el aviso sube por encima de la hoja abierta y vuelve abajo al cerrarla', async ({ page }) => {
    await page.goto('/#overlays');
    await page.locator('#openSheet').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet).toBeVisible();
    await page.locator('#sheetToast').click();
    const toast = page.locator('.toast.show');
    await expect(toast).toHaveClass(/top/);
    const [toastBox, sheetBox] = await Promise.all([toast.boundingBox(), sheet.boundingBox()]);
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(sheetBox!.y + 1);
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
