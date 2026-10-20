/**
 * Central · menú lateral común (MUELA-013, kit 0.47), búsqueda de la cabecera y pantalla Revisión (MUELA-027 y 069; migración
 * 1512): secciones por rol («Cuentas y accesos» arriba solo para quien administra), «Cerrar sesión» también en el móvil,
 * recientes, Ctrl K con lo vigente primero, e «Importar pantallas» (upsert por app y nombre) solo para el owner. Contra la
 * central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildCentralApp } from './e2e-build.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';
import { heightOf, openMenu } from './ui-helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');
const madrid = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;
const requirementId = crypto.randomUUID();

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const res = await api.app.call('/api/v1/commands', { body: { requestId: 'seed-menu', operations: [
    { op: 'insert', table: 'central.requirements', id: requirementId, fields: { name: 'Seguro del edificio', requirement_type: 'seguro', expires_on: madrid(-1) } },
    { op: 'insert', table: 'central.requirements', id: crypto.randomUUID(), fields: { name: 'Seguro antiguo', requirement_type: 'seguro', expires_on: madrid(30), status: 'cerrado' } },
  ] } });
  expect(res.status).toBe(200);
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp();
  server = await preview({ configFile, logLevel: 'silent', preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } } });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

async function login(page: Page, who: 'owner' | 'reader'): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(`${who}@example.invalid`);
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Hola,/ })).toBeVisible();
}

test('menú · secciones por rol, recientes, «Cerrar sesión» en el móvil y búsqueda con lo vigente primero', async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'owner');
  // Abrir una ficha la apunta en «Recientes».
  await page.goto(`${baseURL}/#/cumplimiento/${requirementId}`);
  await expect(page.getByRole('heading', { name: 'Seguro del edificio' })).toBeAttached();
  // «‹ Volver» con objetivo de 46 px (MUELA-086).
  expect(await heightOf(page.locator('.backlink'))).toBeGreaterThanOrEqual(46);
  let drawer = await openMenu(page);
  await expect(drawer.locator('.appmenu-recientes')).toContainText('Seguro del edificio');
  const tiles = drawer.locator('.appmenu-tile');
  await expect(tiles.first()).toContainText('Cuentas y accesos');
  // Con sus recuentos (MUELA-085 y 086): las cuentas de personas y las claves en uso.
  await expect(tiles.first()).toContainText(/\d+ cuentas?/);
  await tiles.first().click();
  await expect(drawer.locator('.appmenu-panel a', { hasText: 'Agentes' })).toContainText(/\d+ claves? en uso|1 clave en uso/);
  await tiles.first().click();
  await expect(drawer.locator('.appmenu-tile', { hasText: 'Obligaciones' })).toContainText('1 vencida');
  // Un azulejo despliega sus filas debajo; la de un tipo abre Obligaciones con ese tipo puesto.
  await drawer.locator('.appmenu-tile', { hasText: 'Obligaciones' }).click();
  await drawer.locator('.appmenu-panel a', { hasText: 'Seguro' }).click();
  await expect(page).toHaveURL(/#\/cumplimiento\/requisitos\?tipo=seguro$/);
  await expect(page.locator('#typeChips [data-type="seguro"]')).toHaveAttribute('aria-pressed', 'true');
  drawer = await openMenu(page);
  await expect(drawer.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Ctrl K: al escribir, las obligaciones con lo vigente antes que lo cerrado (K1, keepOrder).
  await page.keyboard.press('Control+k');
  await page.keyboard.type('seguro');
  const items = page.locator('.palette-item');
  await expect(items.first()).toContainText('Seguro del edificio');
  await expect(page.locator('.palette-list')).toContainText('Seguro antiguo');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/cumplimiento/${requirementId}$`));

  // Quien solo lee no ve «Cuentas y accesos».
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const reader = await other.newPage();
  await login(reader, 'reader');
  const readerDrawer = await openMenu(reader);
  await expect(readerDrawer.locator('.appmenu-tile', { hasText: 'Cuentas y accesos' })).toHaveCount(0);
  await expect(readerDrawer.locator('.appmenu-tile', { hasText: 'Revisión' })).toHaveCount(1);
  await other.close();
});

test('revisión · importar pantallas (upsert por app y nombre), tablero, lo que te toca y lector sin acciones', async ({ page, browser }) => {
  await login(page, 'owner');
  await page.goto(`${baseURL}/#/revision`);
  await expect(page.getByText('Todavía no hay pantallas')).toBeVisible();
  await page.locator('#importScreens').click();
  await page.locator('#rs-json').fill(JSON.stringify([
    { app: 'central', name: 'Inicio', step: 'alt', route: '#/' },
    { app: 'central', name: 'Cumplimiento', step: 'hecha', route: '#/cumplimiento', feedback_prefix: 'central.cumplimiento' },
    { app: 'booking', name: 'Reservas', step: 'cons' },
  ]));
  await expect(page.locator('#rs-preview')).toContainText('3 pantallas nuevas');
  await page.locator('#importScreensRun').click();
  await expect(page.getByText(/Pantallas importadas: 3 nuevas/)).toBeVisible();
  await expect(page.locator('#main')).toContainText('1 de 3 pantallas pasadas a Sevilla');
  await expect(page.locator('.queue-card')).toContainText('Prototipo por valorar');
  await expect(page.locator('.queue-card')).toContainText('Inicio');

  // Volver a importar: lo que ya existe se actualiza (por app y nombre, sin distinguir mayúsculas) y nada se borra.
  await page.locator('#importScreens').click();
  await page.locator('#rs-json').fill(JSON.stringify({ screens: [{ app: 'central', name: 'inicio', step: 'demo' }, { app: 'booking', name: 'Reservas', step: 'cons' }] }));
  await expect(page.locator('#rs-preview')).toContainText('1 actualizada · 1 sin cambios');
  await page.locator('#importScreensRun').click();
  await expect.poll(async () => (await api.app.t.db.query<{ n: number; step: string }>(
    `select count(*)::int as n, max(step) filter (where name = 'Inicio') as step from central.review_screens where deleted_at is null`)).rows[0]).toEqual({ n: 3, step: 'demo' });

  // Tablero: los diez pasos con su cifra; filtrar por app.
  await page.locator('#reviewBoard .filterchip', { hasText: 'Booking' }).click();
  await expect(page.locator('#reviewBoard .ctl-rv-list li.row')).toHaveCount(1);
  await expect(page.locator('#reviewBoard .ctl-rv-list')).toContainText('Reservas');

  // Quien solo lee ve el avance, sin importar, crear ni «te toca».
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader');
  await reader.goto(`${baseURL}/#/revision`);
  await expect(reader.locator('#main')).toContainText('1 de 3 pantallas pasadas a Sevilla');
  await expect(reader.locator('#importScreens')).toHaveCount(0);
  await expect(reader.locator('#newScreen')).toHaveCount(0);
  await expect(reader.locator('.queue-card')).toHaveCount(0);
  await expect(reader.locator('.chip', { hasText: /^Te toca$/ })).toHaveCount(0);
  await reader.locator('#reviewBoard li.row', { hasText: 'Reservas' }).click();
  await expect(reader.locator('#rs-name')).toBeDisabled();
  await expect(reader.locator('#saveScreen')).toBeHidden();
  await other.close();
});

test('revisión · quien no administra comprueba sus arreglos; sin red, los botones dicen por qué', async ({ browser }) => {
  const context = await browser.newContext();
  const reader = await context.newPage();
  // Sus reportes (`mine=true`), uno arreglado por comprobar; el núcleo le deja comprobarlo (`canVerify`).
  const report = { id: crypto.randomUUID(), code: 'FB_2026_901', originApp: 'central', message: 'El botón de Entidad no respondía', display: 'pending_verify',
    reviewStatus: 'approved', canVerify: true, node: { id: 'central.entidad', path: ['Entidad'] }, routeRaw: '#/entidad', createdAt: new Date().toISOString() };
  const verified: string[] = [];
  await reader.route(/\/api\/v1\/feedback\?.*mine=true/, (route) => route.fulfill({ json: { items: [report] } }));
  await reader.route(/\/api\/v1\/feedback\/[0-9a-f-]{36}\/verify$/, (route) => { verified.push(route.request().url()); return route.fulfill({ json: { report: { ...report, display: 'verified' } } }); });
  await login(reader, 'reader');
  await reader.goto(`${baseURL}/#/revision`);
  const card = reader.locator('.queue-card');
  await expect(card).toContainText('Arreglo por comprobar');
  await expect(card).toContainText('El botón de Entidad no respondía');
  await expect(card.getByRole('button', { name: 'Funciona y siguiente' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Sigue fallando…' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Aprobar y siguiente' })).toHaveCount(0);

  // Sin red: aria-disabled con el motivo escrito (bindOnline), no apagado sin decir nada.
  await context.setOffline(true);
  const main = card.getByRole('button', { name: 'Funciona y siguiente' });
  await expect(main).toHaveAttribute('aria-disabled', 'true');
  await expect(reader.locator('.ctl-rv-why .offline-why')).toBeVisible();
  await expect(reader.locator('.ctl-rv-why')).toContainText('necesita conexión');
  await main.click({ force: true });
  expect(verified).toHaveLength(0);
  await context.setOffline(false);
  await reader.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(main).not.toHaveAttribute('aria-disabled', 'true');
  await main.click();
  await expect(reader.getByText('Verificado.')).toBeVisible();
  expect(verified).toHaveLength(1);
  await expect(reader.locator('.queue-done')).toContainText('Nada te espera');
  await context.close();
});
