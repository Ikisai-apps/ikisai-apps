import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.18.4 · ganchos que pide Food', () => {
  test('renderConflicts({ feedbackId }) marca la tarjeta y sus botones, también tras «Combinar campo a campo»', async ({ page }) => {
    await page.goto('/#conflicts');
    const card = page.locator('#conflictHost [data-request-id="req-1"]');
    await expect(card).toHaveAttribute('data-feedback-id', 'demo.conflicto');
    await expect(card.locator('[data-choice="mine"]')).toHaveAttribute('data-feedback-id', 'demo.conflicto.mantener_mia');
    await expect(card.locator('[data-choice="theirs"]')).toHaveAttribute('data-feedback-id', 'demo.conflicto.tomar_servidor');
    await card.locator('[data-choice="merge"]').click();
    await expect(card.locator('[data-choice="save-merge"]')).toHaveAttribute('data-feedback-id', 'demo.conflicto.guardar_combinacion');
    await expect(card.locator('[data-choice="back"]')).toHaveAttribute('data-feedback-label', 'Volver');
    await card.locator('[data-choice="back"]').click();
    await expect(card.locator('[data-choice="merge"]')).toHaveAttribute('data-feedback-id', 'demo.conflicto.combinar');
  });

  test('createPrintView({ onPrint }) avisa al imprimir', async ({ page }) => {
    await page.goto('/#print');
    await page.evaluate(() => { window.print = () => undefined; });
    await page.locator('#printPage').click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.printCount)).toBe('1');
  });
});
