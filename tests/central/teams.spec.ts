/**
 * Central · Equipos: semilla sugerida, una persona en dos equipos (chips en la ficha y en la lista), filtro por equipo,
 * papelera de la persona con sus equipos y lo que ve un lector. Contra la central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
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

test('equipos · semilla, persona en dos equipos, filtro, papelera y lector', async ({ page, browser }) => {
  await login(page, 'owner@example.invalid', 'Owner');
  await page.getByRole('link', { name: 'Personas', exact: true }).click();
  await page.locator('#manageTeams').click();
  await page.locator('#seedTeams').click();
  await expect(page.getByText('Equipos creados.')).toBeVisible();
  await expect(page.locator('#teamList .teamchip')).toHaveText(['Cocina', 'Mantenimiento', 'Limpieza', 'Dirección', 'Administración', 'Recepción']);

  // Persona nueva en Cocina y Recepción.
  await page.locator('.backlink').click();
  await page.locator('#newPerson').click();
  await page.locator('#p-name').fill('Marga');
  await page.locator('#savePerson').click();
  await expect(page.getByRole('heading', { name: 'Marga' })).toBeVisible();
  await page.locator('#editTeams').click();
  await page.locator('#teamChoices label', { hasText: 'Cocina' }).locator('input').check();
  await page.locator('#teamChoices label', { hasText: 'Recepción' }).locator('input').check();
  await page.locator('#saveTeams').click();
  await expect(page.locator('#personTeams .teamchip')).toHaveText(['Cocina', 'Recepción']);

  // Lista: chips y filtro por equipo.
  await page.locator('.backlink').click();
  await expect(page.locator('.personrow', { hasText: 'Marga' })).toContainText('Recepción');
  await page.locator('#peopleTeam').selectOption({ label: 'Limpieza' });
  await expect(page.getByText('Ninguna persona coincide')).toBeVisible();
  await page.locator('#peopleTeam').selectOption({ label: 'Cocina' });
  await expect(page.locator('.personrow', { hasText: 'Marga' })).toBeVisible();

  // Un lector ve los equipos y no puede cambiarlos.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader@example.invalid', 'Reader');
  await reader.getByRole('link', { name: 'Personas', exact: true }).click();
  await reader.locator('.personrow', { hasText: 'Marga' }).click();
  await expect(reader.locator('#personTeams')).toContainText('Cocina');
  await expect(reader.locator('#editTeams')).toHaveCount(0);
  await reader.goto(`${baseURL}/#/personas/equipos`);
  await expect(reader.locator('#teamList')).toContainText('Cocina');
  await expect(reader.locator('#newTeam')).toHaveCount(0);
  await other.close();

  // Papelera de la persona: se lleva sus equipos en el mismo lote; restaurar los devuelve.
  await page.locator('#peopleTeam').selectOption('');
  await page.locator('.personrow', { hasText: 'Marga' }).click();
  await page.locator('#deletePerson').click();
  await page.getByRole('button', { name: 'Enviar a papelera' }).last().click();
  await expect(page.getByRole('heading', { name: 'Personas' })).toBeVisible();
  await page.locator('#peopleTrash summary').click();
  await page.locator('#peopleTrash').getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.locator('.personrow', { hasText: 'Marga' })).toContainText('Cocina');
  await expect.poll(async () => (await api.app.t.db.query(`select count(*)::int as n from central.person_teams where deleted_at is null`)).rows[0]).toEqual({ n: 2 });
});
