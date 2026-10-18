/**
 * Central · Dirección (V2): el panel de Inicio muestra los KPIs de Central, el owner fija un objetivo y el estado cambia;
 * sin red se ve la última lectura. Contra la central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildCentralApp } from './e2e-build.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');
const madrid = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  // Compilar la app con Vite puede pasar de los 90 s con la máquina cargada (fallo visto con @smoke en paralelo).
  test.setTimeout(180_000);
  api = await startCentralServer();
  // Una obligación vencida, creada por la API como lo haría otra persona.
  const res = await api.app.call('/api/v1/commands', { body: { requestId: 'seed-kpi', operations: [
    { op: 'insert', table: 'central.requirements', id: crypto.randomUUID(), fields: { name: 'Licencia vencida', requirement_type: 'licencia_autorizacion', expires_on: madrid(-2) } },
  ] } });
  expect(res.status).toBe(200);
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp(); // un solo build aunque haya varios workers
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

test('dirección · KPIs de Central, objetivo con umbrales y lectura sin red @smoke', async ({ page, context }) => {
  await login(page);
  const overdue = page.locator('.kpicard[data-kpi="central.legal_overdue"]');
  await expect(overdue).toContainText('Obligaciones vencidas');
  await expect(overdue.locator('.kpivalue')).toHaveText('1');
  // Qué apps faltan cambia según publican; basta con que el panel se pinte y diga cuándo se actualizó.
  await expect(page.locator('#dashboardMeta')).toContainText('Actualizado');

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

test('dirección · R7: grupos plegables con su resumen, Central por temas y Recursos detrás de Central', async ({ page }) => {
  await login(page);
  await expect(page.locator('#dashboardMeta')).toContainText('Actualizado');
  // Hoy era «un grupo por app, sin plegar ni subtítulos»: ahora cada cabecera pliega, y el orden es el de KPI_SOURCES.
  const labels = await page.locator('.kpigrouphead .sectionlabel').allTextContents();
  expect(labels.slice(0, 2)).toEqual(['Central', 'Recursos']);
  const order = ['Central', 'Recursos', 'Booking', 'Finance', 'Tasks', 'Food'];
  expect(labels.map((l) => order.indexOf(l))).toEqual([...labels.map((l) => order.indexOf(l))].sort((a, b) => a - b));
  const central = page.locator('.kpigroup[data-app="central"]');
  await expect(central.locator('.kpisection')).toHaveText(['Cumplimiento', 'Personas', 'Oficios']);
  // Las 7 de siempre siguen, con su pantalla (ahora por tema, no por clave); con las 12 nuevas, 19, todas con «Objetivo».
  const links = Object.fromEntries(await central.locator('.kpicard').evaluateAll((cs) => cs.map((c) => [c.getAttribute('data-kpi'), c.getAttribute('href')])));
  expect(links).toMatchObject({
    'central.blocking_overdue': '#/cumplimiento', 'central.documents_expired': '#/cumplimiento/documentos', 'central.legal_due_soon': '#/cumplimiento',
    'central.legal_overdue': '#/cumplimiento', 'central.people_active': '#/personas', 'central.people_records_expired': '#/personas',
    'central.risks_high_open': '#/cumplimiento/requisitos', 'central.trades_at_risk': '#/personas/oficios?riesgo',
  });
  await expect(central.locator('.kpicard')).toHaveCount(19);
  await expect(central.locator('.kpitarget')).toHaveCount(19);
  // Recursos: espacios e inventario; el owner ve también el valor del inventario. Sin alertas, la cabecera dice cuántos hay.
  const resources = page.locator('.kpigroup[data-app="resources"]');
  await expect(resources.locator('.kpisection')).toHaveText(['Espacios', 'Inventario']);
  await expect(resources.locator('.kpicard[data-kpi="resources.stock_value"]')).toBeVisible();
  await expect(resources.locator('.kpisummary')).toHaveText('12 indicadores');
  // Un indicador mensual sigue sacando una tarjeta por mes (eso cambia en otra tanda).
  if (labels.includes('Booking')) await expect(page.locator('.kpicard[data-kpi="booking.occupancy_rate"]')).toHaveCount(16);

  // Plegar: un toque; el dispositivo lo recuerda al volver.
  const head = resources.locator('.kpigrouphead');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(resources.locator('.kpigroupbody')).toBeHidden();
  await page.reload();
  await expect(page.locator('.kpigroup[data-app="resources"] .kpigrouphead')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.kpigroup[data-app="resources"] .kpigroupbody')).toBeHidden();
  await page.locator('.kpigroup[data-app="resources"] .kpigrouphead').click();
  await expect(page.locator('.kpigroup[data-app="resources"] .kpicard').first()).toBeVisible();

  // La tarjeta de oficios en riesgo lleva a Oficios.
  await page.locator('.kpicard[data-kpi="central.trades_at_risk"] .kpilabel').click();
  await expect(page.getByRole('heading', { name: 'Oficios' })).toBeVisible();
});
