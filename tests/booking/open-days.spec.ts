/**
 * Jornadas abiertas (0482, VG 26-10-2026): el alta con fechas deja la fecha como fecha posible definitiva, y la reserva se
 * confirma sin propuesta ni señal (lo siguiente es «Confirmar la reserva» y el recorrido no pide nada en «Señal»).
 * Datos sintéticos.
 *
 * Cómo correrlo:   npx playwright test tests/booking/open-days.spec.ts
 */
import { expect, test } from 'playwright/test';
import { ASSIGNMENTS, BEDS, EVENTS, FINANCE, GUESTS, RESERVATIONS, SPACES, inDays, login, startHarness, type Harness } from './harness.ts';

const OPTIONS = 'booking.reservation_date_options';

test.use({ viewport: { width: 1280, height: 900 } });
test.setTimeout(120_000);

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

test('jornadas abiertas: alta con fechas (fecha definitiva) y confirmar sin propuesta ni señal', async ({ page }) => {
  const api = harness.api;
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/reservas`);

  await page.getByRole('button', { name: 'Nueva reserva' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
  await dialog.getByLabel('Nombre del grupo o evento').fill('Jornadas de prueba');
  await dialog.locator('#resType').selectOption('jornadas_abiertas');
  await dialog.getByLabel('Estado').selectOption('pre_reservada');
  await dialog.getByLabel('Entrada').fill(inDays(10));
  await dialog.getByLabel('Salida').fill(inDays(12));
  await dialog.getByLabel('Personas previstas').fill('200');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => api.rows(RESERVATIONS).length).toBe(1);
  const reservation = api.rows(RESERVATIONS)[0]!;
  expect(reservation).toMatchObject({ event_type: 'jornadas_abiertas', status: 'pre_reservada', dates_definitive: true });
  expect(api.rows(OPTIONS).map((o) => [o.reservation_id, o.start_date, o.end_date, o.proposed_by])).toEqual([[reservation.id, inDays(10), inDays(12), 'ikisai']]);

  await page.goto(`${harness.baseURL}/#/reservas/${reservation.id}`);
  await expect(page.locator('#statusChip')).toBeVisible();
  // Lo siguiente es confirmar: ni preparar la propuesta ni cobrar la señal
  await expect(page.locator('#phaseAction')).toHaveText('Confirmar la reserva');
  await expect(page.locator('#reservationFocus')).not.toContainText('propuesta');
  await expect(page.locator('#reservationFocus')).not.toContainText('señal');

  await page.locator('#phaseAction').click();
  const confirm = page.getByRole('alertdialog', { name: 'Confirmar reserva' });
  await confirm.getByRole('button', { name: 'Confirmar' }).click();
  await expect.poll(() => api.rows(EVENTS).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => api.rows(RESERVATIONS)[0]!.status).toBe('confirmada');
});

test('jornadas abiertas: cartas de Food y «Alojar a alguien» en un paso; sin régimen de comidas', async ({ page }) => {
  const api = harness.api;
  const res = api.serverInsert(RESERVATIONS, { title: 'Jornadas con barra', status: 'confirmada', start_date: inDays(0), end_date: inDays(2), expected_guests: 200, event_type: 'jornadas_abiertas', priority: 'media' });
  api.serverInsert(FINANCE, { id: res.id });
  const event = api.serverInsert(EVENTS, { reservation_id: res.id });
  const space = api.serverInsert(SPACES, { name: 'Albergue sintético', kind: 'habitacion', zone: 'Albergue', position: 1 });
  const bed = api.serverInsert(BEDS, { space_id: space.id, label: 'Cama 1', kind: 'individual', capacity: 1, position: 1 });
  api.setCartas([
    { carta_id: '00000000-0000-4000-8000-0000000000c1', name: 'Barra del sábado', active: true, items_count: 12, event_id: null },
    { carta_id: '00000000-0000-4000-8000-0000000000c2', name: 'Carta antigua', active: false, items_count: 0, event_id: null },
  ]);
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/reservas/${res.id}`);
  await expect(page.locator('#statusChip')).toBeVisible();

  // Comidas: las cartas, sin régimen ni tipo de menú
  const cartas = page.locator('#foodCartas');
  await expect(cartas.locator('#cartasList button')).toHaveText(['Barra del sábado · 12']);
  await expect(page.locator('#blockMeals')).not.toContainText('Régimen');
  await cartas.getByRole('button', { name: /Barra del sábado/ }).click();
  await expect.poll(() => api.rows(RESERVATIONS).find((r) => r.id === res.id)!.food_carta_ids).toEqual(['00000000-0000-4000-8000-0000000000c1']);

  // Alojamiento a la carta: una persona suelta, dos noches, en un paso
  const walk = page.locator('#blockWalkIn');
  await expect(walk.locator('#walkTonightEmpty')).toBeVisible();
  await walk.locator('#walkIn').click();
  const sheet = page.getByRole('dialog', { name: 'Alojar a alguien' });
  await sheet.locator('#walkName').fill('Persona Suelta');
  await sheet.locator('#walkNights').fill('2');
  await expect(sheet.locator('#walkBed option')).toHaveText(['Albergue sintético · Cama 1']);
  await sheet.locator('#walkSave').click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => api.rows(GUESTS).filter((g) => g.event_id === event.id).map((g) => g.first_name)).toEqual(['Persona Suelta']);
  const assignment = api.rows(ASSIGNMENTS).find((a) => a.event_id === event.id)!;
  expect(assignment).toMatchObject({ bed_id: bed.id, persons: 1, from_date: inDays(0), to_date: inDays(2) });
  await expect(walk.locator('#walkTonight')).toContainText('Persona Suelta');
});

test('familiar: sin propuesta, cobro ni alojamiento; «Menú de casa (Food)»', async ({ page }) => {
  const api = harness.api;
  const res = api.serverInsert(RESERVATIONS, { title: 'Comida familiar', status: 'confirmada', start_date: inDays(5), end_date: inDays(6), expected_guests: 12, event_type: 'familiar', priority: 'media' });
  api.serverInsert(FINANCE, { id: res.id });
  api.serverInsert(EVENTS, { reservation_id: res.id });
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/reservas/${res.id}`);
  await expect(page.locator('#statusChip')).toBeVisible();
  await expect(page.locator('#houseMenu')).toContainText('Menú de casa (Food)');
  await expect(page.locator('#blockProposal, #blockFinance, #financeExtract, #blockCosts, #blockLodging, #blockWalkIn')).toHaveCount(0);
});

