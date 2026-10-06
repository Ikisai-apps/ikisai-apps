import { expect, test } from 'playwright/test';

function key(offset: number): string {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.describe('ui-kit v0.6 · fecha', () => {
  test('los atajos fijan la fecha, la descripción la explica y el rango se valida', async ({ page }) => {
    await page.goto('/#date');
    const dueField = page.locator('#date .datefield').first();
    const due = page.locator('#date-due');
    await expect(due).toHaveValue('');
    await expect(page.locator('#date-due-desc')).toBeHidden();
    await dueField.getByRole('button', { name: 'Mañana', exact: true }).click();
    await expect(due).toHaveValue(key(1));
    await expect(page.locator('#date-due-desc')).toContainText('· Mañana');
    await expect(dueField.getByRole('button', { name: 'Mañana', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#dateOut')).toHaveText(key(1));
    await dueField.getByRole('button', { name: '+7 días', exact: true }).click();
    await expect(due).toHaveValue(key(7));
    await expect(page.locator('#date-due-desc')).toContainText('en 7 días');
    await dueField.getByRole('button', { name: 'Quitar', exact: true }).click();
    await expect(due).toHaveValue('');
    await expect(page.locator('#dateOut')).toHaveText('null');
    // Rango: la salida no puede ser anterior a la entrada.
    const start = page.locator('#date-start'), end = page.locator('#date-end');
    await expect(end).toHaveAttribute('min', key(10));
    await start.fill(key(15));
    await expect(end).toHaveAttribute('min', key(15));
    await expect(page.locator('#date-end-error')).toContainText('No puede ser anterior');
    await end.fill(key(16));
    await end.blur();
    await expect(page.locator('#date-end-error')).toHaveText('');
    await start.fill('');
    await start.blur();
    await expect(page.locator('#date-start-error')).toContainText('Indica una fecha');
  });
});
