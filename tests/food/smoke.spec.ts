/**
 * Humo de Ikisai Food: login → Recetario → receta con ingrediente nuevo y foto recomprimida → edición sin red → sincronizar.
 *
 * Cómo correrlo:   npx playwright test tests/food            (desde la raíz del repo)
 * Compila la app con la API de Vite, la sirve con `vite preview` y reenvía /api a una API falsa en memoria (fake-api.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const RECIPES = 'food.recipes';

// La app calcula «hoy» con la fecha local del navegador: la misma zona que `day()` y el servidor.
test.use({ timezoneId: TIME_ZONE });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  process.env.VITE_API_PROXY = api.url;
  await buildFoodApp();
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
  await expect(page.getByRole('heading', { name: 'Ikisai Food' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

/** Una foto «de cámara» sintética de 2400 × 1800 px, generada en el propio navegador. */
async function cameraPhoto(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400; canvas.height = 1800;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 2400, 1800);
    gradient.addColorStop(0, '#c4712f'); gradient.addColorStop(1, '#56663f');
    context.fillStyle = gradient; context.fillRect(0, 0, 2400, 1800);
    context.fillStyle = '#fffdf8'; context.beginPath(); context.arc(1200, 900, 520, 0, Math.PI * 2); context.fill();
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

test('login → receta con ingrediente nuevo y foto → edición sin red → sincronizar @smoke', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('login y las cinco entradas', async () => {
    await login(page);
    await expect(page.locator('#syncStatus')).toContainText('En línea');
    for (const label of ['Inicio', 'Eventos', 'Menús', 'Recetario', 'Maquinaria']) {
      await expect(page.locator('.nav').getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  await test.step('la marca de la cabecera abre el menú lateral, con las apps de la cuenta y lo que no está en la barra', async () => {
    // Tanda 27 (kit 0.47, MUELA-013): la marca abre el menú lateral; el lanzador va dentro, sin la app actual.
    await page.locator('#appLauncher').click();
    const drawer = page.getByRole('dialog', { name: 'Menú de Food' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Propietario');
    await expect(drawer.locator('a.launcher-app[data-app="booking"]')).toHaveAttribute('href', 'https://booking.ikisai.com/');
    await expect(drawer.locator('a.launcher-app[data-app="tasks"]')).toBeVisible();
    await expect(drawer.locator('a.launcher-app[data-app="food"]')).toHaveCount(0);
    await drawer.getByRole('button', { name: /^Cocina/ }).click();
    await expect(drawer.getByRole('link', { name: /Cocina de hoy/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  await test.step('maquinaria: alta de un horno', async () => {
    await page.goto(`${baseURL}/#/maquinaria`);
    await expect(page.getByText('Todavía no hay maquinaria')).toBeVisible();
    await page.getByRole('button', { name: 'Nueva máquina' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva máquina' });
    await dialog.getByLabel('Nombre').fill('Horno 1');
    await dialog.getByLabel('Tipo').fill('Horno');
    await page.locator('#saveEquipment').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#equipmentList .row', { hasText: 'Horno 1' })).toHaveAttribute('data-pending', 'false');
    expect(api.rows('food.equipment')[0]).toMatchObject({ name: 'Horno 1', category: 'Horno', quantity: 1, status: 'operativo' });
  });

  await test.step('maquinaria: el horno se avería y se avisa a Tasks', async () => {
    await page.locator('#equipmentList .row', { hasText: 'Horno 1' }).getByRole('button', { name: 'Editar Horno 1' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editar máquina' });
    await expect(dialog.locator('#reportFault')).toHaveCount(0); // operativa: nada que avisar
    await dialog.getByLabel('Estado').selectOption('averiado');
    await page.locator('#saveEquipment').click();
    await expect(dialog).toBeHidden();
    // Tanda 27: el recorrido Falla · Avisado · En reparación · Funciona, con la palabra exacta del estado.
    const row = page.locator('#equipmentList .row', { hasText: 'Horno 1' });
    await expect(row.locator('.row-title .chip:not(.pending)')).toHaveText('Averiado');
    await expect(row.locator('.fd-journey')).toContainText('Falla · averiada');
    await row.getByRole('button', { name: 'Editar Horno 1' }).click();
    await expect(page.locator('#equipmentJourney')).toContainText('Siguiente: avisar a Tasks para repararla');
    await expect(page.locator('#reportFaultTop')).toBeVisible();
    await page.locator('#reportFault').click();
    await expect(page.getByText('Aviso enviado a Tasks: queda en «Por clasificar».')).toBeVisible();
    expect(api.faults()).toEqual([{ id: api.rows('food.equipment')[0]!.id, body: { name: 'Horno 1', status: 'averiado', location: '', note: '' } }]);
    // El aviso queda anotado: «Avisado», y nunca «En reparación» sin el estado real de Tasks.
    await expect(page.locator('#equipmentJourney')).toContainText('Avisado · averiada');
    await expect(page.locator('#equipmentJourney')).toContainText('Siguiente: que Tasks la repare');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Editar máquina' })).toBeHidden();
    await expect(row.locator('.fd-journey')).toContainText('Avisado · averiada');
  });

  await test.step('recetario vacío y receta nueva con ingrediente, maquinaria y foto', async () => {
    await page.goto(`${baseURL}/#/recetario`);
    await expect(page.getByText('Todavía no hay recetas')).toBeVisible();
    const photo = await cameraPhoto(page);
    await page.getByRole('button', { name: 'Nueva receta' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva receta' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Nombre', { exact: true }).fill('Curry de verduras');
    await dialog.getByLabel('Raciones base').fill('20');
    await dialog.getByLabel('Descripción pública').fill('Curry suave de verduras de temporada con arroz especiado.');
    const line = dialog.locator('#ingredientRows .linerow').first();
    await line.getByLabel('Ingrediente', { exact: true }).fill('Tomate');
    await line.getByLabel('Cantidad', { exact: true }).fill('2,5');
    await line.getByLabel('Unidad', { exact: true }).selectOption('kg');
    // Dietas y alérgenos: chips del selector de etiquetas del kit.
    await dialog.locator('button[data-label="diet:vegano"]').click();
    await dialog.locator('button[data-label="allergen:apio"]').click();
    await expect(dialog.locator('button[data-label="allergen:apio"]')).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('checkbox', { name: 'Horno 1' }).check();
    await dialog.locator('#r-photo').setInputFiles({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: photo });
    await expect(dialog.locator('#photoNote')).toContainText('Foto lista');

    // Validar sin haber revisado los alérgenos no se puede.
    await dialog.getByLabel('Estado').selectOption('validada');
    await page.locator('#saveRecipe').click();
    await expect(dialog.getByRole('alert')).toContainText('Revisa los alérgenos');
    await dialog.getByLabel('He revisado los alérgenos de esta receta').check();
    await page.locator('#saveRecipe').click();
    await expect(dialog).toBeHidden();

    const card = page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Principal · Vegano');
    await expect(card).toHaveAttribute('data-pending', 'false', { timeout: 15_000 });
    await expect(card.locator('img')).toBeVisible();

    // En el servidor: receta, ingrediente creado en el mismo lote, línea y maquinaria.
    const recipe = api.rows(RECIPES)[0]!;
    expect(recipe).toMatchObject({ name: 'Curry de verduras', base_servings: 20, status: 'validada', allergens_checked: true, diet_tags: ['vegano'], allergens: ['apio'] });
    expect(api.rows('food.ingredients')[0]).toMatchObject({ name: 'Tomate', preferred_unit: 'kg' });
    expect(api.rows('food.recipe_ingredients')[0]).toMatchObject({ recipe_id: recipe.id, quantity: 2.5, unit: 'kg' });
    expect(api.rows('food.recipe_equipment')[0]).toMatchObject({ recipe_id: recipe.id, quantity_required: 1 });

    // La foto: dos archivos recomprimidos en el cliente, ninguno es el original, y la receta los referencia por file_id.
    const files = api.files();
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.verified).toBe(true);
      expect(['image/webp', 'image/jpeg']).toContain(file.mime);
      expect(file.size).toBeLessThan(photo.byteLength);
      expect(file.size).toBeLessThan(400 * 1024);
    }
    const display = files.find((f) => f.id === recipe.photo_file_id)!;
    const thumb = files.find((f) => f.id === recipe.photo_thumb_file_id)!;
    expect(display).toBeTruthy(); expect(thumb).toBeTruthy();
    expect(thumb.size).toBeLessThan(display.size);
    const sizes = await page.evaluate(async (ids) => Promise.all(ids.map(async (id) => {
      const bitmap = await createImageBitmap(await (await fetch(`/api/v1/__storage/${id}`)).blob());
      return [bitmap.width, bitmap.height];
    })), [display.id, thumb.id]);
    expect(sizes).toEqual([[1600, 1200], [480, 360]]);
  });

  await test.step('ficha en lectura', async () => {
    await page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras' }).click();
    const ficha = page.getByRole('dialog', { name: 'Curry de verduras' });
    await expect(ficha).toContainText('20 raciones base');
    await expect(ficha.locator('table.ingredients')).toContainText('Tomate');
    await expect(ficha.locator('table.ingredients')).toContainText('2,5');
    await expect(ficha).toContainText('Alérgenos: Apio');
    await expect(ficha).toContainText('1 × Horno 1');
    // Tanda 27: la foto es la portada de la ficha (`renderCover` del kit).
    await expect(ficha.locator('.ficha-photo[data-photo="ready"] .cover-has-image')).toBeVisible();
    await ficha.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
    await expect(ficha).toBeHidden();
  });

  await test.step('sin red: el recetario y la foto siguen ahí; se edita y queda pendiente', async () => {
    await page.reload();
    await expect(page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras' })).toBeVisible();
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
    await page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras' }).click();
    const ficha = page.getByRole('dialog', { name: 'Curry de verduras' });
    await expect(ficha.locator('.ficha-photo[data-photo="ready"] .cover-has-image')).toBeVisible(); // desde la caché local
    await page.locator('#editRecipe').click();
    const dialog = page.getByRole('dialog', { name: 'Editar receta' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Curry de verduras de temporada');
    await dialog.getByRole('button', { name: 'Añadir ingrediente' }).click();
    const line = dialog.locator('#ingredientRows .linerow').last();
    await line.getByLabel('Ingrediente', { exact: true }).fill('Leche de coco');
    await line.getByLabel('Cantidad', { exact: true }).fill('400');
    await line.getByLabel('Unidad', { exact: true }).selectOption('ml');
    await page.locator('#saveRecipe').click();
    await expect(dialog).toBeHidden();
    const card = page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras de temporada' });
    await expect(card).toHaveAttribute('data-pending', 'true');
    await expect(card).toContainText('Pendiente de sincronizar');
    expect(api.rows(RECIPES)[0]!.name).toBe('Curry de verduras');
  });

  await test.step('vuelve la red: se sincroniza', async () => {
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine);
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
    const card = page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras de temporada' });
    await expect(card).toHaveAttribute('data-pending', 'false', { timeout: 15_000 });
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
    expect(api.rows(RECIPES)[0]).toMatchObject({ name: 'Curry de verduras de temporada', revision: 2 });
    expect(api.rows('food.ingredients').map((i) => i.name).sort()).toEqual(['Leche de coco', 'Tomate']);
    expect(api.rows('food.recipe_ingredients')).toHaveLength(2);
  });

  await test.step('papelera: la receta se va con sus líneas y vuelve con ellas', async () => {
    await page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras de temporada' }).click();
    await page.locator('#editRecipe').click();
    await page.locator('#deleteRecipe').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Enviar a papelera' }).click();
    await expect(page.locator('#recipeGrid .recipecard')).toHaveCount(0);
    await expect.poll(() => api.rows('food.recipe_ingredients').filter((l) => l.deleted_at).length).toBe(2);
    const trash = page.locator('#trash');
    await trash.locator('summary').click();
    await trash.getByRole('button', { name: 'Restaurar Curry de verduras de temporada' }).click();
    await expect(page.locator('#recipeGrid .recipecard', { hasText: 'Curry de verduras de temporada' })).toBeVisible();
    await expect.poll(() => api.rows('food.recipe_ingredients').filter((l) => !l.deleted_at).length).toBe(2);
  });
});

test('elaboración por pasos y subpasos, reordenable, y antelación con unidad (FB_2026_028)', async ({ page }) => {
  const old = api.seed(RECIPES, { name: 'Gazpacho de la casa', category: 'entrante', base_servings: 10, method: 'Uno\nDos' });
  await login(page);
  await page.goto(`${baseURL}/#/recetario`);

  await test.step('una receta antigua con solo «method» se abre con un paso por línea y no se reescribe', async () => {
    await page.locator('#recipeGrid .recipecard', { hasText: 'Gazpacho de la casa' }).click();
    await page.locator('#editRecipe').click();
    const dialog = page.getByRole('dialog', { name: 'Editar receta' });
    const areas = dialog.locator('#r-method textarea.steparea');
    await expect(areas).toHaveCount(2);
    await expect(areas.nth(0)).toHaveValue('Uno');
    await expect(areas.nth(1)).toHaveValue('Dos');
    await expect(dialog.getByLabel('Paso 2', { exact: true })).toHaveValue('Dos');
    await expect(dialog.locator('#r-prep-mode')).toHaveValue('sin');
    await page.locator('#saveRecipe').click(); // sin cambios: se cierra sin escribir
    await expect(dialog).toBeHidden();
    expect(api.rows(RECIPES).find((r) => r.id === old.id)).toMatchObject({ revision: 1, method: 'Uno\nDos', method_steps: null });
  });

  await test.step('dos pasos y un subpaso, se sube el segundo paso y se guarda con 2 horas de antelación', async () => {
    await page.getByRole('button', { name: 'Nueva receta' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva receta' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Crema de calabaza');
    await dialog.getByLabel('Raciones base').fill('10');
    await dialog.getByLabel('Paso 1', { exact: true }).fill('Asar la calabaza');
    await dialog.getByRole('button', { name: 'Añadir paso' }).click();
    await dialog.getByLabel('Paso 2', { exact: true }).fill('Triturar con el caldo');
    await dialog.getByRole('button', { name: 'Añadir subpaso al paso 2' }).click();
    await dialog.getByLabel('Subpaso 2.1', { exact: true }).fill('Colar');
    await expect(dialog.locator('#r-method .stepnum')).toHaveText(['1', '2', '2.1']);
    await dialog.getByRole('button', { name: 'Subir paso 2', exact: true }).click();
    await expect(dialog.locator('#r-method .stepnum')).toHaveText(['1', '1.1', '2']);
    await expect(dialog.getByLabel('Paso 1', { exact: true })).toHaveValue('Triturar con el caldo');
    await expect(dialog.getByLabel('Subpaso 1.1', { exact: true })).toHaveValue('Colar');

    // Antelación: «Antes del servicio» con número y unidad; fuera de rango, aviso claro.
    await dialog.locator('#r-prep-mode').selectOption('antes');
    await dialog.locator('#r-prep').fill('8');
    await dialog.locator('#r-prep-unit').selectOption('dias');
    await page.locator('#saveRecipe').click();
    await expect(dialog.getByRole('alert')).toContainText('La antelación va entre 1 minuto y 7 días.');
    await dialog.locator('#r-prep').fill('2');
    await dialog.locator('#r-prep-unit').selectOption('horas');    await page.locator('#saveRecipe').click();
    await expect(dialog).toBeHidden();

    await expect.poll(() => api.rows(RECIPES).find((r) => r.name === 'Crema de calabaza')?.prep_minutes).toBe(120);
    const row = api.rows(RECIPES).find((r) => r.name === 'Crema de calabaza')!;
    expect(row.method_steps).toMatchObject([{ text: 'Triturar con el caldo', steps: [{ text: 'Colar' }] }, { text: 'Asar la calabaza' }]);
    expect(row.method).toBe('1. Triturar con el caldo\n   1.1. Colar\n2. Asar la calabaza');
  });

  await test.step('la ficha numera 1, 1.1, 2 y dice «2 horas antes»; el formulario vuelve con número y unidad', async () => {
    await page.locator('#recipeGrid .recipecard', { hasText: 'Crema de calabaza' }).click();
    const ficha = page.getByRole('dialog', { name: 'Crema de calabaza' });
    await expect(ficha.locator('.methodsteps .stepnum')).toHaveText(['1', '1.1', '2']);
    await expect(ficha.locator('.methodsteps .steptext')).toHaveText(['Triturar con el caldo', 'Colar', 'Asar la calabaza']);
    await expect(ficha).toContainText('Antelación: 2 horas antes');    await page.locator('#editRecipe').click();
    const dialog = page.getByRole('dialog', { name: 'Editar receta' });
    await expect(dialog.locator('#r-prep-mode')).toHaveValue('antes');
    await expect(dialog.locator('#r-prep')).toHaveValue('2');
    await expect(dialog.locator('#r-prep-unit')).toHaveValue('horas');
    await expect(dialog.locator('#r-method .stepnum')).toHaveText(['1', '1.1', '2']);
  });

  await test.step('subpasos sin restricción: a otro paso con el teclado, sacar y meter de nivel, y arrastre con el ratón', async () => {
    const dialog = page.getByRole('dialog', { name: 'Editar receta' });
    const nums = dialog.locator('#r-method .stepnum');
    const live = dialog.locator('#r-method [aria-live]');

    // Teclado sobre el asa: ↓ lleva el subpaso 1.1 al paso siguiente.
    await dialog.getByRole('button', { name: 'Mover subpaso 1.1', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(nums).toHaveText(['1', '2', '2.1']);
    await expect(dialog.getByLabel('Subpaso 2.1', { exact: true })).toHaveValue('Colar');
    await expect(live).toHaveText('Subpaso 1.1, ahora subpaso 2.1.');
    await expect(dialog.getByRole('button', { name: 'Mover subpaso 2.1', exact: true })).toBeFocused();

    // Botón: sacar de nivel (pasa a paso detrás del suyo).
    await dialog.getByRole('button', { name: 'Sacar subpaso 2.1 de nivel', exact: true }).click();
    await expect(nums).toHaveText(['1', '2', '3']);
    await expect(dialog.getByLabel('Paso 3', { exact: true })).toHaveValue('Colar');
    await expect(live).toHaveText('Subpaso 2.1, ahora paso 3.');
    // El primer paso no se puede meter de nivel.
    await expect(dialog.getByRole('button', { name: 'Meter paso 1 en el paso anterior', exact: true })).toBeDisabled();

    // Teclado: → mete el paso 2 (sin subpasos) en el paso 1.
    await dialog.getByRole('button', { name: 'Mover paso 2', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(nums).toHaveText(['1', '1.1', '2']);
    await expect(dialog.getByLabel('Subpaso 1.1', { exact: true })).toHaveValue('Asar la calabaza');
    await expect(dialog.getByLabel('Paso 2', { exact: true })).toHaveValue('Colar');
    await expect(live).toHaveText('Paso 2, ahora subpaso 1.1.');
    // Un subpaso no baja a un tercer nivel.
    await page.keyboard.press('ArrowRight');
    await expect(live).toHaveText('Ya es un subpaso: solo hay dos niveles.');
    await expect(nums).toHaveText(['1', '1.1', '2']);

    // Ratón: arrastrar el subpaso 1.1 por el asa hasta debajo del paso 2 lo convierte en su subpaso.
    const handle = dialog.getByRole('button', { name: 'Mover subpaso 1.1', exact: true });
    await handle.scrollIntoViewIfNeeded();
    const from = (await handle.boundingBox())!;
    const to = (await dialog.getByLabel('Paso 2', { exact: true }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 3 });
    await page.mouse.move(from.x + from.width / 2, to.y + to.height * 0.8, { steps: 8 });
    await expect(dialog.locator('#r-method .stepdrop')).toHaveText('Subpaso 2.1');
    await page.mouse.up();
    await expect(nums).toHaveText(['1', '2', '2.1']);
    await expect(dialog.getByLabel('Subpaso 2.1', { exact: true })).toHaveValue('Asar la calabaza');
    await expect(dialog.locator('#r-method .stepdrop')).toBeHidden();

    await page.locator('#saveRecipe').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows(RECIPES).find((r) => r.name === 'Crema de calabaza')?.revision).toBe(2);
    const row = api.rows(RECIPES).find((r) => r.name === 'Crema de calabaza')!;
    expect(row.method_steps).toMatchObject([{ text: 'Triturar con el caldo' }, { text: 'Colar', steps: [{ text: 'Asar la calabaza' }] }]);
    expect((row.method_steps as Array<{ steps?: unknown }>)[0]!.steps).toBeUndefined();
    expect(row.method).toBe('1. Triturar con el caldo\n2. Colar\n   2.1. Asar la calabaza');

    const ficha = page.getByRole('dialog', { name: 'Crema de calabaza' });
    if (!(await ficha.isVisible())) await page.locator('#recipeGrid .recipecard', { hasText: 'Crema de calabaza' }).click();
    await expect(ficha.locator('.methodsteps .stepnum')).toHaveText(['1', '2', '2.1']);
    await expect(ficha.locator('.methodsteps .steptext')).toHaveText(['Triturar con el caldo', 'Colar', 'Asar la calabaza']);
  });
});
