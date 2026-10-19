/**
 * Food · Cocina, «Ahora en cocina» de Inicio y la Preparación nueva (tanda 27; MUELA-006, 035 y 068 §1–2), a 390 px.
 * El reloj de la página se fija a las 11:20 de hoy (hora de Madrid): la comida de las 14:00 es «Ahora».
 * - Seguridad: todas las alergias e intolerancias con su número en la línea plegada (la grave destacada); por plato, solo
 *   «⚠ lleva…», «Alérgenos sin revisar» o la preferencia. Nunca «apto» ni «✓ sin…».
 * - Pasos: «Siguiente» y «Atrasado», marcar hecho desde Cocina, el círculo del responsable, «Cambiar hora o día»,
 *   las cifras y «Sin día (n)».
 * - El pase: un plato por pantalla, con flechas y Escape. El lector, sin casillas ni «Editar la receta».
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas a 390 px.
 *
 * Cómo correrlo:   npx playwright test tests/food/cocina.spec.ts      (desde la raíz del repo)
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
const OWNER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const READER = { email: 'lector@example.invalid', password: 'secreta-123', displayName: 'Lectora', role: 'reader' as const };
const EVENT = randomUUID();
const CAPTURES = process.env.FOOD_CAPTURAS;

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let menuId: string;

/** El instante de «HH:MM» de un día en Madrid (sirve en cualquier zona horaria de la máquina). */
function madridAt(dayKey: string, hhmm: string): number {
  const guess = Date.parse(`${dayKey}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess - (local - guess);
}

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [OWNER, READER],
    events: [{
      event_id: EVENT, event_code: null, reservation_code: null, title: 'Retiro de otoño', event_type: 'retiro', start_date: day(-1), end_date: day(1),
      arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 22, guest_count_is_final: true, minors_count: 0,
      meal_plan: 'pension_completa', menu_style: null, reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 1,
      dietary_restrictions: [
        { type: 'intolerancia', subject: 'lactosa', severity: 'leve', servings: 2, kitchen_notes: null },
        { type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1, kitchen_notes: null },
        { type: 'preferencia', subject: 'cilantro', severity: null, servings: 1, kitchen_notes: null },
      ],
    }],
  });
  const recipe = (name: string, extra: Record<string, unknown>) => api.seed('food.recipes', { category: 'principal', base_servings: 10, status: 'validada', diet_tags: [], allergens: [], allergens_checked: true, ...extra, name }).id;
  const tart = recipe('Tarta de pistacho', { category: 'postre', allergens: ['frutos_cascara'] });
  const curry = recipe('Curry de verduras', {});
  const salad = recipe('Ensalada verde', { allergens_checked: false });
  const bread = recipe('Pan con tomate', {});
  const coriander = api.seed('food.ingredients', { name: 'Cilantro fresco', preferred_unit: 'manojo' }).id;
  api.seed('food.recipe_ingredients', { recipe_id: curry, ingredient_id: coriander, quantity: 1, unit: 'manojo', position: 1 });
  menuId = api.seed('food.menus', { event_id: EVENT, source_event_revision: 1, status: 'validado' }).id;
  const service = (date: string, type: string, time: string, position: number) => api.seed('food.menu_services', { menu_id: menuId, service_date: date, service_type: type, service_time: time, position }).id;
  const breakfast = service(day(0), 'desayuno', '09:00:00', 1);
  const lunch = service(day(0), 'comida', '14:00:00', 2);
  const dinner = service(day(0), 'cena', '20:30:00', 3);
  const tomorrow = service(day(1), 'comida', '14:00:00', 4);
  const dish = (serviceId: string, recipeId: string, position: number) => api.seed('food.menu_items', { service_id: serviceId, recipe_id: recipeId, servings: 22, position }).id;
  dish(breakfast, bread, 1);
  const curryDish = dish(lunch, curry, 1);
  const saladDish = dish(lunch, salad, 2);
  dish(dinner, tart, 1);
  dish(tomorrow, curry, 1);
  const step = (text: string, extra: Record<string, unknown>) => api.seed('food.preparation_items', { menu_id: menuId, menu_item_id: null, recipe_id: null, scheduled_date: day(0), scheduled_time: null, text, responsible: null, done: false, position: 1, manual: false, ...extra });
  step('Sacar el pan del congelador', { scheduled_time: '10:00:00', manual: true }); // atrasado a las 11:20
  step('Preparar Curry de verduras', { menu_item_id: curryDish, recipe_id: curry, scheduled_time: '12:30:00' }); // siguiente
  step('Lavar la ensalada', { menu_item_id: saladDish, recipe_id: salad, scheduled_time: '13:00:00', responsible: 'Marga' });
  step('Montar la tarta', { scheduled_time: '18:00:00', responsible: 'Tomás', manual: true });
  step('Afilar los cuchillos', { scheduled_date: null, manual: true });
  step('Preparar el curry de mañana', { scheduled_date: day(1), scheduled_time: '12:00:00', manual: true });
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

async function login(page: Page, user: { email: string; password: string; displayName: string }): Promise<void> {
  await page.clock.setFixedTime(madridAt(day(0), '11:20'));
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(user.email);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${user.displayName}` })).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (CAPTURES) await page.screenshot({ path: path.join(CAPTURES, `${name}.png`), fullPage: true });
}

