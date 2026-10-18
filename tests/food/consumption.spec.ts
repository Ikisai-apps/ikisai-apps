/**
 * Food · R5c en el navegador (390 px): consumo al acabar el servicio. Con el reloj fijado el 20-10-2026 a las 17:00
 * (hora de Madrid): la comida de ese día (14:00) está por confirmar y la del 19, pasadas 24 h, se descuenta sola.
 *
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas («después» de la tabla de R5).
 * Cómo correrlo:   npx playwright test tests/food/consumption.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUSE_MENU_ID, menuItemRef } from '../../supabase/functions/_domain/food/mod.ts';
import { freePort, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const CAPTURES = process.env.FOOD_CAPTURAS;
const NOW = new Date('2026-10-20T17:00:00+02:00');

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let kitchen: string;
let pantry: string;
let rice: string;
let today: string;
let salad: string;
let yesterday: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  const house = api.seed('resources.spaces', { kind: 'edificio', name: 'Casa' }).id;
  kitchen = api.seed('resources.spaces', { kind: 'cocina', name: 'Cocina', parent_id: house }).id;
  pantry = api.seed('resources.spaces', { kind: 'almacen', name: 'Despensa', parent_id: house }).id;
  rice = api.seed('resources.items', { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg' }).id;
  const soon = api.seed('resources.lots', { item_id: rice, code: 'A', expires_on: '2026-10-25' }).id;
  api.seed('resources.movements', { item_id: rice, space_id: kitchen, lot_id: soon, quantity: 1, kind: 'entrada_manual' });
  api.seed('resources.movements', { item_id: rice, space_id: pantry, quantity: 10, kind: 'entrada_manual' });
  const riceIngredient = api.seed('food.ingredients', { name: 'Arroz', preferred_unit: 'kg', item_id: rice }).id;
  const lettuce = api.seed('food.ingredients', { name: 'Lechuga', preferred_unit: 'unidad' }).id;
  const parsley = api.seed('food.ingredients', { name: 'Perejil', preferred_unit: 'g' }).id;
  const plain = api.seed('food.recipes', { name: 'Arroz blanco', category: 'guarnicion', base_servings: 10, status: 'validada', allergens_checked: true }).id;
  const greens = api.seed('food.recipes', { name: 'Ensalada verde', category: 'entrante', base_servings: 10, status: 'validada', allergens_checked: true }).id;
  api.seed('food.recipe_ingredients', { recipe_id: plain, ingredient_id: riceIngredient, quantity: 1, unit: 'kg', position: 1 });
  api.seed('food.recipe_ingredients', { recipe_id: greens, ingredient_id: lettuce, quantity: 2, unit: 'unidad', position: 1 });
  // En la receta, por manojos; su artículo (que crea el enlace al abrir) va en gramos: no se puede descontar.
  api.seed('food.recipe_ingredients', { recipe_id: greens, ingredient_id: parsley, quantity: 1, unit: 'manojo', position: 2 });
  api.seed('food.menus', { id: HOUSE_MENU_ID, kind: 'casa', house_servings: 22 });
  const lunch = api.seed('food.menu_services', { menu_id: HOUSE_MENU_ID, service_date: '2026-10-20', service_type: 'comida', service_time: '14:00', position: 1 }).id;
  today = api.seed('food.menu_items', { service_id: lunch, recipe_id: plain, servings: 22, position: 1 }).id;
  salad = api.seed('food.menu_items', { service_id: lunch, recipe_id: greens, servings: 22, position: 2 }).id;
  const before = api.seed('food.menu_services', { menu_id: HOUSE_MENU_ID, service_date: '2026-10-19', service_type: 'comida', service_time: '14:00', position: 1 }).id;
  yesterday = api.seed('food.menu_items', { service_id: before, recipe_id: plain, servings: 10, position: 1 }).id;
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
  await page.clock.setFixedTime(NOW);
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (CAPTURES) await page.screenshot({ path: path.join(CAPTURES, `${name}.png`), fullPage: true });
}

const moved = (dish: string) => api.rows('resources.movements').filter((m) => m.source_ref === menuItemRef(dish));
const consumption = (dish: string) => api.rows('food.consumptions').find((c) => c.menu_item_id === dish);

test('consumo · solo a las 24 h, «Confirmar consumo» con correcciones y «No se hizo»', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('la comida del 19, sin confirmar a las 24 h, se descuenta sola con lo previsto', async () => {
    await expect.poll(() => consumption(yesterday), { timeout: 20_000 }).toMatchObject({ status: 'confirmado', automatic: true });
    // 1 kg para 10 raciones: primero el kilo que caduca antes, en la cocina.
    expect(moved(yesterday).map((m) => [m.kind, Number(m.quantity), m.space_id])).toEqual([['consumo_servicio', -1, kitchen]]);
  });

  await test.step('Inicio: la comida de hoy, por confirmar', async () => {
    // Con la navegación de la app (recargar, con el reloj fijado días por delante del servidor, cerraría la sesión).
    await page.getByRole('link', { name: 'Inicio' }).first().click();
    const card = page.locator('#consumeDue');
    await expect(card).toContainText('Consumo por confirmar');
    await expect(card.locator('li')).toHaveCount(1);
    await expect(card.locator('li')).toContainText('Menú de casa');
    await capture(page, '11-inicio-consumo');
    await card.locator('li a').click();
    await expect(page).toHaveURL(new RegExp(`#/menus/${HOUSE_MENU_ID}$`));
  });

  await test.step('«Confirmar consumo»: corregir el arroz y marcar que la ensalada no se hizo', async () => {
    const day = page.locator('.menuday[data-day="2026-10-20"]');
    await day.getByRole('button', { name: 'Confirmar consumo de Comida' }).click();
    const sheet = page.locator('#consumptionSheet');
    // 1 kg × 22 ÷ 10 = 2,2 kg. El perejil va por manojos y su artículo en gramos: se ve, pero no se descuenta.
    await expect(sheet.getByLabel('Arroz gastado en Arroz blanco')).toHaveValue('2,2');
    await expect(sheet).toContainText('no se descuenta: no se pasa a g');
    await capture(page, '12-confirmar-consumo');
    await sheet.getByLabel('Arroz gastado en Arroz blanco').fill('2');
    await sheet.getByLabel('Ensalada verde: se hizo').uncheck();
    await page.locator('#confirmConsumption').click();
    await expect(page.locator('.toast.show')).toContainText('Consumo anotado');
    await expect.poll(() => moved(today).reduce((sum, m) => sum + Number(m.quantity), 0), { timeout: 15_000 }).toBe(-2);
    expect(moved(today).every((m) => m.space_id === pantry && m.kind === 'consumo_servicio')).toBe(true);
    await expect.poll(() => [consumption(today)?.status, consumption(salad)?.status]).toEqual(['confirmado', 'omitido']);
    await expect(day.locator('.consumebar .chip')).toHaveText('Consumo anotado');
  });
});
