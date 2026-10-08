/**
 * Diseño del portal en la app del personal (API §21): peticiones del organizador (aviso en Inicio, chip y bloque de la ficha),
 * notas y extras pedidos (con «Añadir a la propuesta») y tarifas visibles en el portal. Datos sintéticos.
 *
 * Cómo correrlo:   npx playwright test tests/booking/portal-requests.spec.ts
 */
import { expect, test } from 'playwright/test';
import { PROPOSAL_LINES, RATES, RESERVATIONS, inDays, login, startHarness, type Harness } from './harness.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

const PORTAL_REQUESTS = 'booking.portal_requests';
const EXTRA_REQUESTS = 'booking.reservation_extra_requests';

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

test('petición «Quiere confirmar»: aviso en Inicio, chip, marcarla vista; extra pedido y añadido al borrador; tarifa visible en el portal', async ({ page }) => {
  const api = harness.api;
  const reservation = api.serverInsert(RESERVATIONS, {
    title: 'Retiro Portal', status: 'pre_reservada', start_date: inDays(10), end_date: inDays(12), expected_guests: 20, organizer_notes: 'Llegamos en autobús a media tarde.',
  });
  const sound = api.serverInsert(RATES, { name: 'Equipo de sonido', layer: 'extra', unit: 'unidad', amount: 50, position: 1, active: true, portal_visible: true, public_name: 'Sonido para sala' });
  api.serverInsert(RATES, { name: 'Visita guiada', layer: 'servicio', unit: 'persona_noche', amount: 8, position: 2, active: true });
  api.serverInsert(EXTRA_REQUESTS, { reservation_id: reservation.id, rate_id: sound.id, quantity: 2, note: 'Para la sala grande' });

  await login(page, harness.baseURL);
  await test.step('sin peticiones no hay aviso; al llegar una, Inicio la cuenta y enlaza a la ficha', async () => {
    await expect(page.locator('[data-notice="portal"]')).toHaveCount(0);
    api.serverInsert(PORTAL_REQUESTS, { reservation_id: reservation.id, kind: 'quiere_confirmar', message: 'Queremos confirmar la versión 1.', status: 'enviada' });
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
    const notice = page.locator('[data-notice="portal"]');
    await expect(notice).toContainText('petición del portal sin ver');
    await expect(notice.locator('.n')).toHaveText('1');
    await notice.getByRole('link').click();
    await expect(page.locator('#statusChip')).toBeVisible();
  });

  await test.step('ficha: chip, bloque con el mensaje y marcar vista', async () => {
    await expect(page.locator('#portalRequestChip')).toHaveText('Petición del organizador');
    const block = page.locator('#blockPortalRequests');
    await expect(block).toContainText('Quiere confirmar');
    await expect(block).toContainText('Queremos confirmar la versión 1.');
    await block.getByRole('button', { name: 'Marcar vista' }).click();
    await expect.poll(() => api.rows(PORTAL_REQUESTS)[0]!.status).toBe('vista');
    await expect(page.locator('#portalRequestChip')).toHaveCount(0);
    await expect(block.locator('[data-role="status"]')).toHaveText('Vista');
    await expect(block.getByRole('button', { name: 'Marcar vista' })).toHaveCount(0);
  });

  await test.step('notas y extras del organizador; sin borrador no se puede añadir, con borrador sí', async () => {
    const summary = page.locator('#blockSummary');
    await expect(summary).toContainText('Llegamos en autobús a media tarde.');
    const extras = page.locator('#extraRequests');
    await expect(extras).toContainText('Equipo de sonido');
    await expect(extras).toContainText('× 2');
    await expect(extras).toContainText('Para la sala grande');
    await expect(extras.getByRole('button', { name: /Añadir a la propuesta/ })).toHaveCount(0);
    await page.locator('#createProposal').click();
    await expect.poll(() => api.rows('booking.proposals').length).toBe(1);
    await extras.getByRole('button', { name: /Añadir a la propuesta/ }).click();
    await expect.poll(() => api.rows(PROPOSAL_LINES).map((l) => [l.description, l.quantity, l.unit_amount, l.rate_id])).toEqual([['Equipo de sonido', 2, 50, sound.id]]);
    await expect(extras.locator('.chip', { hasText: 'En la propuesta' })).toBeVisible();
    await expect(extras.getByRole('button', { name: /Añadir a la propuesta/ })).toHaveCount(0);
  });

  await test.step('tarifas: chip «En el portal» y marcar otra tarifa como visible con nombre público', async () => {
    await page.goto(`${harness.baseURL}/#/tarifas`);
    await expect(page.locator('.rate-item', { hasText: 'Equipo de sonido' }).locator('[data-role="portal"]')).toHaveText('En el portal');
    await expect(page.locator('.rate-item', { hasText: 'Visita guiada' })).toBeVisible();
    await expect(page.locator('.rate-item', { hasText: 'Visita guiada' }).locator('[data-role="portal"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Editar Visita guiada' }).click();
    const dialog = page.getByRole('dialog', { name: 'Tarifa' });
    await dialog.getByLabel('Visible en el portal del organizador').check();
    await dialog.getByLabel('Nombre público').fill('Visita guiada al entorno');
    await dialog.getByLabel('Descripción pública').fill('Paseo de dos horas con guía.');
    await expect(dialog).toContainText('Lo ve el organizador en su calculadora.');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows(RATES).find((r) => r.name === 'Visita guiada')).toMatchObject({ portal_visible: true, public_name: 'Visita guiada al entorno', public_description: 'Paseo de dos horas con guía.' });
    await expect(page.locator('.rate-item', { hasText: 'Visita guiada' }).locator('[data-role="portal"]')).toHaveText('En el portal');
  });

  await test.step('condiciones: mínimo por retiro', async () => {
    await page.locator('#newConditions').click();
    const dialog = page.getByRole('dialog', { name: 'Nuevas condiciones' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Condiciones con mínimo');
    await dialog.getByLabel('Mínimo por retiro (€)').fill('1500');
    await expect(dialog).toContainText('Si el total no llega, se cobra el mínimo.');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows('booking.conditions')[0]?.minimum_total).toBe(1500);
    await expect(page.locator('.condition', { hasText: 'Condiciones con mínimo' })).toContainText(/Mínimo por retiro1.?500,00/);
  });
});
