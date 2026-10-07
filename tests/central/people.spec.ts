/**
 * Central · Personas (V1-b): alta, datos reservados, documentación con archivo y caducidad, «Dar cuenta», lo que ve un
 * lector, edición sin red y papelera. Contra la central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
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

const synced = (page: Page) => expect(page.getByText(/pendiente/i)).toHaveCount(0);

test('personas · ficha, datos reservados, documentación, cuenta, lector, sin red y papelera', async ({ page, browser, context }) => {
  await login(page, 'owner@example.invalid', 'Owner');
  await page.getByRole('link', { name: 'Personas', exact: true }).click();
  await expect(page.getByText('Todavía no hay personas')).toBeVisible();

  // Alta: lleva a la ficha.
  await page.locator('#newPerson').click();
  await page.locator('#p-name').fill('Marga');
  await page.locator('#p-role').selectOption('cocina');
  await page.locator('#savePerson').click();
  await expect(page.getByRole('heading', { name: 'Marga' })).toBeVisible();
  await expect(page.locator('#blockBasic')).toContainText('Cocina');

  // Datos reservados.
  await page.locator('#editPrivate').click();
  await page.locator('#pp-phone').fill('600 000 000');
  await page.locator('#pp-email').fill('marga@example.invalid');
  await page.locator('#pp-engagement').selectOption('autonomo');
  await page.locator('#savePrivate').click();
  await expect(page.locator('#blockPrivate')).toContainText('600 000 000');
  await expect(page.locator('#blockPrivate')).toContainText('Autónomo');

  // Formación con PDF y caducidad en 10 días.
  await page.locator('#newRecord').click();
  await page.locator('#r-kind').selectOption('formacion');
  await page.locator('#r-type').selectOption('manipulador_alimentos');
  await page.locator('#r-status').selectOption('ok');
  await page.locator('#r-expires').fill(inDays(10));
  await page.locator('#r-file').setInputFiles({ name: 'carne.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 carné de prueba') });
  await expect(page.locator('#r-file-state')).toContainText('carne.pdf');
  await page.locator('#saveRecord').click();
  const record = page.locator('.recordrow', { hasText: 'Manipulador de alimentos' });
  await expect(record).toContainText('Caduca pronto');
  await synced(page);
  await expect.poll(async () => (await api.app.t.db.query(`select file_id is not null as ok from central.person_records`)).rows[0]).toEqual({ ok: true });
  await expect(record.getByRole('button', { name: 'Archivo' })).toBeVisible();

  // Dar cuenta: el correo sale del contacto reservado.
  await page.locator('#giveAccount').click();
  await expect(page.locator('#ga-email')).toHaveValue('marga@example.invalid');
  await page.locator('#ga-tasks').selectOption('editor');
  await page.locator('#giveSubmit').click();
  await expect(page.getByRole('heading', { name: 'Contraseña temporal' })).toBeVisible();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await page.getByLabel('La he guardado en un lugar seguro').check();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await expect(page.locator('#blockAccount')).toContainText('Tasks · Editor');
  await expect.poll(async () => (await api.app.t.db.query(`select user_id is not null as ok from central.people`)).rows[0]).toEqual({ ok: true });

  // Inicio avisa de la caducidad.
  await page.getByRole('link', { name: 'Inicio', exact: true }).click();
  await expect(page.locator('#homeDocs')).toContainText('Marga');

  // Un lector ve el directorio, no los datos reservados ni la documentación.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader@example.invalid', 'Reader');
  await reader.getByRole('link', { name: 'Personas', exact: true }).click();
  await reader.locator('.personrow', { hasText: 'Marga' }).click();
  await expect(reader.locator('#blockBasic')).toContainText('Cocina');
  await expect(reader.locator('#personView')).not.toContainText('600 000 000');
  await expect(reader.locator('#blockRecords')).toHaveCount(0);
  await expect(reader.locator('#editPerson')).toHaveCount(0);
  await expect(reader.locator('#homeDocs')).toHaveCount(0);
  await other.close();

  // Sin red: editar la ficha queda pendiente y se envía al volver la conexión.
  await page.getByRole('link', { name: 'Personas', exact: true }).click();
  await page.locator('.personrow', { hasText: 'Marga' }).click();
  await context.setOffline(true);
  await page.locator('#editPerson').click();
  await page.locator('#p-notes').fill('Solo fines de semana');
  await page.locator('#savePerson').click();
  await expect(page.locator('#blockBasic')).toContainText('Solo fines de semana');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await api.app.t.db.query(`select availability_notes from central.people`)).rows[0], { timeout: 20_000 })
    .toEqual({ availability_notes: 'Solo fines de semana' });

  // Papelera: la persona y lo suyo, en un solo lote; restaurar lo devuelve todo.
  await page.locator('#deletePerson').click();
  await page.getByRole('button', { name: 'Enviar a papelera' }).last().click();
  await expect(page.getByRole('heading', { name: 'Personas' })).toBeVisible();
  await expect(page.locator('#peopleTrash')).toBeVisible();
  await page.locator('#peopleTrash summary').click();
  await page.locator('#peopleTrash').getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.locator('.personrow', { hasText: 'Marga' })).toBeVisible();
  await expect.poll(async () => (await api.app.t.db.query(`select count(*)::int as n from central.person_records where deleted_at is null`)).rows[0]).toEqual({ n: 1 });
});
