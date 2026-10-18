/**
 * Food · Despensa en el navegador (390 px; aprobada el 18-10-2026): pestaña propia, catálogo del kit acotado a la cocina,
 * filtro desde Inicio, ficha con el origen de los movimientos, «A la compra», «Gastar» y recuento a ciegas.
 *
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas («después» de la tabla de Despensa).
 * Cómo correrlo:   npx playwright test tests/food/pantry.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUSE_MENU_ID, weekDays } from '../../supabase/functions/_domain/food/mod.ts';
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
let rice: string;
let yogurt: string;
let riceIngredient: string;
let kitchen: string;
let pantry: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  const house = api.seed('resources.spaces', { kind: 'edificio', name: 'Casa' }).id;
  kitchen = api.seed('resources.spaces', { kind: 'cocina', name: 'Cocina', parent_id: house }).id;
  pantry = api.seed('resources.spaces', { kind: 'almacen', name: 'Despensa', parent_id: house }).id;
  const workshop = api.seed('resources.spaces', { kind: 'almacen', name: 'Taller', parent_id: house }).id;
  rice = api.seed('resources.items', { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg', min_quantity: 5 }).id;
  yogurt = api.seed('resources.items', { name: 'Yogur natural', kind: 'ingrediente', base_unit: 'ud', tracks_expiry: true }).id;
  const cement = api.seed('resources.items', { name: 'Cemento', kind: 'material', base_unit: 'kg' }).id;
  const lot = api.seed('resources.lots', { item_id: yogurt, code: 'L1', expires_on: day(2) }).id;
  riceIngredient = api.seed('food.ingredients', { name: 'Arroz', preferred_unit: 'kg', item_id: rice }).id;
  // El arroz entró por una compra de Food (lista de esta semana del menú de casa): la ficha enlaza ese origen.
  const week = weekDays(day(0), 0);
  api.seed('food.menus', { id: HOUSE_MENU_ID, kind: 'casa', house_servings: 10 });
  const list = api.seed('food.shopping_lists', { menu_id: HOUSE_MENU_ID, status: 'borrador', generated_at: new Date().toISOString(), source_revisions: {}, period_start: week[0], period_end: week[6] }).id;
  const line = api.seed('food.shopping_list_items', { shopping_list_id: list, ingredient_id: riceIngredient, unit: 'kg', purchase_quantity: 3, required_quantity: 0, status: 'comprado' }).id;
  api.seed('resources.movements', { item_id: rice, space_id: pantry, quantity: 3, kind: 'entrada_manual', source_app: 'food', source_ref: `shopping_item:${line}` });
  api.seed('resources.movements', { item_id: yogurt, space_id: kitchen, lot_id: lot, quantity: 6, kind: 'entrada_manual' });
  api.seed('resources.movements', { item_id: cement, space_id: workshop, quantity: 25, kind: 'entrada_manual' });
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

const row = (page: Page, id: string) => page.locator(`.stk-row[data-item-id="${id}"]`);
const sheet = (page: Page) => page.locator('.sheetback.show .sheet').last();

test('Despensa · pestaña, catálogo de cocina, filtro desde Inicio, ficha, «A la compra», «Gastar» y recuento', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);

  await test.step('seis pestañas que se leen a 390 px, con Despensa entre Recetario y Maquinaria', async () => {
    const labels = page.locator('.nav a');
    await expect(labels).toHaveText(['Inicio', 'Eventos', 'Menús', 'Recetario', 'Despensa', 'Maquinaria']);
    for (const label of await labels.all()) {
      const box = await label.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(48); // objetivo táctil
      expect(await label.evaluate((a) => a.scrollWidth <= a.clientWidth + 1)).toBe(true); // el texto no se corta
    }
  });

  await test.step('Inicio → «Bajo mínimo»: Despensa con ese filtro', async () => {
    await page.locator('#pantry a', { hasText: '1' }).first().click();
    await expect(page).toHaveURL(/#\/despensa\?filtro=bajo_minimo$/);
    await expect(row(page, rice)).toBeVisible();
    await expect(row(page, rice)).toContainText('Bajo mínimo');
    await expect(row(page, yogurt)).toHaveCount(0);
  });

  await test.step('catálogo: solo la cocina, sus despensas y cámaras; ingredientes y bebidas', async () => {
    // Desde la pestaña: sin el filtro que puso el enlace de Inicio.
    await page.locator('.nav a', { hasText: 'Inicio' }).click();
    await page.locator('.nav a', { hasText: 'Despensa' }).click();
    await expect(row(page, rice)).toBeVisible();
    await expect(row(page, yogurt)).toBeVisible();
    await expect(page.locator('.stk-row', { hasText: 'Cemento' })).toHaveCount(0);
    await capture(page, '30-despensa');
  });

  await test.step('ficha: el origen del arroz es la lista de la compra de esta semana', async () => {
    await row(page, rice).locator('.stk-open').click();
    await expect(sheet(page)).toContainText('Lista');
    await capture(page, '31-despensa-ficha');
    await page.keyboard.press('Escape');
  });

  await test.step('«A la compra»: lo que falta hasta el mínimo, a la lista de esta semana', async () => {
    await row(page, rice).getByRole('button', { name: 'A la compra' }).click();
    await expect(page.locator('.toast.show')).toContainText('Arroz: a la lista de');
    await expect.poll(() => api.rows('food.shopping_list_items').filter((l) => l.ingredient_id === riceIngredient && l.manual).map((l) => [Number(l.purchase_quantity), l.unit])).toEqual([[2, 'kg']]);
  });

  await test.step('«Gastar» yogur: salida con motivo «uso»', async () => {
    await row(page, yogurt).getByRole('button', { name: 'Gastar' }).click();
    const d = sheet(page);
    await d.getByLabel('Cuánto sale', { exact: true }).fill('2');
    await d.getByRole('button', { name: 'Registrar salida' }).click();
    await expect.poll(() => api.rows('resources.movements').filter((m) => m.item_id === yogurt && m.kind === 'salida_manual').map((m) => [Number(m.quantity), m.reason])).toEqual([[-2, 'uso']]);
  });

  await test.step('recuento a ciegas de la cocina: el yogur que queda, y el ajuste al cerrar', async () => {
    await page.locator('#countPantry').click();
    await page.locator('#countPlaces button', { hasText: 'Cocina' }).click();
    const d = sheet(page);
    await expect(d.locator('.stk-count-lines')).not.toContainText('calculado');
    const line = d.locator(`.stk-count-line[data-item-id="${yogurt}"]`);
    await line.locator('input').fill('3');
    await line.locator('input').press('Enter');
    await capture(page, '32-despensa-recuento');
    await d.getByRole('button', { name: 'Revisar y cerrar' }).click();
    await d.getByRole('button', { name: 'Cerrar y ajustar' }).click();
    await expect.poll(() => api.rows('resources.movements').filter((m) => m.item_id === yogurt && m.kind === 'ajuste_recuento').map((m) => Number(m.quantity)), { timeout: 15_000 }).toEqual([-1]);
  });
});
