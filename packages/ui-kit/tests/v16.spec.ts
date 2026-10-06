import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.13 · campo de color', () => {
  test('el personalizado abre con los tres degradados colocados sobre el color actual', async ({ page }) => {
    await page.goto('/#color');
    const host = page.locator('#colorHost');
    // #b3c43a no es una sugerencia: el personalizado abre solo y en ese color.
    await expect(host.locator('.cf-custom')).toBeVisible();
    const values = await host.evaluate((n) => ['h', 's', 'v'].map((c) => +(n.querySelector(`.cf-${c}`) as HTMLInputElement).value));
    expect(values[0]).toBeGreaterThan(60); expect(values[0]).toBeLessThan(75);
    expect(values[1]).toBeGreaterThan(65); expect(values[2]).toBeGreaterThan(70);
    await expect(host.locator('.cf-hex')).toHaveValue('#b3c43a');
    // Mover el brillo cambia el color y el degradado de saturación sigue al matiz.
    await host.locator('.cf-v').evaluate((n) => { (n as HTMLInputElement).value = '40'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect(page.locator('#colorOut')).not.toHaveText('#b3c43a');
    const track = await host.locator('.cf-s').evaluate((n) => (n as HTMLElement).style.getPropertyValue('--cf-track'));
    expect(track).toContain('linear-gradient');
    // Una sugerencia y «Sin color».
    await host.locator('.cf-swatch[data-color="#3f6d8e"]').click();
    await expect(page.locator('#colorOut')).toHaveText('#3f6d8e');
    await expect(host.locator('.cf-swatch[data-color="#3f6d8e"]')).toHaveAttribute('aria-checked', 'true');
    await host.locator('.cf-none').click();
    await expect(page.locator('#colorOut')).toHaveText('sin color');
    // Escribir el código.
    if (await host.locator('.cf-custom').isHidden()) await host.locator('.cf-more').click();
    await expect(host.locator('.cf-custom')).toBeVisible();
    await host.locator('.cf-hex').fill('#c87847');
    await expect(page.locator('#colorOut')).toHaveText('#c87847');
  });
});
