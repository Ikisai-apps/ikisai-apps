/**
 * Fechas de los portales (Fase 2, parte 1) en la app del personal: fecha definitiva, fechas posibles de Ikisai (alta, orden,
 * chip del organizador, propuestas del organizador, fijar una) y fechas bloqueadas del Calendario. Datos sintéticos.
 *
 * Cómo correrlo:   npx playwright test tests/booking/dates.spec.ts
 */
import { expect, test } from 'playwright/test';
import { RESERVATIONS, inDays, login as loginTo, startHarness, type Harness } from './harness.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

const OPTIONS = 'booking.reservation_date_options';
const BLOCKS = 'booking.date_blocks';

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

test('fechas posibles: dos opciones, orden, chip del organizador, fijar una; y un bloqueo creado y borrado', async ({ page }) => {
  const api = harness.api;
  const nav = (name: string) => page.locator('.nav').getByText(name, { exact: true }).click();
  const sync = () => page.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await loginTo(page, harness.baseURL);

  await test.step('una pre-reserva con fechas provisionales', async () => {
    await nav('Reservas');
    await page.getByRole('button', { name: 'Nueva reserva' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await dialog.getByLabel('Nombre del grupo o evento').fill('Retiro Fechas');
    await dialog.getByLabel('Estado').selectOption('pre_reservada');
    await dialog.getByLabel('Entrada').fill(inDays(10));
    await dialog.getByLabel('Salida').fill(inDays(12));
    await dialog.getByLabel('Personas previstas').fill('20');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
    await page.locator('#reservationList .row', { hasText: 'Retiro Fechas' }).getByText('Retiro Fechas').first().click();
    await expect(page.locator('#statusChip')).toBeVisible();
    await expect(page.locator('#datesChip')).toHaveText('Provisional');
    await expect(page.locator('#datesDefinitive')).not.toBeChecked();
  });

  const reservationId = () => api.rows(RESERVATIONS)[0]!.id;
  const addOption = async (from: string, to: string) => {
    await page.locator('#addDateOption').click();
    const dialog = page.getByRole('dialog', { name: 'Nueva fecha posible' });
    await dialog.getByLabel('Inicio').fill(from);
    await dialog.getByLabel('Fin').fill(to);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
  };

  await test.step('crear dos fechas posibles; una con fin anterior al inicio se rechaza', async () => {
    await page.locator('#addDateOption').click();
    const bad = page.getByRole('dialog', { name: 'Nueva fecha posible' });
    await bad.getByLabel('Inicio').fill(inDays(30));
    await bad.getByLabel('Fin').fill(inDays(29));
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(bad).toContainText('El fin debe ser posterior al inicio.');
    // Se corrige en la misma hoja y se guarda.
    await bad.getByLabel('Inicio').fill(inDays(20));
    await bad.getByLabel('Fin').fill(inDays(22));
    await bad.getByLabel('Hora de llegada aproximada').fill('16:00');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(bad).toBeHidden();
    await expect.poll(() => api.rows(OPTIONS).length).toBe(1);

    await addOption(inDays(30), inDays(33));
    await expect(page.locator('#blockDates .sortable-row')).toHaveCount(2);
    await expect.poll(() => api.rows(OPTIONS).length).toBe(2);
    const rows = api.rows(OPTIONS).sort((a, b) => Number(a.position) - Number(b.position));
    expect(rows.map((r) => [r.start_date, r.proposed_by, r.organizer_ok])).toEqual([[inDays(20), 'ikisai', false], [inDays(30), 'ikisai', false]]);
    expect(rows[0]!.reservation_id).toBe(reservationId());
    expect(rows[0]!.arrival_time).toMatch(/^16:00/);
  });

  await test.step('reordenar: un solo update de la opción movida', async () => {
    const before = new Map(api.rows(OPTIONS).map((r) => [r.id, r]));
    const mark = api.changeLog().length;
    await page.locator('#blockDates').getByRole('button', { name: /^Bajar / }).first().click();
    await expect.poll(() => api.changeLog().length).toBe(mark + 1);
    const entry = api.changeLog()[mark]!;
    expect(entry).toMatchObject({ table: OPTIONS, op: 'update' });
    const first = api.rows(OPTIONS).find((r) => r.start_date === inDays(20))!;
    expect(entry.id).toBe(first.id);
    expect(first.revision).toBe(before.get(first.id)!.revision + 1);
    expect(Number(first.position)).toBeGreaterThan(Number(api.rows(OPTIONS).find((r) => r.start_date === inDays(30))!.position));
  });

  await test.step('chip «Le viene bien al organizador» y propuestas del organizador (solo lectura)', async () => {
    const mine = api.rows(OPTIONS).find((r) => r.start_date === inDays(30))!;
    api.serverUpdate(OPTIONS, mine.id, { organizer_ok: true });
    api.serverInsert(OPTIONS, { reservation_id: reservationId(), start_date: inDays(40), end_date: inDays(42), proposed_by: 'organizer', position: 1 });
    await sync();
    await expect(page.locator('#blockDates .chip', { hasText: 'Le viene bien al organizador' })).toHaveCount(1);
    await expect(page.locator('#organizerDates li')).toHaveCount(1);
    await expect(page.locator('#organizerDates')).not.toContainText('Quitar');
    await expect(page.locator('#blockDates').getByRole('button', { name: /^Editar la fecha/ })).toHaveCount(2);
  });

  await test.step('«Fecha definitiva» sin fechas no se puede marcar', async () => {
    // Se comprueba el aviso con el cambio hecho en el servidor: sin entrada ni salida la casilla no se queda marcada.
    api.serverUpdate(RESERVATIONS, reservationId(), { start_date: null, end_date: null });
    await sync();
    await expect(page.locator('#datesChip')).toBeVisible();
    await page.locator('#datesDefinitive').click();
    await expect(page.getByText('indica antes la entrada y la salida')).toBeVisible();
    await expect(page.locator('#datesDefinitive')).not.toBeChecked();
    expect(api.rows(RESERVATIONS)[0]!.dates_definitive).toBe(false);
  });

  await test.step('fijar una fecha: un solo update con las fechas y dates_definitive', async () => {
    const mark = api.changeLog().length;
    await page.locator('#blockDates').getByRole('button', { name: /^Fijar la fecha/ }).first().click();
    const confirm = page.getByRole('alertdialog', { name: 'Fijar esta fecha' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Fijar fecha' }).click();
    await expect(page.locator('#datesChip')).toHaveText('Definitiva');
    // el chip cambia con el espejo local; el lote llega al servidor con la sincronización
    await expect.poll(() => api.changeLog().length - mark).toBe(1);
    const batch = api.changeLog().slice(mark);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ table: RESERVATIONS, op: 'update', id: reservationId() });
    await expect.poll(() => api.rows(RESERVATIONS)[0]!.dates_definitive).toBe(true);
    expect(api.rows(RESERVATIONS)[0]!.start_date).not.toBeNull();
    // Con fecha definitiva el bloque se pliega y un enlace lo despliega.
    await expect(page.locator('#dateOptionsEmpty, #addDateOption')).toHaveCount(0);
    await page.locator('#showDateOptions').click();
    await expect(page.locator('#addDateOption')).toBeVisible();
  });

  await test.step('bloqueo de fechas en el Calendario: crear y borrar', async () => {
    await nav('Calendario');
    await expect(page.locator('#blockDateBlocks')).toBeVisible();
    await expect(page.locator('#dateBlocksEmpty')).toBeVisible();
    await page.locator('#addDateBlock').click();
    const dialog = page.getByRole('dialog', { name: 'Bloquear fechas' });
    await expect(dialog).toContainText('Solo lo ve el personal.');
    await dialog.getByLabel('Inicio').fill(inDays(0));
    await dialog.getByLabel('Fin').fill(inDays(1));
    await dialog.getByLabel('Motivo interno').fill('Obras en la cocina');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#dateBlockList li')).toHaveCount(1);
    await expect(page.locator('#dateBlockList')).toContainText('Obras en la cocina');
    expect(api.rows(BLOCKS)).toHaveLength(1);
    expect(api.rows(BLOCKS)[0]).toMatchObject({ start_date: inDays(0), end_date: inDays(1), reason: 'Obras en la cocina' });
    await expect(page.locator('#calendarHost [data-status="bloqueo"]').first()).toBeVisible();

    await page.getByRole('button', { name: /^Quitar el bloqueo/ }).click();
    await page.getByRole('alertdialog', { name: 'Quitar bloqueo' }).getByRole('button', { name: 'Quitar bloqueo' }).click();
    await expect(page.locator('#dateBlocksEmpty')).toBeVisible();
    // la lista se vacía al instante (espejo local); el borrado llega al servidor con la sincronización
    await expect.poll(() => api.rows(BLOCKS).filter((r) => r.deleted_at === null).length).toBe(0);
    await expect(page.locator('#calendarHost [data-status="bloqueo"]')).toHaveCount(0);
  });
});
