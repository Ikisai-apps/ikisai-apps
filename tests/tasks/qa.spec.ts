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

test('FB_2026_018: filas compactas en «Áreas de trabajo»; se ordenan con el asa (teclado y arrastre) y el orden queda en la cabecera y en el servidor', async () => {
  await owner.evaluate(() => areasSheet());
  const names = async () => (await owner.locator('#shellTop [data-tab]').allTextContents()).map((n) => n.replace(/\d+$/, '').trim());
  const rows = () => owner.locator('#sheet .area-row');
  const before = await names();
  expect(before.length).toBeGreaterThan(2);
  // Cada fila: asa, color, nombre con sus proyectos debajo y editar a la derecha; sin los botones ↑ y ↓.
  const first = rows().first();
  await expect(first.locator('[data-area-drag]')).toBeVisible();
  await expect(first.locator('.areadot')).toBeVisible();
  await expect(first.locator('.area-open')).toContainText(/\d+ proyectos?/);
  await expect(first.locator('[data-edit-area]')).toBeVisible();
  await expect(owner.locator('#sheet [data-area-move]')).toHaveCount(0);
  const box = (sel: string) => first.locator(sel).boundingBox();
  expect((await box('[data-area-drag]'))!.x).toBeLessThan((await box('.area-open'))!.x);
  expect((await box('[data-edit-area]'))!.x).toBeGreaterThan((await box('.area-open'))!.x);

  // Con el teclado: flecha abajo en el asa de la primera la baja una posición, y el foco sigue en su asa.
  const firstId = await first.getAttribute('data-area-row');
  await first.locator('[data-area-drag]').focus();
  await owner.keyboard.press('ArrowDown');
  await expect.poll(names).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(owner.locator(`[data-area-drag="${firstId}"]`)).toBeFocused();

  // Arrastrando (ratón o dedo): la última a la primera posición.
  const order = await names();
  const lastHandle = rows().last().locator('[data-area-drag]');
  const from = (await lastHandle.boundingBox())!, to = (await rows().first().boundingBox())!;
  await owner.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await owner.mouse.down();
  await owner.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 8 });
  await owner.mouse.up();
  await expect.poll(names).toEqual([order[order.length - 1], ...order.slice(0, -1)]);
  await settled(owner);
  const live = (await server.rows('tasks.tabs')).filter((t) => !t.deleted_at).sort((a, b) => a.position - b.position).map((t) => t.name);
  expect(live).toEqual(await names());
  await owner.screenshot({ path: '../coordinacion/tasks/areas-filas-movil.png' }).catch(() => {});
  // Tocar el nombre abre el área.
  await rows().nth(1).locator('.area-open').click();
  await expect.poll(() => owner.evaluate(() => state.view)).toBe('projects');
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

test('FB_2026_021: chips de etiquetas agrupados por madre, y el selector con madres desplegables y «Todos»', async () => {
  // Una madre «Staff» con tres hijas en la familia Persona del área.
  const ids = await owner.evaluate(() => {
    const scope = (window as any).tab(), family = scope.families.find((f: any) => f.system === 'person');
    const staff = crypto.randomUUID(), vg = crypto.randomUUID(), an = crypto.randomUUID(), jl = crypto.randomUUID();
    scope.labels.push({ id: staff, text: 'Staff', family: family.id, parent: null, archived: false },
      { id: vg, text: 'VG', family: family.id, parent: staff, archived: false },
      { id: an, text: 'AN', family: family.id, parent: staff, archived: false },
      { id: jl, text: 'JL', family: family.id, parent: staff, archived: false });
    (window as any).save(); return { staff, vg, an, jl };
  });
  await settled(owner);
  // En la tarjeta: una sola chip por madre.
  const chipsOf = (list: string[]) => owner.evaluate((l) => { const d = document.createElement('div'); d.innerHTML = (window as any).chips(l); return [...d.querySelectorAll('.chip')].map((c) => c.textContent); }, list);
  expect(await chipsOf([ids.staff, ids.vg, ids.an])).toEqual(['Staff: VG, AN']);
  expect(await chipsOf([ids.staff, ids.vg, ids.an, ids.jl])).toEqual(['Staff']);
  expect(await chipsOf([ids.staff])).toEqual(['Staff']);
  expect(await chipsOf([ids.vg])).toEqual(['Staff: VG']);

  // En el selector: la madre se despliega; «Todos» y una hija suelta no van juntas.
  let picked: string[] | null = null;
  await owner.evaluate(() => { (window as any).__picked = null; (window as any).openLabelPicker([], (l: string[]) => { (window as any).__picked = l; }); });
  const mother = owner.locator(`[data-pick-mother="${ids.staff}"]`);
  await expect(mother).toHaveText(/Staff/);
  await expect(owner.locator(`[data-pick-kid="${ids.vg}"]`)).toHaveCount(0);
  await mother.click();
  await owner.locator(`[data-pick-kid="${ids.vg}"]`).click();
  await owner.locator(`[data-pick-kid="${ids.an}"]`).click();
  await expect(owner.locator(`[data-pick-mother="${ids.staff}"]`)).toContainText('Staff: VG, AN');
  await owner.locator(`[data-pick-all="${ids.staff}"]`).click();
  await expect(owner.locator(`[data-pick-mother="${ids.staff}"]`)).toContainText('Staff: Todos');
  await expect(owner.locator(`[data-pick-kid="${ids.vg}"]`)).not.toHaveClass(/\bon\b/);
  await owner.locator(`[data-pick-kid="${ids.jl}"]`).click();
  await expect(owner.locator(`[data-pick-all="${ids.staff}"]`)).not.toHaveClass(/\bon\b/);
  await owner.locator('#labelsDone').click();
  picked = await owner.evaluate(() => (window as any).__picked);
  expect(picked).toEqual([ids.jl]);
  await owner.evaluate(() => (window as any).closeSheet?.());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('FB_2026_022: la lupa y el filtro son iconos en la fila de facetas; la lupa despliega el campo', async () => {
  await owner.evaluate((id) => { state.taskScope = 'area'; state.activeTab = id; state.search = ''; state.filters = {}; (window as any).navigateView('projects'); }, ID.ikisai);
  const row = owner.locator('.facetbar .facets');
  await expect(row.locator('#searchToggle')).toBeVisible();
  await expect(row.locator('#filterBtn')).toBeVisible();
  await expect(row.locator('[data-facet]').first()).toBeVisible();
  await expect(owner.locator('#searchInput')).toBeHidden();
  await row.locator('#searchToggle').click();
  await expect(owner.locator('#searchInput')).toBeFocused();
  await owner.keyboard.type('zzz-sin-resultados');
  await expect.poll(() => owner.evaluate(() => state.search)).toBe('zzz-sin-resultados');
  await expect(owner.locator('#searchInput')).toBeVisible();
  // Cerrar la lupa borra la búsqueda y pliega el campo.
  await owner.locator('#searchToggle').click();
  await expect(owner.locator('#searchInput')).toBeHidden();
  expect(await owner.evaluate(() => state.search)).toBe('');
  // «/» la abre y la enfoca.
  await owner.locator('body').click({ position: { x: 5, y: 400 } });
  await owner.keyboard.press('/');
  await expect(owner.locator('#searchInput')).toBeFocused();
  await owner.keyboard.press('Escape');
  await owner.screenshot({ path: '../coordinacion/tasks/facetas-iconos-movil.png', clip: { x: 0, y: 0, width: 484, height: 360 } }).catch(() => {});
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
