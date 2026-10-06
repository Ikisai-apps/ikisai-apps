import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.9', () => {
  test('el desglose de importes ordena, enlaza, compara con el presupuesto y pliega el resto', async ({ page }) => {
    await page.goto('/#money');
    const host = page.locator('#moneyHost .moneybreak');
    await expect(host.locator('.mb-total .mb-amount')).toHaveText('1230,05 €');
    await expect(host.locator('.mb-compare')).toContainText('de 1500,00 € presupuestados · 82 %');
    await expect(host.locator('.moneybar')).toHaveAttribute('aria-valuenow', '82');
    // Ordenadas de mayor a menor, cuatro visibles y «y 2 más».
    await expect(host.locator('.mb-line .mb-name')).toHaveText([/Alimentación/, /Energía/, /Limpieza/, /Lavandería/]);
    await expect(host.locator('.mb-more .linkbtn')).toHaveText('y 2 más');
    await host.locator('.mb-more .linkbtn').click();
    await expect(host.locator('.mb-line')).toHaveCount(6);
    // Enlace y acción al origen; participación proporcional.
    await expect(host.locator('.mb-line[data-line="food"] a.mb-open')).toHaveAttribute('href', '#money');
    await host.locator('.mb-line[data-line="energy"] button.mb-open').click();
    await expect(page.locator('.toast.show')).toContainText('Abrir energía');
    const share = await host.locator('.mb-line[data-line="food"] .mb-share span').evaluate((n) => (n as HTMLElement).style.width);
    expect(Math.round(parseFloat(share))).toBe(50);
    // Excedido y vacío.
    await expect(page.locator('#moneyOver .moneybreak')).toHaveClass(/over/);
    await expect(page.locator('#moneyOver .mb-compare')).toContainText('excede 500,00 € del importe final · 116 %');
    await expect(page.locator('#moneyEmpty .mb-empty')).toContainText('Invoices no ha asignado compras');
  });

  test('la estrella de urgencia es ámbar en los dos niveles y el relleno dice cuál; excedido en rojo sobre color', async ({ page }) => {
    await page.goto('/#projects');
    const cards = page.locator('#projectHost .card.project');
    const critical = cards.filter({ hasText: 'Edificio inferior' }).locator('.star');
    const high = cards.filter({ hasText: 'Cocina operativa' }).locator('.star');
    const [cColor, hColor] = await Promise.all([critical, high].map((l) => l.evaluate((n) => getComputedStyle(n).color)));
    expect(await high.locator('.star-fill').evaluate((n) => getComputedStyle(n).clipPath)).toContain('inset');
    expect(await critical.locator('.star-fill').evaluate((n) => getComputedStyle(n).clipPath)).toBe('none');
    // Ámbar en los dos niveles, también sobre la tarjeta con color propio.
    expect(hColor).toBe('rgb(197, 139, 42)');
    expect(cColor).toBe('rgb(197, 139, 42)');
    await expect(cards.filter({ hasText: 'Edificio inferior' }).locator('.moneytext .icon')).toHaveCount(1);
  });
});
