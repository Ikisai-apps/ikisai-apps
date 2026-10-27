/**
 * Food · O3c en el navegador (390 px): los platos que sugieren las personas de fuera para el menú de casa. Entrada en
 * Menús y en la cabecera del menú de casa. Tanda 27 (MUELA-033 y 068 §3): el mazo de votos (también quien solo lee, sin ver
 * quién propone), la ficha «Para decidir» con lo que pide cada uno, aprobar o descartar con un «Deshacer» de verdad,
 * «Usar receta parecida», «Ya pasó» y el historial en «Ver todas en lista».
 *
 * Con `FOOD_CAPTURAS=<carpeta>` guarda capturas de cada pantalla («después» de la tabla de O3c).
 *
 * Cómo correrlo:   npx playwright test tests/food/house-suggestion.spec.ts      (desde la raíz del repo)
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
const READER = { email: 'lector@example.invalid', password: 'secreta-123', displayName: 'Lectora', role: 'reader' as const };
const CAPTURES = process.env.FOOD_CAPTURAS;

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let gazpacho: string;
let lentils: string;
let rice: string;
let soup: string;
let curryRecipe: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER, READER] });
  curryRecipe = api.seed('food.recipes', { name: 'Curry de verduras', category: 'principal', base_servings: 10, status: 'validada', allergens_checked: true }).id;
  api.seed('food.menus', { id: HOUSE_MENU_ID, kind: 'casa', house_servings: 6 });
  // Hoy: siempre en la semana que enseña el menú de casa (el día siguiente, un domingo, ya es la semana que viene).
  gazpacho = api.seedSuggestion({ name: 'Gazpacho', date: day(0), service: 'comida', author: 'Marta' });
  api.seedSuggestion({ name: 'Curry de verduras', date: day(2), service: 'cena', author: 'Íñigo' });
  lentils = api.seedSuggestion({ name: 'Lentejas', date: day(3), service: 'comida', author: 'Marta' });
  rice = api.seedSuggestion({ name: 'Arroz con verduras', date: day(4), service: 'cena', author: 'Íñigo' });
  soup = api.seedSuggestion({ name: 'Sopa de ayer', date: day(-1), service: 'cena', author: 'Marta' });
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

async function login(page: Page, user: { email: string; password: string; displayName: string } = USER): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(user.email);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${user.displayName}` })).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (CAPTURES) await page.screenshot({ path: path.join(CAPTURES, `${name}.png`), fullPage: true });
}

const decide = (page: Page) => page.locator('#suggestionDecide');
const status = (id: string) => api.suggestions().find((x) => x.id === id)?.status;

/** Lleva la ficha «Para decidir» a la sugerencia de ese plato. */
async function select(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    if ((await decide(page).locator('.fd-decide-name').textContent()) === name) return;
    await decide(page).getByRole('button', { name: 'Siguiente ›' }).click();
  }
  await expect(decide(page).locator('.fd-decide-name')).toHaveText(name);
}

