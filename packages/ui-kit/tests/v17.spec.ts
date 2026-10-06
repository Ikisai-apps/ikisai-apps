import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.14 · lanzador de apps', () => {
  test('abre la hoja con las apps del catálogo, marca la actual y guarda la lista para usarla sin red', async ({ page }) => {
    await page.goto('/#launcher');
    await page.evaluate(() => { try { localStorage.removeItem('demo-launcher'); } catch { /* */ } });
    const mark = page.locator('#demoLauncher');
    await expect(mark).toHaveAttribute('aria-haspopup', 'dialog');
    await mark.click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet.locator('.launcher-app')).toHaveCount(5);
    // Internas arriba, portales debajo con su título.
    await expect(sheet.locator('.launcher-list').first().locator('.launcher-app')).toHaveCount(4);
    await expect(sheet.locator('.launcher-group')).toHaveText('Portales');
    // La actual no es enlace; las demás abren su dominio principal en la misma pestaña.
    const current = sheet.locator('.launcher-app.current');
    await expect(current).toHaveAttribute('data-app', 'tasks');
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current.locator('.chip')).toHaveText('Aquí');
    const finance = sheet.locator('a.launcher-app[data-app="invoices"]');
    await expect(finance).toHaveAttribute('href', 'https://finance.ikisai.com/');
    expect(await finance.getAttribute('target')).toBeNull();
    await expect(finance).toContainText('Solo lectura');
    await page.keyboard.press('Escape');
    // Sin red: la última lista guardada, con aviso.
    await page.locator('#launcherOffline').check();
    await mark.click();
    await expect(page.locator('.sheetback.show .launcher-note')).toContainText('última lista guardada');
    await expect(page.locator('.sheetback.show .launcher-app')).toHaveCount(5);
    await page.keyboard.press('Escape');
    // Sin red y sin lista guardada.
    await page.locator('#launcherForget').click();
    await mark.click();
    await expect(page.locator('.sheetback.show .launcher-note')).toContainText('sin lista guardada');
    await expect(page.locator('.sheetback.show .launcher-app')).toHaveCount(0);
  });
});
