/**
 * Compra, preparación, vista de cocinero y cierre de un menú en el navegador (docs/food/API.md §9, recorrido G 37–40 y H 49).
 *
 * Cómo correrlo:   npx playwright test tests/food/planning.spec.ts      (desde la raíz del repo)
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
const MENU_ID = randomUUID();

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

// El puerto se elige dentro de un rango sin puertos que Chromium bloquea por inseguros (5060, 5061, 6000…).
test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [{
      event_id: EVENT_ID, event_code: 'EVT_2026_001', reservation_code: 'RSV_2026_001', title: 'Retiro Test', event_type: 'retiro',
      start_date: day(10), end_date: day(11), arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 22, guest_count_is_final: true, minors_count: 0,
      meal_plan: 'pension_completa', menu_style: 'vegetariano', reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 3,
      dietary_restrictions: [],
    }],
  });
  const tomato = api.seed('food.ingredients', { name: 'Tomate', preferred_unit: 'kg', preferred_supplier: 'Frutería' });
  const rice = api.seed('food.ingredients', { name: 'Arroz', preferred_unit: 'kg' });
  const curry = api.seed('food.recipes', { name: 'Curry de verduras', category: 'principal', base_servings: 20, prep_minutes: 90, status: 'validada', allergens: ['apio'], allergens_checked: true, method: 'Sofreír, añadir el tomate y cocer 40 minutos.' });
  const side = api.seed('food.recipes', { name: 'Arroz especiado', category: 'guarnicion', base_servings: 10, status: 'validada', allergens_checked: true });
  // Curry (20 raciones): 2 kg + 500 g de tomate. Arroz (10 raciones): 1 kg.
  api.seed('food.recipe_ingredients', { recipe_id: curry.id, ingredient_id: tomato.id, quantity: 2, unit: 'kg', position: 1 });
  api.seed('food.recipe_ingredients', { recipe_id: curry.id, ingredient_id: tomato.id, quantity: 500, unit: 'g', position: 2 });
  api.seed('food.recipe_ingredients', { recipe_id: side.id, ingredient_id: rice.id, quantity: 1, unit: 'kg', position: 1 });
  api.seed('food.menus', { id: MENU_ID, event_id: EVENT_ID, source_event_revision: 3 });
  const dinner = api.seed('food.menu_services', { menu_id: MENU_ID, service_date: day(10), service_type: 'cena', service_time: '20:30:00', position: 1 });
  api.seed('food.menu_items', { service_id: dinner.id, recipe_id: curry.id, servings: 22, position: 1 });
  api.seed('food.menu_items', { service_id: dinner.id, recipe_id: side.id, servings: 22, position: 2 });

  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: 5800 + Math.floor(Math.random() * 190), strictPort: false, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
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

const tab = (page: Page, name: string) => page.locator('.menutabs').getByRole('link', { name, exact: true }).click();
const buyRow = (page: Page, name: string) => page.locator('#shoppingList .buyrow', { hasText: name });
const line = (name: string) => {
  const ingredient = api.rows('food.ingredients').find((i) => i.name === name)!;
  return api.rows('food.shopping_list_items').find((i) => i.ingredient_id === ingredient.id && !i.deleted_at)!;
};
async function setQuantity(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.blur();
}

test('vista de cocinero → compra → preparación → cierre', async ({ page, context }) => {
  test.setTimeout(150_000);
  await login(page);

  await test.step('vista de cocinero: ingredientes escalados a las raciones del plato', async () => {
    await page.goto(`${baseURL}/#/menus/${MENU_ID}`);
    await expect(page.locator('.dish')).toHaveCount(2);
    await page.locator('#cookView').click();
    const curry = page.locator('.dish', { hasText: 'Curry de verduras' });
    // 2 kg y 500 g para 20 raciones → 2,2 kg y 550 g para 22.
    await expect(curry.locator('.cookdetails')).toContainText('2,2');
    await expect(curry.locator('.cookdetails')).toContainText('550');
    await expect(curry.locator('.cookdetails')).toContainText('Alérgenos: Apio');
    await expect(curry.locator('.cookdetails')).toContainText('Sofreír, añadir el tomate');
    await expect(page.getByRole('button', { name: 'Añadir plato' })).toHaveCount(0);
    await page.locator('#cookView').click();
    await expect(page.locator('.cookdetails')).toHaveCount(0);
  });

  await test.step('compra: generar y comprobar cantidades agrupadas', async () => {
    await tab(page, 'Compra');
    await expect(page.locator('#shoppingEmpty')).toContainText('la lista es provisional');
    await page.locator('#generateShopping').click();
    // (2 kg + 500 g) × 22 ÷ 20 = 2,75 kg de tomate; 1 kg × 22 ÷ 10 = 2,2 kg de arroz.
    await expect(buyRow(page, 'Tomate')).toContainText('Necesario: 2,75 kg · Frutería');
    await expect(buyRow(page, 'Arroz')).toContainText('Necesario: 2,2 kg');
    await expect(page.getByLabel('Comprar de Tomate', { exact: true })).toHaveValue('2,75');
    await expect(page.locator('#shoppingStatus')).toHaveText('Borrador');
    expect(api.rows('food.shopping_list_items')).toHaveLength(2);
  });

  await test.step('«en casa» recalcula «comprar»; fijar «comprar» a mano lo deja fijo', async () => {
    await setQuantity(page, 'En casa de Arroz', '0,5');
    await expect(page.getByLabel('Comprar de Arroz', { exact: true })).toHaveValue('1,7');
    await expect.poll(() => line('Arroz')).toMatchObject({ stock_quantity: 0.5, purchase_quantity: 1.7, manual_override: false });
    await setQuantity(page, 'Comprar de Tomate', '3');
    await expect(buyRow(page, 'Tomate')).toContainText('Compra fijada');
    await expect.poll(() => line('Tomate')).toMatchObject({ purchase_quantity: 3, manual_override: true });
  });

  await test.step('sin red: marcar comprado queda pendiente y se sincroniza al volver', async () => {
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
    await page.getByLabel('Arroz comprado', { exact: true }).check();
    await expect(buyRow(page, 'Arroz')).toHaveAttribute('data-pending', 'true');
    expect(line('Arroz').status).toBe('pendiente');
    await page.locator('#regenerateShopping').click();
    await expect(page.getByText('Esta acción necesita conexión.')).toBeVisible();
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine);
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
    await expect(buyRow(page, 'Arroz')).toHaveAttribute('data-pending', 'false', { timeout: 15_000 });
    expect(line('Arroz').status).toBe('comprado');
  });

  await test.step('línea a mano para lo que no sale del menú', async () => {
    await page.locator('#addManual').click();
    const dialog = page.getByRole('dialog', { name: 'Añadir a la compra' });
    await dialog.getByLabel('Producto').fill('Servilletas');
    await dialog.getByLabel('Cantidad a comprar').fill('3');
    await dialog.getByLabel('Unidad').selectOption('paquete');
    await page.locator('#saveManual').click();
    await expect(dialog).toBeHidden();
    await expect(buyRow(page, 'Servilletas')).toContainText('A mano');
    await expect.poll(() => line('Servilletas')).toMatchObject({ manual: true, purchase_quantity: 3, unit: 'paquete' });
  });

  await test.step('el menú cambia: la lista avisa y regenerar conserva lo tocado a mano', async () => {
    await tab(page, 'Menú');
    await setQuantity(page, 'Raciones de Curry de verduras', '30');
    await expect.poll(() => api.rows('food.menu_items').some((i) => i.servings === 30)).toBe(true);
    await tab(page, 'Compra');
    await expect(page.locator('#shoppingStale')).toContainText('han cambiado desde que se generó la lista');
    await page.locator('#regenerateShopping').click();
    await expect(page.locator('#shoppingStale')).toHaveCount(0);
    // 2,5 kg × 30 ÷ 20 = 3,75 kg necesarios; «comprar» sigue en los 3 fijados; el arroz sigue comprado y con su «en casa».
    await expect(buyRow(page, 'Tomate')).toContainText('Necesario: 3,75 kg');
    await expect(page.getByLabel('Comprar de Tomate', { exact: true })).toHaveValue('3');
    expect(line('Arroz')).toMatchObject({ status: 'comprado', stock_quantity: 0.5, purchase_quantity: 1.7 });
    await expect(buyRow(page, 'Servilletas')).toBeVisible();
    // «Recalcular» devuelve la compra a lo necesario menos lo que hay en casa.
    await buyRow(page, 'Tomate').getByRole('button', { name: 'Volver a calcular la compra de Tomate' }).click();
    await expect(page.getByLabel('Comprar de Tomate', { exact: true })).toHaveValue('3,75');
  });

  await test.step('revisar y cerrar la lista: cerrada no se edita', async () => {
    await page.locator('#listReviewed').click();
    await expect(page.locator('#shoppingStatus')).toHaveText('Revisada');
    await page.locator('#listClose').click();
    await expect(page.locator('#shoppingStatus')).toHaveText('Cerrada');
    await expect(page.getByLabel('Comprar de Tomate', { exact: true })).toBeDisabled();
    await expect(page.locator('#addManual')).toHaveCount(0);
    await expect.poll(() => api.rows('food.shopping_lists')[0]!.status).toBe('cerrada');
  });

  await test.step('preparación: propuesta por plato, hecho, paso reescrito y paso propio', async () => {
    await tab(page, 'Preparación');
    await page.locator('#generatePreparation').click();
    await expect(page.locator('.preprow')).toHaveCount(2);
    // Cena a las 20:30: el curry pide 90 minutos y el arroz, sin antelación propia, 120.
    await expect(page.locator('.preprow', { hasText: 'Preparar Curry de verduras' }).locator('.preptime')).toHaveText('19:00');
    await expect(page.locator('.preprow', { hasText: 'Preparar Arroz especiado' }).locator('.preptime')).toHaveText('18:30');
    await page.getByLabel('Hecho: Preparar Curry de verduras', { exact: true }).check();
    await expect(page.locator('#preparationProgress')).toHaveText('1 de 2 hechos');

    await page.getByRole('button', { name: 'Editar: Preparar Arroz especiado' }).click();
    const edit = page.getByRole('dialog', { name: 'Editar paso' });
    await edit.getByLabel('Qué hay que hacer').fill('Lavar y poner el arroz');
    await edit.getByLabel('Responsable').fill('Marga');
    await page.locator('#saveStep').click();
    await expect(edit).toBeHidden();
    await expect(page.locator('.preprow', { hasText: 'Lavar y poner el arroz' })).toContainText('Marga · paso propio');

    await page.locator('#addStep').click();
    const added = page.getByRole('dialog', { name: 'Nuevo paso' });
    await added.getByLabel('Qué hay que hacer').fill('Sacar el pan del congelador');
    await added.getByLabel('Día').fill(day(10));
    await added.getByLabel('Hora').fill('08:00');
    await page.locator('#saveStep').click();
    await expect(page.locator('.preprow')).toHaveCount(3);
    await expect(page.locator('.preprow').first()).toContainText('Sacar el pan del congelador');
    await expect.poll(() => api.rows('food.preparation_items').filter((p) => p.manual).length).toBe(2);
  });

  await test.step('cambia la hora de la cena: la propuesta avisa y regenerar respeta lo hecho y lo propio', async () => {
    await tab(page, 'Menú');
    await page.getByLabel('Hora de Cena').fill('21:00');
    await page.getByLabel('Hora de Cena').blur();
    await expect.poll(() => api.rows('food.menu_services')[0]!.service_time).toBe('21:00');
    await tab(page, 'Preparación');
    await expect(page.locator('#preparationStale')).toContainText('El menú ha cambiado');
    await page.locator('#regeneratePreparation').click();
    await expect(page.locator('#preparationStale')).toHaveCount(0);
    await expect(page.locator('.preprow')).toHaveCount(3);
    await expect(page.locator('.preprow', { hasText: 'Preparar Curry de verduras' }).locator('.preptime')).toHaveText('19:00'); // hecho: intacto
    await expect(page.locator('.preprow', { hasText: 'Lavar y poner el arroz' }).locator('.preptime')).toHaveText('18:30'); // propio: intacto
  });

  await test.step('cierre de cocina e Inicio', async () => {
    await tab(page, 'Cierre');
    await page.locator('#closingNotes').fill('Sobraron 4 raciones de curry. Reponer comino.');
    await page.locator('#saveClosing').click();
    await expect.poll(() => api.rows('food.menus')[0]!.closing_notes).toBe('Sobraron 4 raciones de curry. Reponer comino.');
    await page.goto(`${baseURL}/#/`);
    const card = page.locator('#upcoming .eventcard', { hasText: 'Retiro Test' });
    await expect(card).toContainText('Compra');
    await expect(card).toContainText('cerrada');
    await expect(card).toContainText('1 de 3');
  });
});
