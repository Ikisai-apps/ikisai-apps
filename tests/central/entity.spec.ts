/**
 * Central · Entidad: el owner rellena razón social, NIF/CIF, domicilio y logotipo; un NIF/CIF erróneo se rechaza sin red
 * de por medio; un lector la ve sin poder editar. Contra la central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');
// PNG de 1 × 1 px: el logotipo de prueba (los datos reales no van en el repositorio).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  // Compilar la app con Vite puede pasar de los 90 s con la máquina cargada (fallo visto con @smoke en paralelo).
  test.setTimeout(180_000);
  api = await startCentralServer();
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

async function login(page: Page, email: string, name: string): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${name}` })).toBeVisible();
}

test('entidad · el owner rellena los datos y el logotipo; el lector los ve sin editar @smoke', async ({ page, browser }) => {
  await login(page, 'owner@example.invalid', 'Owner');
  await page.locator('#homeEntity').click();
  await expect(page.getByText('Todavía no hay datos de la entidad')).toBeVisible();
  await page.locator('#editEntity').click();

  await page.locator('#en-legal').fill('Entidad de Prueba S.L.');
  await page.locator('#en-tax').fill('b-12345675');
  await page.locator('#en-address').fill('Calle Falsa 1');
  await page.locator('#en-postal').fill('28000');
  await page.locator('#en-city').fill('Madrid');
  await page.locator('#en-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('.logopreview img')).toBeVisible();
  await page.locator('#saveEntity').click();
  await expect(page.locator('.formerror')).toContainText('control del CIF');
  // Un dato erróneo no deja el logotipo encolado.
  await expect(page.getByText(/pendiente/)).toHaveCount(0);

  await page.locator('#en-tax').fill('B12345674');
  await page.locator('#saveEntity').click();
  await expect(page.getByText('Datos de la entidad guardados.')).toBeVisible();
  await expect(page.locator('#entityView')).toContainText('Entidad de Prueba S.L.');
  await expect(page.locator('#entityView')).toContainText('B12345674');
  await expect(page.locator('#entityView')).toContainText('Calle Falsa 1, 28000 Madrid');

  // El logotipo llega al servidor como archivo verificado de Central y la proyección lo publica.
  await expect.poll(async () => (await api.app.t.db.query(`select logo_mime from central.common_entity_projection`)).rows[0]).toEqual({ logo_mime: 'image/png' });
  await expect(page.locator('#entityView img.entitylogo')).toHaveCount(1);

  // Otra persona, en su propio navegador: lectora de Central.
  const other = await browser.newContext();
  const readerPage = await other.newPage();
  await login(readerPage, 'reader@example.invalid', 'Reader');
  await readerPage.locator('#homeEntity').click();
  await expect(readerPage.locator('#entityView')).toContainText('Entidad de Prueba S.L.');
  await expect(readerPage.locator('#editEntity')).toHaveCount(0);
  await other.close();
});