test('platos sugeridos · entrada, votar en el mazo, decidir con «Deshacer», receta parecida, «Ya pasó» y el historial', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);

  await test.step('Menús: «Platos sugeridos» bajo el menú de casa, con las pendientes', async () => {
    await page.goto(`${baseURL}/#/menus`);
    const row = page.locator('#houseMenu li', { hasText: 'Platos sugeridos' });
    await expect(row).toContainText('5 pendientes de revisar');
    await expect(page.locator('.pagehead p').first()).toHaveText('El menú de cada evento. Se crean desde Eventos.');
    await capture(page, '18-menus-sugerencias');
    await page.goto(`${baseURL}/#/menus/${HOUSE_MENU_ID}`);
    await expect(page.locator('#houseSuggestionsChip')).toHaveText('5 platos sugeridos por revisar');
    await page.locator('#houseSuggestionsChip').click();
    await expect(page).toHaveURL(/#\/menus\/sugerencias$/);
    await expect(page.getByRole('heading', { name: 'Platos sugeridos', level: 2 })).toBeVisible();
    await expect(decide(page).locator('h3')).toHaveText('Para decidir (5)');
  });

  await test.step('el mazo: votar con los botones o con las flechas; la ficha cuenta los votos', async () => {
    const deck = page.locator('#suggestionDeck');
    await expect(deck.locator('.vote-card:not(.vote-behind)')).toContainText('Gazpacho');
    await expect(deck.locator('.vote-card:not(.vote-behind)')).toContainText('Propone: Marta');
    await capture(page, '19-sugeridos-mazo');
    await deck.getByRole('button', { name: 'Aprobar: votar para que entre' }).click();
    await expect.poll(() => api.rows('food.suggestion_votes').filter((v) => !v.deleted_at).map((v) => [v.suggestion_id, v.vote])).toEqual([[gazpacho, 'keep']]);
    await expect(deck.locator('.vote-card:not(.vote-behind)')).toContainText('Curry de verduras');
    await deck.locator('.vote-stack').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => api.rows('food.suggestion_votes').filter((v) => !v.deleted_at).length).toBe(2);
    await select(page, 'Gazpacho');
    await expect(page.locator('#suggestionTally')).toHaveText('1 aprobar · 0 descartar');
    await expect(page.locator('#suggestionMyVote')).toHaveText('Aprobar');
  });

  await test.step('la ficha dice qué plato, cuándo, el menú de casa ese día y si la receta ya existe o será rápida', async () => {
    const sheet = decide(page).locator('.suggestiondish');
    await expect(sheet).toContainText('Comida del');
    await expect(sheet).toContainText('Ese día en casa');
    await expect(sheet).toContainText('Nueva: se creará como plato rápido. Luego complétalo (alérgenos e ingredientes).');
    await expect(sheet).toContainText('Marta');
    await capture(page, '20-sugerencia-ficha');
  });

  await test.step('aprobar con «Deshacer» de verdad: deshecho no se envía; sin deshacer, a los 5 s', async () => {
    await page.locator('#approveSuggestion').click();
    await expect(page.locator('.toast.show')).toContainText('Aprobado: Gazpacho');
    await expect(decide(page).locator('h3')).toHaveText('Para decidir (4)');
    await page.locator('.toast.show').getByRole('button', { name: 'Deshacer' }).click();
    await expect(decide(page).locator('h3')).toHaveText('Para decidir (5)');
    await page.waitForTimeout(6000);
    expect(status(gazpacho)).toBe('pending');
    await select(page, 'Gazpacho');
    await page.locator('#approveSuggestion').click();
    await expect.poll(() => status(gazpacho), { timeout: 15_000 }).toBe('approved');
    // El servidor pone el plato en ese día con las personas en casa y una receta rápida.
    await expect.poll(() => api.rows('food.recipes').find((r) => r.name === 'Gazpacho')?.quick).toBe(true);
    const service = api.rows('food.menu_services').find((s) => s.menu_id === HOUSE_MENU_ID && s.service_date === day(0))!;
    expect(service).toMatchObject({ service_type: 'comida', service_time: '14:00' });
    expect(Number(api.rows('food.menu_items').find((i) => i.service_id === service.id)!.servings)).toBe(6);
    // Plato rápido nuevo: se ofrece completarlo al momento (F-SUG-2).
    await expect(page.locator('.toast.show')).toContainText('«Gazpacho» está en el menú de casa como plato rápido');
    await expect(page.locator('.toast.show').getByRole('button', { name: 'Completar la receta' })).toBeVisible();
  });

  await test.step('con una receta del Recetario, lo dice; «Usar receta parecida»; descartar con comentario', async () => {
    await select(page, 'Curry de verduras');
    await expect(decide(page).locator('.suggestiondish')).toContainText('Ya está en el Recetario: se usará esa.');
    await select(page, 'Arroz con verduras');
    // F-SUG-3: la que comparte «verduras» sale arriba, en «Más parecidas».
    await expect(page.locator('#similarRecipe optgroup[label="Más parecidas"] option').first()).toHaveText('Curry de verduras');
    await page.locator('#similarRecipe').selectOption({ label: 'Curry de verduras' });
    await page.locator('#approveSuggestion').click();
    await expect.poll(() => status(rice), { timeout: 15_000 }).toBe('approved');
    const dinner = api.rows('food.menu_services').find((s) => s.menu_id === HOUSE_MENU_ID && s.service_date === day(4))!;
    expect(api.rows('food.menu_items').find((i) => i.service_id === dinner.id)!.recipe_id).toBe(curryRecipe);
    expect(api.rows('food.recipes').some((r) => r.name === 'Arroz con verduras')).toBe(false);
    await select(page, 'Lentejas');
    await page.locator('#suggestionComment').fill('Esta semana ya hay legumbre.');
    await page.locator('#rejectSuggestion').click();
    await expect.poll(() => status(lentils), { timeout: 15_000 }).toBe('rejected');
    expect(api.suggestions().find((x) => x.id === lentils)?.comment).toBe('Esta semana ya hay legumbre.');
    expect(api.rows('food.recipes').some((r) => r.name === 'Lentejas')).toBe(false);
    expect(api.rows('food.recipes').filter((r) => r.name === 'Curry de verduras').map((r) => r.id)).toEqual([curryRecipe]);
  });

  await test.step('«Ya pasó»: no se puede aprobar un día que ya pasó', async () => {
    await select(page, 'Sopa de ayer');
    await expect(decide(page).locator('.fd-past')).toHaveText('Ya pasó');
    await expect(page.locator('#approveSuggestion')).toBeDisabled();
  });

  await test.step('«Elegir varias» (F-SUG-5): marcar las dos que quedan, descartarlas juntas y deshacerlo con un solo «Deshacer»', async () => {
    await page.locator('#suggestionsBatchToggle').click();
    const rows = page.locator('#suggestionBatch li');
    await expect(rows).toHaveCount(2);
    for (const box of await rows.locator('input[type=checkbox]').all()) await box.check();
    // Con «Sopa de ayer» marcada no se puede aprobar: ese día ya pasó.
    await expect(page.locator('#approveBatch')).toBeDisabled();
    await expect(page.locator('#rejectBatch')).toHaveText('Descartar (2)');
    await page.locator('#rejectBatch').click();
    await expect(page.locator('.toast.show')).toContainText('Descartadas: 2 sugerencias');
    await page.locator('.toast.show').getByRole('button', { name: 'Deshacer' }).click();
    await expect(decide(page).locator('h3')).toHaveText('Para decidir (2)');
    await page.waitForTimeout(5500); // pasado el plazo, nada se ha enviado
    expect(api.suggestions().filter((x) => x.status === 'rejected').length).toBe(1); // solo las lentejas, de antes
  });

  await test.step('«Ver todas en lista»: aprobadas con su enlace al menú de casa; el plato está en su día', async () => {
    await page.locator('#suggestionsAll').click();
    await page.locator('.pl-tabs button', { hasText: 'Aprobadas' }).click();
    const approved = page.locator(`.pl-card[data-id="${gazpacho}"]`);
    await expect(approved).toBeVisible();
    await page.locator('.pl-tabs button', { hasText: 'Descartadas' }).click();
    await expect(page.locator(`.pl-card[data-id="${lentils}"]`)).toContainText('Esta semana ya hay legumbre.');
    await page.locator('.pl-tabs button', { hasText: 'Aprobadas' }).click();
    await approved.getByRole('link', { name: 'Ver en el menú de casa' }).click();
    await expect(page).toHaveURL(new RegExp(`#/menus/${HOUSE_MENU_ID}$`));
    await expect(page.locator(`.menuday[data-day="${day(0)}"]`)).toContainText('Gazpacho');
    await expect(page.locator('#houseSuggestionsChip')).toHaveText('2 platos sugeridos por revisar');
    await capture(page, '21-menu-casa-con-sugerido');
  });
});

test('platos sugeridos · quien solo lee vota sin ver quién propone y no decide', async ({ page }) => {
  await login(page, READER);
  await page.goto(`${baseURL}/#/menus`);
  await page.locator('#houseMenu li', { hasText: 'Platos sugeridos' }).click();
  const deck = page.locator('#suggestionDeck');
  await expect(deck.locator('.vote-card:not(.vote-behind)')).toContainText('Propone: Una persona invitada');
  await expect(page.locator('main')).not.toContainText('Marta');
  await expect(page.locator('#approveSuggestion')).toHaveCount(0);
  await expect(page.locator('#suggestionsAll')).toHaveCount(0);
  await expect(decide(page)).toContainText('Los votos orientan; decide quien administra la cocina.');
  const before = api.rows('food.suggestion_votes').filter((v) => !v.deleted_at).length;
  await deck.getByRole('button', { name: 'Descartar: votar para que no entre' }).click();
  await expect.poll(() => api.rows('food.suggestion_votes').filter((v) => !v.deleted_at).length).toBe(before + 1);
  await capture(page, '22-sugeridos-lector');
});
