import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.7', () => {
  test('el selector de etiquetas conmuta, respeta familias únicas, busca sin acentos y crea en línea', async ({ page }) => {
    await page.goto('/#labels');
    const host = page.locator('#labelHost');
    await expect(host.locator('.lp-summary .chip')).toHaveCount(2);
    await expect(host.locator('.lp-family')).toHaveCount(4);
    // Familias con selección abiertas; sin selección, plegadas (hay más de 3).
    await expect(host.locator('.lp-family[data-family="trade"]')).toHaveAttribute('open', '');
    expect(await host.locator('.lp-family[data-family="person"]').getAttribute('open')).toBeNull();
    // Conmutar desde el chip de familia y quitar desde el resumen.
    await host.locator('.lp-family[data-family="trade"] .lp-chip[data-label="font"]').click();
    await expect(page.locator('#labelOut')).toHaveText('carp, centro, font');
    await host.locator('.lp-summary [data-label="carp"] .x').click();
    await expect(page.locator('#labelOut')).toHaveText('centro, font');
    // Familia única: elegir Mejora quita Apertura.
    await host.locator('.lp-family[data-family="phase"] summary').click();
    await host.locator('.lp-chip[data-label="apertura"]').click();
    await host.locator('.lp-chip[data-label="mejora"]').click();
    await expect(page.locator('#labelOut')).toHaveText('centro, font, mejora');
    // Hijas sangradas bajo su padre.
    await expect(host.locator('.lp-chip.child[data-label="cocina"]')).toBeVisible();
    // Búsqueda sin acentos y alta en línea en la familia Oficio.
    await host.locator('.lp-search').fill('electri');
    await expect(host.locator('.lp-chip:visible')).toHaveCount(1);
    await host.locator('.lp-search').fill('Pintura');
    await host.locator('[data-create-in="trade"]').click();
    await expect(page.locator('#labelOut')).toHaveText('centro, font, mejora, new-1');
    await expect(host.locator('.lp-summary [data-label="new-1"]')).toContainText('Pintura');
    // Food: vocabularios fijos sin búsqueda, todo abierto.
    const food = page.locator('#foodLabelHost');
    await expect(food.locator('.lp-search')).toHaveCount(0);
    await expect(food.locator('.lp-family[data-family="allergen"] .lp-chip')).toHaveCount(14);
    await expect(food.locator('.lp-summary .chip')).toHaveCount(2);
  });

  test('la tarjeta de proyecto muestra anillo, pin, urgencia, presupuesto y color propio', async ({ page }) => {
    await page.goto('/#projects');
    const cards = page.locator('#projectHost .card.project');
    await expect(cards).toHaveCount(4);
    const p1 = cards.filter({ hasText: 'Edificio inferior' });
    await expect(p1).toHaveClass(/colored/);
    await expect(p1.locator('.ring text')).toHaveText('40%');
    await expect(p1.locator('.star-critical')).toHaveCount(1);
    await expect(p1.locator('.money')).toContainText('de 3000');
    await expect(p1.locator('.pinbtn')).toHaveAttribute('aria-pressed', 'true');
    await p1.locator('.pinbtn').click();
    await expect(page.locator('#projectHost .card.project').filter({ hasText: 'Edificio inferior' }).locator('.pinbtn')).toHaveAttribute('aria-pressed', 'false');
    const p2 = cards.filter({ hasText: 'Cocina operativa' });
    await expect(p2.locator('.money')).toHaveClass(/over/);
    await expect(cards.filter({ hasText: 'Piscina' }).locator('.projectpending')).toBeVisible();
    const inbox = cards.filter({ hasText: 'Entrada' });
    await expect(inbox).toHaveClass(/system/);
    await expect(inbox.locator('.pinbtn')).toHaveCount(0);
    await p1.locator('.projectopen').click();
    await expect(page.locator('.toast.show')).toContainText('Abrir Edificio inferior');
    const ink = await p1.evaluate((node) => getComputedStyle(node).getPropertyValue('--item-ink').trim());
    expect(ink).toBe('#ffffff');
  });
});
