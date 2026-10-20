/**
 * Food · tanda 40 (MUELA-093): la Compra «Estantería» con el envase. Estanterías por tienda, el envase dibujado y su
 * hoja («Guardar en la Despensa» crea una fila nueva y habitual sin tocar las que hay), la lista que redondea al momento,
 * el dinero con «≈» y los precios que faltan, el carrito y el lote con «Deshacer», y el lector sin mandos.
 * Capturas a 390 y 1440 con FOOD_CAPTURAS.
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
let flourItem: string;
let oilUnit: string;
let rice: string;

test.beforeAll(async () => {
  rice = crypto.randomUUID();
  api = await startFakeApi({
    users: [USER],
    // El arroz tiene compra en Invoices (su precio); la harina, ni compra ni precio: «sin precio».
    purchases: [{ allocation_id: 'a1', target_kind: 'ingredient', target_id: rice, invoice_date: day(-10), supplier_name: 'Mercadona', line_description: 'Arroz',
      allocated_quantity: 5, unit: 'kg', allocated_amount: 7.5 }],
  });
  const house = api.seed('resources.spaces', { kind: 'edificio', name: 'Casa' }).id;
  api.seed('resources.spaces', { kind: 'almacen', name: 'Despensa', parent_id: house });
  const riceItem = api.seed('resources.items', { name: 'Arroz', kind: 'ingrediente', base_unit: 'kg' }).id;
  flourItem = api.seed('resources.items', { name: 'Harina', kind: 'ingrediente', base_unit: 'g' }).id;
  const oilItem = api.seed('resources.items', { name: 'Aceite', kind: 'ingrediente', base_unit: 'l' }).id;
  // El aceite ya tiene su envase habitual, con precio; la harina, una conversión de recetas que no es un envase.
  oilUnit = api.seed('resources.item_units', { item_id: oilItem, unit: 'garrafa de 5 l', factor: 5, usual: true, price: 21.5 }).id;
  api.seed('resources.item_units', { item_id: flourItem, unit: 'taza', factor: 120 });
  api.seed('food.ingredients', { id: rice, name: 'Arroz', preferred_unit: 'kg', preferred_supplier: 'Mercadona', item_id: riceItem });
  const flour = api.seed('food.ingredients', { name: 'Harina', preferred_unit: 'kg', preferred_supplier: 'Mercadona', item_id: flourItem }).id;
  const oil = api.seed('food.ingredients', { name: 'Aceite', preferred_unit: 'l', preferred_supplier: 'Makro', item_id: oilItem }).id;
  const salt = api.seed('food.ingredients', { name: 'Sal', preferred_unit: 'g' }).id;
  const recipe = api.seed('food.recipes', { name: 'Arroz con todo', category: 'principal', base_servings: 10, status: 'validada', allergens_checked: true }).id;
  api.seed('food.recipe_ingredients', { recipe_id: recipe, ingredient_id: rice, quantity: 1, unit: 'kg', position: 1 });
  api.seed('food.recipe_ingredients', { recipe_id: recipe, ingredient_id: flour, quantity: 500, unit: 'g', position: 2 });
  api.seed('food.recipe_ingredients', { recipe_id: recipe, ingredient_id: oil, quantity: 100, unit: 'ml', position: 3 });
  api.seed('food.recipe_ingredients', { recipe_id: recipe, ingredient_id: salt, quantity: 20, unit: 'g', position: 4 });
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
  if (!CAPTURES) return;
  await page.screenshot({ path: path.join(CAPTURES, `${name}-390.png`), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: path.join(CAPTURES, `${name}-360.png`), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(CAPTURES, `${name}-1440.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
}

const tileOf = (page: Page, name: string) => page.locator('#shoppingList .buyrow', { hasText: name });
const line = (name: string) => {
  const ingredient = api.rows('food.ingredients').find((i) => i.name === name)!;
  return api.rows('food.shopping_list_items').find((i) => i.ingredient_id === ingredient.id && !i.deleted_at)!;
};

test('la Compra «Estantería»: tiendas, envase, dinero, carrito y lote', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);

  await test.step('estanterías por tienda, el envase dibujado y el dinero sin sumar 0 €', async () => {
    await page.goto(`${baseURL}/#/menus/${HOUSE_MENU_ID}/compra`);
    await page.locator('#generateShopping').click();
    const shelves = page.locator('#shoppingList .shelf-row');
    await expect(shelves).toHaveCount(3);
    await expect(shelves.locator('h3')).toHaveText(['Makro', 'Mercadona', 'Sin tienda']);
    // Aceite: 0,22 l → una garrafa de 5 l (redondeo del servidor), con su precio.
    await expect(tileOf(page, 'Aceite')).toContainText('1 garrafa de 5 l');
    await expect(tileOf(page, 'Aceite')).toContainText('≈ 21,50 €');
    await expect(tileOf(page, 'Aceite').getByRole('img')).toHaveAttribute('aria-label', /1 garrafa de 5 l: se usa 220 ml/);
    // Arroz: 2,2 kg al precio de la última compra (1,50 €/kg); harina y sal, sin precio y nunca 0 €.
    await expect(tileOf(page, 'Arroz')).toContainText('≈ 3,30 €');
    await expect(tileOf(page, 'Harina')).toContainText('sin precio');
    await expect(tileOf(page, 'Harina')).toContainText('Sin envase: lo justo');
    await expect(page.locator('#shoppingMoney')).toContainText('≈ 24,80 €');
    await expect(page.locator('#shoppingMoney')).toContainText('faltan precios de 2 productos');
    await expect(page.locator('#shoppingMoney')).not.toContainText('0,00 €');
    await expect(page.locator('.shelf-row', { hasText: 'Mercadona' }).locator('.shelf-head')).toContainText('2 de 2 · ≈ 3,30 € · faltan precios de 1 producto');
    await capture(page, '40-compra');
  });

  await test.step('«¿Cómo se vende?»: guardar en la Despensa crea una fila nueva y habitual, y la lista redondea al momento', async () => {
    await page.getByRole('button', { name: '¿Cómo se vende Harina?', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '¿Cómo se vende harina?' });
    await sheet.getByRole('button', { name: /paquete de 1 kg/ }).click();
    await expect(sheet).toContainText('compras');
    await sheet.getByLabel('Precio del envase en euros').fill('1,20');
    await capture(page, '41-envase');
    await sheet.getByRole('button', { name: 'Guardar en la Despensa' }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => api.rows('resources.item_units').filter((u) => u.item_id === flourItem && !u.deleted_at).map((u) => [u.unit, Number(u.factor), u.usual ?? false, u.price === null || u.price === undefined ? null : Number(u.price)]).sort())
      .toEqual([['paquete de 1 kg', 1000, true, 1.2], ['taza', 120, false, null]]);
    // 500 g × 22 / 10 = 1,1 kg → 2 paquetes de 1 kg, y sobran 900 g.
    await expect.poll(() => Number(line('Harina').purchase_quantity)).toBe(2);
    await expect(tileOf(page, 'Harina')).toContainText('2 paquetes de 1 kg');
    await expect(tileOf(page, 'Harina')).toContainText('sobra 900 g');
    await expect(tileOf(page, 'Harina')).toContainText('≈ 2,40 €');
    // El envase del aceite (otra fila) no ha cambiado.
    expect(api.rows('resources.item_units').find((u) => u.id === oilUnit)).toMatchObject({ factor: 5, usual: true });
  });

  await test.step('el carrito y el lote de una tienda, con «Deshacer»', async () => {
    await page.getByRole('button', { name: 'Marcar comprado: Aceite', exact: true }).click();
    await expect(tileOf(page, 'Aceite')).toHaveAttribute('data-status', 'comprado');
    await expect(tileOf(page, 'Aceite')).toContainText('En el carro');
    // En una línea comprada el dibujo del envase no es botón.
    await expect(tileOf(page, 'Aceite').locator('button.tile-media')).toHaveCount(0);
    await page.getByRole('button', { name: /^Comprado lo de Mercadona · 2/ }).click();
    await expect.poll(() => [line('Arroz').status, line('Harina').status]).toEqual(['comprado', 'comprado']);
    await expect.poll(() => api.rows('resources.movements').filter((m) => m.source_ref === shoppingItemRef(String(line('Harina').id))).map((m) => Number(m.quantity))).toEqual([2000]);
    await capture(page, '42-lote');
    await page.locator('.toast.show').getByRole('button', { name: 'Deshacer' }).last().click();
    await expect.poll(() => [line('Arroz').status, line('Harina').status]).toEqual(['pendiente', 'pendiente']);
    await expect.poll(() => api.rows('resources.movements').filter((m) => m.source_ref === shoppingItemRef(String(line('Harina').id))).reduce((s, m) => s + Number(m.quantity), 0)).toBe(0);
  });

  await test.step('el «⋯»: «En casa», «Comprar» y el estado de siempre en su hoja', async () => {
    await tileOf(page, 'Sal').getByRole('button', { name: 'Más de Sal', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Sal' });
    await expect(sheet.getByLabel('Comprar de Sal', { exact: true })).toHaveValue('44');
    await sheet.getByLabel('En casa de Sal', { exact: true }).fill('10');
    await sheet.getByLabel('En casa de Sal', { exact: true }).blur();
    await expect(sheet.getByLabel('Comprar de Sal', { exact: true })).toHaveValue('34');
    await expect(tileOf(page, 'Sal')).toContainText('En casa 10 g');
    await capture(page, '43-mas');
    await expect(sheet.getByLabel('Estado de Sal')).toHaveValue('pendiente');
    await sheet.getByLabel('Estado de Sal').selectOption('recibido');
    await expect(sheet).toBeHidden();
    await expect(tileOf(page, 'Sal')).toHaveAttribute('data-status', 'recibido');
  });
});
