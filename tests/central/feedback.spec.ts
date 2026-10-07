/**
 * Central · «Sugerencias y QA» y uso semántico (fase 4): aviso de medición la primera vez, centro de reportes en el
 * panel del lanzador, marcas de pantalla y una operación importante contada con `usage.run`. Contra la central-api real (server.ts),
 * sin el consentimiento previo de las cuentas de prueba para ver el aviso.
 */
import { expect, test } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  // Compilar la app con Vite puede pasar de los 90 s con la máquina cargada (fallo visto con @smoke en paralelo).
  test.setTimeout(180_000);
  api = await startCentralServer({ consent: false });
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

test('feedback · aviso de uso, centro «Sugerencias y QA», marcas de pantalla y usage.run @smoke', async ({ page, context }) => {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();

  // Aviso de medición la primera vez; «Entendido» lo guarda.
  await expect(page.getByRole('heading', { name: 'Mejoramos las herramientas con su uso' })).toBeVisible();
  await page.getByRole('button', { name: 'Entendido' }).click();
  await expect(page.getByRole('heading', { name: 'Mejoramos las herramientas con su uso' })).toHaveCount(0);
  const consent = await api.app.call('/api/v1/usage/consent');
  expect(consent.data.consentedAt).toBeTruthy();

  // Marcas de la cáscara y de la pantalla.
  await expect(page.locator('main')).toHaveAttribute('data-feedback-id', 'central.inicio');
  await expect(page.locator('#feedbackCenter')).toHaveCount(0); // kit 0.18: el centro va en el panel del lanzador
  await page.getByRole('link', { name: 'Personas', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-feedback-id', 'central.personas');
  expect(await page.locator('main [data-feedback-id]').count()).toBeGreaterThan(3);

  // Centro de reportes, desde el panel del lanzador.
  await page.locator('#appLauncher').click();
  await page.locator('.launcher-center').click();
  await expect(page.getByRole('heading', { name: 'Sugerencias y QA' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Una operación importante cuenta como éxito y llega al núcleo al volver la red.
  await page.goto(`${baseURL}/#/decisiones`);
  await page.locator('#newDecision').click();
  await page.locator('#dc-name').fill('Probar el uso');
  await page.locator('#dc-summary').fill('Una decisión para comprobar que se cuenta.');
  await page.locator('#saveDecision').click();
  await expect(page.getByText('Decisión guardada.')).toBeVisible();
  await context.setOffline(true);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await api.app.t.db.query<{ n: number }>(
    `select coalesce(sum(successes), 0)::int as n from core.usage_daily where feature_id = 'central.decisiones.guardar'`)).rows[0]!.n,
  { timeout: 20_000 }).toBeGreaterThan(0);
});
