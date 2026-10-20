/**
 * Food · caracterización antes de R5 (RECURSOS.md §6 «Food» y §17), en el navegador a 390 px: lo que hoy sale de
 * `food.ingredients` y `food.equipment` y que en R5 pasará a artículos de Recursos. No se toca en R5: debe seguir en
 * verde después (solo cambia la fuente del dato, no lo que ve el usuario).
 *
 * - Inicio: recuento de equipos y averiados.
 * - Maquinaria: lista, orden, datos y estados; ficha de edición.
 * - Recetario: en la ficha, la maquinaria que falta o está averiada; en el formulario, ingredientes con sugerencias, sin
 *   distinguir mayúsculas, unidad preferida, ingrediente nuevo una sola vez y las ocho unidades; maquinaria con unidades.
 * - Vista de cocinero: la maquinaria del plato.
 * - Compra: «En casa» se escribe a mano (en R5 vendrá del stock).
 *
 * Compra, costes y avisos a Tasks ya están caracterizados en `planning.spec.ts` y `smoke.spec.ts`.
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas («hoy» de la tabla de R5).
 *
 * Cómo correrlo:   npx playwright test tests/food/caracterizacion-r5.spec.ts      (desde la raíz del repo)
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
let rice: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  rice = api.seed('food.ingredients', { name: 'Arroz', preferred_unit: 'kg', preferred_supplier: 'Mercado' }).id;
  const pistachio = api.seed('food.ingredients', { name: 'Pistachos tostados', preferred_unit: 'g' }).id;
  api.seed('food.ingredients', { name: 'Tomate', preferred_unit: 'kg', preferred_supplier: 'Frutería' });
  const oven = api.seed('food.equipment', { name: 'Horno', category: 'Horno', quantity: 2, capacity: '70 cm', location: 'Cocina principal', status: 'operativo' }).id;
  api.seed('food.equipment', { name: 'Freidora', category: 'Fuego', quantity: 1, status: 'limitado' });
  const chiller = api.seed('food.equipment', { name: 'Abatidor', quantity: 1, location: 'Office', status: 'averiado' }).id;
  const cake = api.seed('food.recipes', { name: 'Bizcocho de pistacho', category: 'postre', base_servings: 10, status: 'validada', allergens: ['frutos_cascara'], allergens_checked: true }).id;
  api.seed('food.recipe_ingredients', { recipe_id: cake, ingredient_id: pistachio, quantity: 200, unit: 'g', position: 1 });
  api.seed('food.recipe_equipment', { recipe_id: cake, equipment_id: oven, quantity_required: 3 });
  api.seed('food.recipe_equipment', { recipe_id: cake, equipment_id: chiller, quantity_required: 1 });
  api.seed('food.menus', { id: HOUSE_MENU_ID, kind: 'casa', house_servings: 10 });
  const lunch = api.seed('food.menu_services', { menu_id: HOUSE_MENU_ID, service_date: day(0), service_type: 'comida', service_time: '14:00', position: 1 }).id;
  api.seed('food.menu_items', { service_id: lunch, recipe_id: cake, servings: 20, position: 1 });
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

const value = (page: Page, term: string) => page.locator('dt', { hasText: term }).locator('xpath=following-sibling::dd[1]');

test('caracterización R5 · Inicio, Maquinaria, ficha y formulario de receta, y vista de cocinero', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('Inicio: cuántos equipos hay y cuántos están averiados o fuera de servicio', async () => {
    await expect(value(page, 'Equipos')).toHaveText('3');
    await expect(value(page, 'Averiados o fuera de servicio')).toHaveText('1');
    await capture(page, '01-inicio');
  });

  await test.step('Maquinaria: por orden alfabético, con unidades, tipo y ubicación; el estado, si no es operativo', async () => {
    await page.goto(`${baseURL}/#/maquinaria`);
    const rows = page.locator('#equipmentList .row');
    await expect(rows.locator('.name')).toHaveText(['Abatidor', 'Freidora', 'Horno']);
    await expect(rows.nth(0)).toContainText('1 unidad');
    await expect(rows.nth(0)).toContainText('Office');
    await expect(rows.nth(0).locator('.row-title .chip')).toHaveText('Averiado');
    await expect(rows.nth(1).locator('.row-title .chip')).toHaveText('Limitado');
    await expect(rows.nth(2)).toContainText('2 unidades');
    await expect(rows.nth(2)).toContainText('Cocina principal');
    await expect(rows.nth(2).locator('.row-title .chip')).toHaveCount(0);
    await capture(page, '02-maquinaria');

    await rows.nth(2).getByRole('button', { name: 'Editar Horno' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editar máquina' });
    for (const [role, label] of [['textbox', 'Nombre'], ['textbox', 'Tipo'], ['spinbutton', 'Cantidad'], ['textbox', 'Capacidad'], ['textbox', 'Ubicación'], ['combobox', 'Estado'], ['textbox', 'Notas']] as const) {
      await expect(dialog.getByRole(role, { name: label, exact: true })).toBeVisible();
    }
    await expect(dialog.getByRole('textbox', { name: 'Capacidad', exact: true })).toHaveValue('70 cm');
    await expect(dialog.getByRole('combobox', { name: 'Estado', exact: true }).locator('option')).toHaveText(['Operativo', 'Limitado', 'Averiado', 'Fuera de servicio']);
    await expect(dialog.locator('#reportFault')).toHaveCount(0);
    await capture(page, '03-maquinaria-ficha');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await rows.nth(0).getByRole('button', { name: 'Editar Abatidor' }).click();
    await expect(page.locator('#reportFault')).toHaveText('Avisar a Tasks para repararla');
    await page.keyboard.press('Escape');
  });

  await test.step('ficha de receta: ingredientes, y la maquinaria que no alcanza o está averiada', async () => {
    await page.goto(`${baseURL}/#/recetario`);
    await page.locator('#recipeGrid .recipecard', { hasText: 'Bizcocho de pistacho' }).click();
    const ficha = page.getByRole('dialog', { name: 'Bizcocho de pistacho' });
    await expect(ficha.locator('table.ingredients tr').first()).toContainText('Pistachos tostados');
    await expect(ficha.locator('table.ingredients tr').first()).toContainText('200');
    const machines = ficha.locator('[data-feedback-id="food.recetario.ficha.maquinaria"] li');
    // Sin orden fijo (el del espejo): cada máquina con su aviso, en una línea resaltada.
    await expect(machines).toHaveCount(2);
    await expect(machines.filter({ hasText: 'Horno' })).toHaveText('3 × Horno · hacen falta 3 y hay 2');
    await expect(machines.filter({ hasText: 'Abatidor' })).toHaveText('1 × Abatidor · averiado');
    for (const n of [0, 1]) await expect(machines.nth(n)).toHaveClass(/warnline/);
    await capture(page, '04-receta-ficha');
    await ficha.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
  });

  await test.step('formulario: ingredientes con sugerencias, sin duplicar, con su unidad preferida; maquinaria con unidades', async () => {
    await page.locator('#newRecipe').click();
    const dialog = page.getByRole('dialog', { name: 'Nueva receta' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Arroz con cebolla');
    await dialog.getByLabel('Raciones base').fill('10');
    await expect(dialog.locator('#ingredientNames option')).toHaveCount(3);
    const line = (n: number) => dialog.locator('#ingredientRows .linerow').nth(n);
    await expect(line(0).getByLabel('Unidad', { exact: true }).locator('option')).toHaveText(['g', 'kg', 'ml', 'l', 'unidad', 'paquete', 'manojo', 'otro']);
    // «arroz» en minúsculas es el Arroz del catálogo: trae su unidad preferida (kg) si aún no hay cantidad.
    await line(0).getByLabel('Ingrediente', { exact: true }).fill('arroz');
    await line(0).getByLabel('Ingrediente', { exact: true }).blur();
    await expect(line(0).getByLabel('Unidad', { exact: true })).toHaveValue('kg');
    await line(0).getByLabel('Cantidad', { exact: true }).fill('1');
    // Un ingrediente nuevo escrito dos veces se crea una sola vez, con la unidad de su primera línea.
    for (const [n, name, quantity] of [[1, 'Cebolla morada', '2'], [2, 'cebolla  morada ', '1']] as const) {
      await dialog.locator('#addIngredient').click();
      await line(n).getByLabel('Ingrediente', { exact: true }).fill(name);
      await line(n).getByLabel('Cantidad', { exact: true }).fill(quantity);
      await line(n).getByLabel('Unidad', { exact: true }).selectOption('unidad');
    }
    await expect(dialog.locator('.machinerow .checkline')).toHaveText(['Abatidor', 'Freidora', 'Horno']);
    await dialog.getByRole('checkbox', { name: 'Horno' }).check();
    await dialog.getByLabel('Unidades de Horno').fill('2');
    await dialog.locator('#ingredientRows').scrollIntoViewIfNeeded();
    await capture(page, '05a-receta-ingredientes');
    await dialog.locator('.machinerow').last().scrollIntoViewIfNeeded();
    await capture(page, '05b-receta-maquinaria');
    await page.locator('#saveRecipe').click();
    await expect(dialog).toBeHidden();

    await expect.poll(() => api.rows('food.recipes').find((r) => r.name === 'Arroz con cebolla')).toBeTruthy();
    const recipe = api.rows('food.recipes').find((r) => r.name === 'Arroz con cebolla')!;
    const onions = api.rows('food.ingredients').filter((i) => String(i.name).toLowerCase().includes('cebolla'));
    expect(onions.map((i) => [i.name, i.preferred_unit])).toEqual([['Cebolla morada', 'unidad']]);
    const lines = api.rows('food.recipe_ingredients').filter((l) => l.recipe_id === recipe.id).sort((a, b) => Number(a.position) - Number(b.position));
    expect(lines.map((l) => [l.ingredient_id, Number(l.quantity), l.unit])).toEqual([[rice, 1, 'kg'], [onions[0]!.id, 2, 'unidad'], [onions[0]!.id, 1, 'unidad']]);
    const oven = api.rows('food.equipment').find((e) => e.name === 'Horno')!;
    expect(api.rows('food.recipe_equipment').filter((n) => n.recipe_id === recipe.id).map((n) => [n.equipment_id, n.quantity_required])).toEqual([[oven.id, 2]]);
  });

  await test.step('vista de cocinero: ingredientes escalados y la maquinaria del plato', async () => {
    await page.goto(`${baseURL}/#/menus/${HOUSE_MENU_ID}`);
    await page.locator('#cookView').click();
    const dish = page.locator('.dish', { hasText: 'Bizcocho de pistacho' });
    await expect(dish.locator('.cookdetails')).toContainText('400'); // 200 g para 10 → 400 g para 20
    await expect(dish.locator('.cookdetails')).toContainText('Maquinaria: ');
    await expect(dish.locator('.cookdetails')).toContainText('3 × Horno');
    await expect(dish.locator('.cookdetails')).toContainText('1 × Abatidor');
    await capture(page, '06-cocinero');
  });

  await test.step('compra: «Necesario» de los menús, «En casa» a mano y «Comprar» = necesario − en casa', async () => {
    await page.locator('.menutabs').getByRole('link', { name: 'Compra', exact: true }).click();
    await page.locator('#generateShopping').click();
    const row = page.locator('#shoppingList .buyrow', { hasText: 'Pistachos tostados' });
    await expect(row).toContainText('Necesario: 400 g');
    await row.getByRole('button', { name: 'Más de Pistachos tostados', exact: true }).click(); // tanda 40: las cifras van en el «⋯» (autorizado por Core)
    await page.getByLabel('En casa de Pistachos tostados', { exact: true }).fill('150');
    await page.getByLabel('En casa de Pistachos tostados', { exact: true }).blur();
    await expect(page.getByLabel('Comprar de Pistachos tostados', { exact: true })).toHaveValue('250');
    await expect(page.locator('.toast.show')).toHaveCount(0, { timeout: 10_000 });
    await row.scrollIntoViewIfNeeded();
    await capture(page, '07-compra');
  });
});
