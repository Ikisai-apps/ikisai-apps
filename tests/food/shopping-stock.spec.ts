/**
 * Food · R5b en el navegador (390 px): la compra con el stock de Recursos. «En casa» llega del inventario de la cocina,
 * el mínimo se suma, lo que está bajo mínimo y ningún menú pide va en «Reponer», y «comprado» da entrada al stock.
 *
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas («después» de la tabla de R5).
 * Cómo correrlo:   npx playwright test tests/food/shopping-stock.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUSE_MENU_ID, shoppingItemRef } from '../../supabase/functions/_domain/food/mod.ts';
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
let pantry: string;
let saltItem: string;

// Tanda 40: «En casa» y «Comprar» van en la hoja del «⋯» de cada baldosa.
const openMore = (page: Page, name: string) => page.getByRole('button', { name: `Más de ${name}`, exact: true }).click();
const closeMore = (page: Page) => page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).last().click();

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  const house = api.seed('resources.spaces', { kind: 'edificio', name: 'Casa' }).id;
  const kitchen = api.seed('resources.spaces', { kind: 'cocina', name: 'Cocina', parent_id: house }).id;
  pantry = api.seed('resources.spaces', { kind: 'almacen', name: 'Despensa', parent_id: house }).id;
  const riceItem = api.seed('resources.items', { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg', min_quantity: 1 }).id;
  saltItem = api.seed('resources.items', { name: 'Sal', kind: 'ingrediente', base_unit: 'g', min_quantity: 500 }).id;
  const rice = api.seed('food.ingredients', { name: 'Arroz', preferred_unit: 'kg', item_id: riceItem }).id;
  api.seed('food.ingredients', { name: 'Sal', preferred_unit: 'g', preferred_supplier: 'Mercado', item_id: saltItem });
  api.seed('resources.movements', { item_id: riceItem, space_id: pantry, quantity: 3, kind: 'entrada_manual' });
  api.seed('resources.movements', { item_id: saltItem, space_id: kitchen, quantity: 100, kind: 'entrada_manual' });
  const recipe = api.seed('food.recipes', { name: 'Arroz blanco', category: 'guarnicion', base_servings: 10, status: 'validada', allergens_checked: true }).id;
  api.seed('food.recipe_ingredients', { recipe_id: recipe, ingredient_id: rice, quantity: 1, unit: 'kg', position: 1 });
  api.seed('food.menus', { id: HOUSE_MENU_ID, kind: 'casa', house_servings: 22 });
  const lunch = api.seed('food.menu_services', { menu_id: HOUSE_MENU_ID, service_date: day(0), service_type: 'comida', service_time: '14:00', position: 1 }).id;
  api.seed('food.menu_items', { service_id: lunch, recipe_id: recipe, servings: 22, position: 1 });
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

test('compra con stock · «en casa» del inventario, mínimo, «Reponer» y «comprado» al stock', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('generar: «en casa» llega del inventario y el mínimo se suma', async () => {
    await page.goto(`${baseURL}/#/menus/${HOUSE_MENU_ID}/compra`);
    await page.locator('#generateShopping').click();
    const rice = page.locator('#shoppingList .buyrow', { hasText: 'Arroz' });
    // 1 kg × 22 ÷ 10 = 2,2 kg; en casa 3 kg (despensa); mínimo 1 kg → comprar 0,2 kg.
    await expect(rice).toContainText('Necesario: 2,2 kg · Mínimo 1 kg');
    await openMore(page, 'Arroz');
    await expect(page.getByLabel('En casa de Arroz', { exact: true })).toHaveValue('3');
    await expect(page.getByLabel('Comprar de Arroz', { exact: true })).toHaveValue('0,2');
    await closeMore(page);
  });

  await test.step('«Reponer»: la sal, bajo mínimo y sin menú que la pida, aparte', async () => {
    const salt = page.locator('#restockList .buyrow', { hasText: 'Sal' });
    await expect(salt).toContainText('Bajo mínimo: 500 g · Mercado');
    await openMore(page, 'Sal');
    await expect(page.getByLabel('En casa de Sal', { exact: true })).toHaveValue('100');
    await expect(page.getByLabel('Comprar de Sal', { exact: true })).toHaveValue('400');
    await closeMore(page);
    await expect(page.locator('#shoppingList .buyrow', { hasText: 'Sal' })).toHaveCount(0);
    await expect(page.locator('.toast.show')).toHaveCount(0, { timeout: 10_000 });
    await capture(page, '10-compra-con-stock');
  });

  await test.step('«comprado» entra al stock (sin coste, para que Finance le añada el coste); desmarcar lo saca', async () => {
    const line = api.rows('food.shopping_list_items').find((i) => i.restock)!;
    // El carrito de la baldosa (tanda 40) hace lo que hacía la casilla «Comprado».
    await page.getByRole('button', { name: 'Marcar comprado: Sal', exact: true }).click();
    await expect.poll(() => api.rows('resources.movements').filter((m) => m.source_ref === shoppingItemRef(line.id as string)).map((m) => [m.kind, Number(m.quantity), m.space_id, m.source_app, m.unit_cost ?? null]), { timeout: 15_000 })
      .toEqual([['entrada_manual', 400, pantry, 'food', null]]);
    await expect(page.locator('#restockList .buyrow', { hasText: 'Sal' })).toContainText('En el carro');
    // H-C5: cambiar «Comprar» en una línea ya comprada corrige la Despensa con la diferencia, con la misma referencia.
    await openMore(page, 'Sal');
    await page.getByLabel('Comprar de Sal', { exact: true }).fill('500');
    await page.getByLabel('Comprar de Sal', { exact: true }).blur();
    await expect.poll(() => api.rows('resources.movements').filter((m) => m.source_ref === shoppingItemRef(line.id as string)).map((m) => [m.kind, Number(m.quantity)]), { timeout: 15_000 })
      .toEqual([['entrada_manual', 400], ['entrada_manual', 100]]);
    await closeMore(page);
    await page.getByRole('button', { name: 'Quitar del carro: Sal', exact: true }).click();
    await expect.poll(() => api.rows('resources.movements').filter((m) => m.source_ref === shoppingItemRef(line.id as string)).reduce((sum, m) => sum + Number(m.quantity), 0), { timeout: 15_000 }).toBe(0);
    expect(api.rows('resources.movements').filter((m) => m.item_id === saltItem && m.kind === 'salida_manual').map((m) => m.reason)).toEqual(['otro']);
  });

  await test.step('ficha de receta: «En casa» de cada ingrediente; Inicio: la despensa', async () => {
    await page.goto(`${baseURL}/#/recetario`);
    await page.locator('#recipeGrid .recipecard', { hasText: 'Arroz blanco' }).click();
    const ficha = page.getByRole('dialog', { name: 'Arroz blanco' });
    await expect(ficha.locator('table.ingredients .athome')).toHaveText('En casa: 3 kg');
    await ficha.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
    await page.goto(`${baseURL}/#/`);
    const pantryCard = page.locator('#pantry');
    await expect(pantryCard).toContainText('Bajo mínimo: Sal.');
    await expect(pantryCard.locator('dt', { hasText: 'Bajo mínimo' }).locator('xpath=following-sibling::dd[1]')).toHaveText('1');
    await capture(page, '13-inicio-despensa');
  });
});
