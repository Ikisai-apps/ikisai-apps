/**
 * Dos dispositivos y sin red (docs/food/API.md §10.4 y §11.2, escenarios 4, 5 y 6): lo que hace «otra persona» se
 * simula escribiendo directamente en la API falsa mientras este navegador está sin conexión.
 *   · Preparación: campos distintos de la misma fila → fusión automática.
 *   · Compra: el mismo campo → conflicto con decisión humana.
 *   · Platos editados sin red en un menú que otro valida → rechazo MENU_LOCKED explicado, sin bloquear la cola.
 *
 * Cómo correrlo:   npx playwright test tests/food/offline.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, day, TIME_ZONE } from './helpers.ts';
import { startFakeApi, type FakeApi, type FakeRow } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const EVENT_ID = randomUUID();
const MENU_ID = randomUUID();

// La app calcula «hoy» con la fecha local del navegador: la misma zona que `day()` y el servidor.
test.use({ timezoneId: TIME_ZONE });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let step: FakeRow;
let buy: FakeRow;
let dish: FakeRow;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [{
      event_id: EVENT_ID, title: 'Retiro Test', event_type: 'retiro', start_date: day(10), end_date: day(11), arrival_time: '17:00:00', departure_time: '12:00:00',
      guest_count: 22, guest_count_is_final: true, minors_count: 0, meal_plan: 'pension_completa', menu_style: 'vegetariano', reservation_status: 'confirmada',
      requires_meals: true, meal_notes: null, event_revision: 3, dietary_restrictions: [],
    }],
  });
  const tomato = api.seed('food.ingredients', { name: 'Tomate', preferred_unit: 'kg' });
  const curry = api.seed('food.recipes', { name: 'Curry de verduras', category: 'principal', base_servings: 20, status: 'validada', allergens_checked: true });
  api.seed('food.recipe_ingredients', { recipe_id: curry.id, ingredient_id: tomato.id, quantity: 2.5, unit: 'kg' });
  api.seed('food.menus', { id: MENU_ID, event_id: EVENT_ID, source_event_revision: 3 });
  const dinner = api.seed('food.menu_services', { menu_id: MENU_ID, service_date: day(10), service_type: 'cena', service_time: '20:30:00', position: 1 });
  dish = api.seed('food.menu_items', { service_id: dinner.id, recipe_id: curry.id, servings: 22, position: 1 });
  const list = api.seed('food.shopping_lists', { menu_id: MENU_ID, generated_at: new Date().toISOString(), source_revisions: {} });
  buy = api.seed('food.shopping_list_items', { shopping_list_id: list.id, ingredient_id: tomato.id, required_quantity: 2.75, unit: 'kg', purchase_quantity: 2.75 });
  step = api.seed('food.preparation_items', { menu_id: MENU_ID, menu_item_id: dish.id, recipe_id: curry.id, scheduled_date: day(10), scheduled_time: '18:30:00', text: 'Preparar Curry de verduras' });

  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
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

async function offline(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(true);
  await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
}

async function backOnline(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine);
  await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
}

const row = (table: string, id: string) => api.rows(table).find((r) => r.id === id)!;

test('sin red con dos dispositivos: fusión automática, conflicto y rechazo por menú validado', async ({ page, context }) => {
  test.setTimeout(150_000);
  await login(page);

  await test.step('preparación · campos distintos de la misma fila se fusionan solos', async () => {
    await page.goto(`${baseURL}/#/menus/${MENU_ID}/preparacion`);
    await expect(page.locator('.preprow')).toHaveCount(1);
    await offline(page, context);
    await page.getByLabel('Hecho: Preparar Curry de verduras', { exact: true }).check();
    await expect(page.locator('.preprow')).toHaveAttribute('data-pending', 'true');
    // Mientras tanto, otra persona asigna responsable al mismo paso.
    api.serverUpdate('food.preparation_items', step.id, { responsible: 'Marga' });
    await backOnline(page, context);
    await expect(page.locator('.preprow')).toHaveAttribute('data-pending', 'false', { timeout: 15_000 });
    await expect(page.locator('.preprow')).toContainText('Marga');
    await expect(page.getByLabel('Hecho: Preparar Curry de verduras', { exact: true })).toBeChecked();
    expect(row('food.preparation_items', step.id)).toMatchObject({ done: true, responsible: 'Marga', revision: 3 });
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  });

  await test.step('compra · el mismo campo tocado en dos sitios pide una decisión', async () => {
    await page.goto(`${baseURL}/#/menus/${MENU_ID}/compra`);
    const purchase = page.getByLabel('Comprar de Tomate', { exact: true });
    await expect(purchase).toHaveValue('2,75');
    await offline(page, context);
    await purchase.fill('3');
    await purchase.blur();
    await expect(page.locator('.buyrow')).toHaveAttribute('data-pending', 'true');
    // Otra persona regenera la lista: la necesidad sube y «comprar» se recalcula en el servidor.
    api.serverUpdate('food.shopping_list_items', buy.id, { required_quantity: 3.75, purchase_quantity: 3.75 });
    await backOnline(page, context);
    await expect(page.locator('#syncStatus')).toContainText('1 conflicto', { timeout: 15_000 });
    expect(row('food.shopping_list_items', buy.id).purchase_quantity).toBe(3.75); // nada se pisa en silencio

    await page.goto(`${baseURL}/#/conflictos`);
    const conflict = page.locator('#conflictList');
    await expect(conflict).toContainText('Compra: Tomate'); // la tarjeta se titula con algo reconocible, no con un identificador
    await expect(conflict).toContainText('Comprar');
    await expect(conflict).toContainText('3,75');
    await conflict.locator('[data-choice="mine"]').click();
    await expect.poll(() => row('food.shopping_list_items', buy.id).purchase_quantity, { timeout: 15_000 }).toBe(3);
    // Mi decisión no deshace lo que el otro cambió en campos que yo no toqué.
    expect(row('food.shopping_list_items', buy.id)).toMatchObject({ required_quantity: 3.75, manual_override: true });
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  });

  await test.step('menú · platos editados sin red en un menú que otro valida: rechazo explicado y cola libre', async () => {
    await page.goto(`${baseURL}/#/menus/${MENU_ID}`);
    const servings = page.getByLabel('Raciones de Curry de verduras', { exact: true });
    await expect(servings).toHaveValue('22');
    await offline(page, context);
    await servings.fill('30');
    await servings.blur();
    await expect(page.locator('.dish')).toHaveAttribute('data-pending', 'true');
    api.serverUpdate('food.menus', MENU_ID, { status: 'validado', validated_at: new Date().toISOString() });
    await backOnline(page, context);
    await expect(page.locator('#syncStatus')).toContainText('1 rechazado', { timeout: 15_000 });
    expect(row('food.menu_items', dish.id).servings).toBe(22);
    // El espejo vuelve a lo que dice el servidor y el menú aparece validado y bloqueado.
    await expect(page.locator('#menuStatus')).toHaveText('Validado');
    await expect(page.getByLabel('Raciones de Curry de verduras', { exact: true })).toHaveValue('22');
    await expect(page.getByLabel('Raciones de Curry de verduras', { exact: true })).toBeDisabled();

    await page.goto(`${baseURL}/#/conflictos`);
    const rejected = page.locator('#rejectedList');
    await expect(rejected).toContainText('El menú está validado: reábrelo para cambiarlo.');
    await expect(rejected).toContainText('Plato del menú: Curry de verduras');
    await rejected.locator('[data-choice="discard"]').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Descartar' }).click();
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');

    // La cola no quedó bloqueada: un cambio permitido en ese mismo menú se guarda con normalidad.
    await page.goto(`${baseURL}/#/menus/${MENU_ID}/cierre`);
    await page.locator('#closingNotes').fill('Sobró curry.');
    await page.locator('#saveClosing').click();
    await expect.poll(() => row('food.menus', MENU_ID).closing_notes).toBe('Sobró curry.');
  });
});
