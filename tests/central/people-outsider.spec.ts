/**
 * Central · fase O4: «Convertir en outsider» (tabla «hoy / después» aprobada el 13-10-2026). Empezó como caracterización
 * (PR 0, #489); lo que sigue igual se comprueba igual (filtro, fila, ficha, desenlazar) y lo marcado «hoy» pasa a lo nuevo:
 * los accesos que da el nivel, el selector fijo en Accesos, el aviso «Sin cuenta», «Nuevo outsider», convertir y quitar.
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
let beaUser: string;
const ids = { ana: crypto.randomUUID(), bea: crypto.randomUUID(), ciro: crypto.randomUUID(), eva: crypto.randomUUID(), gil: crypto.randomUUID(), fon: crypto.randomUUID() };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const person = (id: string, name: string, fields: Record<string, unknown>) => ({ op: 'insert', table: 'central.people', id, fields: { display_name: name, availability: 'segun_calendario', ...fields } });
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'outsider-seed', operations: [
    person(ids.ana, 'Ana Ficticia', { relation: 'equipo', base_role: 'cocina', house_level: 'staff', position: 1 }),
    person(ids.bea, 'Bea Ficticia', { relation: 'colaborador', base_role: 'mantenimiento_logistica', house_level: 'outsider', position: 2 }),
    person(ids.ciro, 'Ciro Ficticio', { relation: 'colaborador', base_role: 'otro', house_level: 'outsider', active: false, position: 3 }),
    person(ids.eva, 'Eva Ficticia', { relation: 'otro', base_role: 'otro', position: 4 }),
    person(ids.gil, 'Gil Ficticio', { relation: 'otro', base_role: 'otro', position: 5 }),
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
const memberships = async (user: string) => (await api.app.t.db.query<{ app: string; role: string }>(`select app, role from core.memberships where user_id = $1 and app in ('booking', 'guests', 'tasks') order by app`, [user])).rows.map((m) => `${m.app}:${m.role}`);
const personRow = async (id: string) => (await api.app.t.db.query<{ l: string | null; u: string | null; r: string }>(`select house_level as l, user_id as u, relation as r from central.people where id = $1`, [id])).rows[0]!;

test('outsider · lista con sus accesos, ficha y Accesos con lo que da el nivel, quitar y volver a convertir, desenlazar', async ({ page }) => {
  await login(page);
  expect(await memberships(beaUser)).toEqual(['guests:editor', 'tasks:outsider']); // el nivel ya le dio lo suyo

  // Lista: el filtro «Outsider» deja solo a los outsiders, con dónde entran o el aviso de que sin cuenta no entran.
  await page.goto(`${baseURL}/#/personas`);
  await page.locator('#peopleLevel').selectOption('outsider');
  await expect(page.locator('.personrow')).toHaveCount(1);
  const bea = rowOf(page, 'Bea Ficticia');
  await expect(bea).toContainText('Mantenimiento y logística · Outsider');
  await expect(bea).toContainText('Fontanería');
  await expect(bea).toContainText('Tasks · Outsider');
  await expect(bea).toContainText('Guests · Editor');
  await page.locator('#peopleInactive').check();
  await expect(page.locator('.personrow')).toHaveCount(2);
  await expect(rowOf(page, 'Ciro Ficticio')).toContainText('Inactiva');
  await expect(rowOf(page, 'Ciro Ficticio')).toContainText('Sin cuenta: no entra en ninguna app');
  await expect(rowOf(page, 'Ana Ficticia')).toHaveCount(0);
  // Con el filtro puesto, el botón flotante crea un outsider (la ficha nace con el nivel y dice qué da).
  await expect(page.locator('#newPerson')).toContainText('Nuevo outsider');
  await page.locator('#newPerson').click();
  await expect(page.locator('#p-level')).toHaveValue('outsider');
  await expect(page.locator('#p-level-hint')).toContainText('Como outsider entrará en Guests');
  await page.keyboard.press('Escape');
  await page.locator('#peopleLevel').selectOption('');
  await expect(page.locator('#newPerson')).toContainText('Nueva persona');

  // Ficha: la cabecera dice el nivel; el bloque Cuenta marca lo que da el nivel y lo que tenía antes.
  await page.goto(`${baseURL}/#/personas/${ids.bea}`);
  await expect(page.locator('.pagehead p').first()).toContainText('Outsider');
  const account = page.locator('#blockAccount');
  await expect(account).toContainText('bea-outsider@example.invalid');
  await expect(account.locator('[data-derived]', { hasText: 'Tasks · Outsider' })).toContainText('por nivel de casa');
  await expect(page.locator('#derivedNote')).toContainText('Antes tenía Tasks · Lector');
  await expect(page.locator('a', { hasText: 'Cambiar accesos en Accesos' })).toHaveAttribute('href', '#/accesos');
  await expect(page.locator('#convertOutsider')).toHaveCount(0);

  // Accesos › Cuentas: lo que da el nivel sale marcado y fijo; «Outsider» no se ofrece a mano en ninguna app.
  await page.goto(`${baseURL}/#/accesos`);
  const accountRow = page.locator('.accountrow', { hasText: 'Bea Ficticia' });
  await expect(accountRow.locator('[data-derived]', { hasText: 'Tasks · Outsider' })).toContainText('por nivel de casa');
  await accountRow.click();
  await expect(page.locator('#role-tasks')).toHaveValue('outsider');
  await expect(page.locator('#role-tasks')).toBeDisabled();
  await expect(page.locator('[data-derived="tasks"]')).toContainText('cámbialo en Personas');
  await expect(page.locator('#role-booking option')).toHaveText(['Sin acceso', 'Lector', 'Editor', 'Propietario']);
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();

  // Quitar de outsider: se pregunta a qué nivel pasa («Sin nivel» por defecto) y vuelve lo de antes.
  await page.goto(`${baseURL}/#/personas/${ids.bea}`);
  await page.locator('#removeOutsider').click();
  await expect(page.locator('#ro-level')).toHaveValue('');
  await expect(page.locator('#removeOutsiderSheet')).toContainText('se conservan');
  await page.locator('#removeOutsiderSubmit').click();
  await expect(page.getByText('Ya no es outsider.')).toBeVisible();
  await expect.poll(() => memberships(beaUser)).toEqual(['tasks:reader']);
  expect(await personRow(ids.bea)).toMatchObject({ l: null, r: 'otro' });

  // Convertir en outsider (con cuenta): un toque más «Convertir».
  await page.locator('#convertOutsider').click();
  await expect(page.locator('#convertSheet')).toContainText('No entra en Booking, Food ni Central');
  await page.locator('#convertSubmit').click();
  await expect(page.getByText('Ahora es outsider: entra en Guests y Tasks.')).toBeVisible();
  await expect.poll(() => memberships(beaUser)).toEqual(['guests:editor', 'tasks:outsider']);
  expect(await personRow(ids.bea)).toMatchObject({ l: 'outsider', r: 'colaborador' });

  // Desenlazar: la ficha se queda sin cuenta y la cuenta vuelve a lo que tenía antes del nivel.
  await page.locator('#unlinkAccount').click();
  await page.getByRole('button', { name: 'Desenlazar', exact: true }).last().click();
  await expect(page.getByText('Cuenta desenlazada.')).toBeVisible();
  await expect(page.locator('#blockAccount')).toContainText('Sin cuenta: no entra en ninguna app.');
  await expect.poll(() => memberships(beaUser)).toEqual(['tasks:reader']);
});

test('outsider · convertir sin cuenta y convertir dándole cuenta en el mismo paso', async ({ page }) => {
  await login(page);
  // Sin cuenta: se permite, con el aviso.
  await page.goto(`${baseURL}/#/personas/${ids.eva}`);
  await page.locator('#convertOutsider').click();
  await expect(page.locator('#convertSheet')).toContainText('No tiene cuenta');
  await page.locator('#convertNoAccount').click();
  await expect(page.getByText('Ahora es outsider. Sin cuenta no entra en ninguna app.')).toBeVisible();
  await expect.poll(async () => (await personRow(ids.eva)).l).toBe('outsider');
  await expect(page.locator('#removeOutsider')).toBeVisible();

  // Con cuenta nueva: correo y, como hoy, otros accesos opcionales; los de outsider llegan solos al enlazarla.
  await page.goto(`${baseURL}/#/personas/${ids.gil}`);
  await page.locator('#convertOutsider').click();
  await expect(page.locator('#co-tasks')).toHaveCount(0); // Tasks y Guests los da el nivel
  await page.locator('#co-email').fill('gil-outsider@example.invalid');
  await page.locator('#co-booking').selectOption('reader');
  await page.locator('#convertSubmit').click();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await page.getByLabel('La he guardado en un lugar seguro').check();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await expect.poll(async () => (await personRow(ids.gil)).l).toBe('outsider');
  const gil = (await personRow(ids.gil)).u!;
  expect(gil).toBeTruthy();
  await expect.poll(() => memberships(gil)).toEqual(['booking:reader', 'guests:editor', 'tasks:outsider']);
});
