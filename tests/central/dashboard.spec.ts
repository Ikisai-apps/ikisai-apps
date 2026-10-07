/**
 * Central · Dirección (V2): el panel de Inicio muestra los KPIs de Central, el owner fija un objetivo y el estado cambia;
 * sin red se ve la última lectura. Contra la central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');
const madrid = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startCentralServer();
  // Una obligación vencida, creada por la API como lo haría otra persona.
  const res = await api.app.call('/api/v1/commands', { body: { requestId: 'seed-kpi', operations: [
    { op: 'insert', table: 'central.requirements', id: crypto.randomUUID(), fields: { name: 'Licencia vencida', requirement_type: 'licencia_autorizacion', expires_on: madrid(-2) } },
  ] } });
  expect(res.status).toBe(200);
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
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();
}

test('dirección · KPIs de Central, objetivo con umbrales y lectura sin red', async ({ page, context }) => {
  await login(page);
  const overdue = page.locator('.kpicard[data-kpi="central.legal_overdue"]');
  await expect(overdue).toContainText('Obligaciones vencidas');
  await expect(overdue.locator('.kpivalue')).toHaveText('1');
  // Las apps sin vista salen en «Aún sin indicadores»; Finance ya publica (migración 0211) y sus tarjetas entran en el panel.
  await expect(page.locator('#dashboardMeta')).toContainText('Aún sin indicadores:');
  await expect(page.locator('#dashboardMeta')).not.toContainText('Finance');
  await expect(page.locator('.kpicard[data-kpi="invoices.pending_review"]')).toContainText('Facturas recibidas por revisar');

  // Objetivo: ninguna vencida; atención desde 0, crítico desde 2 (menos es mejor).
  await overdue.getByRole('button', { name: /Objetivo/ }).click();
  await page.locator('#k-direction').selectOption('down');
  await page.locator('#k-target').fill('0');
  await page.locator('#k-warn').fill('0');
  await page.locator('#k-critical').fill('2');
  await page.locator('#saveTarget').click();
  await expect(page.getByText('Objetivo guardado.')).toBeVisible();
  await expect(overdue).toContainText('Atención');
  await expect(overdue).toContainText('objetivo 0');

  // El enlace lleva a Cumplimiento.
  await overdue.locator('.kpilabel').click();
  await expect(page.getByRole('heading', { name: 'Cumplimiento' })).toBeVisible();

  // Sin red: la última lectura, con su hora.
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Inicio', exact: true }).click();
  await expect(page.locator('#dashboardMeta')).toContainText('Sin conexión: datos del');
  await expect(overdue.locator('.kpivalue')).toHaveText('1');
  await context.setOffline(false);
});
