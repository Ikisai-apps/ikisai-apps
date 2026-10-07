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
});
