import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.4', () => {
  test('la hoja de importación previsualiza, cuadra, avisa y rechaza JSON inválido', async ({ page }) => {
    await page.goto('/#import');
    await page.locator('#openImport').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet).toBeVisible();
    const preview = sheet.locator('#importPreview');
    await expect(preview.locator('.imp-lines tbody tr')).toHaveCount(2);
    await expect(preview.locator('.imp-cuadre tr[data-row="total"] .diff')).toHaveText('✓');
    await expect(preview.locator('.imp-verdict')).toHaveAttribute('data-verdict', 'ok');
    await expect(preview.locator('.chip', { hasText: 'Confianza 95 %' })).toBeVisible();
    await expect(preview.locator('.chip', { hasText: 'dudosa' })).toHaveCount(1);
    await expect(sheet.locator('#confirmImport')).toBeEnabled();
    // Un total documental distinto rompe el cuadre: fila en rojo y veredicto de revisión; se puede importar igual.
    const text = await sheet.locator('#importJson').inputValue();
    await sheet.locator('#importJson').fill(text.replace('"total": 90.75', '"total": 95'));
    await expect(preview.locator('.imp-verdict')).toHaveAttribute('data-verdict', 'bad');
    await expect(preview.locator('.imp-cuadre tr[data-row="total"]')).toHaveClass(/bad/);
    await expect(preview.locator('.imp-verdict')).toContainText('4,25');
    await expect(sheet.locator('#confirmImport')).toBeEnabled();
    // Una línea cuyo neto no es cantidad × precio se marca y aparece el aviso.
    await sheet.locator('#importJson').fill(text.replace('"net_amount": 40', '"net_amount": 41'));
    await expect(preview.locator('.imp-lines tr[data-line="0"]')).toHaveClass(/bad/);
    await expect(preview.locator('.imp-warnings li')).toContainText('Línea 1');
    // JSON inválido: errores de formato y botón deshabilitado.
    await sheet.locator('#importJson').fill('{"schema_version":"otro"}');
    await expect(preview.locator('.imp-errors')).toContainText('schema_version');
    await expect(sheet.locator('#confirmImport')).toBeDisabled();
    await sheet.locator('#importJson').fill('esto no es json');
    await expect(preview.locator('.imp-errors code').first()).toHaveText('$');
    // Vuelve a ser válido e importa.
    await sheet.locator('#importJson').fill(text);
    await expect(sheet.locator('#confirmImport')).toBeEnabled();
    await sheet.locator('#confirmImport').click();
    await expect(page.locator('.toast.show')).toContainText('Importada F-2026-123 · cuadra');
    await expect(page.locator('.sheetback')).toHaveCount(0);
  });
});
