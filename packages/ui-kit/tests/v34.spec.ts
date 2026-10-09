import { expect, test } from 'playwright/test';
import { matchName, normalizeName, suggestMessage, uniqueNames } from '../src/fields/suggest.ts';

test.describe('ui-kit v0.27 · texto con sugerencias (de Booking)', () => {
  test('funciones: normalizar, únicos ordenados, exacto / parecido / nuevo', () => {
    expect(normalizeName('  Sála   ROBLE ')).toBe('sala roble');
    expect(uniqueNames(['Sala Roble', 'Comedor', ' comedor ', '', null, 'Piscina'])).toEqual(['Comedor', 'Piscina', 'Sala Roble']);
    expect(matchName('Comedor', ['Comedor'])).toEqual({ kind: 'exact', match: 'Comedor' });
    expect(matchName('sala  roble', ['Sala Roble'])).toEqual({ kind: 'similar', match: 'Sala Roble' });
    expect(matchName('Terraza', ['Sala Roble'])).toEqual({ kind: 'new' });
    expect(suggestMessage({ kind: 'exact', match: 'X' }, 'pick')).toBeNull();
    expect(suggestMessage({ kind: 'new' }, 'unique')).toBeNull();
    expect(suggestMessage({ kind: 'exact', match: 'X' }, 'unique')?.warn).toBe(true);
  });

  test('pick @smoke: lista sin repetidos, «parecido» con «Usar», «nuevo» y nada si es exacto', async ({ page }) => {
    await page.goto('/#portal');
    const field = page.locator('#suggestPick');
    const input = field.locator('input');
    await expect(field.locator('datalist option')).toHaveCount(3);
    const hint = field.locator('.hint.suggest');
    await input.fill('sala  roble');
    await expect(hint).toHaveClass(/warn/);
    await expect(hint).toContainText('Ya existe «Sala Roble».');
    const use = hint.locator('.suggest-use');
    await expect(use).toHaveAttribute('data-feedback-id', 'demo.espacio.zona_usar');
    await use.click();
    await expect(input).toHaveValue('Sala Roble');
    await expect(hint).toBeEmpty();
    await input.fill('Terraza');
    await expect(hint).toHaveText('Nuevo: no existe todavía.');
    await expect(hint).not.toHaveClass(/warn/);
  });

  test('unique: avisa si el nombre ya existe (exacto o parecido)', async ({ page }) => {
    await page.goto('/#portal');
    const field = page.locator('#suggestUnique');
    const input = field.locator('input');
    const hint = field.locator('.hint.suggest');
    await input.fill('habitacion 3');
    await expect(hint).toContainText('Ya hay uno que se llama «Habitación 3».');
    await input.fill('Habitación 4');
    await expect(hint).toBeEmpty();
    await expect(input).toHaveAttribute('aria-describedby', /suggest/);
  });

  test('en inglés, con el idioma del portal', async ({ page }) => {
    await page.goto('/#portal');
    await page.evaluate(() => (window as any).ikisaiI18n.start().setLocale('en'));
    const pick = page.locator('#suggestPick');
    await pick.locator('input').fill('sala roble');
    await expect(pick.locator('.hint.suggest')).toContainText('“Sala Roble” already exists.');
    await expect(pick.locator('.suggest-use')).toContainText('Use “Sala Roble”');
  });
});
