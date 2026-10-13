import { expect, test } from 'playwright/test';
import { levelFill } from '../src/fields/level-star.ts';

test.describe('ui-kit v0.29 · estrella de nivel (createLevelStar)', () => {
  test('@smoke pulsar pasa al siguiente nivel y vuelve al primero; el relleno sigue al nivel', async ({ page }) => {
    await page.goto('/#levelstar');
    const star = page.locator('#levelStarHost button.level-star');
    await expect(star).toHaveAttribute('aria-label', /^Nivel en fontanería: Sabe\. Pulsa para cambiar/);
    await expect(star.locator('.level-star-label')).toHaveText('Sabe');
    await star.click();
    await expect(page.locator('#levelOut')).toHaveText('Experto');
    await expect(star).toHaveAttribute('data-level', '2');
    await star.click();
    await expect(page.locator('#levelOut')).toHaveText('Aprendiz');
    await expect(star.locator('.level-star-fill')).toHaveCSS('opacity', '0');
    await expect(page.locator('#levelStarHost [aria-live]')).toHaveText('Nivel en fontanería: Aprendiz');
  });

  test('teclado: flechas, Inicio y Fin; sin pasarse de los extremos', async ({ page }) => {
    await page.goto('/#levelstar');
    const star = page.locator('#levelStarBare button.level-star');
    await star.focus();
    await page.keyboard.press('ArrowDown');
    await expect(star).toHaveAttribute('data-level', '0');
    await page.keyboard.press('ArrowUp');
    await expect(star).toHaveAttribute('aria-label', /^Prioridad: Alta/);
    await page.keyboard.press('End');
    await expect(star).toHaveAttribute('data-level', '2');
    await page.keyboard.press('ArrowRight');
    await expect(star).toHaveAttribute('data-level', '2');
    await page.keyboard.press('Home');
    await expect(star).toHaveAttribute('data-level', '0');
    await page.keyboard.press('Enter');
    await expect(star).toHaveAttribute('data-level', '1');
  });

  test('objetivo táctil de al menos 44×44 y estrellas de solo lectura con nombre', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#levelstar');
    const box = (await page.locator('#levelStarBare button.level-star').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#levelStatic [role="img"]')).toHaveCount(3);
    await expect(page.getByRole('img', { name: 'Experto' })).toBeVisible();
  });

  test('relleno por pasos: 3 niveles = vacía, media, llena', () => {
    expect([0, 1, 2].map((v) => levelFill(v, 3))).toEqual([0, 0.5, 1]);
    expect(levelFill(3, 5)).toBe(0.75);
    expect(levelFill(0, 1)).toBe(1);
  });
});
