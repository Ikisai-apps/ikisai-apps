/**
 * Tanda 27 (MUELA-009, 020 y 067): Inicio con cifras y «Lo primero», Reservas con portada, filtros con recuento y búsqueda
 * sin tildes, la ficha con portada, foco, recorrido y pestañas («Todo» se recuerda), y «Vaciar papelera» desactivado sin
 * red con su motivo. Datos sintéticos.
 *
 * Cómo correrlo:   npx playwright test tests/booking/ficha-tabs.spec.ts
 */
import { expect, test } from 'playwright/test';
import { inDays, login as loginTo, startHarness, type Harness } from './harness.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

test('Inicio, Reservas y la ficha por pestañas; vaciar la papelera sin red, desactivado con su motivo', async ({ page, context }) => {
  const nav = (name: string) => page.locator('.nav').getByText(name, { exact: true }).click();
  await loginTo(page, harness.baseURL, { tabs: true });

  await test.step('una pre-reserva en diez días', async () => {
    await nav('Reservas');
    await page.getByRole('button', { name: 'Nueva reserva' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await dialog.getByLabel('Nombre del grupo o evento').fill('Retiro Pestañas');
    await dialog.getByLabel('Estado').selectOption('pre_reservada');
    await dialog.getByLabel('Entrada').fill(inDays(10));
    await dialog.getByLabel('Salida').fill(inDays(12));
    await dialog.getByLabel('Personas previstas').fill('12');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step('Reservas: portada de la próxima, «Siguiente», filtros con recuento y búsqueda sin tildes en todas', async () => {
    await expect(page.locator('#nextCover')).toContainText('Retiro Pestañas');
    await expect(page.locator('#nextCover')).toContainText('La próxima');
    const row = page.locator('#reservationList .row', { hasText: 'Retiro Pestañas' });
    await expect(row).toContainText('Siguiente: Preparar la propuesta');
    await expect(page.locator('#phase-comercial')).toBeVisible();
    await expect(page.locator('.filters [data-filter="pre"]')).toHaveAttribute('aria-label', 'Pre-reservas: 1');
    await page.locator('.filters [data-filter="canceladas"]').click();
    await page.getByLabel('Buscar reservas').fill('pestanas');
    await expect(page.locator('#reservationSearchScope')).toContainText('Buscando en todas las reservas: 1 resultado');
    await expect(page.locator('#reservationList .row')).toHaveCount(1);
    await expect(page.locator('#nextCover')).toHaveCount(0); // con búsqueda, sin portada
    await page.getByLabel('Buscar reservas').fill('');
    await page.locator('.filters [data-filter="proximas"]').click();
    await page.locator('#nextCoverOpen').click();
    await expect(page.getByRole('heading', { name: 'Retiro Pestañas', level: 2 })).toBeVisible();
  });

  await test.step('ficha: portada, foco y recorrido; abre en la pestaña de lo siguiente', async () => {
    await expect(page.locator('#reservationCover')).toContainText('Comercial');
    await expect(page.locator('#reservationCover')).toContainText('12 personas');
    await expect(page.locator('#reservationFocus')).toContainText('Preparar la propuesta');
    await expect(page.locator('#reservationJourney [aria-current="step"]')).toContainText('Señal');
    await expect(page.locator('#reservationTabs [data-tab="comercial"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#blockProposal')).toBeVisible();
    await expect(page.locator('#blockOperation')).toBeHidden();
    await page.locator('#reservationTabs [data-tab="operacion"]').click();
    await expect(page.locator('#blockOperation')).toBeVisible();
    await expect(page.locator('#blockProposal')).toBeHidden();
    // «Hacer lo siguiente» lleva a su bloque, en su pestaña.
    await page.locator('#phaseAction').click();
    await expect(page.locator('#blockProposal')).toBeVisible();
    // «Todo» enseña la ficha entera y se recuerda en el dispositivo.
    await page.locator('#reservationTabs [data-tab="todo"]').click();
    await expect(page.locator('#blockOperation')).toBeVisible();
    await expect(page.locator('#blockSummary')).toBeVisible();
    await page.reload();
    await expect(page.locator('#reservationTabs [data-tab="todo"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#reservationTabs [data-tab="resumen"]').click();
    await expect(page.locator('#blockOperation')).toBeHidden();
  });

  await test.step('Inicio: cifras que filtran, «Lo primero» con lo siguiente, utilidades plegadas', async () => {
    await nav('Inicio');
    await expect(page.locator('#homeStats')).toContainText('Necesitan algo');
    await expect(page.locator('#upcomingList')).toContainText('Retiro Pestañas');
    await expect(page.locator('#upcomingList')).toContainText('Preparar la propuesta');
    await expect(page.locator('#openSpacesHome')).toBeHidden();
    await page.locator('#homeStats [data-filter="captacion"]').click();
    await expect(page.locator('#homeStats [data-filter="captacion"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#upcomingList')).toContainText('En captación');
    await page.locator('#homeFilterClear').click();
    await expect(page.locator('#upcomingList')).toContainText('Lo primero');
  });

  await test.step('papelera: sin red, «Vaciar papelera» desactivado con su motivo; vuelve sola con la red', async () => {
    await nav('Reservas');
    await page.locator('#reservationList .row', { hasText: 'Retiro Pestañas' }).click();
    await page.locator('#reservationTabs [data-tab="todo"]').click();
    await page.locator('#moreActions summary').click();
    await page.locator('#trashReservation').click();
    await page.locator('.dialog').getByRole('button', { name: 'Enviar a la papelera' }).click();
    await expect(page.locator('#trash')).toBeVisible();
    await page.locator('#trash summary').click();
    await expect(page.locator('#emptyTrash')).toHaveAttribute('aria-disabled', 'false');
    await context.setOffline(true);
    await expect(page.locator('#emptyTrash')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#emptyTrashWhy')).toHaveText('Sin conexión: vaciar la papelera borra en el servidor. Se activa sola cuando vuelva la red.');
    await expect(page.locator('#emptyTrash')).toHaveAttribute('aria-describedby', 'emptyTrashWhy');
    await page.locator('#emptyTrash').dispatchEvent('click'); // desactivado: el clic no llega a vaciar
    await expect(page.locator('.dialog')).toHaveCount(0);
    await context.setOffline(false);
    await expect(page.locator('#emptyTrash')).toHaveAttribute('aria-disabled', 'false');
  });
});
