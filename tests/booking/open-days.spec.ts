/**
 * Jornadas abiertas (0482, VG 26-10-2026): el alta con fechas deja la fecha como fecha posible definitiva, y la reserva se
 * confirma sin propuesta ni señal (lo siguiente es «Confirmar la reserva» y el recorrido no pide nada en «Señal»).
 * Datos sintéticos.
 *
 * Cómo correrlo:   npx playwright test tests/booking/open-days.spec.ts
 */
import { expect, test } from 'playwright/test';
import { EVENTS, RESERVATIONS, inDays, login, startHarness, type Harness } from './harness.ts';

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