test('cocina · Inicio → Cocina: alergias a la vista, platos con su aviso, pasos y el pase', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);

  await test.step('Inicio: «Ahora en cocina» con la comida de las 14:00 y las alergias', async () => {
    const card = page.locator('#kitchenNow');
    await expect(card).toContainText('Ahora · Comida · 14:00');
    await expect(card).toContainText('Retiro de otoño');
    await expect(card).toContainText('en 2 h 40 min');
    await expect(card).toContainText('Alergia grave: pistacho (1)');
    await expect(card).toContainText('Intolerancia: lactosa (2)');
    // Lo de Inicio de siempre sigue debajo.
    await expect(page.locator('#upcoming .eventcard', { hasText: 'Retiro de otoño' })).toBeVisible();
    await capture(page, '20-inicio-ahora-en-cocina');
    await card.getByRole('link', { name: 'Abrir Cocina' }).first().click();
    await expect(page).toHaveURL(new RegExp(`#/cocina\\?menu=${menuId}&dia=${day(0)}$`));
  });

  await test.step('Cocina: la línea plegada dice todas las alergias e intolerancias, la grave primero y destacada', async () => {
    await expect(page.locator('#kitchenAllergies .fd-line')).toHaveText(['Alergia grave: pistacho (1)', 'Intolerancia: lactosa (2)']);
    await expect(page.locator('#kitchenAllergies strong.fd-severe')).toHaveText('Alergia grave: pistacho (1)');
    await page.locator('#kitchenStrip summary').click();
    await expect(page.locator('#kitchenStrip .fd-strip-body')).toContainText('cilantro');
  });

  await test.step('servicios del día: ahora, después y lo hecho; cada plato con su aviso, nunca «apto»', async () => {
    await expect(page.locator('.fd-service[data-phase="ahora"] h3')).toHaveText('Ahora · Comida · 14:00');
    await expect(page.locator('.fd-service[data-phase="despues"] h3')).toHaveText(['Después · Cena · 20:30']);
    await expect(page.locator('.fd-done > summary')).toHaveText('Lo hecho (1)');
    const dish = (name: string) => page.locator('.fd-dish', { hasText: name });
    await expect(dish('Tarta de pistacho').locator('.fd-safety')).toHaveText('⚠ lleva pistacho · 1 persona · alergia grave');
    await expect(dish('Ensalada verde').locator('.fd-safety')).toHaveText('Alérgenos sin revisar');
    await expect(dish('Curry de verduras').locator('.fd-safety')).toHaveText('lleva cilantro · preferencia');
    await expect(page.locator('main')).not.toContainText(/apto|✓ sin|no contiene/i);
    await expect(page.locator('#kitchenShare')).toHaveText('4 pasos · Marga 1 · Tomás 1');
  });

  await test.step('pasos: «Atrasado» y «Siguiente», y marcar hecho desde Cocina', async () => {
    await expect(page.locator('.preprow', { hasText: 'Sacar el pan del congelador' })).toHaveAttribute('data-flag', 'atrasado');
    await expect(page.locator('.preprow', { hasText: 'Preparar Curry de verduras' })).toHaveAttribute('data-flag', 'siguiente');
    await capture(page, '21-cocina');
    await page.getByLabel('Hecho: Preparar Curry de verduras', { exact: true }).check();
    await expect.poll(() => api.rows('food.preparation_items').find((p) => p.text === 'Preparar Curry de verduras')?.done).toBe(true);
    await expect(page.locator('.fd-service[data-phase="ahora"] .fd-service-head p')).toContainText('1 de 2 pasos');
  });

  await test.step('el pase: un plato por pantalla, con flechas y Escape', async () => {
    await page.getByRole('button', { name: 'Pase de Comida' }).click();
    const pass = page.getByRole('dialog', { name: 'El pase' });
    await expect(pass.locator('.fd-pass-count')).toHaveText('1 de 2');
    await expect(pass.locator('.fd-pass-name')).toHaveText('Curry de verduras');
    await expect(pass).toContainText('Cilantro fresco');
    await capture(page, '22-pase');
    await page.keyboard.press('ArrowRight');
    await expect(pass.locator('.fd-pass-name')).toHaveText('Ensalada verde');
    await expect(pass).toContainText('Alérgenos sin revisar');
    await page.keyboard.press('Escape');
    await expect(pass).toHaveCount(0);
  });

  await test.step('desde la ficha del menú, «Cocina» abre ese menú en Cocina', async () => {
    await page.goto(`${baseURL}/#/menus/${menuId}`);
    await page.locator('#openKitchen').click();
    await expect(page).toHaveURL(new RegExp(`#/cocina\\?menu=${menuId}&dia=${day(0)}$`));
    await expect(page.locator('.fd-service[data-phase="ahora"]')).toBeVisible();
  });
});

