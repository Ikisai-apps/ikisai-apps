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
  // Sin red, el panel dice de cuándo son sus indicadores, sin rojo (el «Sin conexión» lo dice el menú, MUELA-013).
  await expect(page.locator('#dashboardMeta')).toContainText('Indicadores del');
  await expect(page.locator('#dashboardMeta')).not.toContainText('Sin conexión');
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
  // Regla de ceros (Bloque 2): lo que está a cero sin objetivo (o en objetivo) se pliega, y la cabecera lo cuenta.
  const stock = resources.locator('.kpicard[data-kpi="resources.stock_value"]');
  if (await stock.locator('.kpivalue').textContent().then((t) => /^0/.test(t ?? ''))) {
    await expect(stock).toBeHidden();
    await expect(resources.locator('.kpizerocount')).toContainText('a cero');
    await resources.locator('.kpizeros').click();
  }
  await expect(stock).toBeVisible();
  await expect(resources.locator('.kpisummary')).toHaveText('12 indicadores');
  // Series: antes, una tarjeta por mes (16 de ocupación); ahora una, con el mes en curso y «Ver 16 meses».
  if (labels.includes('Booking')) {
    const occupancy = page.locator('.kpicard[data-kpi="booking.occupancy_rate"]');
    await expect(occupancy).toHaveCount(1);
    await expect(occupancy).toContainText(new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(new Date()));
    await occupancy.locator('.kpiseries').click();
    await expect(page.locator('.kpiseriesrow')).toHaveCount(16);
    await expect(page.locator('.kpiseriesrow.current')).toHaveCount(1);
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(page.locator('.kpiseriesrow')).toHaveCount(0);
  }

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
  await expect(page.locator('.kpigroup[data-app="resources"] .kpigroupbody')).toBeVisible();

  // La tarjeta de oficios en riesgo lleva a Oficios (si está a cero, primero «Ver k a cero»).
  const risk = page.locator('.kpicard[data-kpi="central.trades_at_risk"]');
  if (await risk.isHidden()) await page.locator('.kpigroup[data-app="central"] .kpizeros').click();
  await risk.locator('.kpilabel').click();
  await expect(page.getByRole('heading', { name: 'Oficios' })).toBeVisible();
});

test('dirección · un cero en atención no se pliega; chips «N críticos» filtran; «Ajustar objetivos» abre cada objetivo', async ({ page }) => {
  // Personas con documentación caducada (a cero en esta base): con objetivo «más es mejor» y atención por debajo de 1, el
  // cero está en atención y se ve siempre (§2 del Bloque 2).
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'zero-target', operations: [
    { op: 'insert', table: 'central.kpi_targets', id: crypto.randomUUID(), fields: { kpi: 'central.people_active', target: 5, warn_at: 1, direction: 'up' } },
  ] } });
  expect(seeded.status).toBe(200);
  await login(page);
  const active = page.locator('.kpicard[data-kpi="central.people_active"]');
  await expect(active).toContainText('Atención');
  await expect(active).toBeVisible();
  // Chip «N en atención»: solo quedan los que están en atención.
  await page.locator('#kpiChips [data-state="atencion"]').click();
  await expect(active).toBeVisible();
  await expect(page.locator('.kpicard.state-ok:not([hidden])')).toHaveCount(0);
  await page.locator('#kpiChips [data-state="atencion"]').click();
  // Y entra en la cola de Inicio como aviso, con «Abrir» su app.
  await expect(page.locator('#homeDocs')).toContainText('Personas activas');
  // «Ajustar objetivos»: la lista entera; cada uno abre su objetivo. El de la tarjeta sigue.
  await page.locator('#adjustTargets').click();
  await page.locator('#targetsList li[data-kpi="central.people_active"]').getByRole('button', { name: /Objetivo/ }).click();
  await expect(page.locator('#k-target')).toHaveValue('5');
  await page.keyboard.press('Escape');
  await expect(active.locator('.kpitarget')).toBeVisible();
});

test('dirección · series: si otro mes está en atención, la tarjeta lo dice; la hoja da el estado de cada mes', async ({ page }) => {
  // Gasto del mes de Finance (13 meses, a 0 en esta base): con «menos es mejor» y atención por encima de -1, todos en atención.
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'series-target', operations: [
    { op: 'insert', table: 'central.kpi_targets', id: crypto.randomUUID(), fields: { kpi: 'invoices.expenses_month', warn_at: -1, direction: 'down' } },
  ] } });
  expect(seeded.status).toBe(200);
  await login(page);
  const expenses = page.locator('.kpicard[data-kpi="invoices.expenses_month"]');
  test.skip(!(await expenses.count()), 'Finance no publica en esta base');
  await expect(expenses).toHaveCount(1);
  await expect(expenses).toContainText('Atención');
  // «Meses pasados» y «Previsión» por separado (Bloque 2, 076): aquí, los doce meses de antes.
  await expect(expenses.locator('.kpiothers')).toHaveText('Meses pasados: 12 en atención');
  await expenses.locator('.kpiseries').click();
  await expect(page.locator('.kpiseriesrow')).toHaveCount(13);
  await expect(page.locator('.kpiseriesrow .kpistate.warn')).toHaveCount(13);
});
