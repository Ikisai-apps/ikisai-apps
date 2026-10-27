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
  const res = api.serverInsert(RESERVATIONS, { title: 'Jornadas con barra', status: 'confirmada', start_date: inDays(-1), end_date: inDays(3), expected_guests: 200, event_type: 'jornadas_abiertas', priority: 'media' });
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
  // «Desde» lo pone la app con su día (hora de Madrid); cerca de medianoche UTC no coincide con inDays(0)
  const from = await sheet.locator('#walkFrom').inputValue();
  const plusDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  await sheet.locator('#walkSave').click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => api.rows(GUESTS).filter((g) => g.event_id === event.id).map((g) => g.first_name)).toEqual(['Persona Suelta']);
  const assignment = api.rows(ASSIGNMENTS).find((a) => a.event_id === event.id)!;
  expect(assignment).toMatchObject({ bed_id: bed.id, persons: 1, from_date: from, to_date: plusDays(from, 2) });
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

test('servicio de barra: los cierres del día de Flow en la ficha del evento (pedidos, ventas, puntas y lo más vendido)', async ({ page }) => {
  const api = harness.api;
  const res = api.serverInsert(RESERVATIONS, { title: 'Jornadas con cierre', status: 'en_ejecucion', start_date: inDays(-1), end_date: inDays(1), expected_guests: 200, event_type: 'jornadas_abiertas', priority: 'media' });
  api.serverInsert(FINANCE, { id: res.id });
  const event = api.serverInsert(EVENTS, { reservation_id: res.id });
  api.setBarService([
    { event_id: event.id, day: inDays(-1), data: { orders: 87, sales_cents: 104550, sales_by_method: { cash: 60000, bizum: 44550 }, refunds_pending_cents: 350,
      peak_hours: [{ hour: 13, orders: 30 }, { hour: 14, orders: 41 }, { hour: 21, orders: 12 }, { hour: 22, orders: 4 }],
      units_by_product: [{ scope: 'clasico', code: 'A', name: 'Montadito de lomo', units: 64 }, { scope: 'barra', code: 'α', name: 'Caña', units: 120 }] } },
    { event_id: 'otro-evento', day: inDays(-1), data: { orders: 1, sales_cents: 100 } },
  ]);
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/reservas/${res.id}`);
  const bar = page.locator('#blockBarService');
  await expect(bar.locator('#barServiceDays li')).toHaveCount(1);
  await expect(bar).toContainText('87 pedidos');
  await expect(bar).toContainText('1045,50');
  await expect(bar).toContainText('Bizum 445,50');
  await expect(bar).toContainText('Devoluciones pendientes 3,50');
  await expect(bar).toContainText('Horas punta: 13 h (30) · 14 h (41) · 21 h (12)');
  await expect(bar).toContainText('Lo más vendido: α Caña × 120 · A Montadito de lomo × 64');
});

test('ofertas de comida de Food en la ficha del evento, junto a las cartas', async ({ page }) => {
  const api = harness.api;
  const res = api.serverInsert(RESERVATIONS, { title: 'Jornadas con ofertas', status: 'confirmada', start_date: inDays(3), end_date: inDays(5), expected_guests: 80, event_type: 'jornadas_abiertas', priority: 'media' });
  api.serverInsert(FINANCE, { id: res.id });
  const event = api.serverInsert(EVENTS, { reservation_id: res.id });
  api.setOffers([
    { offer_id: 'o2', event_id: event.id, name: 'Barra', meal_groups: [], days: null, services: null, place: 'Terraza', payer: 'huesped', charge_when: 'barra', menu_kind: 'carta', menu_id: 'c1', price_cents: null, active: true, position: 2 },
    { offer_id: 'o1', event_id: event.id, name: 'Cena de ponentes', meal_groups: ['Ponentes'], days: [inDays(3)], services: ['cena'], place: 'Comedor', payer: 'organizador', charge_when: null, menu_kind: 'cerrado', menu_id: 'm1', price_cents: null, active: true, position: 1 },
    { offer_id: 'o3', event_id: 'otro', name: 'De otro evento', meal_groups: [], days: null, services: null, place: null, payer: null, charge_when: null, menu_kind: 'cerrado', menu_id: null, price_cents: null, active: true, position: 0 },
  ]);
  await login(page, harness.baseURL);
  await page.goto(`${harness.baseURL}/#/reservas/${res.id}`);
  const list = page.locator('#foodOffers #offersList li');
  await expect(list).toHaveCount(2);
  await expect(list.nth(0)).toContainText('Cena de ponentes');
  await expect(list.nth(0)).toContainText('Para Ponentes');
  await expect(list.nth(0)).toContainText('Paga el organizador');
  await expect(list.nth(1)).toContainText('Para todos los huéspedes');
  await expect(list.nth(1)).toContainText('Paga el huésped en barra');
  await expect(list.nth(1)).toContainText('Carta');
});

