/**
 * MUELA-067 (cierre): «Movimientos» del extracto de la ficha con las emitidas de Finance (#643), por meses y con las
 * rectificativas restando; la última copia queda en el dispositivo y se borra al cerrar sesión. Datos sintéticos.
 *
 * Cómo correrlo:   npx playwright test tests/booking/extract-moves.spec.ts
 */
import { expect, test } from 'playwright/test';
import { FINANCE, RESERVATIONS, inDays, login, startHarness, type Harness } from './harness.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

test('extracto: lo cobrado y «Movimientos» por meses, la rectificativa resta, y la copia se borra al salir', async ({ page }) => {
  const api = harness.api;
  const res = api.serverInsert(RESERVATIONS, { title: 'Retiro Extracto', status: 'confirmada', start_date: inDays(20), end_date: inDays(22), expected_guests: 10, event_type: 'retiro', priority: 'media' });
  api.serverInsert(FINANCE, { id: res.id, final_amount: 2000, deposit_required: 600, deposit_paid: 600 });
  api.setMovements([
    { reservation_id: res.id, issued_invoice_id: 'f1', full_number: 'F-2026-0001', issue_date: '2026-09-10', concept: 'Señal del retiro', purpose: 'senal', kind: 'factura', total: 600, collected: true, paid_at: '2026-09-12T10:00:00Z' },
    { reservation_id: res.id, issued_invoice_id: 'f2', full_number: 'F-2026-0007', issue_date: '2026-10-05', concept: 'Saldo del retiro', purpose: 'saldo', kind: 'factura', total: 1400, collected: false, paid_at: null },
    { reservation_id: res.id, issued_invoice_id: 'r1', full_number: 'R-2026-0001', issue_date: '2026-10-06', concept: 'Corrección del saldo', purpose: 'saldo', kind: 'rectificativa', total: -100, collected: false, paid_at: null },
  ]);
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/reservas/${res.id}`);

  const extract = page.locator('#financeExtract');
  await expect(extract.locator('.mb-amount')).toContainText('1400');
  await expect(extract).toContainText('cobrado 600');
  const moves = extract.locator('.mb-feed', { hasText: 'Movimientos' });
  await expect(moves.locator('.mb-monthh')).toHaveText(['Octubre de 2026', 'Septiembre de 2026']);
  await expect(moves.locator('.mb-move')).toHaveCount(3);
  await expect(moves.locator('.mb-move').nth(0)).toContainText('Rectificativa · R-2026-0001');
  await expect(moves.locator('.mb-move').nth(0)).toContainText('-100');
  await expect(moves.locator('.mb-move').nth(0)).toContainText('Resta');
  await expect(moves.locator('.mb-move').nth(1)).toContainText('Saldo · F-2026-0007');
  await expect(moves.locator('.mb-move').nth(1)).toContainText('Pendiente');
  await expect(moves.locator('.mb-move').nth(2)).toContainText('Señal · F-2026-0001');
  await expect(moves.locator('.mb-move').nth(2)).toContainText('Cobrada');
  await expect(moves.locator('.mb-move').nth(2)).toContainText('cobrada el');
  await expect(extract.locator('#openIssuedInvoices')).toBeVisible();

  // La última copia, en el dispositivo; al cerrar sesión se borra.
  const stored = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('booking:movimientos:')));
  expect(await stored()).toEqual([`booking:movimientos:${res.id}`]);
  await page.locator('#appLauncher').click();
  await page.getByRole('dialog', { name: 'Menú de Booking' }).getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect.poll(stored).toEqual([]);
});
