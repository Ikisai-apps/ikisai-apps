/**
 * Food · Bloque 2 en el navegador (390 px; MUELA-077 con `PERDIDAS_food_bloque2.md`, aprobado por VG el 20-10-2026):
 * Inicio con lo caducado primero y las máquinas que fallan y hacen falta; la ficha de receta comparada con el próximo
 * servicio (la cantidad del servicio en grande y la de la receta debajo, «Hay bastante» solo sin dudas, «Seguridad»
 * después de la portada y el foco con lo que falta); y Maquinaria con un solo «Dónde está», el stock dicho antes de
 * guardar y el aviso a Tasks con el espacio.
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas a 390 px.
 *
 * Cómo correrlo:   npx playwright test tests/food/bloque2.spec.ts      (desde la raíz del repo)
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
let oil: string;
let pumpkin: string;
let yogurt: string;
let chiller: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  const house = api.seed('resources.spaces', { kind: 'edificio', name: 'Casa' }).id;
  const kitchen = api.seed('resources.spaces', { kind: 'cocina', name: 'Cocina', parent_id: house }).id;
  const office = api.seed('resources.spaces', { kind: 'almacen', name: 'Office', parent_id: kitchen }).id;
  const item = (name: string, base_unit: string, extra: Record<string, unknown> = {}) => api.seed('resources.items', { name, kind: 'ingrediente', base_unit, ...extra }).id;
  oil = item('Aceite de oliva', 'ml', { min_quantity: 5000 });
  pumpkin = item('Calabaza', 'kg');
  const salt = item('Sal', 'g');
  yogurt = item('Yogur natural', 'ud', { tracks_expiry: true });
  const lot = api.seed('resources.lots', { item_id: yogurt, code: 'L1', expires_on: day(-1) }).id;
  const move = (item_id: string, quantity: number, extra: Record<string, unknown> = {}) => api.seed('resources.movements', { item_id, space_id: kitchen, quantity, kind: quantity > 0 ? 'entrada_manual' : 'salida_manual', ...extra });
  move(oil, 1500); move(pumpkin, 10); move(salt, 5); move(salt, -5, { reason: 'uso' }); move(yogurt, 4, { lot_id: lot });
  const ingredient = (name: string, unit: string, item_id: string | null) => api.seed('food.ingredients', { name, preferred_unit: unit, item_id }).id;
  const gOil = ingredient('Aceite de oliva', 'ml', oil);
  const gPumpkin = ingredient('Calabaza', 'kg', pumpkin);
  const gSalt = ingredient('Sal', 'g', salt);
  const gPepper = ingredient('Pimienta', 'g', null);
  const recipe = (name: string) => api.seed('food.recipes', { name, category: 'principal', base_servings: 10, status: 'validada', diet_tags: [], allergens: [], allergens_checked: true }).id;
  const cream = recipe('Crema de calabaza');
  const mash = recipe('Puré de patata');
  for (const [position, [ingredient_id, quantity, unit]] of ([[gOil, 50, 'ml'], [gPumpkin, 2, 'kg'], [gSalt, 5, 'g'], [gPepper, 1, 'g']] as const).entries()) {
    api.seed('food.recipe_ingredients', { recipe_id: cream, ingredient_id, quantity, unit, position: position + 1 });
  }
  api.seed('food.recipe_ingredients', { recipe_id: mash, ingredient_id: gOil, quantity: 30, unit: 'ml', position: 1 });
  api.seed('food.menus', { id: HOUSE_MENU_ID, kind: 'casa', house_servings: 24 });
  const lunch = api.seed('food.menu_services', { menu_id: HOUSE_MENU_ID, service_date: day(3), service_type: 'comida', service_time: '14:00:00', position: 1 }).id;
  api.seed('food.menu_items', { service_id: lunch, recipe_id: cream, servings: 24, position: 1 });
  api.seed('food.menu_items', { service_id: lunch, recipe_id: mash, servings: 24, position: 2 });
  // Máquinas: el abatidor averiado hace falta en la crema; el horno tiene artículo sin espacio y no cuadra con su stock.
  const machine = (name: string, extra: Record<string, unknown>) => api.seed('resources.items', { name, kind: 'maquina', base_unit: 'ud', ...extra }).id;
  const chillerItem = machine('Abatidor', { default_space_id: office });
  const ovenItem = machine('Horno', {});
  api.seed('resources.movements', { item_id: chillerItem, space_id: office, quantity: 1, kind: 'entrada_manual' });
  api.seed('resources.movements', { item_id: ovenItem, space_id: office, quantity: 1, kind: 'entrada_manual' });
  chiller = api.seed('food.equipment', { name: 'Abatidor', quantity: 1, status: 'averiado', location: 'Office', item_id: chillerItem }).id;
  api.seed('food.equipment', { name: 'Horno', quantity: 2, status: 'operativo', location: 'Office', item_id: ovenItem });
  api.seed('food.recipe_equipment', { recipe_id: cream, equipment_id: chiller, quantity_required: 1 });
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

test('Inicio · lo ya caducado primero, lo bajo mínimo con «A la compra» y la máquina que falla y hace falta', async ({ page }) => {
  await login(page);
  const rows = page.locator('#pantry .fd-urgent-row');
  await expect(rows.first()).toHaveAttribute('data-item-id', yogurt);
  await expect(rows.first()).toContainText('Caducado el');
  await expect(rows.first()).toContainText('4 unidades en la cocina');
  await expect(rows.nth(1)).toHaveAttribute('data-item-id', oil);
  await expect(rows.nth(1)).toContainText('Bajo mínimo · quedan 1,5 l (mínimo 5 l)');
  await expect(page.locator('#machinesNow')).toContainText('Abatidor: averiado');
  // Plegado, pero el aviso de las máquinas que fallan se ve en rojo sin abrirlo.
  await expect(page.locator('#machinesDown')).toBeVisible();
  await expect(page.locator('#machinesDown')).toHaveText('1 máquina falla');
  await expect(page.locator('#homeMore .cardgrid')).toBeHidden();
  await capture(page, 'b2-01-inicio');
  await page.locator('#homeMore summary').click();
  await expect(page.locator('#homeMore .cardgrid')).toBeVisible();
});

test('ficha de receta · el próximo servicio, la cantidad de la receta debajo y «Hay bastante» solo sin dudas', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/recetario`);
  await page.locator('#recipeGrid .recipecard', { hasText: 'Crema de calabaza' }).click();
  const ficha = page.getByRole('dialog', { name: 'Crema de calabaza' });
  await expect(ficha.locator('.cover-stats')).toContainText(', comida · 24 raciones');
  await expect(ficha.locator('.cover-stats')).toContainText('2/3 en casa · 1 falta · 1 bajo mínimo');
  const row = (name: string) => ficha.locator('table.ingredients tr', { hasText: name });
  await expect(row('Aceite de oliva').locator('.fd-needqty strong')).toHaveText('120 ml');
  await expect(row('Aceite de oliva').locator('.fd-recipeqty')).toHaveText('Receta, 10 raciones: 50 ml');
  await expect(row('Aceite de oliva').locator('.fd-needstate')).toHaveText('En casa 1,5 l · también lo usa puré de patata del mismo servicio');
  await expect(row('Calabaza').locator('.fd-needstate')).toHaveText('Hay bastante');
  await expect(row('Calabaza').locator('.athome')).toHaveText('En casa: 10 kg');
  await expect(row('Sal').locator('.fd-needstate')).toHaveText('No hay en casa');
  await expect(row('Pimienta').locator('.fd-needstate')).toHaveText('Sin seguimiento en Recursos');
  // «Seguridad» se queda tal cual, después de la portada y antes de los ingredientes.
  const order = await ficha.locator('.ficha-block h4').allTextContents();
  expect(order.indexOf('Seguridad')).toBeLessThan(order.indexOf('Ingredientes'));
  // El foco: solo lo que falta o está bajo mínimo, de uno en uno.
  await expect(ficha.locator('.focus-count')).toHaveText('1 de 2 por hacer');
  await expect(ficha.locator('.focus-title')).toHaveText('Aceite de oliva');
  await expect(ficha.locator('.focus-btn', { hasText: 'Ver en la Despensa' })).toBeVisible();
  await capture(page, 'b2-02-ficha');
  // La fila entera lleva a la Despensa.
  await row('Calabaza').locator('td').first().click({ position: { x: 4, y: 4 } });
  await expect(page).toHaveURL(new RegExp(`#/despensa\\?articulo=${pumpkin}$`));
});

test('Maquinaria · un solo «Dónde está», el stock antes de guardar y el aviso a Tasks con el espacio', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/maquinaria`);
  const rows = page.locator('#equipmentList .row');
  await expect(rows.filter({ hasText: 'Abatidor' })).toContainText('Cocina › Office');
  await expect(rows.filter({ hasText: 'Abatidor' })).not.toContainText('Casa › Cocina');
  await rows.filter({ hasText: 'Horno' }).getByRole('button', { name: 'Editar Horno' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar máquina' });
  await expect(dialog.getByText('Dónde está', { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('Espacio', { exact: true })).toHaveCount(0);
  await expect(dialog.locator('#oldLocation')).toContainText('Antes: “Office”');
  await expect(dialog.getByRole('textbox', { name: 'Ubicación', exact: true })).toHaveCount(0);
  await expect(dialog.locator('#machineStock')).toHaveText('No cuadra: la ficha dice 2 · en Recursos hay 1. Elige dónde está para ajustarlo al guardar.');
  await capture(page, 'b2-03-maquinaria-ficha');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await rows.filter({ hasText: 'Abatidor' }).getByRole('button', { name: 'Editar Abatidor' }).click();
  const fault = page.waitForRequest((r) => r.url().includes(`/equipment/${chiller}/fault`));
  await page.locator('#reportFault').click();
  expect((await fault).postDataJSON().location).toBe('Cocina › Office');
});
