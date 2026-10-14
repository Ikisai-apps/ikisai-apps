/**
 * Food · R5a en el navegador (390 px): al abrir la app, cada ingrediente y máquina queda enlazado con su artículo de
 * Recursos; el recetario sugiere los ingredientes que ya existen en Recursos y los usa sin duplicarlos; lo que Food
 * cambia se copia al artículo. Para quien usa la app no cambia nada más (caracterizacion-r5.spec.ts).
 *
 * Cómo correrlo:   npx playwright test tests/food/resources.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { equipmentRef, ingredientRef } from '../../supabase/functions/_domain/food/mod.ts';
import { freePort, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };

test.use({ timezoneId: TIME_ZONE, viewport: { width: 390, height: 844 } });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;
let tomato: string;
let oven: string;
let oil: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  tomato = api.seed('food.ingredients', { name: 'Tomate', preferred_unit: 'kg' }).id;
  oven = api.seed('food.equipment', { name: 'Horno', category: 'Horno', capacity: '70 cm', status: 'averiado' }).id;
  // Un ingrediente que ya está en Recursos (lo creó Finance, por ejemplo) y que Food aún no usa.
  oil = api.seed('resources.items', { name: 'Aceite de oliva', kind: 'ingrediente', base_unit: 'l' }).id;
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
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

const item = (ref: string) => api.rows('resources.items').find((i) => (i.source_refs as string[]).includes(ref));
const row = (table: string, id: string) => api.rows(table).find((r) => r.id === id)!;

test('Recursos · enlace al abrir, ingrediente de Recursos sugerido y estado de la máquina copiado', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('al abrir: cada ingrediente y máquina tiene su artículo, enlazado', async () => {
    await expect.poll(() => row('food.ingredients', tomato).item_id, { timeout: 15_000 }).toBeTruthy();
    await expect.poll(() => row('food.equipment', oven).item_id, { timeout: 15_000 }).toBeTruthy();
    expect(item(ingredientRef(tomato))).toMatchObject({ id: row('food.ingredients', tomato).item_id, name: 'Tomate', kind: 'ingrediente', base_unit: 'kg' });
    expect(item(equipmentRef(oven))).toMatchObject({ id: row('food.equipment', oven).item_id, name: 'Horno', kind: 'maquina', category: 'Horno', attributes: { status: 'averiado', capacity: '70 cm' } });
    expect(api.rows('resources.items')).toHaveLength(3);
  });

  await test.step('recetario: sugiere «Aceite de oliva» de Recursos, con su unidad, y lo usa sin duplicarlo', async () => {
    await page.goto(`${baseURL}/#/recetario`);
    await page.locator('#newRecipe').click();
    const dialog = page.getByRole('dialog', { name: 'Nueva receta' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Ensalada');
    await dialog.getByLabel('Raciones base').fill('4');
    await expect(dialog.locator('#ingredientNames option')).toHaveCount(2);
    const line = dialog.locator('#ingredientRows .linerow').first();
    await line.getByLabel('Ingrediente', { exact: true }).fill('aceite de oliva');
    await line.getByLabel('Ingrediente', { exact: true }).blur();
    await expect(line.getByLabel('Unidad', { exact: true })).toHaveValue('l');
    await line.getByLabel('Cantidad', { exact: true }).fill('0,1');
    await page.locator('#saveRecipe').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows('food.ingredients').find((i) => i.item_id === oil)).toMatchObject({ name: 'Aceite de oliva', preferred_unit: 'l' });
    // Tras el siguiente enlace, el artículo lleva la referencia de Food y no hay otro con el mismo nombre.
    const id = api.rows('food.ingredients').find((i) => i.item_id === oil)!.id as string;
    await expect.poll(() => (row('resources.items', oil).source_refs as string[]).includes(ingredientRef(id)), { timeout: 15_000 }).toBe(true);
    expect(api.rows('resources.items').filter((i) => String(i.name).toLowerCase() === 'aceite de oliva')).toHaveLength(1);
  });

  await test.step('Maquinaria: el estado que se cambia en Food se copia al artículo', async () => {
    await page.goto(`${baseURL}/#/maquinaria`);
    await page.locator('#equipmentList .row', { hasText: 'Horno' }).getByRole('button', { name: 'Editar Horno' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editar máquina' });
    await dialog.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('operativo');
    await page.locator('#saveEquipment').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => item(equipmentRef(oven))?.attributes, { timeout: 15_000 }).toEqual({ status: 'operativo', capacity: '70 cm' });
  });
});
