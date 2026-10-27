/**
 * Central · fase P1: nivel de casa. Vista previa editable para dirección, aplicar, la pantalla nueva (Nivel de casa y Área
 * principal; Relación y Cobertura dejan de verse pero se conservan), el directorio solo con nivel, el Alta con nivel y la
 * marcha atrás (vaciar los niveles vuelve a la pantalla de antes). Datos ficticios.
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
const ids = { ana: crypto.randomUUID(), bea: crypto.randomUUID(), ciro: crypto.randomUUID(), dora: crypto.randomUUID(), eva: crypto.randomUUID() };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const person = (id: string, name: string, fields: Record<string, unknown>) => ({ op: 'insert', table: 'central.people', id, fields: { display_name: name, ...fields } });
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'levels-seed', operations: [
    person(ids.ana, 'Ana Ficticia', { relation: 'equipo', base_role: 'cocina', coverage: 'solo_cocina', position: 1 }),
    person(ids.bea, 'Bea Ficticia', { relation: 'voluntario', base_role: 'limpieza', position: 2 }),
    person(ids.ciro, 'Ciro Ficticio', { relation: 'colaborador', base_role: 'otro', active: false, position: 3 }),
    person(ids.dora, 'Dora Ficticia', { relation: 'equipo', base_role: 'direccion_general', position: 4 }),
    person(ids.eva, 'Eva Ficticia', { relation: 'otro', base_role: 'otro', position: 5 }),
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
const dbRow = async (id: string) => (await api.app.t.db.query<{ l: string | null; r: string; c: string }>(`select house_level as l, relation as r, coverage as c from central.people where id = $1`, [id])).rows[0]!;

test('nivel de casa · vista previa, aplicar, pantalla nueva, Alta con nivel y marcha atrás', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/personas`);

  // Antes de aplicar: la pantalla de siempre (la relación, en «Filtros») y el aviso para dirección.
  await page.locator('#peopleFiltersToggle').click(); // «Filtros» (Bloque 2): relación, oficio, equipo e inactivas
  await expect(page.locator('#peopleRelation')).toBeVisible();
  await expect(page.locator('#peopleLevels')).toBeHidden();
  await expect(page.locator('#levelsNote')).toContainText('5 personas no lo tienen');

  // Vista previa: propuesta por función y relación, editable.
  await page.locator('#reviewLevels').click();
  await expect(page.locator(`#lv-${ids.ana}`)).toHaveValue('staff');
  await expect(page.locator(`#lv-${ids.bea}`)).toHaveValue('outsider');
  await expect(page.locator(`#lv-${ids.ciro}`)).toHaveValue('outsider');
  await expect(page.locator(`#lv-${ids.dora}`)).toHaveValue('direccion');
  await expect(page.locator(`#lv-${ids.eva}`)).toHaveValue('');
  await page.locator(`#lv-${ids.bea}`).selectOption('staff'); // el usuario corrige una
  await page.locator('#applyLevels').click();
  await expect(page.getByText('Nivel de casa aplicado.')).toBeVisible();
  await expect.poll(async () => (await dbRow(ids.bea)).l).toBe('staff');
  expect(await dbRow(ids.ana)).toEqual({ l: 'staff', r: 'equipo', c: 'solo_cocina' }); // relación y cobertura se conservan
  expect((await dbRow(ids.eva)).l).toBeNull();

  // Después: filtro de nivel en el mismo sitio, «Área · Nivel», y el directorio solo con nivel.
  await expect(page.locator('#levelsNote')).toHaveCount(0);
  await expect(page.locator('#peopleRelation')).toBeHidden();
  await expect(page.locator('#peopleLevels')).toBeVisible();
  await expect(rowOf(page, 'Ana Ficticia')).toContainText('Cocina · Staff');
  await expect(rowOf(page, 'Dora Ficticia')).toContainText('Dirección general · Dirección');
  await expect(rowOf(page, 'Eva Ficticia')).toHaveCount(0);
  await page.locator('#peopleLevels [data-level="sin_nivel"]').click();
  await expect(page.locator('.personrow')).toHaveCount(1);
  await expect(rowOf(page, 'Eva Ficticia')).toBeVisible();
  await page.locator('#peopleLevels [data-level="staff"]').click();
  await expect(page.locator('.personrow')).toHaveCount(2);

  // Ficha: Nivel de casa y Área principal; Relación y Cobertura ya no se ven.
  await page.goto(`${baseURL}/#/personas/${ids.ana}`);
  const basic = page.locator('#blockBasic');
  await expect(basic).toContainText('Nivel de casa');
  await expect(basic).toContainText('Staff');
  await expect(basic).toContainText('Área principal');
  await expect(basic).not.toContainText('Relación');
  await expect(basic).not.toContainText('Cobertura');

  // Editor: el nivel en el sitio de la relación; sin las funciones de dirección (salvo la que ya tenga la ficha).
  await page.locator('#editPerson').click();
  await expect(page.locator('#p-relation')).toHaveCount(0);
  await expect(page.locator('#p-coverage')).toHaveCount(0);
  await expect(page.locator('#p-level')).toHaveValue('staff');
  await expect(page.locator('#p-role option[value="direccion_general"]')).toHaveCount(0);
  await page.locator('#p-level').selectOption('outsider');
  await page.locator('#savePerson').click();
  await expect(page.getByText('Cambios guardados.')).toBeVisible();
  await expect.poll(async () => dbRow(ids.ana)).toEqual({ l: 'outsider', r: 'colaborador', c: 'solo_cocina' });
  await page.goto(`${baseURL}/#/personas/${ids.dora}`);
  await page.locator('#editPerson').click();
  await expect(page.locator('#p-role')).toHaveValue('direccion_general'); // se enseña igual, sin romper
  await page.keyboard.press('Escape');

  // Alta con «Persona nueva»: elige el nivel (por defecto, Staff).
  await page.goto(`${baseURL}/#/accesos/alta`);
  await page.locator('#invitePeople .ctl-face[data-person=""]').click();
  await expect(page.locator('#inviteLevel')).toHaveValue('staff');
  await page.locator('#inviteName').fill('Nueva Ficticia');
  await page.locator('#inviteEmail').fill('nueva-nivel@example.invalid');
  await page.locator('#invite-tasks button[data-role="reader"]').click();
  await page.locator('#inviteSubmit').click();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await page.getByLabel('La he guardado en un lugar seguro').check();
  await page.getByRole('button', { name: 'Hecho' }).click();
  await expect.poll(async () => (await api.app.t.db.query<{ l: string; r: string }>(`select house_level as l, relation as r from central.people where display_name = 'Nueva Ficticia' and deleted_at is null`)).rows[0])
    .toEqual({ l: 'staff', r: 'equipo' });

  // Marcha atrás: sin niveles, vuelve la pantalla de antes con sus datos.
  const withLevel = (await api.app.t.db.query<{ id: string; revision: number }>(`select id, revision from central.people where house_level is not null and deleted_at is null`)).rows;
  const back = await api.app.call('/api/v1/commands', { body: { requestId: 'levels-back', operations: withLevel.map((r) => ({ op: 'update', table: 'central.people', id: r.id, expectedRevision: Number(r.revision), fields: { house_level: null } })) } });
  expect(back.status, JSON.stringify(back.data)).toBe(200);
  await page.goto(`${baseURL}/#/personas`);
  await page.reload();
  await expect(rowOf(page, 'Bea Ficticia')).toContainText('Limpieza · Voluntariado');
  await page.locator('#peopleFiltersToggle').click(); // «Filtros» (Bloque 2): relación, oficio, equipo e inactivas
  await expect(page.locator('#peopleRelation')).toBeVisible();
  await expect(page.locator('#peopleLevels')).toBeHidden();
});

test('nivel de casa · «Dar cuenta» en persona desde el móvil: solo el correo, la contraseña una vez y los accesos por nivel', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const id = crypto.randomUUID();
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'give-in-person', operations: [
    { op: 'insert', table: 'central.people', id, fields: { display_name: 'Tati Ficticia', relation: 'equipo', house_level: 'staff' } },
  ] } });
  expect(seeded.status, JSON.stringify(seeded.data)).toBe(200);
  await login(page);
  await page.goto(`${baseURL}/#/personas/${id}`);
  // Paso 1: «Dar cuenta» y el correo, escrito delante de la persona. Sus accesos los da el nivel.
  await page.locator('#giveAccount').click();
  await expect(page.locator('#giveByLevel')).toContainText('Staff');
  await expect(page.locator('#giveByLevel')).toContainText('Tasks');
  await page.locator('#ga-email').fill('tati.ficticia@example.invalid');
  await page.locator('#giveSubmit').click();
  // Paso 2: la contraseña temporal, visible una sola vez.
  const secret = page.locator('[data-feedback-id="central.accesos.contrasena.valor"]');
  await expect(secret).toBeVisible();
  expect((await secret.inputValue()).length).toBeGreaterThan(7);
  await page.locator('[data-feedback-id="central.accesos.contrasena.hecho"]').click();
  await page.locator('.so-confirm input').check();
  await page.locator('[data-feedback-id="central.accesos.contrasena.hecho"]').click();
  await expect(secret).toHaveCount(0);
  // La cuenta queda enlazada a la ficha y el nivel le da sus accesos (staff: editor de Tasks).
  const user = async () => (await api.app.t.db.query<{ u: string | null }>(`select user_id as u from central.people where id = $1`, [id])).rows[0]!.u;
  await expect.poll(user).not.toBeNull();
  await expect.poll(async () => (await api.app.t.db.query<{ r: string }>(`select role as r from core.memberships where user_id = $1 and app = 'tasks'`, [await user()])).rows[0]?.r ?? null).toBe('editor');
  await page.close();
});
