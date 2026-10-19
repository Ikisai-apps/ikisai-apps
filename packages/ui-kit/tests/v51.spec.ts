import { expect, test } from 'playwright/test';

/** Tanda 27, lote C (MUELA-075 K20, K15, K16): bandeja por áreas y conflictos en bandeja. */
test.describe('ui-kit v0.46 · bandeja', () => {
  test('@smoke conflictos en bandeja: áreas con recuento, lo que choca escrito y dos botones al mismo nivel', async ({ page }) => {
    await page.goto('/#piecesc');
    const tray = page.locator('#conflictTrayHost .tray-box');
    await expect(tray.locator('.tray-areahead')).toHaveText([/Reservas\s*1/, /Dinero\s*2/]);
    await expect(tray.locator('.tray-count').nth(1)).toHaveAttribute('aria-label', '2 por resolver');
    const sierra = tray.locator('.tray-row[data-request-id="req-1"]');
    await expect(sierra.locator('.tray-title')).toHaveText('Ferretería Sierra');
    await expect(sierra.locator('.tray-who')).toContainText('Lo cambió Laura.');
    await expect(sierra.locator('.tray-clash')).toHaveText('Notas: «Pedir siempre con albarán.» frente a «Horario de tarde.»');
    const mine = sierra.locator('[data-choice="mine"]');
    const theirs = sierra.locator('[data-choice="theirs"]');
    await expect(mine).toHaveText('Lo mío');
    await expect(theirs).toHaveText('Lo de Laura');
    // Al mismo nivel: ninguno es el principal.
    await expect(sierra.locator('.tray-actions .primary')).toHaveCount(0);
    await expect(mine).toHaveAttribute('data-feedback-id', 'demo.pendientes.conflicto.mantener_mia');
    expect((await mine.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    // Un borrado se decide con «Borrar» o «Conservar».
    const del = tray.locator('.tray-row[data-request-id="req-2"]');
    await expect(del.locator('[data-choice="mine"]')).toHaveText('Borrar');
    await expect(del.locator('[data-choice="theirs"]')).toHaveText('Conservar');
    await expect(del.locator('[data-choice="both"]')).toHaveCount(0);
  });

  test('@smoke «Deshacer» antes de enviar, y la decisión llega cuando pasa el tiempo', async ({ page }) => {
    await page.goto('/#piecesc');
    await page.clock.install();
    await page.reload();
    const row = page.locator('#conflictTrayHost .tray-row[data-request-id="req-1"]');
    await row.locator('[data-choice="theirs"]').click();
    await expect(row.locator('.tray-decision')).toContainText('Elegido: Lo de Laura');
    await expect(row.locator('[data-choice="mine"]')).toBeDisabled();
    await expect(page.locator('#trayResolved')).toHaveText('—');
    await row.getByRole('button', { name: 'Deshacer' }).click();
    await expect(row.locator('.tray-decision')).toHaveCount(0);
    await expect(row.locator('[data-choice="mine"]')).toBeEnabled();
    await page.clock.runFor(5000);
    await expect(page.locator('#trayResolved')).toHaveText('—');
    await row.locator('[data-choice="mine"]').click();
    await page.clock.runFor(4100);
    await expect(page.locator('#trayResolved')).toHaveText('req-1:mine');
  });

  test('@smoke «Los dos» en listas une las dos sin repetir; «Ver diferencias» abre la tarjeta de siempre', async ({ page }) => {
    await page.goto('/#piecesc');
    await page.clock.install();
    await page.reload();
    const row = page.locator('#conflictTrayHost .tray-row[data-request-id="req-6"]');
    await expect(row.locator('.tray-clash')).toHaveText('Dietas: «vegana, sin gluten» frente a «vegana, sin lactosa»');
    await row.locator('[data-choice="both"]').click();
    await page.clock.runFor(4100);
    await expect(page.locator('#trayResolved')).toHaveText('req-6:merge=["vegana","sin gluten","sin lactosa"]');
    const sierra = page.locator('#conflictTrayHost .tray-row[data-request-id="req-1"]');
    await sierra.locator('[data-choice="diff"]').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet.locator('.conflict[data-request-id="req-1"]')).toBeVisible();
    await expect(sheet.locator('[data-choice="merge"]')).toBeVisible();
    await sheet.locator('[data-choice="theirs"]').click();
    await expect(page.locator('.sheetback.show')).toHaveCount(0);
    await expect(page.locator('#trayResolved')).toHaveText(/req-1:theirs/);
  });

  test('bandeja genérica: por estado, chips, acciones y la línea rechazada con su icono', async ({ page }) => {
    await page.goto('/#piecesc');
    const ses = page.locator('#sesTrayHost');
    await expect(ses.locator('.tray-arealabel')).toHaveText(['Por enviar', 'Rechazados']);
    await expect(ses.locator('.tray-row').first().locator('.chip')).toHaveText('Vence hoy');
    await expect(ses.locator('[data-action="send"]')).toHaveClass(/primary/);
    const rej = ses.locator('.tray-rejected');
    await expect(rej.locator('.tray-rejicon')).toBeVisible();
    await expect(rej.locator('.tray-title')).toHaveText('Rechazado: Luis Pérez · 18 oct');
    await ses.locator('.tray-areahead').first().click();
    await expect(ses.locator('.tray-row').first()).toBeHidden();
  });

  test('sin `layout`, los conflictos se pintan como siempre (tarjetas)', async ({ page }) => {
    await page.goto('/#conflicts');
    await expect(page.locator('#conflictHost .conflict').first()).toBeVisible();
    await expect(page.locator('#conflictHost .tray-box')).toHaveCount(0);
  });

  test('la página no se sale de lado en el móvil', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'solo en móvil');
    await page.goto('/#piecesc');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});
