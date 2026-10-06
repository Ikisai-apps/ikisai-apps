import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.2', () => {
  test('la hoja atrapa el foco, cierra con Escape y pide confirmación con cambios', async ({ page }) => {
    await page.goto('/#overlays');
    await page.locator('#openSheet').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#sheetName')).toBeFocused();
    await expect(page.locator('.sheet-foot')).toBeHidden();
    // Tab recorre solo la hoja: desde el último control vuelve al primero.
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.sheet'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheetback')).toHaveCount(0);
    await expect(page.locator('#openSheet')).toBeFocused();
    // Con cambios, Escape abre el diálogo; cancelar mantiene la hoja; descartar la cierra.
    await page.locator('#openSheet').click();
    await page.locator('#sheetName').fill('Otro nombre');
    await expect(page.locator('.sheet-foot')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialogback .dialog')).toBeVisible();
    await expect(page.locator('#dialogCancel')).toBeFocused();
    await page.locator('#dialogCancel').click();
    await expect(page.locator('.sheetback.show .sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.sheetback')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('el diálogo de confirmación resuelve por botón, Escape y fondo', async ({ page }) => {
    await page.goto('/#overlays');
    await page.locator('#openDialog').click();
    await expect(page.locator('.dialog[role="alertdialog"]')).toBeVisible();
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Enviado a papelera');
    await page.locator('#openDialog').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialogback')).toHaveCount(0);
    await expect(page.locator('#openDialog')).toBeFocused();
    await page.locator('#openAlert').click();
    await expect(page.locator('#dialogConfirm')).toHaveText('Entendido');
    await expect(page.locator('#dialogCancel')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('.dialogback')).toHaveCount(0);
  });

  test('el conflicto muestra ambas versiones y combina campo a campo', async ({ page }) => {
    await page.goto('/#conflicts');
    const card = page.locator('#conflictHost [data-request-id="req-1"]');
    await expect(card.locator('tr.overlap th')).toHaveText('Notas');
    await expect(card.locator('tbody tr')).toHaveCount(3);
    await card.locator('[data-choice="merge"]').click();
    await card.locator('input[name="pick-req-1-notes"][value="theirs"]').check();
    await card.locator('[data-choice="save-merge"]').click();
    await expect(page.locator('.toast.show')).toContainText('merge {"name":"Ferretería Sierra S.L."}');
    await expect(card).toHaveCount(0);
    const del = page.locator('#conflictHost [data-request-id="req-2"]');
    await expect(del.locator('h3')).toContainText('Querías borrar');
    await expect(del.locator('[data-choice="merge"]')).toHaveCount(0);
    await del.locator('[data-choice="theirs"]').click();
    await expect(page.locator('.toast.show')).toContainText('req-2: theirs');
    const rejected = page.locator('#rejectedHost [data-request-id="req-3"]');
    await expect(rejected).toContainText('editar «Maderas del Valle»');
    await expect(rejected.locator('code')).toHaveText('INVALID_VALUE');
    await rejected.locator('[data-choice="discard"]').click();
    await expect(page.locator('#rejectedHost .empty')).toContainText('Nada rechazado');
  });

  test('la lista marca pendientes, papelera y filas pulsables', async ({ page }) => {
    await page.goto('/#list');
    const list = page.locator('#demoList');
    await expect(list.locator('.row')).toHaveCount(3);
    await expect(list.locator('.row[data-id="b"]')).toHaveAttribute('data-pending', 'true');
    await expect(list.locator('.row[data-id="b"] .chip.pending')).toContainText('Pendiente de sincronizar');
    await expect(list.locator('.row[data-id="c"]')).toHaveClass(/deleted/);
    await list.locator('.row[data-id="a"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast.show')).toContainText('Abrir Ferretería Sierra');
    await list.locator('.row[data-id="a"] .iconbtn').click();
    await expect(page.locator('.toast.show')).toContainText('Abrir Ferretería Sierra');
  });

  test('la barra avisa de rechazados y del cambio de persona', async ({ page }) => {
    await page.goto('/#status');
    const states = page.locator('#statusStates .statuschip');
    await expect(states).toHaveCount(7);
    await expect(states.nth(5)).toHaveAttribute('data-rejected', 'true');
    await expect(states.nth(5)).toHaveAttribute('aria-label', 'En línea · Todo sincronizado · 2 rechazados');
    await page.locator('[data-state="online"]', { hasText: 'Rechazados' }).click();
    const banner = page.locator('#bannerStates [data-banner="rejected"]');
    await expect(banner).toContainText('rechazó 2 cambios');
    await banner.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.locator('.toast.show')).toContainText('Reintentar rechazados');
    await page.locator('[data-state="online"]', { hasText: 'Cambio de persona' }).click();
    await expect(page.locator('#bannerStates [data-banner="user-changed"]')).toContainText('otra persona');
    await expect(page.locator('#bannerStates [data-banner="error"]')).toHaveCount(0);
  });

  test('selector de tema y paleta Ctrl K', async ({ page }) => {
    await page.goto('/#theme');
    await page.locator('.themeselect [data-theme="dark"]').click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await expect(page.locator('.themeselect [data-theme="dark"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#theme .themetoggle')).toHaveAttribute('aria-label', 'Cambiar a tema claro');
    await page.locator('.themeselect [data-theme="system"]').click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
    await page.keyboard.press('Control+k');
    await expect(page.locator('#paletteInput')).toBeFocused();
    await expect(page.locator('#paletteList .palette-group', { hasText: 'Proveedores' })).toHaveCount(0);
    await page.keyboard.type('madéras');
    await expect(page.locator('#paletteList .palette-item')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.locator('#palette')).toHaveCount(0);
    await expect(page.locator('.toast.show')).toContainText('Maderas del Valle');
    await page.locator('#openPalette').click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#paletteList .palette-item.on')).toContainText('Facturas');
    await page.keyboard.press('Escape');
    await expect(page.locator('#palette')).toHaveCount(0);
    await expect(page.locator('#openPalette')).toBeFocused();
  });
});
