/**
 * Food · la carta en el navegador (390 px): el bloque «Cartas» de Menús, la vista de una carta con sus bloques, el precio
 * y «Disponible» (que llegan al servidor), «Nueva carta», y el evento familiar, que come del menú de casa.
 *
 * Cómo correrlo:   npx playwright test tests/food/carta.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, day, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const FAMILY = randomUUID();

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
const carta = randomUUID();
let serrano: string;
let agua: string;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [{
      event_id: FAMILY, event_code: null, reservation_code: null, title: 'Visita de la familia', event_type: 'familiar', start_date: day(3), end_date: day(4),
      arrival_time: '12:00:00', departure_time: '18:00:00', guest_count: 6, guest_count_is_final: true, minors_count: 2, meal_plan: 'pension_completa',
      menu_style: null, reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 1, dietary_restrictions: [],
    }],
    // El plan de bandejas lo calcula el servidor (food.carta_prep_totals_projection): aquí, dos filas de muestra.
    reads: {
      'food.carta_prep_totals_projection': [
        { menu_id: carta, component_key: 'k-jamon', item_id: null, ingredient_id: null, name: 'Jamón serrano', unit: 'kg', need_total: 1.5, mesa: 0.45, nevera: 0.3, fresco: 0.75, convertible: true, station: 2 },
        { menu_id: carta, component_key: 'k-tomate', item_id: null, ingredient_id: null, name: 'Tomate', unit: 'kg', need_total: null, mesa: null, nevera: null, fresco: null, convertible: false, station: 2 },
        { menu_id: carta, component_key: 'k-agua', item_id: null, ingredient_id: null, name: 'Agua, botella pequeña', unit: 'ud', need_total: 60, mesa: null, nevera: null, fresco: null, convertible: true, station: null },
      ],
    },
  });
  const recipe = api.seed('food.recipes', { name: 'Montadito Serrano', public_name: 'Serrano', category: 'entrante', base_servings: 1, status: 'en_prueba', diet_tags: [], allergens: [], allergens_checked: false }).id;
  const water = api.seed('resources.items', { name: 'Agua, botella pequeña', kind: 'bebida', base_unit: 'ud' }).id;
  api.seed('food.menus', { id: carta, kind: 'carta', name: 'Barra de prueba', status: 'borrador' });
  serrano = api.seed('food.carta_lines', { menu_id: carta, recipe_id: recipe, scope: 'clasico', code: 'A', sale_price_cents: 250, active: true, position: 1 }).id;
  agua = api.seed('food.carta_lines', { menu_id: carta, item_id: water, scope: 'barra', code: 'A', name: 'Agua, botella pequeña', sale_price_cents: 100, active: true, position: 9 }).id;
  process.env.VITE_API_PROXY = api.url;
  await buildFoodApp();
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

async function login(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

const line = (id: string) => api.rows('food.carta_lines').find((l) => l.id === id)!;

test('carta · en Menús, su vista con precio y disponibilidad, y «Nueva carta»', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('Menús: el bloque «Cartas» con la carta guardada', async () => {
    await page.goto(`${baseURL}/#/menus`);
    const list = page.locator('#cartaList');
    await expect(list.getByText('Barra de prueba')).toBeVisible();
    await expect(list.getByText('Guardada, sin evento')).toBeVisible();
    await list.getByText('Barra de prueba').click();
  });

  await test.step('la vista: bloques, nombre de la receta, «Alérgenos sin revisar»', async () => {
    await expect(page.locator('#cartaTitle')).toHaveText('Barra de prueba');
    await expect(page.locator('#carta-clasico')).toContainText('Clásicos · 1');
    await expect(page.locator('#carta-barra')).toContainText('Barra · 1');
    await expect(page.locator(`#carta-line-${serrano}`)).toContainText('Serrano');
    await expect(page.locator(`#carta-line-${serrano}`)).toContainText('Alérgenos sin revisar');
  });

  await test.step('precio y disponibilidad llegan al servidor', async () => {
    const price = page.getByLabel('Precio de Serrano en euros');
    await price.fill('2,80');
    await price.press('Tab');
    await expect.poll(() => line(serrano).sale_price_cents).toBe(280);
    await page.locator(`#carta-active-${agua}`).uncheck();
    await expect.poll(() => line(agua).active).toBe(false);
  });

  await test.step('Previsión: unidades esperadas, reparto y plan de bandejas', async () => {
    await page.locator('nav.menutabs a[data-tab="prevision"]').click();
    // Por persona × asistentes = total (hacia arriba), y al revés; los dos se guardan.
    await page.locator('#cartaAttendance').fill('199');
    await page.locator('#cartaAttendance').press('Tab');
    await expect.poll(() => api.rows('food.menus').find((m) => m.id === carta)?.expected_attendance).toBe(199);
    const perPerson = page.getByLabel('Por persona de Serrano');
    await perPerson.fill('0.5');
    await perPerson.press('Tab');
    await expect.poll(() => [line(serrano).per_person, line(serrano).expected_units]).toEqual([0.5, 100]);
    const units = page.getByLabel('Unidades esperadas de Serrano');
    await units.fill('60');
    await units.press('Tab');
    await expect.poll(() => [line(serrano).expected_units, line(serrano).per_person]).toEqual([60, 0.302]);
    // Al cambiar los asistentes, el total sale otra vez del «por persona».
    await page.locator('#cartaAttendance').fill('300');
    await page.locator('#cartaAttendance').press('Tab');
    await expect.poll(() => line(serrano).expected_units).toBe(91);
    await page.locator('#split-mesa').fill('40');
    await page.locator('#split-fresco').fill('40');
    await expect(page.locator('#splitSum')).toHaveText('Suma: 100 %');
    await page.locator('#splitSave').click();
    await expect.poll(() => api.rows('food.menus').find((m) => m.id === carta)?.prep_split).toEqual({ mesa: 40, nevera: 20, fresco: 40 });
    const table = page.locator('#trayTable');
    await expect(table).toContainText('Jamón serrano');
    await expect(table).toContainText('450 g');
    await expect(table).toContainText('falta la conversión');
    await expect(page.locator('#trayMissing')).toContainText('1 ingrediente sin conversión');
    await expect(page.locator('#trayPlan')).toContainText('Agua, botella pequeña: 60 ud');
  });

  await test.step('Compra: la lista de la carta sale de la previsión', async () => {
    await page.locator('nav.menutabs a[data-tab="compra"]').click();
    await expect(page.getByText('Se calcula con la previsión')).toBeVisible();
  });

  await test.step('«Nueva carta» desde Menús', async () => {
    await page.goto(`${baseURL}/#/menus`);
    await page.locator('#newCarta').click();
    await page.locator('#cartaNewName').fill('Carta del domingo');
    await page.locator('#cartaNewSave').click();
    await expect(page.locator('#cartaTitle')).toHaveText('Carta del domingo');
    expect(api.rows('food.menus').some((m) => m.kind === 'carta' && m.name === 'Carta del domingo')).toBe(true);
  });
});

test('evento familiar · come del menú de casa: sin «Crear menú» y con el enlace al menú de casa', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto(`${baseURL}/#/eventos`);
  const row = page.locator('#eventList, .list').getByText('Visita de la familia').first();
  await expect(row).toBeVisible();
  await expect(page.getByText('Menú de casa').first()).toBeVisible();
  await row.click();
  await expect(page.locator('#familyEvent')).toContainText('come del menú de casa');
  await expect(page.locator('#createMenu')).toHaveCount(0);
  await page.locator('#openHouseMenu').click();
  await expect(page).toHaveURL(/#\/menus\/f00dca5a-0000-4000-8000-000000000001$/);
});
