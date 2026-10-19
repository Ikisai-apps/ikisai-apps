/**
 * O2 en la app del personal (tabla «hoy / después» aprobada el 14-10-2026), con datos sintéticos:
 * - Estancias: crear una estancia de outsider, ver el choque con un retiro (aviso, se guarda) y fijar la cama por defecto;
 * - Inicio: el aviso «estancia que choca con un retiro» lleva a Estancias;
 * - Calendario: las capas de outsiders y staff, con interruptores que se recuerdan;
 * - Ficha: «Visible para huéspedes» con su resumen, y la chip en Reservas; en Alojamiento, el aviso de la estancia.
 *
 * Cómo correrlo:   npx playwright test tests/booking/stays.spec.ts
 */
import { expect, test } from 'playwright/test';
import { ASSIGNMENTS, BEDS, EVENTS, RESERVATIONS, SPACES, inDays, login as loginTo, startHarness, type Harness } from './harness.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

const STAYS = 'booking.stays';
const MARTA = '00000000-0000-4000-8000-0000000000a1';
const ANA = '00000000-0000-4000-8000-0000000000a2';

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

test('estancias: alta, choque como aviso, cama por defecto, capas, retiro abierto y aviso en Alojamiento', async ({ page }) => {
  const api = harness.api;
  api.setHousePeople([{ account_id: MARTA, name: 'Marta Ejemplo', level: 'outsider' }, { account_id: ANA, name: 'Ana Ejemplo', level: 'staff' }]);
  const space = api.serverInsert(SPACES, { name: 'Hab Olivo', kind: 'habitacion', capacity: 1 });
  const bed = api.serverInsert(BEDS, { space_id: space.id, label: 'Cama 1' });
  const res = api.serverInsert(RESERVATIONS, { title: 'Retiro Olivo', status: 'confirmada', start_date: inDays(10), end_date: inDays(12), expected_guests: 8, event_type: 'retiro', priority: 'media', briefing_received: false, archived_at: null });
  const ev = api.serverInsert(EVENTS, { reservation_id: res.id });
  api.serverInsert(ASSIGNMENTS, { event_id: ev.id, space_id: space.id, bed_id: bed.id, group_label: 'Grupo', persons: 1 });
  api.serverInsert(STAYS, { kind: 'staff', account_id: ANA, from_date: inDays(3), to_date: inDays(5), space_id: null, bed_id: null });

  await loginTo(page, harness.baseURL);
  const sync = () => page.getByRole('button', { name: 'Sincronizar ahora' }).click();

  await test.step('Inicio lleva a Estancias', async () => {
    await page.locator('#homeUtilities').evaluate((d) => { (d as HTMLDetailsElement).open = true; }); // utilidades plegadas en Inicio (tanda 27)
    await page.locator('#openStaysHome').click();
    await expect(page.getByRole('heading', { name: 'Estancias' })).toBeVisible();
    await expect(page.locator('[data-stay-id]')).toHaveCount(1);
    await expect(page.locator('[data-kind="staff"] .name')).toHaveText('Ana');
  });

  await test.step('nueva estancia de outsider en la cama del retiro: se guarda y avisa del choque', async () => {
    await page.locator('#newStay').click();
    const dialog = page.getByRole('dialog', { name: 'Nueva estancia' });
    await dialog.getByLabel('Persona').selectOption(MARTA);
    await dialog.getByLabel('Llegada').fill(inDays(11));
    await dialog.getByLabel('Salida').fill(inDays(14));
    await dialog.getByLabel('Cama').selectOption(bed.id);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
    const row = page.locator('[data-kind="outsider"]');
    await expect(row.locator('.name')).toHaveText('Marta');
    await expect(row.locator('[data-clash]')).toHaveText('Choca');
    await expect(row.getByRole('link', { name: 'Retiro Olivo' })).toBeVisible();
    await sync();
    expect(api.rows(STAYS).filter((s) => s.kind === 'outsider').map((s) => [s.account_id, s.bed_id])).toEqual([[MARTA, bed.id]]);
  });

  await test.step('cama por defecto del outsider', async () => {
    await page.getByRole('button', { name: 'Cama por defecto de Marta Ejemplo' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cama por defecto · Marta Ejemplo' });
    await dialog.getByLabel('Cama').selectOption(bed.id);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#outsiderDefaults .row-meta')).toHaveText('Hab Olivo · Cama 1');
  });

  await test.step('Inicio avisa del choque', async () => {
    await page.locator('.nav').getByText('Inicio', { exact: true }).click();
    await expect(page.locator('[data-notice="stays"]')).toContainText('1');
    await page.locator('#otherNotices').evaluate((d) => { (d as HTMLDetailsElement).open = true; }); // avisos que no son de SES ni del portal, plegados (tanda 27)
    await page.locator('[data-notice="stays"] a').click();
    await expect(page.getByRole('heading', { name: 'Estancias' })).toBeVisible();
  });

  await test.step('calendario: capas con interruptor recordado', async () => {
    await page.locator('.nav').getByText('Calendario', { exact: true }).click();
    await expect(page.locator('#calendarLayers')).toBeVisible();
    await expect(page.locator('#layerOutsider')).toBeChecked();
    await page.locator('#layerStaff').uncheck();
    await page.reload();
    await expect(page.locator('#layerStaff')).not.toBeChecked();
    await expect(page.locator('#layerOutsider')).toBeChecked();
    await page.locator('#layerStaff').check();
  });

  await test.step('ficha: visible para huéspedes, chip en Reservas y aviso en Alojamiento', async () => {
    await page.goto(`${harness.baseURL}/#/reservas/${res.id}`);
    await expect(page.locator('#openRetreatState')).toContainText('No visible');
    await expect(page.locator('.lodging-stay')).toContainText('Cama 1: la usa una estancia');
    await page.locator('#editOpenRetreat').click();
    const dialog = page.getByRole('dialog', { name: 'Visible para huéspedes' });
    await dialog.getByLabel('Visible para huéspedes').check();
    await dialog.getByLabel('Resumen público').fill('Meditación y paseos.');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#openRetreatState')).toContainText('Visible');
    await sync();
    expect(api.rows(RESERVATIONS).find((r) => r.id === res.id)).toMatchObject({ guests_visible: true, public_summary: 'Meditación y paseos.' });
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await expect(page.locator('#reservationList .row', { hasText: 'Retiro Olivo' }).locator('[data-open]')).toHaveText('Visible para huéspedes');
  });

  await test.step('«Apuntarme»: Inicio cuenta las solicitudes; aceptar una y pasar otra al organizador', async () => {
    const join = (id: string, names: string[]) => ({ id, kind: 'apuntarme', author: { id: MARTA, name: 'Marta Ejemplo' }, createdAt: new Date().toISOString(),
      operations: [{ op: 'call', procedure: 'booking.join_from_suggestion', args: { reservation_id: res.id, persons: names.map((name) => ({ name })) } }] });
    api.setSuggestions([join('s-uno', ['Marta', 'Nico']), join('s-dos', ['Lía'])]);
    await page.locator('.nav').getByText('Inicio', { exact: true }).click();
    await expect(page.locator('[data-notice="joins"]')).toContainText('2');
    await page.goto(`${harness.baseURL}/#/reservas/${res.id}`);
    const rows = page.locator('#joinRequests [data-join-id]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.name')).toHaveText('Marta, Nico');
    await rows.filter({ hasText: 'Lía' }).getByRole('button', { name: 'Pasar al organizador' }).click();
    await expect(rows).toHaveCount(1);
    await rows.first().getByRole('button', { name: 'Aceptar' }).click();
    await expect(page.locator('#joinRequestsEmpty')).toBeVisible();
    const decisions = api.suggestionDecisions();
    expect(decisions.map((d) => [d.id, d.decision])).toEqual([['s-dos', 'approve'], ['s-uno', 'approve']]);
    expect((decisions[0]!.operations as any)[0].args).toMatchObject({ reservation_id: res.id, mode: 'organizer' });
    expect(decisions[1]!.operations).toBeNull();
  });
});