test('preparación · días con botones y «Sin día (n)», cifras, círculo del responsable y «Cambiar hora o día»', async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`${baseURL}/#/menus/${menuId}/preparacion`);
  const days = page.locator('#menuTab .fd-days .fd-day');
  await expect(days.locator('.fd-day-name')).toHaveText(['Hoy', 'Mañana', 'Sin día (1)']);
  await expect(days.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(days.first().locator('.fd-day-sub')).toHaveText(/\/4 · 1 atrasado$/);
  await expect(page.locator('[data-feedback-id="food.menu.preparacion.cifras"]')).toContainText('atrasado');
  await expect(page.locator('#preparationProgress')).toHaveText(/ de 6 hechos$/);
  await capture(page, '23-preparacion');

  // El círculo pasa al siguiente nombre del plan (Marga → Tomás) de un toque.
  const salad = page.locator('.preprow', { hasText: 'Lavar la ensalada' });
  await salad.locator('.fd-who').click();
  await expect.poll(() => api.rows('food.preparation_items').find((p) => p.text === 'Lavar la ensalada')?.responsible).toBe('Tomás');

  // «Cambiar hora o día»: +30 min; la propuesta pasa a paso propio.
  await page.getByRole('button', { name: 'Cambiar hora o día: Lavar la ensalada' }).click();
  const move = page.getByRole('dialog', { name: 'Cambiar hora o día' });
  await expect(move).toContainText('es una propuesta');
  await move.getByRole('button', { name: '+30 min' }).click();
  await move.locator('#saveMove').click();
  await expect.poll(() => { const row = api.rows('food.preparation_items').find((p) => p.text === 'Lavar la ensalada'); return [row?.scheduled_time, row?.manual]; }).toEqual(['13:30', true]);

  // «Sin día (1)»: los pasos sin fecha, en su propio botón.
  await days.filter({ hasText: 'Sin día (1)' }).click();
  await expect(page.locator('#preparationDays .preprow strong')).toHaveText(['Afilar los cuchillos']);
  await days.first().click();
  await expect(page.locator('#preparationDays')).toContainText('Lavar la ensalada');
});

test('cocina · el lector ve lo mismo sin casillas ni «Editar la receta»', async ({ page }) => {
  await login(page, READER);
  await page.goto(`${baseURL}/#/cocina`);
  await expect(page.locator('.fd-service[data-phase="ahora"]')).toBeVisible();
  await expect(page.locator('#kitchenAllergies .fd-line').first()).toHaveText('Alergia grave: pistacho (1)');
  for (const box of await page.locator('.preprow .bigcheck').all()) await expect(box).toBeDisabled();
  await page.locator('.fd-dish', { hasText: 'Ensalada verde' }).click();
  const sheet = page.getByRole('dialog', { name: 'Ensalada verde' });
  await expect(sheet).toContainText('Alérgenos sin revisar');
  await expect(sheet.getByRole('link', { name: /Editar la receta/ })).toHaveCount(0);
  await capture(page, '24-cocina-lector');
});
