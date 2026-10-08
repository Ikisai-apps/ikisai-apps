/**
 * Ikisai Tasks · reportes del usuario del 8-10-2026 (QA): FB_2026_015 (responsables de una regla desde el equipo),
 * FB_2026_018 (ordenar las áreas en «Áreas de trabajo»), FB_2026_019 («General» con icono) y FB_2026_020 (sin los
 * iconos de áreas y vistas en la cabecera: están en el menú lateral).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const areasSheet: any, routeSheet: any, state: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let owner: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  context = await browser.newContext({ viewport: { width: 484, height: 686 } });
  owner = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('FB_2026_019 y 020: cabecera sin los iconos de áreas y vistas; «General» con icono de todas las áreas', async () => {
  await expect(owner.locator('#shellTop [data-areas-tool]')).toHaveCount(0);
  await expect(owner.locator('#shellTop #savedViews')).toHaveCount(0);
  const general = owner.locator('#shellTop [data-general-area]');
  await expect(general).toHaveAttribute('aria-label', 'General: todas las áreas');
  await expect(general.locator('svg')).toHaveCount(1);
  await owner.screenshot({ path: '../coordinacion/tasks/cabecera-qa-movil.png', clip: { x: 0, y: 0, width: 484, height: 220 } }).catch(() => {});
  expect((await general.textContent())?.trim()).toBe('');
  await general.click();
  await expect.poll(() => owner.evaluate(() => state.taskScope)).toBe('all');
  // Siguen en el menú lateral, en Trabajo.
  await owner.locator('#moreBtn').click();
  await expect(owner.locator('[data-action="areas"]')).toBeVisible();
  await expect(owner.locator('[data-action="views"]')).toBeVisible();
  await owner.evaluate(() => (window as any).closeNavigation());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('FB_2026_018: ordenar las áreas desde «Áreas de trabajo», y el orden queda en la cabecera y en el servidor', async () => {
  await owner.evaluate(() => areasSheet());
  const names = async () => owner.locator('#shellTop [data-tab]').allTextContents();
  const before = await names();
  expect(before.length).toBeGreaterThan(1);
  await expect(owner.locator('[data-area-move$="|-1"]').first()).toBeDisabled();
  await owner.locator('[data-area-move$="|1"]').first().click();
  await expect.poll(names).toEqual([before[1], before[0], ...before.slice(2)]);
  await settled(owner);
  const live = (await server.rows('tasks.tabs')).filter((t) => !t.deleted_at).sort((a, b) => a.position - b.position);
  expect(live[0].name).toBe(before[1]!.replace(/\d+$/, '').trim());
  await expect(owner.locator('#sheet')).toContainText('Áreas de trabajo');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('FB_2026_015: el responsable de una regla se elige entre las personas del equipo; si no tiene etiqueta, se crea', async () => {
  await owner.evaluate(() => routeSheet('core.user_task'));
  const select = owner.locator('#destOwner');
  await expect(select.locator('optgroup[label="Equipo"] option')).toContainText(['Editor', 'Owner']);
  const editorValue = await select.locator('optgroup[label="Equipo"] option', { hasText: 'Editor' }).getAttribute('value');
  await select.selectOption(editorValue!);
  const tabId = await owner.locator('#destTab').inputValue();
  await owner.locator('#routeSave').click();
  await settled(owner);
  const route = (await server.rows('tasks.request_routes')).find((r) => r.kind === 'core.user_task' && !r.deleted_at);
  expect(route.owner_label_id).toBeTruthy();
  const label = (await server.rows('tasks.labels')).find((l) => l.id === route.owner_label_id);
  expect([label.name, label.tab_id]).toEqual(['Editor', tabId]);
  // La segunda vez ya la encuentra por su nombre: no se crea otra.
  await owner.evaluate(() => routeSheet('core.user_task'));
  await expect(owner.locator('#destOwner')).toHaveValue(route.owner_label_id);
  expect((await server.rows('tasks.labels')).filter((l) => l.tab_id === tabId && l.name === 'Editor' && !l.deleted_at)).toHaveLength(1);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('reglas genéricas acotadas (8-10-2026): las casillas de tarea y los campos de Tasks conservan su estilo; el kit no los hereda', async () => {
  await owner.evaluate(() => (window as any).closeSheet?.());
  await owner.evaluate((id) => { state.taskScope = 'area'; state.activeTab = id; (window as any).navigateView('projects'); }, ID.ikisai);
  await owner.locator('[data-open-project]').first().click().catch(async () => owner.locator('.project').first().click());
  const check = owner.locator('.task .check').first();
  await expect(check).toBeVisible();
  const box = await check.boundingBox();
  expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([38, 44]);
  await owner.screenshot({ path: '../coordinacion/tasks/proyecto-casillas-movil.png' }).catch(() => {});
  // Un campo de una hoja de Tasks sigue con su altura; una casilla y un campo dentro de la capa del kit, no.
  await owner.evaluate(() => (window as any).newAreaSheet());
  expect(await owner.locator('#sheet .field label').first().evaluate((n) => getComputedStyle(n).textTransform)).toBe('uppercase');
  const kit = await owner.evaluate(() => {
    const layer = (window as any).sheetKitLayer(), host = document.createElement('div');
    host.innerHTML = '<label class="check">Me bloquea</label><div class="field"><label id="kitProbe">Nota</label><input></div>';
    layer.appendChild(host);
    const out = { check: getComputedStyle(host.querySelector('.check')!).width, label: getComputedStyle(host.querySelector('#kitProbe')!).textTransform };
    host.remove(); return out;
  });
  expect(kit.check).not.toBe('38px');
  expect(kit.label).not.toBe('uppercase');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('FB_2026_015 (2): con central.people_options, el equipo suma a las personas sin cuenta y no duplica a quien tiene cuenta y ficha', async () => {
  // La lectura es de Central (la publica Central); aquí se simula con su forma acordada.
  const ownerId = (await server.app.t.db.query<{ user_id: string }>(`select m.user_id from core.memberships m join core.profiles p on p.user_id = m.user_id where m.app = 'tasks' and p.display_name = 'Owner'`)).rows[0]!.user_id;
  await owner.route('**/read/central.people_options', (route) => route.fulfill({ json: { rows: [
    { person_id: 'p-1', name: 'Marta Jardín', user_id: null, active: true },
    { person_id: 'p-2', name: 'Olga Propietaria', user_id: ownerId, active: true },
    { person_id: 'p-3', name: 'Baja Antigua', user_id: null, active: false },
  ] } }));
  await owner.evaluate(() => { (window as any).eval('teamAsked=false;centralPeople=null'); });
  await owner.evaluate(() => routeSheet('central.compliance_due'));
  const team = owner.locator('#destOwner optgroup[label="Equipo"] option');
  await expect(team).toHaveText(['Editor', 'Marta Jardín', 'Olga Propietaria', 'Reader']);
  await owner.locator('#destOwner').selectOption({ label: 'Marta Jardín' });
  const tabId = await owner.locator('#destTab').inputValue();
  await owner.locator('#routeSave').click();
  await settled(owner);
  const route = (await server.rows('tasks.request_routes')).find((r) => r.kind === 'central.compliance_due' && !r.deleted_at);
  const label = (await server.rows('tasks.labels')).find((l) => l.id === route.owner_label_id);
  expect([label.name, label.tab_id]).toEqual(['Marta Jardín', tabId]);
  await owner.unroute('**/read/central.people_options');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
