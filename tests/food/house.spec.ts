/**
 * Food · O3a en el navegador (390 px): menú de casa por semanas, «+ Comida», plato rápido con solo el nombre, «Hoy en
 * casa» en Inicio y en Menús, y la salvaguarda: en un retiro el plato rápido se ve atenuado y lleva a completarlo.
 *
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas de cada pantalla («después» de la tabla de O3).
 *
 * Cómo correrlo:   npx playwright test tests/food/house.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUSE_MENU_ID, weekDays } from '../../supabase/functions/_domain/food/mod.ts';
import { freePort, day, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const RETREAT = randomUUID();
const CAPTURES = process.env.FOOD_CAPTURAS;

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let retreatMenu: string;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [{
      event_id: RETREAT, event_code: null, reservation_code: null, title: 'Retiro Test', event_type: 'retiro', start_date: day(10), end_date: day(12),
      arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 22, guest_count_is_final: true, minors_count: 0, meal_plan: 'pension_completa',
      menu_style: null, reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 1, dietary_restrictions: [],
    }],
  });
  const curry = api.seed('food.recipes', { name: 'Curry de verduras', category: 'principal', base_servings: 10, status: 'validada', diet_tags: [], allergens: [], allergens_checked: true, prep_minutes: 60 }).id;
  const rice = api.seed('food.ingredients', { name: 'Arroz', preferred_unit: 'kg' }).id;
  api.seed('food.recipe_ingredients', { recipe_id: curry, ingredient_id: rice, quantity: 1, unit: 'kg', position: 1 });
  retreatMenu = api.seed('food.menus', { event_id: RETREAT, source_event_revision: 1, status: 'borrador' }).id;
  api.seed('food.menu_services', { menu_id: retreatMenu, service_date: day(10), service_type: 'cena', service_time: '20:30:00', position: 1 });
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

const house = () => api.rows('food.menus').find((m) => m.id === HOUSE_MENU_ID);

test('menú de casa · por semanas, «+ Comida» y plato rápido; en un retiro, el rápido lleva a completarlo', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('Menús: el de casa, fijo arriba; se crea solo al abrirlo, sin evento ni pestañas', async () => {
    await page.goto(`${baseURL}/#/menus`);
    await expect(page.locator('#houseMenu')).toContainText('Menú de casa');
    await expect(page.locator('#menuList li')).toHaveCount(1); // los retiros, como siempre
    await page.locator('#houseMenu li').click();
    await expect(page).toHaveURL(new RegExp(`#/menus/${HOUSE_MENU_ID}$`));
    await expect(page.getByRole('heading', { name: 'Menú de casa', level: 2 })).toBeVisible();
    await expect.poll(() => house()?.kind).toBe('casa');
    expect(house()).toMatchObject({ event_id: null, status: 'borrador' });
    // Menú, Compra y Preparación (O3b); sin Organizador ni Cierre.
    await expect(page.locator('.menutabs a:visible')).toHaveText(['Menú', 'Compra', 'Preparación']);
    await expect(page.locator('#validateMenu')).toHaveCount(0);
    await expect(page.locator('#menuRestrictions')).toBeHidden();
    await expect(page.locator('#menuShare')).toBeHidden();
  });

  await test.step('personas en casa: raciones por defecto', async () => {
    await page.locator('#houseServings').fill('5');
    await page.locator('#houseServings').blur();
    await expect.poll(() => Number(house()?.house_servings)).toBe(5);
  });

  await test.step('semanas de lunes a domingo, con hoy marcado; «+ Comida» en un toque', async () => {
    await expect(page.locator('#weekLabel')).toHaveText('Esta semana');
    await expect(page.locator('.menuday')).toHaveCount(7);
    const today = page.locator(`.menuday[data-day="${day(0)}"]`);
    await expect(today.locator('.todaychip')).toHaveText('Hoy');
    await capture(page, '10-menu-casa');
    await today.getByRole('button', { name: /^Añadir comida/ }).click();
    await expect(today.locator('.service h4')).toHaveText(['Comida']);
    await expect.poll(() => api.rows('food.menu_services').find((s) => s.menu_id === HOUSE_MENU_ID)).toMatchObject({ service_date: day(0), service_type: 'comida', service_time: '14:00' });
    await page.locator('#weekNext').click();
    await expect(page.locator('#weekLabel')).toHaveText('La semana que viene');
    await expect(page.locator('.menuday .service')).toHaveCount(0);
    await page.locator('#weekToday').click();
    await expect(page.locator('#weekLabel')).toHaveText('Esta semana');
  });

  await test.step('plato rápido: escribir el nombre y un toque', async () => {
    const today = page.locator(`.menuday[data-day="${day(0)}"]`);
    await today.getByRole('button', { name: 'Añadir plato' }).click();
    const dialog = page.getByRole('dialog', { name: 'Añadir plato · Comida' });
    await expect(dialog).toContainText('5 raciones por defecto');
    await dialog.getByRole('searchbox', { name: 'Buscar receta' }).fill('Gazpacho');
    await expect(dialog.locator('#quickDish')).toHaveText('Añadir «Gazpacho» como plato rápido');
    await capture(page, '11-plato-rapido');
    await dialog.locator('#quickDish').click();
    const dish = today.locator('.dish', { hasText: 'Gazpacho' });
    await expect(dish).toContainText('Rápida · por completar');
    await expect(dish.locator('.servings')).toHaveValue('5');
    const recipe = api.rows('food.recipes').find((r) => r.name === 'Gazpacho')!;
    expect(recipe).toMatchObject({ quick: true, category: 'principal', base_servings: 5, status: 'en_prueba', allergens_checked: false });
    // Si el nombre ya es una receta, no se ofrece duplicarla.
    await today.getByRole('button', { name: 'Añadir plato' }).click();
    await page.getByRole('dialog').getByRole('searchbox', { name: 'Buscar receta' }).fill('curry de verduras');
    await expect(page.getByRole('dialog').locator('#quickDish')).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).first().click();
  });

  await test.step('Inicio y Menús enseñan lo de hoy en casa', async () => {
    await page.goto(`${baseURL}/#/`);
    await expect(page.locator('#houseToday')).toContainText('Comida · Gazpacho');
    await capture(page, '12-inicio-casa');
    await page.goto(`${baseURL}/#/menus`);
    await expect(page.locator('#houseMenu')).toContainText('Hoy: Comida · Gazpacho');
    await capture(page, '13-menus-casa');
  });

  await test.step('en un retiro el plato rápido sale atenuado y lleva al Recetario a completarlo', async () => {
    await page.goto(`${baseURL}/#/menus/${retreatMenu}`);
    await page.locator('.service').first().getByRole('button', { name: 'Añadir plato' }).click();
    const dialog = page.getByRole('dialog', { name: 'Añadir plato · Cena' });
    await expect(dialog.getByRole('button', { name: 'Añadir Curry de verduras' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Añadir Gazpacho' })).toHaveCount(0);
    const blocked = dialog.locator('.recipecard.disabled', { hasText: 'Gazpacho' });
    await expect(blocked).toContainText('Rápida: complétala (alérgenos e ingredientes) para usarla en un retiro.');
    await dialog.getByRole('searchbox', { name: 'Buscar receta' }).fill('Tortilla');
    await expect(dialog.locator('#quickDish')).toHaveCount(0); // en un retiro no hay plato rápido
    await dialog.getByRole('searchbox', { name: 'Buscar receta' }).fill('');
    await capture(page, '14-retiro-rapida');
    await blocked.getByRole('link', { name: 'Completar en el Recetario' }).click();
    const sheet = page.getByRole('dialog', { name: 'Gazpacho' });
    await expect(sheet.locator('#quickNotice')).toContainText('Complétalo (alérgenos e ingredientes) para usarlo en un retiro.');
    await capture(page, '15-ficha-rapida');
    await sheet.locator('#completeQuick').click();
    await expect(page.getByRole('dialog', { name: 'Editar receta' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
  });

  await test.step('Recetario: chip y filtro «Rápidas por completar»', async () => {
    await page.goto(`${baseURL}/#/recetario`);
    const cards = page.locator('#recipeGrid .recipecard');
    await expect(cards.filter({ hasText: 'Gazpacho' })).toContainText('Rápida · por completar');
    await page.locator('#openFilters').click();
    await page.locator('#filterStatus').selectOption('rapida');
    await page.locator('#filtersDone').click();
    await expect(cards.locator('strong')).toHaveText(['Gazpacho']);
  });

  await test.step('O3b · compra y preparación de casa por los días elegidos (por defecto, esta semana)', async () => {
    await page.goto(`${baseURL}/#/menus/${HOUSE_MENU_ID}`);
    const today = page.locator(`.menuday[data-day="${day(0)}"]`);
    await today.getByRole('button', { name: 'Añadir plato' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Añadir Curry de verduras' }).click();
    await expect(today.locator('.dish', { hasText: 'Curry de verduras' }).locator('.servings')).toHaveValue('5');

    await page.locator('.menutabs').getByRole('link', { name: 'Compra', exact: true }).click();
    await expect(page.locator('#periodThisWeek')).toHaveClass(/ok/);
    await expect(page.locator('#shoppingEmpty')).toContainText('Todavía no hay lista para');
    await page.locator('#generateShopping').click();
    await expect(page.locator('#shoppingList')).toContainText('Arroz');
    const list = () => api.rows('food.shopping_lists').find((l) => l.menu_id === HOUSE_MENU_ID)!;
    const week = weekDays(day(0));
    await expect.poll(() => [list()?.period_start, list()?.period_end]).toEqual([week[0], week[6]]);
    await capture(page, '16-compra-casa');
    // Otros días: otra lista; la de esta semana sigue ahí, en las chips.
    await page.locator('#periodNextWeek').click();
    await expect(page.locator('#shoppingEmpty')).toContainText('Todavía no hay lista para');
    await expect(page.locator('.houselists button')).toHaveCount(1);
    await page.locator('.houselists button').first().click();
    await expect(page.locator('#shoppingList')).toContainText('Arroz');

    await page.locator('.menutabs').getByRole('link', { name: 'Preparación', exact: true }).click();
    await expect(page.locator('#preparationEmpty')).toContainText('Todavía no hay pasos para');
    await page.locator('#generatePreparation').click();
    await expect(page.locator('#preparationDays')).toContainText('Preparar Curry de verduras');
    await expect(page.locator('#preparationDays')).toContainText('Preparar Gazpacho');
    await capture(page, '17-preparacion-casa');
    await page.locator('#periodNextWeek').click();
    await expect(page.locator('#preparationEmpty')).toBeVisible();
  });
});
