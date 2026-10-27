/**
 * Food · tanda 27 en el navegador (390 px): Recetario («Filtrar por alérgeno» con «Lleva X / Sin X» y la línea sin red),
 * ficha de receta (portada y coste plegado), Organizador (veredicto, comprobaciones, «Alérgenos sin revisar» en la hoja y
 * confirmación al compartir) y Cierre (comprobaciones). Las reglas de seguridad de VG: nunca «apto» ni «no contiene».
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas a 390 px.
 *
 * Cómo correrlo:   npx playwright test tests/food/tanda27.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, day, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const EVENT = randomUUID();
const CAPTURES = process.env.FOOD_CAPTURAS;

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let menuId: string;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [{
      event_id: EVENT, event_code: null, reservation_code: null, title: 'Retiro de otoño', event_type: 'retiro', start_date: day(5), end_date: day(6),
      arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 12, guest_count_is_final: true, minors_count: 0, meal_plan: 'media_pension',
      menu_style: null, reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 1,
      dietary_restrictions: [{ type: 'alergia', subject: 'frutos secos', severity: 'grave', servings: 1, kitchen_notes: null }],
    }],
  });
  const recipe = (name: string, extra: Record<string, unknown>) => api.seed('food.recipes', { category: 'principal', base_servings: 10, status: 'validada', diet_tags: [], allergens: [], allergens_checked: true, ...extra, name }).id;
  const tart = recipe('Tarta de pistacho', { category: 'postre', allergens: ['frutos_de_cascara'], public_name: 'Tarta de la casa' });
  const curry = recipe('Curry de verduras', {});
  const salad = recipe('Ensalada verde', { allergens_checked: false });
  const almond = api.seed('food.ingredients', { name: 'Almendra molida', preferred_unit: 'g' }).id;
  api.seed('food.recipe_ingredients', { recipe_id: curry, ingredient_id: almond, quantity: 100, unit: 'g', position: 1 });
  menuId = api.seed('food.menus', { event_id: EVENT, source_event_revision: 1, status: 'validado' }).id;
  const dinner = api.seed('food.menu_services', { menu_id: menuId, service_date: day(5), service_type: 'cena', service_time: '20:30:00', position: 1 }).id;
  for (const [position, recipeId] of [tart, curry, salad].entries()) api.seed('food.menu_items', { service_id: dinner, recipe_id: recipeId, servings: 12, position: position + 1 });
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

test('recetario · «Lleva X / Sin X» con lo no revisado marcado, y la línea sin red', async ({ page, context }) => {
  await login(page);
  await page.goto(`${baseURL}/#/recetario`);
  const names = page.locator('#recipeGrid .recipecard strong');
  await expect(names).toHaveText(['Curry de verduras', 'Ensalada verde', 'Tarta de pistacho']);
  await page.locator('#filterAllergen').selectOption('frutos_de_cascara');
  // «Lleva»: lo declara (la tarta) o lo nombra un ingrediente (la almendra del curry).
  await expect(names).toHaveText(['Curry de verduras', 'Tarta de pistacho']);
  await page.locator('#filterAllergenMode').selectOption('sin');
  await expect(names).toHaveText(['Ensalada verde']);
  await expect(page.locator('#recipeGrid .recipecard', { hasText: 'Ensalada verde' }).locator('.fd-unreviewed')).toHaveText('Alérgenos sin revisar');
  await expect(page.locator('main')).not.toContainText(/apto|no contiene/i);
  await capture(page, '25-recetario-sin');

  // Ficha del curry: la almendra molida nombra frutos de cáscara, que no declara (aviso con su arreglo).
  await page.locator('#filterAllergen').selectOption('');
  await page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras' }).click();
  const ficha = page.getByRole('dialog', { name: 'Curry de verduras' });
  await expect(ficha.locator('.fd-undeclared')).toHaveText(/El ingrediente «almendra molida» nombra frutos de cáscara, que la receta no declara: revisa los alérgenos\./);
  await expect(ficha.getByRole('button', { name: 'Revisar los alérgenos' })).toBeVisible();
  await capture(page, '29-receta-sin-declarar');
  await page.keyboard.press('Escape');

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  // Sin red, lo que la necesita queda desactivado con el motivo (MUELA-086, `bindOnline`).
  await page.evaluate((id) => { location.hash = `#/menus/${id}/preparacion`; }, menuId);
  await expect(page.locator('#generatePreparation')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.offline-why').first()).toContainText('necesita conexión');
  // La Despensa sin red lo dice (aquí no hay espacios de cocina en el dispositivo: no afirma que no la haya).
  await page.evaluate(() => { location.hash = '#/despensa'; });
  await expect(page.locator('#pantryOffline')).toBeVisible();
  await expect(page.locator('#pantryEmpty')).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#/recetario'; });
  await expect(page.locator('#recipesOffline')).toBeVisible();
  await expect(page.locator('#recipesOffline')).toContainText(/Sin conexión · datos de las \d\d:\d\d\. Lo que cambies se guardará al volver la conexión\./);
  await expect(page.locator('#recipesOffline')).toContainText('«Platos sugeridos» necesitan red');
  await capture(page, '26-recetario-sin-red');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#recipesOffline')).toBeHidden();
});

test('organizador y cierre · veredicto, comprobaciones, «Alérgenos sin revisar» en la hoja y confirmación al compartir', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/menus/${menuId}/organizador`);
  const checks = page.locator('[data-feedback-id="food.menu.organizador.comprobaciones"]');
  await expect(checks.locator('.check-verdict')).toHaveText('!2 cosas por resolver · La primera: los alérgenos de Ensalada verde están sin revisar');
  await expect(checks.locator('.check-item')).toHaveCount(6);
  // El curry lleva almendra molida y no declara frutos de cáscara: comprobación en rojo (decisión de Core Sevilla, 20-10-2026).
  const undeclared = checks.locator('.check-item', { hasText: 'Alérgenos posibles sin declarar' });
  await expect(undeclared).toHaveAttribute('data-ok', 'false');
  await expect(undeclared).toHaveAttribute('data-tone', 'alert');
  await expect(undeclared).toContainText('1 plato con un alérgeno posible sin declarar: Curry de verduras');
  await expect(checks.locator('.check-item[data-ok="true"]', { hasText: 'Menú validado' })).toHaveCount(1);
  await expect(checks.locator('.check-item[data-ok="false"]', { hasText: 'Compartido con el organizador' })).toHaveAttribute('data-tone', 'warn');
  // En la hoja: el plato sin revisar lo dice, y la nota cambia.
  const sheet = page.locator('.print-page');
  await expect(sheet).toContainText('Alérgenos sin revisar');
  await expect(sheet).toContainText('todavía no los ha revisado cocina');
  await expect(sheet).toContainText('Tarta de la casa');
  await capture(page, '27-organizador');

  // Compartir con alérgenos sin revisar pide confirmación; cancelar no comparte.
  await page.goto(`${baseURL}/#/menus/${menuId}`);
  // Tanda 38 (MUELA-091, Ficha A con el ajuste de VG): validado, la línea de restricciones va plegada y es corta; la
  // portada dice estado, personas y coste; el foco, lo que falta; el plato lleva su ⚠; lo demás, plegado.
  const restrictions = page.locator('#menuRestrictions');
  await expect(restrictions).not.toHaveAttribute('open', '');
  await expect(restrictions.locator('summary')).toContainText('1 alergia a frutos secos (grave)');
  await expect(restrictions.locator('summary')).toContainText('avisos');
  await expect(restrictions.locator('.fd-restralert')).toHaveCount(0);
  await expect(page.locator('#menuCover')).toContainText('Validado');
  await expect(page.locator('#menuCover')).toContainText('1 servicio · 3 platos · 3 platos con aviso');
  await expect(page.locator('#menuCover')).not.toContainText('0,00 €');
  const focus = page.locator('[data-feedback-id="food.menu.foco"]');
  await expect(focus.locator('.focus-kicker')).toHaveText('Alérgenos sin revisar');
  await expect(focus.locator('.focus-title')).toHaveText('Ensalada verde');
  await expect(focus.locator('.focus-count')).toHaveText('1 de 3 por hacer');
  await expect(page.locator('#menuNext')).toContainText('Tarta de pistacho');
  // Sin saturar (VG): el ⚠ va solo en el plato del menú, no también en «Lo siguiente».
  await expect(page.locator('#menuNext .fd-safety')).toHaveCount(0);
  await expect(page.locator('.dish', { hasText: 'Tarta de pistacho' }).locator('.fd-safety')).toContainText('⚠ lleva frutos de cáscara (frutos secos) · 1 persona · alergia grave');
  await expect(page.locator('.dish', { hasText: 'Ensalada verde' }).locator('.fd-safety')).toContainText('Alérgenos sin revisar');
  await expect(page.locator('main')).not.toContainText(/apto|✓ sin/i);
  await capture(page, '30-ficha-menu');
  await page.locator('#menuShareFold summary').click();
  await page.locator('#shareMenu').click();
  await expect(page.getByRole('alertdialog')).toContainText('Hay platos con los alérgenos sin revisar');
  await expect(page.getByRole('alertdialog')).toContainText('Curry de verduras: un ingrediente o el texto del plato nombran un alérgeno que el plato no declara.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
  expect(api.rows('food.menus').find((m) => m.id === menuId)?.organizer_shared).toBe(false);
  await page.locator('#shareMenu').click();
  await page.locator('#dialogConfirm').click();
  await expect.poll(() => api.rows('food.menus').find((m) => m.id === menuId)?.organizer_shared).toBe(true);

  // MUELA-086 (S2): compartido igualmente, la hoja sigue diciendo «los alérgenos que declara» y marca el plato pendiente.
  await page.goto(`${baseURL}/#/menus/${menuId}/organizador`);
  const printed = page.locator('.print-page');
  await expect(printed).toContainText('los alérgenos que declara');
  await expect(printed).not.toContainText('los alérgenos que contiene');
  await expect(printed).toContainText('Alérgeno posible sin declarar');
  await expect(printed).toContainText('los está revisando cocina');

  await page.goto(`${baseURL}/#/menus/${menuId}/cierre`);
  const closing = page.locator('[data-feedback-id="food.menu.cierre.comprobaciones"]');
  await expect(closing.locator('.check-item', { hasText: 'Menú cerrado' })).toHaveAttribute('data-ok', 'false');
  await expect(closing.locator('.check-item', { hasText: 'Preparación hecha' })).toContainText('no hay plan de preparación');
  // Tanda 38: dos comprobaciones más (comentarios y alérgenos, esta en rojo) y «Cerrar menú» también aquí.
  await expect(closing.locator('.check-item')).toHaveCount(6);
  await expect(closing.locator('.check-item', { hasText: 'Comentarios del organizador resueltos' })).toHaveAttribute('data-ok', 'true');
  const allergens = closing.locator('.check-item', { hasText: 'Alérgenos revisados' });
  await expect(allergens).toHaveAttribute('data-tone', 'alert');
  await expect(allergens).toContainText('sin revisar: Ensalada verde · posibles sin declarar: Curry de verduras (frutos de cáscara)');
  await expect(allergens.getByRole('button', { name: 'Abrir en el Recetario' })).toBeVisible();
  await expect(closing.locator('.check-item', { hasText: 'Menú cerrado' })).toContainText('con «Cerrar menú», aquí debajo o en la pestaña Menú');
  await expect(closing.locator('.check-verdict')).toContainText('2 cosas por resolver');
  await expect(page.locator('#closingNotes')).toBeVisible();
  // Con algo pendiente, solo avisa (decisión de VG): gris, con la frase, y cierra sin pedir confirmación.
  const close = page.locator('#closeMenuHere');
  await expect(close).toHaveClass(/ghost/);
  await expect(page.locator('#closeBar')).toContainText('Puedes cerrarlo igualmente; el Cierre seguirá diciendo lo que falta.');
  await capture(page, '28-cierre');
  // Las notas sin guardar se guardan antes de cerrar.
  await page.locator('#closingNotes').fill('Sobró tarta.');
  await close.click();
  await expect(page.locator('#closeBar')).toContainText('Menú cerrado.');
  await expect.poll(() => api.rows('food.menus').find((m) => m.id === menuId)).toMatchObject({ status: 'cerrado', closing_notes: 'Sobró tarta.' });
  await expect(closing.locator('.check-item', { hasText: 'Menú cerrado' })).toHaveAttribute('data-ok', 'true');
  await capture(page, '31-cierre-cerrado');
  // Las otras pestañas: la misma línea plegada arriba, nada más (VG: sin saturar).
  for (const [tab, name] of [['', '32-menu-cerrado'], ['compra', '33-compra'], ['preparacion', '34-preparacion'], ['organizador', '35-organizador']] as const) {
    await page.goto(`${baseURL}/#/menus/${menuId}${tab ? `/${tab}` : ''}`);
    await expect(page.locator('#menuRestrictions')).not.toHaveAttribute('open', '');
    await expect(page.locator('.fd-restr')).toHaveCount(1);
    await capture(page, name);
  }
});
