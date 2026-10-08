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
import { feedbackRoundTrip, simulateKeyboard } from '../../packages/ui-kit/testing/feedback-smoke.ts';

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

// Prueba común de feedback del kit (0.25.1): lanzador → «Señalar para comentar» → pulsación larga → enviar con doble toque →
// composer cerrado → aviso visible y sin estirarse. La central-api real cuenta los reportes: con el doble toque llega uno.
async function enterAsOwner(page: import('playwright/test').Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();
  const notice = page.getByRole('button', { name: 'Entendido' });
  if (await notice.isVisible().catch(() => false)) await notice.click(); // el aviso de uso, si esta prueba va sola
}
const reports = async () => (await api.app.t.db.query<{ n: number }>(`select count(*)::int as n from core.feedback_reports where origin_app = 'central'`)).rows[0]!.n;

test('feedback · enviar un reporte: se cierra, se ve el aviso y llega uno solo @smoke', async ({ page }) => {
  await enterAsOwner(page);
  const before = await reports();
  // El saludo lleva el nombre y está fuera del gesto (data-feedback-ignore): se comenta el enlace a Entidad.
  const { code } = await feedbackRoundTrip(page, { target: '[data-feedback-id="central.inicio.enlaces.entidad"]' });
  expect(code).toMatch(/^FB_\d{4}_\d+$/);
  await expect.poll(reports).toBe(before + 1);
});

test('feedback · con una hoja abierta y el teclado en pantalla (móvil 484×1008 → 686): el aviso se ve y llega uno solo', async ({ page }) => {
  // Como `feedbackRoundTrip`, pero con el modo encendido antes de abrir la hoja (con la hoja abierta, el lanzador queda debajo).
  await page.setViewportSize({ width: 484, height: 1008 });
  await enterAsOwner(page);
  await page.goto(`${baseURL}/#/entidad`);
  await page.locator('#appLauncher').click();
  if (!(await page.locator('.launcher-signal input').isChecked())) await page.locator('.launcher-signal').click();
  await expect(page.locator('.launcher-signal input')).toBeChecked();
  await page.keyboard.press('Escape');
  await page.locator('#editEntity').click();
  await expect(page.locator('#en-legal')).toBeVisible();
  const before = await reports();

  const label = page.locator('[data-feedback-id="central.entidad.editar.campo_razon_social"] > span').first();
  const box = (await label.boundingBox())!;
  await label.hover({ position: { x: Math.min(box.width / 2, 20), y: Math.min(box.height / 2, 8) } });
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  const composer = page.locator('.fb-composer');
  await expect(composer).toBeVisible();
  await composer.locator('.fb-message').fill('La razón social debería avisar si falta la forma jurídica.');
  await simulateKeyboard(page, 686);
  await composer.locator('.fb-send').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter').catch(() => undefined); // doble toque: tiene que llegar uno
  await expect(composer).toHaveCount(0, { timeout: 8000 });
  const toast = page.locator('.toast.show').filter({ hasText: /Enviado · FB_/ });
  await expect(toast).toBeVisible();
  const fit = await toast.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { h: r.height, inside: r.top >= 0 && r.bottom <= 686 && r.left >= 0 && r.right <= innerWidth };
  });
  expect(fit.inside, 'el aviso se ve por encima del teclado').toBe(true);
  expect(fit.h, 'el aviso no se estira en columna').toBeLessThan(90);
  await simulateKeyboard(page, null);
  await expect.poll(reports).toBe(before + 1);
  const node = (await api.app.t.db.query<{ node_id: string }>(`select node_id from core.feedback_reports where origin_app = 'central' order by created_at desc limit 1`)).rows[0]!;
  expect(node.node_id).toBe('central.entidad.editar.campo_razon_social');
});
