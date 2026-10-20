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

// Tanda 36 (MUELA-049): la ficha del espacio con «Monta el dormitorio». Una sala recibe camas y cuenta sus plazas.
test('ficha y «Monta el dormitorio»: añadir, girar, mover sin montarse, guardar en un lote y las plazas de la sala', async ({ page }) => {
  const api = harness.api;
  const salon = api.serverInsert(SPACES, { name: 'Salón del albergue', kind: 'sala', zone: 'Albergue', capacity: 30, position: 9000 });
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/espacios`);

  // Sin plano (ningún espacio enlazado con Recursos), la ficha se abre desde el nombre en la lista.
  await expect(page.locator('#spacePlan')).toBeEmpty();
  await page.getByRole('button', { name: 'Abrir la ficha de Salón del albergue' }).click();
  const card = page.locator('#spaceCard');
  await expect(card.locator('#spaceCardTitle')).toHaveText('Salón del albergue');
  await expect(card.locator('#spaceCardPlaces')).toHaveText('Capacidad: 30 personas');
  await expect(card.locator('#spaceCardData')).not.toHaveAttribute('open', '');
  await expect(card.locator('#dormEmpty')).toHaveText('Sin camas: añade la primera para usarla como dormitorio.');

  // Editar: dos camas en el primer hueco; girar la individual con R y no dejar que se monte sobre la litera.
  await card.locator('#dormEdit').click();
  await card.locator('#dormAdd-litera').click();
  await card.locator('#dormAdd-individual').click();
  const litera = card.getByRole('button', { name: /^Litera 1, Litera, 2 plazas/ });
  const single = card.getByRole('button', { name: /^Individual 1, Individual, 1 plaza/ });
  await expect(litera).toBeVisible();
  await single.click();
  await expect(card.locator('#dormBar')).toContainText('Individual 1');
  await single.press('r');
  await expect(single).toHaveAttribute('data-rot', '90');
  await single.press('ArrowLeft');
  await expect(card.locator('#dormMessage')).toHaveText('No cabe ahí: se montaría sobre Litera 1.');
  // Abajo no cabe (2 de fondo): se dice; con un cuadrante más de fondo, sí.
  await card.getByRole('button', { name: 'Mover hacia abajo: Individual 1' }).click();
  await expect(card.locator('#dormMessage')).toHaveText('No cabe ahí: se saldría de la estancia.');
  await card.getByRole('button', { name: 'Fondo: más' }).click();
  await expect(card.locator('#dormSize-rows strong')).toHaveText('3');
  await card.getByRole('button', { name: 'Mover hacia abajo: Individual 1' }).click();
  await expect(card.locator('#dormMessage')).toHaveText('Individual 1: x 3, y 2.');
  // Encoger el fondo dejaría fuera la individual.
  await card.getByRole('button', { name: 'Fondo: menos' }).click();
  await expect(card.locator('#dormMessage')).toHaveText('No se puede encoger: alguna cama se quedaría fuera. Muévela antes.');

  const before = new Set(api.changeLog().map((c) => c.requestId));
  await card.locator('#dormSave').click();
  await expect.poll(() => api.rows(BEDS).filter((b) => b.space_id === salon.id).length).toBe(2);
  const beds = api.rows(BEDS).filter((b) => b.space_id === salon.id);
  expect(beds.find((b) => b.kind === 'litera')).toMatchObject({ capacity: 2, cell: { x: 0, y: 0, rot: 0 } });
  expect(beds.find((b) => b.kind === 'individual')).toMatchObject({ capacity: 1, cell: { x: 2, y: 1, rot: 90 } });
  await expect.poll(() => api.rows(SPACES).find((s) => s.id === salon.id)?.layout).toEqual({ cols: 4, rows: 3 });
  // Un solo lote: el espacio y las dos camas.
  expect(new Set(api.changeLog().map((c) => c.requestId).filter((r) => !before.has(r))).size).toBe(1);

  // La sala cuenta las plazas de sus camas, en la ficha y en la lista, y enseña sus camas.
  await expect(card.locator('#spaceCardPlaces')).toHaveText('3 plazas · 2 camas libres esta noche');
  const row = page.locator('.space-item[data-kind="sala"]').filter({ hasText: 'Salón del albergue' }).first();
  await expect(row.locator('[data-role="places"]').first()).toContainText('3 plazas');
  await expect(card.locator('#dormEdit')).toBeVisible();
});
