/**
 * Humo de Ikisai Food: login → Recetario → receta con ingrediente nuevo y foto recomprimida → edición sin red → sincronizar.
 *
 * Cómo correrlo:   npx playwright test tests/food            (desde la raíz del repo)
 * Compila la app con la API de Vite, la sirve con `vite preview` y reenvía /api a una API falsa en memoria (fake-api.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const RECIPES = 'food.recipes';

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: 4800 + Math.floor(Math.random() * 500), strictPort: false, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
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

test('login → receta con ingrediente nuevo y foto → edición sin red → sincronizar', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('login y las cinco entradas', async () => {
    await login(page);
    await expect(page.locator('#syncStatus')).toContainText('En línea');
    for (const label of ['Inicio', 'Eventos', 'Menús', 'Recetario', 'Maquinaria']) {
      await expect(page.locator('.nav').getByText(label, { exact: true }).first()).toBeVisible();
    }
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
    await dialog.getByRole('checkbox', { name: 'Vegano', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Apio', exact: true }).check();
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
    await expect(ficha.locator('.ficha-photo img')).toBeVisible();
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
    await expect(ficha.locator('.ficha-photo img')).toBeVisible(); // desde la caché local
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
