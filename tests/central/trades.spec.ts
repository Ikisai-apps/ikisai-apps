/**
 * Central · fase P1: oficios en árbol y capacidades con la estrella de nivel del kit. Crear el árbol, añadir capacidades
 * en la ficha, cambiar el nivel pulsando la estrella, filtrar Personas por un oficio con lo que cuelga de él, ver las chips y
 * «Quién sabe hacerlo» en cada oficio. Datos ficticios.
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

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;
const ids = { ana: crypto.randomUUID(), bea: crypto.randomUUID() };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'trades-seed', operations: [
    { op: 'insert', table: 'central.people', id: ids.ana, fields: { display_name: 'Ana Ficticia', relation: 'equipo', base_role: 'mantenimiento_logistica', house_level: 'staff', position: 1 } },
    { op: 'insert', table: 'central.people', id: ids.bea, fields: { display_name: 'Bea Ficticia', relation: 'equipo', base_role: 'limpieza', house_level: 'staff', position: 2 } },
  ] } });
  if (seeded.status !== 200) throw new Error(JSON.stringify(seeded.data));
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp();
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
const level = async (person: string) => (await api.app.t.db.query<{ l: number }>(`select level as l from central.person_trades where person_id = $1 and deleted_at is null`, [person])).rows[0]?.l;

async function newTrade(page: Page, name: string, parent?: string): Promise<void> {
  if (parent) {
    await page.locator('.traderow', { hasText: parent }).first().click();
    await page.locator('#addSubtrade').click();
  } else await page.locator('#newTrade').click();
  await page.locator('#tr-name').fill(name);
  await page.locator('#saveTrade').click();
  await expect(page.locator('.traderow', { hasText: name })).toBeVisible();
}

test('oficios · árbol, capacidades con estrella, filtro con descendientes, chips y «Quién sabe hacerlo»', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/personas`);
  await page.locator('#manageTrades').click();
  await expect(page.getByText('Todavía no hay oficios')).toBeVisible();
  await newTrade(page, 'Fontanería');
  await newTrade(page, 'ACS', 'Fontanería');
  await newTrade(page, 'Electricidad');

  // Ficha de Ana: añadir «Fontanería › ACS» y subirle el nivel a experto con la estrella.
  await page.goto(`${baseURL}/#/personas/${ids.ana}`);
  await expect(page.locator('#blockTrades')).toContainText('Sin oficios.');
  await page.locator('#addTrade').click();
  await page.locator('#pt-trade').selectOption({ label: '· ACS' });
  await page.locator('.sheet .level-star').click(); // Sabe → Experto
  await page.locator('#pt-note').fill('Calentadores');
  await page.locator('#savePersonTrade').click();
  await expect(page.locator('#personTrades')).toContainText('Fontanería › ACS');
  await expect(page.locator('#personTrades')).toContainText('Experto');
  await expect.poll(() => level(ids.ana)).toBe(2);
  // Pulsar la estrella de la fila cambia el nivel (vuelve a «Aprende»).
  await page.locator('#personTrades .level-star').first().click();
  await expect.poll(() => level(ids.ana)).toBe(0);

  // Bea sabe electricidad (nivel por defecto: «Sabe»).
  await page.goto(`${baseURL}/#/personas/${ids.bea}`);
  await page.locator('#addTrade').click();
  await page.locator('#pt-trade').selectOption({ label: 'Electricidad' });
  await page.locator('#savePersonTrade').click();
  await expect(page.locator('#personTrades')).toContainText('Sabe');

  // Personas: filtrar por «Fontanería» incluye a quien sabe «ACS»; chips del oficio en la fila.
  await page.goto(`${baseURL}/#/personas`);
  await expect(page.locator('.personrow', { hasText: 'Ana Ficticia' })).toContainText('ACS');
  await page.locator('#peopleTrade').selectOption({ label: 'Fontanería' });
  await expect(page.locator('.personrow')).toHaveCount(1);
  await expect(page.locator('.personrow', { hasText: 'Ana Ficticia' })).toBeVisible();
  await page.locator('#peopleTrade').selectOption('');
  await expect(page.locator('.personrow')).toHaveCount(2);

  // Oficios: «Quién sabe hacerlo» con su nivel; archivar saca el oficio de la lista.
  await page.goto(`${baseURL}/#/personas/oficios`);
  await page.locator('.traderow', { hasText: 'ACS' }).click();
  await expect(page.locator('#tradePeople')).toContainText('Ana Ficticia');
  await expect(page.locator('#tradePeople')).toContainText('Aprende');
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await page.locator('.traderow', { hasText: 'Electricidad' }).click();
  await page.locator('#archiveTrade').click();
  await expect(page.getByText('Oficio archivado.')).toBeVisible();
  await expect(page.locator('.traderow', { hasText: 'Electricidad' })).toHaveCount(0);
  await page.locator('#tradesArchived').check();
  await expect(page.locator('.traderow', { hasText: 'Electricidad' })).toContainText('Archivado');
});
