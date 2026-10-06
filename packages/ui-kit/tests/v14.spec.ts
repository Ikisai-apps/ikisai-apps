import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.11 · agentes', () => {
  test('la revisión de una propuesta agrupa los cambios, muestra el riesgo y deja el pie fijo a la vista', async ({ page }) => {
    await page.goto('/#agents');
    const rows = page.locator('#proposalHost .proposalrow');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('.chip.status')).toHaveText('Pendiente');
    await expect(rows.nth(0)).toContainText('caduca en 23 h');
    await expect(rows.nth(1).locator('.chip.status')).toHaveText('Aplicada');
    await expect(rows.nth(2).locator('.chip.status')).toHaveText('Caducada');
    await expect(rows.nth(2)).not.toContainText('caduca');
    await rows.nth(0).click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet.locator('.risksummary .chip').first()).toHaveText('12 elementos afectados · umbral 10');
    await expect(sheet.locator('.risksummary .chip.alert')).toHaveText('Incluye borrados');
    const groups = sheet.locator('.cl-group');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).locator('.cl-head')).toHaveText('Editar 11 tareas');
    await expect(groups.nth(1).locator('.cl-head')).toHaveText('Borrar 1 tarea');
    await expect(groups.nth(0).locator('.cl-item')).toHaveCount(6);
    await groups.nth(0).locator('.cl-more button').click();
    await expect(groups.nth(0).locator('.cl-item')).toHaveCount(11);
    await expect(groups.nth(0).locator('.cl-item').first().locator('.cl-before')).toHaveText('Sin clasificar todavía');
    await expect(groups.nth(0).locator('.cl-item').first().locator('.cl-after')).toHaveText('Revisado por el asistente');
    await expect(groups.nth(0).locator('.cl-item').nth(6).locator('.cl-before .cl-empty')).toHaveCount(1);
    // Pie fijo: con la lista desplegada sigue dentro de la ventana.
    const approve = page.locator('#demoApprove');
    await expect(approve).toHaveText('Aprobar 12 cambios');
    const box = await approve.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await approve.click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta aprobada');
    await expect(rows.nth(0).locator('.chip.status')).toHaveText('Aprobada');
    // Solo lectura: una propuesta ya aplicada no tiene pie.
    await rows.nth(1).click();
    await expect(page.locator('.sheetback.show .sheet-foot')).toHaveCount(0);
  });

  test('la clave se ve entera, «Copiar» confirma y «Hecho» pide guardarla si no se copió', async ({ page, context, browserName }) => {
    await page.goto('/#agents');
    const value = page.locator('#demoSecret');
    await expect(value).toHaveValue(/^ika_.*AzvE$/);
    const fits = await value.evaluate((n) => (n as HTMLTextAreaElement).scrollWidth <= (n as HTMLTextAreaElement).clientWidth + 1);
    expect(fits).toBe(true);
    await page.locator('#demoSecretDone').click();
    await expect(page.locator('#secretHost .so-confirm')).toBeVisible();
    await expect(page.locator('#secretOut')).toHaveText('');
    await page.locator('#secretHost .so-check').check();
    await page.locator('#demoSecretDone').click();
    await expect(page.locator('#secretOut')).toHaveText('hecho');
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.locator('#demoSecretCopy').click();
    await expect(page.locator('#demoSecretCopy')).toContainText('Copiada');
  });

  test('registro por días y selector de ámbitos', async ({ page }) => {
    await page.goto('/#agents');
    const days = page.locator('#accessLogHost .al-day');
    await expect(days).toHaveCount(2);
    await expect(days.nth(0).locator('h4')).toHaveText('Hoy');
    await expect(days.nth(1).locator('h4')).toHaveText('Ayer');
    await expect(days.nth(0).locator('.al-actor.agent')).toHaveText('Asistente de obra');
    const scope = page.locator('#scopeHost');
    await scope.locator('[data-scope-project="p2"]').check();
    await expect(page.locator('#scopeOut')).toHaveText('{"tabs":[],"projects":{"ikisai":["p2"]}}');
    await scope.locator('[data-scope-area="ikisai"]').check();
    await expect(page.locator('#scopeOut')).toHaveText('{"tabs":["ikisai"],"projects":{}}');
    await expect(scope.locator('[data-scope-project="p1"]')).toBeDisabled();
    await scope.locator('[data-scope="all"]').check();
    await expect(page.locator('#scopeOut')).toHaveText('"*"');
    await expect(scope.locator('[data-scope-area="personal"]')).toBeDisabled();
  });
});
