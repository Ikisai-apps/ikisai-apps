/**
 * Food · caracterización en el navegador antes de O3 (menú de casa y plato rápido; `coordinacion/ampliacion/RECURSOS.md`
 * §15.3 y §17). Fija lo que hoy ve y toca quien hace un menú de retiro y quien usa el recetario: la lista de Menús, la
 * ficha del evento, el selector de platos y el recetario. Tiene que seguir en verde, sin tocarla, después de O3.
 *
 * Con `FOOD_CAPTURAS=<carpeta>` guarda además capturas a 390 px de cada pantalla (la tabla «hoy / después» de O3).
 *
 * Cómo correrlo:   npx playwright test tests/food/caracterizacion.spec.ts      (desde la raíz del repo)
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
const RETREAT = randomUUID();
const EARLIER = randomUUID();
const NEXT = randomUUID();
const CAPTURES = process.env.FOOD_CAPTURAS;

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let retreatMenu: string;
let earlierMenu: string;

const event = (id: string, title: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  event_id: id, event_code: null, reservation_code: null, title, event_type: 'retiro', start_date: day(start), end_date: day(end),
  arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 22, guest_count_is_final: true, minors_count: 0,
  meal_plan: 'pension_completa', menu_style: null, reservation_status: 'confirmada', requires_meals: true, meal_notes: null,
  event_revision: 1, dietary_restrictions: [], ...extra,
});

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [
      event(RETREAT, 'Retiro Test', 10, 12, { dietary_restrictions: [{ type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1, kitchen_notes: null }] }),
      event(EARLIER, 'Retiro de primavera', 3, 4, { guest_count: 12, meal_plan: 'media_pension' }),
      event(NEXT, 'Retiro sin menú', 20, 21),
    ],
  });
  for (const [name, status, extra] of [
    ['Curry de verduras', 'validada', { diet_tags: ['vegano', 'vegetariano'], allergens_checked: true }],
    ['Lentejas', 'en_prueba', {}],
    ['Arroz con leche', 'validada', { category: 'postre', allergens: ['lacteos'], allergens_checked: true }],
    ['Bizcocho viejo', 'archivada', { category: 'postre' }],
  ] as const) {
    const defaults: Record<string, unknown> = { category: 'principal', base_servings: 10, diet_tags: [], allergens: [], allergens_checked: false };
    api.seed('food.recipes', { ...defaults, ...extra, name, status });
  }
  retreatMenu = api.seed('food.menus', { event_id: RETREAT, source_event_revision: 1, status: 'borrador' }).id;
  earlierMenu = api.seed('food.menus', { event_id: EARLIER, source_event_revision: 1, status: 'validado' }).id;
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

test('caracterización · Inicio, Eventos y Menús: cada menú cuelga de un evento', async ({ page }) => {
  await login(page);
  await capture(page, '01-inicio');

  await test.step('Inicio: los retiros que vienen, con el estado de su menú', async () => {
    await expect(page.locator('#upcoming .eventcard', { hasText: 'Retiro Test' })).toContainText('borrador');
    await expect(page.locator('#upcoming .eventcard', { hasText: 'Retiro de primavera' })).toContainText('validado');
    await expect(page.locator('#upcoming .eventcard', { hasText: 'Retiro sin menú' })).toContainText('pendiente');
  });

  await test.step('Menús: uno por evento, con su título, fechas, personas y régimen; por cercanía, el más cercano arriba (decisión de Core del 27-10, F-MEN-1)', async () => {
    await page.goto(`${baseURL}/#/menus`);
    await expect(page.locator('.pagehead p')).toHaveText('El menú de cada evento. Se crean desde Eventos.');
    const rows = page.locator('#menuList li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Retiro de primavera');
    await expect(rows.nth(0)).toContainText('Media pensión');
    await expect(rows.nth(1)).toContainText('Retiro Test');
    await expect(rows.nth(1)).toContainText('22 personas');
    await expect(rows.nth(1)).toContainText('Pensión completa');
    // Ninguno ha pasado: no hay grupo de pasados.
    await expect(page.locator('#menusPast')).toHaveCount(0);
    await capture(page, '02-menus');
    // No hay botón para crear un menú en Menús: se crean desde la ficha del evento.
    await expect(page.locator('main').getByRole('button', { name: /Crear menú|Nuevo menú/ })).toHaveCount(0);
    await rows.nth(0).click();
    await expect(page).toHaveURL(new RegExp(`#/menus/${earlierMenu}$`));
  });

  await test.step('Eventos: la ficha de un evento sin menú lo crea; la de uno con menú lo abre', async () => {
    await page.goto(`${baseURL}/#/eventos`);
    await capture(page, '03-eventos');
    await page.locator('#eventList .row', { hasText: 'Retiro sin menú' }).click();
    const sheet = page.getByRole('dialog', { name: 'Retiro sin menú' });
    await expect(sheet.locator('#createMenu')).toBeVisible();
    await expect(sheet.locator('input[type=checkbox]')).toHaveCount(2); // la propuesta del régimen: cena y desayuno
    await capture(page, '04-ficha-evento');
    await sheet.getByRole('button', { name: 'Cerrar' }).first().click();
    await page.locator('#eventList .row', { hasText: 'Retiro Test' }).click();
    await page.getByRole('dialog', { name: 'Retiro Test' }).locator('#openMenu').click();
    await expect(page).toHaveURL(new RegExp(`#/menus/${retreatMenu}$`));
  });
});

test('caracterización · añadir plato: solo recetas del recetario, en orden, con las raciones del evento', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/menus/${retreatMenu}`);
  await expect(page.locator('.service')).toHaveCount(1);
  await capture(page, '05-constructor');
  await page.locator('.service').first().getByRole('button', { name: 'Añadir plato' }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir plato · Cena' });
  await expect(dialog).toContainText('22 raciones por defecto; se pueden cambiar después.');
  // Por orden alfabético, sin las archivadas; las que están en prueba lo dicen.
  await expect(dialog.locator('#recipePicker .recipecard strong')).toHaveText(['Arroz con leche', 'Curry de verduras', 'Lentejas']);
  await expect(dialog.locator('.recipecard', { hasText: 'Lentejas' })).toContainText('En prueba');
  await capture(page, '06-selector-plato');
  // Lo que no está en el recetario no se puede poner: hay que crearlo allí antes.
  await dialog.getByRole('searchbox', { name: 'Buscar receta' }).fill('Gazpacho');
  await expect(dialog.locator('#recipePicker')).toHaveText('No hay recetas que coincidan. Créalas en el Recetario.');
  await expect(dialog.getByRole('button', { name: /Gazpacho/ })).toHaveCount(0);
  await dialog.getByRole('searchbox', { name: 'Buscar receta' }).fill('lent');
  await dialog.getByRole('button', { name: 'Añadir Lentejas' }).click();
  await expect(page.locator('.dish', { hasText: 'Lentejas' }).locator('.servings')).toHaveValue('22');
  await expect.poll(() => api.rows('food.menu_items').filter((i) => !i.deleted_at).length).toBe(1);
  // Con una alergia en el grupo, el plato sin alérgenos revisados avisa en la cabecera del menú.
  await expect(page.locator('#menuWarnings')).toContainText('«Lentejas» no tiene los alérgenos revisados');
});

test('caracterización · recetario: archivadas solo si se piden; en prueba y sin alérgenos revisados se ve', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/recetario`);
  const cards = page.locator('#recipeGrid .recipecard');
  await expect(cards.locator('strong')).toHaveText(['Arroz con leche', 'Curry de verduras', 'Lentejas']);
  await expect(cards.filter({ hasText: 'Lentejas' })).toContainText('En prueba');
  await expect(cards.filter({ hasText: 'Curry de verduras' }).locator('.chip')).toHaveCount(0); // validada: sin chip
  await capture(page, '07-recetario');
  await page.locator('#filterStatus').selectOption('archivada');
  await expect(cards.locator('strong')).toHaveText(['Bizcocho viejo']);
  await page.locator('#filterStatus').selectOption('');
  await cards.filter({ hasText: 'Lentejas' }).click();
  const sheet = page.getByRole('dialog', { name: 'Lentejas' });
  await expect(sheet).toContainText('Alérgenos sin revisar');
  await capture(page, '08-ficha-receta');
  await sheet.getByRole('button', { name: 'Cerrar' }).first().click();
  // Una receta nueva pide el formulario completo (nombre, categoría, raciones base…).
  await page.locator('#newRecipe').click();
  await expect(page.getByRole('dialog', { name: 'Nueva receta' })).toBeVisible();
  await capture(page, '09-nueva-receta');
});
