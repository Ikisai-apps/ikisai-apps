/**
 * Flow · cáscara del personal en `/equipo` (FLOW-DIR-001 §8): login del kit, Inicio, menú lateral común con el lanzador, «‹ Volver a…» (K9) al
 * llegar desde otra app y cierre de sesión. Contra la `flow-api` real sobre PGlite. Datos ficticios.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildFlowApp } from './e2e-build.ts';
import { startFlowServer, type FlowTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/flow/vite.config.ts');

let api: FlowTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  api = await startFlowServer();
  await buildFlowApp();
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

async function login(page: Page, url = `${baseURL}/equipo`): Promise<void> {
  await page.goto(url);
  await expect(page.getByText('Ikisai Flow').first()).toBeVisible();
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();
}

test('flow · login con contraseña errónea avisa y no entra', async ({ page }) => {
  await page.goto(`${baseURL}/equipo`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill('mal');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#loginError')).toHaveText('Correo o contraseña incorrectos.');
});

test('flow · login → Inicio en preparación; menú común con perfil; cerrar sesión vuelve al login', async ({ page }) => {
  await login(page);
  await expect(page).toHaveTitle('Inicio · Ikisai Flow');
  await expect(page.getByRole('heading', { name: 'Flow está en preparación' })).toBeVisible();
  await page.locator('#appLauncher').click();
  const drawer = page.locator('#appMenu');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Owner');
  await expect(drawer).toContainText('Propietario');
  // En el móvil, «Cerrar sesión» va dentro del menú (kit, MUELA-013).
  await drawer.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByLabel('Correo electrónico')).toBeVisible();
});

test('flow · llegar desde otra app con returnTo muestra «Volver a…» y limpia la URL', async ({ page }) => {
  const volver = encodeURIComponent('https://central.ikisai.com/#/');
  await login(page, `${baseURL}/equipo?desde=central&volver=${volver}&titulo=Central`);
  const back = page.locator('a.return-link');
  await expect(back).toBeVisible();
  await expect(back).toContainText('Volver a Central');
  await expect(back).toHaveAttribute('href', 'https://central.ikisai.com/#/');
  expect(page.url()).not.toContain('volver=');
});
