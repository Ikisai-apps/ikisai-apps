/**
 * Recorrido G–H de Ikisai Food en el navegador: evento de Booking → menú con propuesta de servicios → platos desde el
 * recetario visual → avisos de restricciones → validar → Booking cambia las personas → aviso, reabrir, revisar y validar.
 *
 * Cómo correrlo:   npx playwright test tests/food/menus.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const EVENT_ID = randomUUID();

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [{
      event_id: EVENT_ID, event_code: 'EVT_2026_001', reservation_code: 'RSV_2026_001', title: 'Retiro Test', event_type: 'retiro',
      start_date: day(10), end_date: day(12), arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 22, guest_count_is_final: true, minors_count: 0,
      meal_plan: 'pension_completa', menu_style: 'vegetariano', reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 3,
      dietary_restrictions: [
        { type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1, kitchen_notes: null },
        { type: 'vegano', subject: null, severity: null, servings: 2, kitchen_notes: null },
      ],
    }],
  });
  api.seed('food.recipes', { name: 'Curry de verduras', category: 'principal', base_servings: 20, status: 'validada', diet_tags: ['vegano', 'vegetariano'], allergens: [], allergens_checked: true });
  api.seed('food.recipes', { name: 'Pasta al pesto', category: 'principal', base_servings: 20, status: 'validada', diet_tags: ['vegetariano'], allergens: ['gluten', 'frutos_de_cascara', 'lacteos'], allergens_checked: true });
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: 5300 + Math.floor(Math.random() * 500), strictPort: false, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
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

const menu = () => api.rows('food.menus')[0]!;

async function addDish(page: Page, recipe: string): Promise<void> {
  await page.locator('.service').first().getByRole('button', { name: 'Añadir plato' }).click();
  await page.getByRole('dialog').getByRole('button', { name: `Añadir ${recipe}` }).click();
  await expect(page.locator('.service').first().locator('.dish', { hasText: recipe })).toBeVisible();
}

async function validate(page: Page, acknowledgements: number): Promise<void> {
  await page.locator('#validateMenu').click();
  const dialog = page.getByRole('dialog', { name: 'Antes de validar' });
  await expect(dialog.locator('#ackList input')).toHaveCount(acknowledgements);
  await expect(page.locator('#confirmValidate')).toBeDisabled();
  for (const box of await dialog.locator('#ackList input').all()) await box.check();
  await page.locator('#confirmValidate').click();
  await expect(page.locator('#menuStatus')).toHaveText('Validado');
}

test('evento → menú → avisos → validar → el evento cambia → revisar y validar de nuevo', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('Inicio y Eventos enseñan el retiro tal como lo publica Booking', async () => {
    await login(page);
    const card = page.locator('#upcoming .eventcard', { hasText: 'Retiro Test' });
    await expect(card).toContainText('22 personas · Pensión completa');
    await expect(card).toContainText('pendiente');
    await page.goto(`${baseURL}/#/eventos`);
    const row = page.locator('#eventList .row', { hasText: 'Retiro Test' });
    await expect(row).toContainText('Sin menú');
    await expect(row).toContainText('2 restricciones');
    await expect(page.locator('#eventsStamp')).toContainText('Datos de los eventos a fecha de');
  });

  await test.step('crear el menú con la propuesta de servicios del régimen', async () => {
    await page.locator('#eventList .row', { hasText: 'Retiro Test' }).click();
    const sheet = page.getByRole('dialog', { name: 'Retiro Test' });
    await expect(sheet).toContainText('1 alergia a pistacho (grave)');
    await expect(sheet).toContainText('2 veganos');
    await expect(sheet.locator('input[type=checkbox]')).toHaveCount(5); // cena · desayuno, comida, cena · desayuno
    await page.locator('#createMenu').click();
    await expect(page).toHaveURL(/#\/menus\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Retiro Test', level: 2 })).toBeVisible();
    await expect(page.locator('#menuStatus')).toHaveText('Borrador');
    await expect(page.locator('.service')).toHaveCount(5);
    await expect(page.locator('.menuday')).toHaveCount(3);
    await expect(page.locator('#menuRestrictions')).toContainText('1 alergia a pistacho');
    await expect.poll(() => api.rows('food.menu_services').length).toBe(5);
    expect(menu()).toMatchObject({ event_id: EVENT_ID, source_event_revision: 3, status: 'borrador' });
    expect((menu().source_event_snapshot as { guest_count: number }).guest_count).toBe(22);
  });

  await test.step('platos desde el recetario visual, con las raciones del evento; el aviso de alergia aparece', async () => {
    await addDish(page, 'Curry de verduras');
    await expect(page.locator('.dish', { hasText: 'Curry de verduras' }).locator('.servings')).toHaveValue('22');
    await expect(page.locator('#menuWarnings')).toHaveCount(0);
    await addDish(page, 'Pasta al pesto');
    await expect(page.locator('#menuWarnings')).toContainText('«Pasta al pesto» declara frutos de cáscara: 1 alergia a pistacho.');
    // El pesto es para dos: se cambian las raciones en línea.
    const pesto = page.locator('.dish', { hasText: 'Pasta al pesto' }).locator('.servings');
    await pesto.fill('2');
    await pesto.blur();
    await expect.poll(() => api.rows('food.menu_items').find((i) => i.servings === 2)).toBeTruthy();
  });

  await test.step('validar exige aceptar el aviso; después el menú queda bloqueado', async () => {
    await validate(page, 1);
    expect(menu()).toMatchObject({ status: 'validado', source_event_revision: 3 });
    expect(menu().validated_warnings).toHaveLength(1);
    await expect(page.locator('.dish .servings').first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Añadir plato' })).toHaveCount(0);
  });

  await test.step('Booking pasa de 22 a 25 personas: aviso con lo que cambió, sin tocar el menú validado', async () => {
    api.updateEvent(EVENT_ID, { guest_count: 25 });
    await page.reload();
    const banner = page.locator('#menuStale');
    await expect(banner).toContainText('La información del evento ha cambiado.');
    await expect(banner).toContainText('Personas: 22 → 25');
    await expect(page.locator('#menuStatus')).toHaveText('Validado');
    expect(menu().source_event_revision).toBe(3);
    await page.goto(`${baseURL}/#/`);
    await expect(page.locator('#upcoming .eventcard', { hasText: 'Retiro Test' })).toContainText('desactualizado');
    await page.goBack();
  });

  await test.step('reabrir, ajustar raciones, dar por revisado el cambio y validar de nuevo', async () => {
    await page.locator('#reopenStale').click();
    await expect(page.locator('#menuStatus')).toHaveText('Por revisar');
    const curry = page.locator('.dish', { hasText: 'Curry de verduras' }).locator('.servings');
    await expect(curry).toBeEnabled();
    await curry.fill('25');
    await curry.blur();
    await expect.poll(() => api.rows('food.menu_items').find((i) => i.servings === 25)).toBeTruthy();
    await page.locator('#acknowledgeEvent').click();
    await expect(page.locator('#menuStale')).toBeEmpty();
    await expect.poll(() => menu().source_event_revision).toBe(4);
    await validate(page, 1);
    expect(menu()).toMatchObject({ status: 'validado', source_event_revision: 4 });
    expect((menu().source_event_snapshot as { guest_count: number }).guest_count).toBe(25);
  });

  await test.step('sin red: el menú se consulta, pero cambiar de estado pide conexión', async () => {
    await page.reload();
    await expect(page.locator('.dish')).toHaveCount(2);
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
    await page.locator('#reopenMenu').click();
    await expect(page.getByText('Esta acción necesita conexión.')).toBeVisible();
    await expect(page.locator('#menuStatus')).toHaveText('Validado');
    await page.goto(`${baseURL}/#/eventos`);
    await expect(page.locator('#eventList .row', { hasText: 'Retiro Test' })).toContainText('Menú: validado');
    await context.setOffline(false);
  });
});
