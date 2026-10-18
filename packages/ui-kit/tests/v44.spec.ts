import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.39 · createSpacePicker con textos propios (los oficios de Tasks)', () => {
  test('@smoke los oficios dicen «oficio» en el vacío, el buscador y las marcas; los espacios siguen igual', async ({ page }) => {
    await page.goto('/#spaces');
    const trades = page.locator('#tradePicker');
    const search = trades.getByRole('combobox');
    await expect(search).toHaveAttribute('placeholder', 'Buscar oficio…');
    await expect(search).toHaveAttribute('data-feedback-label', 'Buscar oficio');
    await search.fill('pintura');
    await expect(trades.getByRole('option')).toHaveText('Ningún oficio coincide con «pintura».');
    await search.fill('fonta');
    await expect(trades.getByRole('option')).toContainText('Mantenimiento');
    await search.press('Enter');
    await expect(trades.locator('.space-chip')).toHaveText(/Mantenimiento › Fontanería/);
    await expect(trades.locator('.space-chip-x')).toHaveAttribute('data-feedback-label', 'Quitar oficio');
    // La que no se pasa se queda con el texto de espacios.
    await search.fill('elec');
    await expect(trades.getByRole('option')).toHaveAttribute('data-feedback-label', 'Resultado de la búsqueda');

    // Sin `texts`, exactamente lo de hoy.
    const spaces = page.locator('#spacePickerMany');
    await expect(spaces.getByRole('combobox')).toHaveAttribute('placeholder', 'Buscar espacio…');
    await expect(spaces.getByRole('combobox')).toHaveAttribute('data-feedback-label', 'Buscar espacio');
    await expect(spaces.getByRole('button', { name: 'Cocina', exact: true })).toHaveAttribute('data-feedback-label', 'Espacio más usado');
    await spaces.getByRole('combobox').fill('pintura');
    await expect(spaces.getByRole('option')).toHaveText('Ningún espacio coincide con «pintura».');
  });
});
