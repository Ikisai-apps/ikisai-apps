/**
 * «Espacios y camas»: distribución inicial en un solo lote. API falsa propia (el espacio debe estar vacío).
 *
 * Cómo correrlo:   npx playwright test tests/booking/spaces.spec.ts
 */
import { expect, test } from 'playwright/test';
import { BEDS, SPACES, login, startHarness, type Harness } from './harness.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

test('crear distribución inicial: 6 habitaciones y 58 camas en un solo lote', async ({ page }) => {
  const api = harness.api;
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/espacios`);
  await expect(page.getByText('Todavía no hay espacios')).toBeVisible();

  // Cancelar no crea nada.
  await page.locator('#createLayout').click();
  const confirmation = page.getByRole('alertdialog', { name: 'Crear distribución inicial' });
  await expect(confirmation).toContainText('58 camas');
  await confirmation.getByRole('button', { name: 'Cancelar' }).click();
  await expect(confirmation).toBeHidden();
  expect(api.rows(SPACES)).toHaveLength(0);

  await page.locator('#createLayout').click();
  await page.getByRole('alertdialog', { name: 'Crear distribución inicial' }).getByRole('button', { name: 'Crear' }).click();
  await expect.poll(() => api.rows(SPACES).length).toBe(6);
  await expect.poll(() => api.rows(BEDS).length).toBe(2 + 3 * (12 + 4) + 2 * (2 + 2)); // 58

  expect(api.rows(SPACES).map((s) => s.name).sort()).toEqual(['Habitación doble', 'Habitación grande 1', 'Habitación grande 2', 'Habitación grande 3', 'Habitación pequeña 1', 'Habitación pequeña 2']);
  expect(api.rows(SPACES).filter((s) => s.bookable === false).map((s) => s.name)).toEqual(['Habitación doble']);
  expect(api.rows(BEDS).filter((b) => b.kind === 'supletoria')).toHaveLength(3 * 4 + 2 * 2);
  // Todo llegó en el mismo `commit`.
  expect(new Set(api.changeLog().map((c) => c.requestId)).size).toBe(1);
  expect(api.changeLog()).toHaveLength(64);

  const grande = page.locator('.space-item[data-kind="habitacion"]').filter({ hasText: 'Habitación grande 1' }).first();
  await expect(grande.locator('[data-role="places"]').first()).toHaveText('12 plazas + 4 supletorias');
  await expect(page.locator('.space-item').filter({ hasText: 'Habitación doble' }).first().locator('.chip', { hasText: 'No reservable' })).toBeVisible();
  await expect(page.locator('#createLayout')).toHaveCount(0);

});

// FB_2026_014: la zona se elige entre las existentes o se crea; un nombre parecido (mayúsculas, tildes, espacios) se avisa.
test('zona con lo que ya existe: nueva, parecida con «Usar», y nombre de espacio repetido', async ({ page }) => {
  const api = harness.api;
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/espacios`);

  const create = async (name: string, zone: string) => {
    await page.locator('#newSpace').click();
    const sheet = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await sheet.locator('#f-name').fill(name);
    await sheet.locator('#f-zone').fill(zone);
    return sheet;
  };
  let sheet = await create('Sala del Roble', 'Edificio norte');
  await expect(sheet.locator('#f-zone-suggest')).toHaveText('Nuevo: no existe todavía.');
  await sheet.getByRole('button', { name: 'Guardar' }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => api.rows(SPACES).some((s) => s.zone === 'Edificio norte')).toBe(true);

  sheet = await create('sala del roble', 'edificio  NORTE');
  await expect(sheet.locator('#f-name-suggest')).toContainText('Ya hay uno que se llama «Sala del Roble».');
  await expect(sheet.locator('#f-zone-suggest')).toContainText('Ya existe «Edificio norte».');
  await expect(sheet.locator('#f-zone-list option[value="Edificio norte"]')).toHaveCount(1);
  await sheet.locator('#f-zone-suggest').getByRole('button', { name: /Usar «Edificio norte»/ }).click();
  await expect(sheet.locator('#f-zone')).toHaveValue('Edificio norte');
  await expect(sheet.locator('#f-zone-suggest')).toBeEmpty();
});
