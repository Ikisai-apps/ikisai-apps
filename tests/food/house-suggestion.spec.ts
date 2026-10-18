/**
 * Food · O3c en el navegador (390 px): los platos que sugieren las personas de fuera para el menú de casa. Entrada en
 * Menús y en la cabecera del menú de casa, la cola del kit con lo que pide cada uno, y aprobar o descartar.
 *
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas de cada pantalla («después» de la tabla de O3c).
 *
 * Cómo correrlo:   npx playwright test tests/food/house-suggestion.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUSE_MENU_ID } from '../../supabase/functions/_domain/food/mod.ts';
import { freePort, day, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const CAPTURES = process.env.FOOD_CAPTURAS;

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let gazpacho: string;
let lentils: string;
let curryRecipe: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  curryRecipe = api.seed('food.recipes', { name: 'Curry de verduras', category: 'principal', base_servings: 10, status: 'validada', allergens_checked: true }).id;
  api.seed('food.menus', { id: HOUSE_MENU_ID, kind: 'casa', house_servings: 6 });
  // Hoy: siempre en la semana que enseña el menú de casa (el día siguiente, un domingo, ya es la semana que viene).
  gazpacho = api.seedSuggestion({ name: 'Gazpacho', date: day(0), service: 'comida', author: 'Marta' });
  api.seedSuggestion({ name: 'Curry de verduras', date: day(2), service: 'cena', author: 'Íñigo' });
  lentils = api.seedSuggestion({ name: 'Lentejas', date: day(3), service: 'comida', author: 'Marta' });
  process.env.VITE_API_PROXY = api.url;
  await buildFoodApp();
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
  if (CAPTURES) mkdirSync(CAPTURES, { recursive: true });
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

async function capture(page: Page, name: string): Promise<void> {
  if (CAPTURES) await page.screenshot({ path: path.join(CAPTURES, `${name}.png`), fullPage: true });
}

const card = (page: Page, id: string) => page.locator(`.pl-card[data-id="${id}"]`);

test('platos sugeridos · entrada en Menús y en el menú de casa; ver qué piden; aprobar y descartar', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('Menús: «Platos sugeridos» bajo el menú de casa, con las pendientes', async () => {
    await page.goto(`${baseURL}/#/menus`);
    const row = page.locator('#houseMenu li', { hasText: 'Platos sugeridos' });
    await expect(row).toContainText('3 pendientes de revisar');
    await expect(page.locator('.pagehead p').first()).toHaveText('El menú de cada evento. Se crean desde Eventos.');
    await capture(page, '18-menus-sugerencias');
    await page.goto(`${baseURL}/#/menus/${HOUSE_MENU_ID}`);
    await expect(page.locator('#houseSuggestionsChip')).toHaveText('3 platos sugeridos por revisar');
    await page.locator('#houseSuggestionsChip').click();
    await expect(page).toHaveURL(/#\/menus\/sugerencias$/);
    await expect(page.getByRole('heading', { name: 'Platos sugeridos', level: 2 })).toBeVisible();
    await expect(page.locator('.pl-card')).toHaveCount(3);
  });

  await test.step('el detalle dice qué plato, cuándo y si la receta ya existe o será rápida', async () => {
    await card(page, gazpacho).locator('.pl-open').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet.locator('.suggestiondish')).toContainText('Gazpacho');
    await expect(sheet.locator('.suggestiondish')).toContainText('Comida del');
    await expect(sheet.locator('.suggestiondish')).toContainText('Nueva: se creará como plato rápido. Luego complétalo (alérgenos e ingredientes).');
    await capture(page, '19-sugerencia-detalle');
    await sheet.getByRole('button', { name: /^Aprobar/ }).click();
    await expect(page.getByRole('alertdialog')).toContainText('¿Aprobar esta propuesta?');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta aprobada.');
    // El servidor pone el plato en ese día con las personas en casa y una receta rápida.
    await expect.poll(() => api.rows('food.recipes').find((r) => r.name === 'Gazpacho')?.quick).toBe(true);
    const service = api.rows('food.menu_services').find((s) => s.menu_id === HOUSE_MENU_ID && s.service_date === day(0))!;
    expect(service).toMatchObject({ service_type: 'comida', service_time: '14:00' });
    expect(Number(api.rows('food.menu_items').find((i) => i.service_id === service.id)!.servings)).toBe(6);
  });

  await test.step('con una receta del Recetario, lo dice; descartar con comentario', async () => {
    const curry = page.locator('.pl-card', { hasText: 'Curry de verduras' });
    await curry.locator('.pl-open').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet.locator('.suggestiondish')).toContainText('Ya está en el Recetario: se usará esa.');
    await page.keyboard.press('Escape');
    await card(page, lentils).getByRole('button', { name: /^Descartar/ }).click();
    await page.locator('#proposalComment').fill('Esta semana ya hay legumbre.');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta descartada.');
    await expect.poll(() => api.suggestions().find((s) => s.id === lentils)?.status).toBe('rejected');
    expect(api.rows('food.recipes').some((r) => r.name === 'Lentejas')).toBe(false);
    expect(api.rows('food.recipes').filter((r) => r.name === 'Curry de verduras').map((r) => r.id)).toEqual([curryRecipe]);
  });

  await test.step('aprobadas, con el enlace al menú de casa; el plato está en su día', async () => {
    await page.locator('.pl-tabs button', { hasText: 'Aprobadas' }).click();
    await expect(card(page, gazpacho)).toBeVisible();
    await card(page, gazpacho).getByRole('link', { name: 'Ver en el menú de casa' }).click();
    await expect(page).toHaveURL(new RegExp(`#/menus/${HOUSE_MENU_ID}$`));
    await expect(page.locator(`.menuday[data-day="${day(0)}"]`)).toContainText('Gazpacho');
    await expect(page.locator('#houseSuggestionsChip')).toHaveText('1 plato sugerido por revisar');
    await capture(page, '20-menu-casa-con-sugerido');
  });
});
