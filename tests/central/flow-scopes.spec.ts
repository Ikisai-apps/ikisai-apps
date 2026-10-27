/**
 * Central · ámbitos de Flow en la ficha y en el alta (encargo de VG del 27-10, vía Core): a qué proyectos de Flow entra una
 * persona (`core.memberships.scopes.projects`, Flow 0902), con la lista de proyectos de `flow.projects_projection` (Flow 0906).
 * Datos ficticios.
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
let daniUser: string;
const ids = { dani: crypto.randomUUID(), boda: crypto.randomUUID() };
const BARRA = '0f10a000-0000-4000-8000-000000000001'; // proyecto sembrado por Flow (0900)

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const db = api.app.t.db;
  // La lectura la publica Flow (0906); si esta rama aún no la tiene, la misma vista para la prueba.
  await db.query(`do $$ begin
    if to_regclass('flow.projects_projection') is null then
      execute 'create view flow.projects_projection as select id, name, status, starts_on, ends_on, test_mode, booking_event_id from flow.projects where deleted_at is null';
      perform core.allow_read('central', 'flow.projects_projection', 'view', '{owner}');
    end if;
  end $$`);
  await db.query(`insert into flow.projects (id, name, starts_on, ends_on) values ($1, 'Boda de noviembre', '2026-11-20', '2026-11-21')`, [ids.boda]);
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'flow-scopes-seed', operations: [
    { op: 'insert', table: 'central.people', id: ids.dani, fields: { display_name: 'Dani Ficticio', relation: 'equipo', base_role: 'cocina', house_level: 'staff', availability: 'segun_calendario' } },
  ] } });
  if (seeded.status !== 200) throw new Error(JSON.stringify(seeded.data));
  const invited = await api.app.call('/api/v1/admin/invite', { body: { email: 'dani-flow@example.invalid', displayName: 'Dani Ficticio', memberships: [] } });
  if (invited.status !== 200) throw new Error(JSON.stringify(invited.data));
  daniUser = invited.data.userId as string;
  const rev = Number((await db.query<{ r: number }>(`select revision as r from central.people where id = $1`, [ids.dani])).rows[0]!.r);
  const linked = await api.app.call('/api/v1/commands', { body: { requestId: 'flow-scopes-link', operations: [
    { op: 'update', table: 'central.people', id: ids.dani, expectedRevision: rev, fields: { user_id: daniUser } }] } });
  if (linked.status !== 200) throw new Error(JSON.stringify(linked.data));
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
const barraName = async () => (await api.app.t.db.query<{ n: string }>(`select name as n from flow.projects where id = $1`, [BARRA])).rows[0]!.n;
const flowScopes = async (user: string) => (await api.app.t.db.query<{ role: string; scopes: any }>(`select role, scopes from core.memberships where user_id = $1 and app = 'flow'`, [user])).rows[0] ?? null;

test('ficha · proyectos de Flow: sin ninguno no ve nada; se eligen en una hoja y «Deshacer» devuelve los de antes', async ({ page }) => {
  // Staff entra en Flow como editor por su nivel (0095), sin proyectos.
  expect(await flowScopes(daniUser)).toMatchObject({ role: 'editor' });
  await login(page);
  await page.goto(`${baseURL}/#/personas/${ids.dani}`);
  const block = page.locator('#blockFlow');
  await expect(block).toContainText('En Flow es editor.');
  await expect(block.locator('#flowScope')).toContainText('No ve ningún proyecto de Flow');
  await block.locator('#editFlowProjects').click();
  const sheet = page.getByRole('dialog', { name: 'Proyectos de Flow' });
  await expect(sheet.locator('label.check')).toHaveCount(2);
  await expect(sheet).toContainText(await barraName());
  await sheet.getByRole('checkbox', { name: /Boda de noviembre/ }).check();
  await sheet.getByRole('button', { name: 'Guardar' }).click();
  await expect.poll(async () => (await flowScopes(daniUser))?.scopes).toEqual({ projects: [ids.boda] });
  await expect(block.locator(`#flowScope [data-project="${ids.boda}"]`)).toHaveText('Boda de noviembre');
  expect((await flowScopes(daniUser))?.role).toBe('editor');
  await page.locator('.ikisai-toast').getByRole('button', { name: 'Deshacer' }).click();
  await expect.poll(async () => (await flowScopes(daniUser))?.scopes ?? null).toBeNull();
  await expect(block.locator('#flowScope')).toContainText('No ve ningún proyecto de Flow');
});

test('alta · Flow + proyecto en un paso: marcar el proyecto le da Flow · Editor y va en el mismo envío', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/accesos/alta`);
  await page.locator('#invitePeople .ctl-face[data-person=""]').click();
  await page.locator('#inviteName').fill('Lola Ficticia');
  await page.locator('#inviteEmail').fill('lola-flow@example.invalid');
  const barra = await barraName();
  await page.locator('#inviteFlowProjects').getByRole('checkbox', { name: barra }).check();
  await expect(page.locator('#invite-flow [data-role="editor"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#inviteSummary')).toContainText(`Flow · Editor (${barra})`);
  await page.locator('#inviteSubmit').click();
  await expect(page.getByRole('dialog')).toContainText('lola-flow@example.invalid');
  // La ficha nueva queda enlazada con su cuenta (staff, el nivel por defecto): Flow conserva el proyecto.
  await expect.poll(async () => (await api.app.t.db.query<{ u: string | null }>(`select user_id as u from central.people where display_name = 'Lola Ficticia' and deleted_at is null`)).rows[0]?.u ?? null).not.toBeNull();
  const lola = (await api.app.t.db.query<{ u: string }>(`select user_id as u from central.people where display_name = 'Lola Ficticia' and deleted_at is null`)).rows[0]!.u;
  await expect.poll(async () => await flowScopes(lola)).toEqual({ role: 'editor', scopes: { projects: [BARRA] } });
});
