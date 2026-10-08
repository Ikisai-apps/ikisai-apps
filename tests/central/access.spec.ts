/**
 * Central · Accesos (V1-a): entrar como owner, ver cuentas, dar acceso, alta con contraseña temporal, desactivar,
 * revocar un agente y ver el registro. Un editor no ve Accesos.
 *
 * Cómo correrlo:   npx playwright test tests/central            (desde la raíz del repo)
 * Compila la app con Vite, la sirve con `vite preview` y reenvía /api a la central-api real sobre PGlite (server.ts).
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

test.beforeAll(async () => {
  // Compilar la app con Vite puede pasar de los 90 s con la máquina cargada (fallo visto con @smoke en paralelo).
  test.setTimeout(180_000);
  api = await startCentralServer();
  // Otra app con un propietario y una clave de agente, para que la tabla tenga algo que mostrar.
  const t = api.app.t;
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'owner'), ('tasks', $2, 'editor')`, [api.app.users.owner, api.app.users.reader]);
  const agent = await t.createUser();
  await t.rpc('core_agent_key_issue', { p_app: 'tasks', p_actor: api.app.users.owner, p_user: agent, p_name: 'Asistente de obra', p_role: 'editor', p_scopes: null, p_digest: 'c'.repeat(64), p_hint: 'cccc', p_expires_at: null });
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

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${baseURL}/`);
  await expect(page.getByRole('heading', { name: 'Ikisai Central' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

test('accesos · el owner administra cuentas, altas, agentes y registro', async ({ page }) => {
  await login(page, 'owner@example.invalid');
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();
  await expect(page.locator('#homeAccounts strong')).toHaveText('3');

  // Cuentas: el lector tiene Central (lector) y Tasks (editor).
  await page.locator('#homeAccounts').click();
  await expect(page.locator('#accountList')).toBeVisible();
  const reader = page.locator('.accountrow', { hasText: 'Reader' });
  await expect(reader).toContainText('Central · Lector');
  await expect(reader).toContainText('Tasks · Editor');

  // Dar acceso de editor a Booking y quitar Tasks.
  await reader.click();
  await page.locator('#role-booking').selectOption('editor');
  await expect(page.getByText('Acceso a Ikisai Booking: Editor.')).toBeVisible();
  await page.locator('#role-tasks').selectOption('');
  await page.getByRole('button', { name: 'Quitar acceso' }).click();
  await expect(page.getByText('Acceso a Ikisai Tasks quitado.')).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(reader).toContainText('Booking · Editor');
  await expect(reader).not.toContainText('Tasks ·');

  // El owner no puede quitarse Central: su selector está desactivado.
  await page.locator('.accountrow', { hasText: '(tú)' }).click();
  await expect(page.locator('#role-central')).toBeDisabled();
  await expect(page.locator('#toggleDisabled')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();

  // Editor de Central con ámbito de datos reservados.
  await page.locator('.accountrow', { hasText: 'Editor' }).first().click();
  await page.locator('#scope-people').check();
  await expect(page.getByText('Ahora ve los datos reservados de personas.')).toBeVisible();
  // Desactivar y reactivar.
  await page.locator('#toggleDisabled').click();
  await page.getByRole('button', { name: 'Desactivar', exact: true }).click();
  await expect(page.getByText('Cuenta desactivada.')).toBeVisible();
  await expect(page.locator('#toggleDisabled')).toHaveText('Reactivar cuenta');
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();

  // Alta con contraseña temporal mostrada una vez.
  await page.locator('#tab-alta').click();
  await page.locator('#inviteEmail').fill('nueva@example.invalid');
  await page.locator('#inviteName').fill('Nueva');
  await page.locator('#invite-tasks').selectOption('editor');
  await page.locator('#inviteSubmit').click();
  await expect(page.getByRole('heading', { name: 'Contraseña temporal' })).toBeVisible();
  await expect(page.locator('textarea.so-value')).not.toHaveValue('');
  // «Hecho» sin copiar pide confirmar que se ha guardado; después vuelve a Cuentas.
  await page.getByRole('button', { name: 'Hecho' }).click();
  await page.getByLabel('La he guardado en un lugar seguro').check();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await expect(page.getByRole('heading', { name: 'Contraseña temporal' })).toHaveCount(0);
  await expect(page.locator('.accountrow', { hasText: 'Nueva' })).toContainText('Tasks · Editor');

  // Agentes: revocar la clave.
  await page.goto(`${baseURL}/#/accesos/agentes`);
  const key = page.locator('.agentrow', { hasText: 'Asistente de obra' });
  await expect(key).toContainText('tasks (Editor)');
  await key.getByRole('button', { name: 'Revocar' }).click();
  await page.getByRole('button', { name: 'Revocar', exact: true }).last().click();
  await expect(page.getByText('Clave revocada.')).toBeVisible();
  await expect(page.locator('#agentList')).toContainText('No hay claves de agentes activas.');

  // Registro: aparecen los cambios hechos, con quién los hizo.
  await page.locator('#tab-registro').click();
  await expect(page.locator('#accessLog')).toContainText('Clave de agente revocada');
  await expect(page.locator('#accessLog')).toContainText('Cuenta desactivada');
  await page.locator('#logApp').selectOption('booking');
  await expect(page.locator('#accessLog')).toContainText('Acceso cambiado · Editor');
  await expect(page.locator('#accessLog')).not.toContainText('Clave de agente revocada');
});

test('accesos · un editor de Central no ve Accesos ni puede abrirlos por la dirección @smoke', async ({ page }) => {
  await api.app.t.db.query(`update core.memberships set scopes = null where app = 'central' and user_id = $1`, [api.app.users.editor]);
  await login(page, 'reader@example.invalid');
  await expect(page.getByRole('heading', { name: 'Hola, Reader' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Accesos' })).toHaveCount(0);
  await page.goto(`${baseURL}/#/accesos`);
  await expect(page.getByRole('heading', { name: 'Hola, Reader' })).toBeVisible();
  await expect(page.locator('#accountList')).toHaveCount(0);
});

// FB_2026_013 (opción A del usuario): la ficha de Personas manda sobre el nombre de la cuenta. Datos ficticios.
test('accesos · la ficha manda: alta desde la ficha, renombrar (también sin red), enlazar cuentas y alinear nombres', async ({ page, context }) => {
  const db = api.app.t.db;
  const profileName = async (userId: string) => (await db.query<{ n: string }>(`select display_name as n from core.profiles where user_id = $1`, [userId])).rows[0]?.n;
  const personId = crypto.randomUUID();
  const created = await api.app.call('/api/v1/commands', { body: { requestId: 'fb013-person', operations: [
    { op: 'insert', table: 'central.people', id: personId, fields: { display_name: 'Marta Ruiz', relation: 'equipo', base_role: 'otro', coverage: 'todo', availability: 'segun_calendario', position: 1 } },
    { op: 'insert', table: 'central.person_private', id: crypto.randomUUID(), fields: { person_id: personId, email: 'marta@example.invalid' } },
  ] } });
  expect(created.status, JSON.stringify(created.data)).toBe(200);
  await login(page, 'owner@example.invalid');
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();

  // 1. Alta desde la ficha: el nombre y el correo salen de ella y la cuenta queda enlazada.
  await page.goto(`${baseURL}/#/accesos/alta`);
  await page.locator('#invitePerson').selectOption({ label: 'Marta Ruiz' });
  await expect(page.locator('#inviteName')).toHaveValue('Marta Ruiz');
  await expect(page.locator('#inviteName')).toHaveAttribute('readonly', '');
  await expect(page.locator('#inviteEmail')).toHaveValue('marta@example.invalid');
  await page.locator('#invite-tasks').selectOption('editor');
  await page.locator('#inviteSubmit').click();
  await expect(page.getByRole('heading', { name: 'Contraseña temporal' })).toBeVisible();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await page.getByLabel('La he guardado en un lugar seguro').check();
  await page.getByRole('button', { name: 'Hecho' }).click();
  const linkedUser = async () => (await db.query<{ u: string | null }>(`select user_id as u from central.people where id = $1`, [personId])).rows[0]?.u ?? null;
  await expect.poll(linkedUser).not.toBeNull();
  const userId = (await linkedUser())!;
  expect(await profileName(userId)).toBe('Marta Ruiz');

  // 2. Renombrar la ficha cambia el nombre de su cuenta.
  await page.goto(`${baseURL}/#/personas/${personId}`);
  await page.locator('#editPerson').click();
  await page.locator('#p-name').fill('Marta Ruiz Gil');
  await page.locator('#savePerson').click();
  await expect(page.getByText('Cambios guardados.')).toBeVisible();
  await expect.poll(() => profileName(userId)).toBe('Marta Ruiz Gil');

  // 3. Sin red: se guarda la ficha, se avisa y la cuenta se cambia al volver la conexión.
  await context.setOffline(true);
  await page.locator('#editPerson').click();
  await page.locator('#p-name').fill('Marta R. Gil');
  await page.locator('#savePerson').click();
  await expect(page.getByText('El nombre de su cuenta se cambiará al volver la conexión.')).toBeVisible();
  expect(await profileName(userId)).toBe('Marta Ruiz Gil');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => profileName(userId), { timeout: 20_000 }).toBe('Marta R. Gil');

  // 4. Cuentas del equipo sin ficha: aviso, «Sin ficha» y «Enlazar con una persona» (aquí, creando su ficha).
  await page.goto(`${baseURL}/#/accesos`);
  await expect(page.locator('#accountIssues')).toContainText('sin ficha');
  const reader = page.locator('.accountrow', { hasText: 'Reader' });
  await expect(reader).toContainText('Sin ficha');
  await reader.click();
  await page.locator('#linkPerson').selectOption('');
  await page.locator('#linkPersonSubmit').click();
  await expect(page.getByText('Ficha creada y enlazada.')).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(reader).not.toContainText('Sin ficha');
  expect((await db.query(`select 1 from central.people where user_id = $1 and display_name = 'Reader' and deleted_at is null`, [api.app.users.reader])).rows.length).toBe(1);

  // 5. Nombre distinto (por ejemplo, de antes de este cambio): «Usar el nombre de la ficha».
  await db.query(`update core.profiles set display_name = 'Lector antiguo' where user_id = $1`, [api.app.users.reader]);
  await page.reload();
  const renamed = page.locator('.accountrow', { hasText: 'Lector antiguo' });
  await expect(renamed).toContainText('Nombre distinto de la ficha');
  await renamed.click();
  await page.locator('#useFichaName').click();
  await expect(page.getByText('La cuenta usa ya el nombre de la ficha.')).toBeVisible();
  expect(await profileName(api.app.users.reader)).toBe('Reader');
});

// Una persona, una ficha, una cuenta (decisión del usuario): el alta con un correo que ya tiene cuenta avisa y deja elegir.
test('accesos · alta con un correo que ya tiene cuenta: enlazar, fusionar fichas u otro correo', async ({ page }) => {
  const db = api.app.t.db;
  const person = (name: string, extra: Record<string, unknown> = {}) => ({ op: 'insert', table: 'central.people', id: crypto.randomUUID(), fields: { display_name: name, relation: 'equipo', position: 2, ...extra } });
  const invite = async (email: string) => (await api.app.call('/api/v1/admin/invite', { body: { email, displayName: email.split('@')[0], memberships: [{ app: 'tasks', role: 'reader' }] } })).data.userId as string;
  // Una cuenta del equipo sin ficha, y otra enlazada a la ficha «Carla Prueba» que tiene una duplicada sin cuenta.
  const lonely = await invite('sinficha@example.invalid');
  const carla = await invite('carla@example.invalid');
  const luis = person('Luis Prueba'); const carlaKeep = person('Carla Prueba', { user_id: carla }); const carlaDup = person('Carla P.'); const mario = person('Mario Prueba');
  const setup = await api.app.call('/api/v1/commands', { body: { requestId: 'existing-setup', operations: [luis, carlaKeep, carlaDup, mario] } });
  expect(setup.status, JSON.stringify(setup.data)).toBe(200);
  const userOf = async (id: string) => (await db.query<{ u: string | null; d: string | null; m: string | null }>(`select user_id as u, deleted_at as d, merged_into as m from central.people where id = $1`, [id])).rows[0]!;

  await login(page, 'owner@example.invalid');
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();
  const startInvite = async (personName: string, email: string) => {
    await page.goto(`${baseURL}/#/accesos/alta`);
    await page.locator('#invitePerson').selectOption({ label: personName });
    await page.locator('#inviteEmail').fill(email);
    await page.locator('#invite-booking').selectOption('reader');
    await page.locator('#inviteSubmit').click();
    await expect(page.locator('#existingAccount')).toBeVisible();
  };

  // 1. Cuenta sin ficha → enlazar esta ficha (y se suman los accesos).
  await startInvite('Luis Prueba', 'sinficha@example.invalid');
  await expect(page.locator('#existingAccount')).toContainText('Este correo ya tiene cuenta');
  await expect(page.locator('#existingAccount')).toContainText('sin ficha');
  await expect(page.locator('#existingMerge')).toHaveCount(0);
  await page.locator('#existingLink').click();
  await expect(page.getByText('Esa cuenta ya existía: se le han añadido los accesos.')).toBeVisible();
  await expect.poll(async () => (await userOf(luis.id)).u).toBe(lonely);
  expect((await db.query(`select 1 from core.memberships where user_id = $1 and app = 'booking'`, [lonely])).rows.length).toBe(1);

  // 2. Cuenta enlazada a otra ficha → fusionar las dos fichas: queda la de la cuenta.
  await startInvite('Carla P.', 'carla@example.invalid');
  await expect(page.locator('#existingAccount')).toContainText('enlazada a la ficha «Carla Prueba»');
  await page.locator('#existingMerge').click();
  await expect(page.getByText('Fichas fusionadas: queda «Carla Prueba».')).toBeVisible();
  await expect.poll(async () => (await userOf(carlaDup.id)).d).not.toBeNull();
  expect((await userOf(carlaDup.id)).m).toBe(carlaKeep.id);
  expect((await userOf(carlaKeep.id)).u).toBe(carla);
  expect((await db.query(`select 1 from core.memberships where user_id = $1 and app = 'booking'`, [carla])).rows.length).toBe(1);

  // 3. Es otra persona → usar otro correo: no se da de alta ni se enlaza nada.
  await startInvite('Mario Prueba', 'carla@example.invalid');
  await page.locator('#existingOther').click();
  await expect(page.locator('#existingAccount')).toHaveCount(0);
  await expect(page.locator('.formerror')).toContainText('Escribe el correo de esta persona.');
  await expect(page.locator('#inviteEmail')).toBeFocused();
  expect((await userOf(mario.id)).u).toBeNull();
  // Nunca dos fichas con la misma cuenta.
  expect((await db.query(`select user_id from central.people where deleted_at is null and user_id is not null group by user_id having count(*) > 1`)).rows.length).toBe(0);
});
