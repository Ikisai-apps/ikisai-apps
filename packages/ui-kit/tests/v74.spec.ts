import { expect, test } from 'playwright/test';

/** Encargo de Core (27-10): «Trabajos de hoy» compuesto solo con piezas (carriles, agrupar, proyección y Guiado). */
test.describe('ui-kit v0.69.1 · Trabajos de hoy (composición en la muestra)', () => {
  test('@smoke por persona, oficio o espacio; «Hecha» la quita al releer; cada tarjeta abre la tarea con el Guiado; sin scroll lateral', async ({ page }) => {
    await page.goto('/');
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    await page.evaluate(() => { try { localStorage.setItem('ikisai-lanes:demo-hoy', 'tabs'); } catch { /* */ } });
    await page.reload();
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    const host = page.locator('#todayHost');
    await host.scrollIntoViewIfNeeded();
    // Por persona: Ana, Luis, Marta y «Sin asignar» (Barrer el porche ya está hecha y no sale).
    await expect(host.getByRole('tab')).toHaveCount(4);
    await expect(host).toContainText('Revisar la ducha 3');
    await expect(page.locator('#todayCounts')).toContainText('Ana: 2');
    // Cada tarjeta abre la tarea en Tasks con su guía y la vuelta a Trabajos de hoy.
    const href = await host.locator('.proj-row[data-row="t1"] a.proj-title').getAttribute('href');
    expect(href).toMatch(/^https:\/\/tasks\.ikisai\.com\/#\/t\/t1\?desde=flow&volver=.*&titulo=Trabajos\+de\+hoy&guia=hoy_t1$/);
    // «Hecha»: se invoca la capacidad y, al releer, la tarea deja de estar.
    await host.getByRole('button', { name: 'Hecha: Revisar la ducha 3' }).click();
    await expect(host.locator('.proj-row[data-row="t1"]')).toHaveCount(0);
    await expect(page.locator('#todayCounts')).toContainText('Ana: 1');
    // Por oficio: los fijos en su orden.
    await page.locator('#todayPick [data-by="trade"]').click();
    await expect(page.locator('#todayPick [data-by="trade"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(host).toContainText('Mantenimiento');
    await page.locator('#todayPick [data-by="place"]').click();
    await expect(host).toContainText('Piscina');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
});
