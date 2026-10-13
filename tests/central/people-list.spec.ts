/**
 * Central · Personas: **caracterización** de la lista, la ficha y el editor tal como son hoy (sección 17 de RECURSOS.md,
 * fase P1). Mientras ninguna persona tenga nivel de casa, la pantalla tiene que seguir así exactamente: filtro «Relación»,
 * línea «Función · Relación», ficha con Relación, Función y Cobertura, y el editor que las guarda. Datos ficticios.
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
const ids = { ana: crypto.randomUUID(), bea: crypto.randomUUID(), ciro: crypto.randomUUID(), dora: crypto.randomUUID(), team: crypto.randomUUID() };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const person = (id: string, name: string, fields: Record<string, unknown>) => ({ op: 'insert', table: 'central.people', id, fields: { display_name: name, availability: 'segun_calendario', ...fields } });
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'people-list-seed', operations: [
    person(ids.ana, 'Ana Ficticia', { relation: 'equipo', base_role: 'cocina', coverage: 'solo_cocina', position: 1 }),
    person(ids.bea, 'Bea Ficticia', { relation: 'voluntario', base_role: 'limpieza', position: 2 }),
    person(ids.ciro, 'Ciro Ficticio', { relation: 'colaborador', base_role: 'otro', active: false, position: 3 }),
    person(ids.dora, 'Dora Ficticia', { relation: 'equipo', base_role: 'direccion_general', position: 4 }),
    { op: 'insert', table: 'central.teams', id: ids.team, fields: { name: 'Cocina' } },
    { op: 'insert', table: 'central.person_teams', id: crypto.randomUUID(), fields: { person_id: ids.ana, team_id: ids.team } },
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

const rowOf = (page: Page, name: string) => page.locator('.personrow', { hasText: name });

test('personas (caracterización) · lista: Relación, Equipo e Inactivas; «Función · Relación» en cada fila', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/personas`);
  // Activas, en su orden; la inactiva no sale.
  await expect(page.locator('.personrow')).toHaveCount(3);
  await expect(rowOf(page, 'Ana Ficticia')).toContainText('Cocina · Equipo');
  await expect(rowOf(page, 'Bea Ficticia')).toContainText('Limpieza · Voluntariado');
  await expect(rowOf(page, 'Dora Ficticia')).toContainText('Dirección general · Equipo');
  await expect(rowOf(page, 'Ana Ficticia')).toContainText('Cocina'); // chip del equipo
  await expect(rowOf(page, 'Ciro Ficticio')).toHaveCount(0);

  // Filtro por relación.
  await expect(page.locator('#peopleRelation option')).toHaveText(['Todas las relaciones', 'Equipo', 'Colaborador', 'Voluntariado', 'Prácticas', 'Otra']);
  await page.locator('#peopleRelation').selectOption('voluntario');
  await expect(page.locator('.personrow')).toHaveCount(1);
  await expect(rowOf(page, 'Bea Ficticia')).toBeVisible();
  await page.locator('#peopleRelation').selectOption('');

  // Filtro por equipo.
  await page.locator('#peopleTeam').selectOption({ label: 'Cocina' });
  await expect(page.locator('.personrow')).toHaveCount(1);
  await expect(rowOf(page, 'Ana Ficticia')).toBeVisible();
  await page.locator('#peopleTeam').selectOption('');

  // Inactivas.
  await page.locator('#peopleInactive').check();
  await expect(page.locator('.personrow')).toHaveCount(4);
  await expect(rowOf(page, 'Ciro Ficticio')).toContainText('Inactiva');
  await expect(rowOf(page, 'Ciro Ficticio')).toContainText('Otra función · Colaborador');

  // Búsqueda.
  await page.locator('#peopleSearch').fill('bea');
  await expect(page.locator('.personrow')).toHaveCount(1);
});

test('personas (caracterización) · ficha y editor: Relación, Función y Cobertura se ven y se guardan', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/personas/${ids.ana}`);
  const basic = page.locator('#blockBasic');
  await expect(basic).toContainText('Relación');
  await expect(basic).toContainText('Equipo');
  await expect(basic).toContainText('Función');
  await expect(basic).toContainText('Cocina');
  await expect(basic).toContainText('Cobertura');
  await expect(basic).toContainText('Solo cocina');

  await page.locator('#editPerson').click();
  await expect(page.locator('#p-relation')).toHaveValue('equipo');
  await expect(page.locator('#p-role')).toHaveValue('cocina');
  await expect(page.locator('#p-coverage')).toHaveValue('solo_cocina');
  await page.locator('#p-relation').selectOption('practicas');
  await page.locator('#p-coverage').selectOption('todo');
  await page.locator('#savePerson').click();
  await expect(page.getByText('Cambios guardados.')).toBeVisible();
  await expect(basic).toContainText('Prácticas');
  await expect.poll(async () => (await api.app.t.db.query<{ r: string; c: string }>(`select relation as r, coverage as c from central.people where id = $1`, [ids.ana])).rows[0])
    .toEqual({ r: 'practicas', c: 'todo' });
});
