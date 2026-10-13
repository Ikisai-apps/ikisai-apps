/**
 * Central · O4, caracterización (PR 0): Personas, la ficha y Accesos de un outsider tal como están tras P1, antes de
 * «Convertir en outsider». Debe seguir en verde después de O4, salvo lo marcado «hoy» (los accesos que dará el nivel y el
 * selector de rol, que enseñará «Outsider» fijo). Datos ficticios.
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
let beaUser: string;
const ids = { ana: crypto.randomUUID(), bea: crypto.randomUUID(), ciro: crypto.randomUUID(), eva: crypto.randomUUID(), fon: crypto.randomUUID() };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const person = (id: string, name: string, fields: Record<string, unknown>) => ({ op: 'insert', table: 'central.people', id, fields: { display_name: name, availability: 'segun_calendario', ...fields } });
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'outsider-seed', operations: [
    person(ids.ana, 'Ana Ficticia', { relation: 'equipo', base_role: 'cocina', house_level: 'staff', position: 1 }),
    person(ids.bea, 'Bea Ficticia', { relation: 'colaborador', base_role: 'mantenimiento_logistica', house_level: 'outsider', position: 2 }),
    person(ids.ciro, 'Ciro Ficticio', { relation: 'colaborador', base_role: 'otro', house_level: 'outsider', active: false, position: 3 }),
    person(ids.eva, 'Eva Ficticia', { relation: 'otro', base_role: 'otro', position: 4 }),
    { op: 'insert', table: 'central.trades', id: ids.fon, fields: { name: 'Fontanería' } },
    { op: 'insert', table: 'central.person_trades', id: crypto.randomUUID(), fields: { person_id: ids.bea, trade_id: ids.fon, level: 1 } },
  ] } });
  if (seeded.status !== 200) throw new Error(JSON.stringify(seeded.data));
  const invited = await api.app.call('/api/v1/admin/invite', { body: { email: 'bea-outsider@example.invalid', displayName: 'Bea Ficticia', memberships: [{ app: 'tasks', role: 'reader' }] } });
  if (invited.status !== 200) throw new Error(JSON.stringify(invited.data));
  beaUser = invited.data.userId as string;
  const rev = Number((await api.app.t.db.query<{ r: number }>(`select revision as r from central.people where id = $1`, [ids.bea])).rows[0]!.r);
  const linked = await api.app.call('/api/v1/commands', { body: { requestId: 'outsider-link', operations: [
    { op: 'update', table: 'central.people', id: ids.bea, expectedRevision: rev, fields: { user_id: beaUser } }] } });
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
const rowOf = (page: Page, name: string) => page.locator('.personrow', { hasText: name });
const memberships = async () => (await api.app.t.db.query<{ app: string; role: string }>(`select app, role from core.memberships where user_id = $1 order by app`, [beaUser])).rows.map((m) => `${m.app}:${m.role}`);

test('outsider (caracterización) · lista con el filtro Outsider, ficha con su cuenta, Accesos y desenlazar', async ({ page }) => {
  await login(page);
  const before = await memberships();
  expect(before).toContain('tasks:reader');

  // Lista: el filtro «Outsider» deja solo a los outsiders; los inactivos, con «Mostrar inactivas».
  await page.goto(`${baseURL}/#/personas`);
  await page.locator('#peopleLevel').selectOption('outsider');
  await expect(page.locator('.personrow')).toHaveCount(1);
  await expect(rowOf(page, 'Bea Ficticia')).toContainText('Mantenimiento y logística · Outsider');
  await expect(rowOf(page, 'Bea Ficticia')).toContainText('Fontanería');
  await page.locator('#peopleInactive').check();
  await expect(page.locator('.personrow')).toHaveCount(2);
  await expect(rowOf(page, 'Ciro Ficticio')).toContainText('Inactiva');
  await expect(rowOf(page, 'Ana Ficticia')).toHaveCount(0);
  // Hoy, el botón flotante es «Nueva persona» con cualquier filtro.
  await expect(page.locator('#newPerson')).toContainText('Nueva persona');

  // Ficha: la cabecera dice el nivel; el bloque Cuenta enseña los accesos dados a mano.
  await rowOf(page, 'Bea Ficticia').click();
  await expect(page.locator('.pagehead p').first()).toContainText('Outsider');
  await expect(page.locator('#blockBasic')).toContainText('Outsider');
  const account = page.locator('#blockAccount');
  await expect(account).toContainText('bea-outsider@example.invalid');
  await expect(account).toContainText('Tasks · Lector'); // hoy: el nivel no da nada (con O4, «Tasks · Outsider»)
  await expect(page.locator('a', { hasText: 'Cambiar accesos en Accesos' })).toHaveAttribute('href', '#/accesos');

  // Accesos › Cuentas: sus chips y el selector de rol de hoy (sin «Outsider»).
  await page.goto(`${baseURL}/#/accesos`);
  const accountRow = page.locator('.accountrow', { hasText: 'Bea Ficticia' });
  await expect(accountRow).toContainText('Tasks · Lector');
  await accountRow.click();
  await expect(page.locator('#role-tasks')).toHaveValue('reader');
  await expect(page.locator('#role-tasks option')).toHaveText(['Sin acceso', 'Lector', 'Editor', 'Propietario']);
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();

  // Desenlazar: la ficha se queda sin cuenta y la cuenta conserva sus accesos.
  await page.goto(`${baseURL}/#/personas/${ids.bea}`);
  await page.locator('#unlinkAccount').click();
  await page.getByRole('button', { name: 'Desenlazar', exact: true }).last().click();
  await expect(page.getByText('Cuenta desenlazada.')).toBeVisible();
  await expect(page.locator('#blockAccount')).toContainText('Sin cuenta: no entra en ninguna app.');
  await expect.poll(async () => (await api.app.t.db.query<{ u: string | null }>(`select user_id as u from central.people where id = $1`, [ids.bea])).rows[0]?.u).toBeNull();
  expect(await memberships()).toEqual(before);
  // Hoy, la fila no avisa de que un outsider no tiene cuenta.
  await page.goto(`${baseURL}/#/personas`);
  await page.locator('#peopleLevel').selectOption('outsider');
  await expect(rowOf(page, 'Bea Ficticia')).not.toContainText('Sin cuenta');
});
