/**
 * Ikisai Tasks · P2, PR 3b: el botón «Pasar las personas a Central», su vista previa y «Volver a las etiquetas de persona»
 * (docs/tasks/API.md §33). Solo la propietaria humana con acceso a todo lo ve, en «Trabajo» justo después de «Etiquetas» (y de
 * lo de los espacios y los oficios). Sin personas con nivel de casa en Central avisa con el enlace; si Central no responde,
 * lo dice. Cada etiqueta sale con su propuesta ya puesta en un select; la que no tiene propuesta sale vacía («Por
 * confirmar») y bloquea «Pasar» hasta elegirla. Tras pulsar, la app pasa sola a modo central (chips con las iniciales), y al
 * volver, a las etiquetas que guardaba el servidor, exactas. Capturas en `coordinacion/tasks/p2-despues/`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, EDITOR, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, navigationGroups: any, handleTopAction: any, syncNow: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), PUESTA = id(), STAFF = id(), VG = id(), JARDINERO = id();
const T_VG = id(), T_JARD = id(), T_STAFF = id();
// Personas de Central (nombres inventados).
const P_VG = id(), P_LUIS = id(), P_ROSA = id();
let PERSON = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  const mant = createTabOps({ id: MANT, name: 'Mantenimiento', position: 90_000 });
  PERSON = mant.find((o) => o.fields?.system_key === 'person')!.id!;
  await ok(mant);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: STAFF, fields: { tab_id: MANT, family_id: PERSON, name: 'Staff', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: JARDINERO, fields: { tab_id: MANT, family_id: PERSON, name: 'Jardinero', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PUESTA, fields: { tab_id: MANT, title: 'Puesta a punto', position: 2048 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: MANT, family_id: PERSON, parent_id: STAFF, name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_JARD, fields: { tab_id: MANT, project_id: PUESTA, title: 'Podar el seto', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: T_STAFF, fields: { tab_id: MANT, project_id: PUESTA, title: 'Barrer el patio', position: 3072 } },
  ]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: T_VG, fields: { tab_id: MANT, project_id: PUESTA, title: 'Cambiar el grifo', position: 1024, owner_label_id: VG } }]);
  const tl = (task: string, label: string) => ({ op: 'insert', table: 'tasks.task_labels', id: id(), fields: { tab_id: MANT, project_id: PUESTA, task_id: task, label_id: label } });
  await ok([tl(T_VG, STAFF), tl(T_VG, VG), tl(T_JARD, JARDINERO), tl(T_STAFF, STAFF)]);
  // Central, todavía sin personas con nivel de casa: las siembra la segunda prueba.
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const source = () => page.evaluate(() => (window as any).eval('Sync.core.peopleSource()'));
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/p2-despues/${name}.png` }).catch(() => {}); };
const openProject = () => page.evaluate(([t, p]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; state.filters = {}; state.search = ''; render(); }, [MANT, PUESTA]);
const menuItems = (p: Page) => p.evaluate(() => navigationGroups().flatMap((g: any) => g.items.map((i: any) => i[0])));
const workItems = (p: Page) => p.evaluate(() => [...document.querySelectorAll('#kebab [data-menu-group="work"] [data-menu-view], #kebab [data-menu-group="work"] [data-action]')].map((n: any) => n.dataset.menuView || n.dataset.action));
const sheet = () => page.locator('#sheet');
const sql = (text: string, params: unknown[] = []) => server.app.t.db.query(text, params);
const person = (pid: string, name: string, level: string, initials: string | null) =>
  sql(`insert into central.people (id, display_name, relation, house_level, initials, active) values ($1, $2, 'equipo', $3, $4, true)`, [pid, name, level, initials]);
const labelsOf = async (task: string) => (await server.rows('tasks.task_labels')).filter((r) => r.task_id === task && !r.deleted_at).map((r) => r.label_id).sort();

test('sin personas con nivel en Central, el aviso con el enlace; y si Central no responde, lo dice', async () => {
  await page.evaluate(() => handleTopAction('peopleToCentral'));
  await expect(sheet()).toContainText('Central no tiene personas con nivel de casa: ponlo primero en Central › Personas');
  await expect(sheet().locator('a', { hasText: 'Central › Personas' })).toHaveAttribute('href', 'https://central.ikisai.com');
  await expect(page.locator('#peopleApply')).toHaveCount(0);
  await shot('34-personas-central-sin-personas');
  await page.locator('#peopleClose').click();

  const saved = (await sql(`select * from core.allowed_reads where app = 'tasks' and name = 'central.people_options'`)).rows[0] as any;
  await sql(`delete from core.allowed_reads where app = 'tasks' and name = 'central.people_options'`);
  try {
    await page.evaluate(() => handleTopAction('peopleToCentral'));
    await expect(sheet()).toContainText('No se ha podido leer Central');
    await expect(page.locator('#peopleApply')).toHaveCount(0);
    await page.locator('#peopleClose').click();
  } finally {
    await sql(`insert into core.allowed_reads (app, name, kind, roles) values ($1, $2, $3, $4)`, [saved.app, saved.name, saved.kind, saved.roles]);
  }
});

test('el botón solo lo ve la propietaria, en «Trabajo» tras «Etiquetas»; las propuestas vienen puestas y la que no tiene bloquea', async () => {
  await person(P_VG, 'Valeria Gómez', 'staff', 'VG');
  await person(P_LUIS, 'Luis Pardo', 'staff', 'LP');
  await person(P_ROSA, 'Rosa Vidal', 'outsider', 'RV');

  expect(await menuItems(page)).toContain('peopleToCentral');
  const editorContext = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
  const editor = await openApp(editorContext, server, { user: EDITOR, aliases: ID });
  expect(await menuItems(editor)).not.toContain('peopleToCentral');
  await editor.locator('#moreBtn').click();
  await expect(editor.locator('#kebab [data-menu-group="work"] [data-menu-view="labels"]')).toBeVisible();
  await expect(editor.locator('#kebab [data-action="peopleToCentral"]')).toHaveCount(0);
  await editorContext.close();

  // Escritorio: a la vista desde el menú real.
  const desktopContext = await page.context().browser()!.newContext({ viewport: { width: 1280, height: 900 } });
  const desktop = await openApp(desktopContext, server, { aliases: ID });
  const deskItem = desktop.locator('#kebab [data-menu-group="work"] [data-action="peopleToCentral"]');
  await expect(deskItem).toBeVisible();
  const deskWork = await workItems(desktop);
  expect(deskWork.slice(deskWork.indexOf('labels'), deskWork.indexOf('labels') + 2)).toEqual(['labels', 'peopleToCentral']);
  await deskItem.click();
  await expect(desktop.locator(`#sheet [data-person-map="${VG}"]`)).toHaveValue(P_VG);
  await desktopContext.close();

  // Móvil, desde el menú real.
  await page.locator('#moreBtn').click();
  const item = page.locator('#kebab [data-menu-group="work"] [data-action="peopleToCentral"]');
  await expect(item).toBeVisible();
  const work = await workItems(page);
  expect(work.slice(work.indexOf('labels'), work.indexOf('labels') + 2)).toEqual(['labels', 'peopleToCentral']);
  await shot('31-personas-menu-trabajo');
  await item.click();
  await expect(page.locator('#moreBtn')).toHaveAttribute('aria-expanded', 'false');
  // Las propuestas, ya puestas: la madre «Staff» como grupo y «VG» por sus iniciales.
  await expect(page.locator(`[data-person-map="${STAFF}"]`)).toHaveValue('level:staff');
  await expect(page.locator(`[data-person-map="${VG}"]`)).toHaveValue(P_VG);
  await expect(sheet().locator(`[data-person-row="${VG}"]`)).toContainText('propuesta por las iniciales');
  await expect(sheet().locator(`[data-person-row="${VG}"]`)).toContainText('Mantenimiento · 1 tarea · responsable de 1');
  // Las de la demostración (otras áreas) tampoco casan con nadie: aquí se quitan, como haría la propietaria.
  const others = await sheet().locator('[data-person-map]').evaluateAll((s) => s.map((x: any) => x.dataset.personMap));
  for (const label of others.filter((l: string) => !([STAFF, VG, JARDINERO] as string[]).includes(l))) {
    await expect(page.locator(`[data-person-map="${label}"]`)).toHaveValue('');
    await page.locator(`[data-person-map="${label}"]`).selectOption('remove');
    await expect(page.locator(`[data-person-map="${label}"]`)).toHaveValue('remove');
  }
  // «Jardinero» no casa con nadie: vacío y «Por confirmar»; el botón no se puede pulsar.
  await expect(page.locator(`[data-person-map="${JARDINERO}"]`)).toHaveValue('');
  await expect(sheet().locator(`[data-person-row="${JARDINERO}"]`)).toContainText('Por confirmar');
  await expect(sheet().locator('.zonecounts')).toContainText('proyectos recibirán su persona');
  const without = async () => Number((await sheet().locator('.zonecounts').textContent())?.match(/(\d+) se queda/)?.[1] ?? 0);
  const lost = await without();
  // Las opciones: las personas por nivel, los grupos y «Quitar».
  expect(await page.locator(`[data-person-map="${JARDINERO}"] optgroup`).evaluateAll((g) => g.map((x: any) => x.label))).toEqual(['Dirección', 'Staff', 'Outsider']);
  expect(await page.locator(`[data-person-map="${JARDINERO}"] option`).allTextContents()).toEqual(['Elige…', 'Toda la dirección', 'Todo el staff', 'Luis Pardo · LP', 'Valeria Gómez · VG', 'Todos los outsiders', 'Rosa Vidal · RV', 'Quitar']);
  await expect(page.locator('#peopleApply')).toBeDisabled();
  await expect(sheet()).toContainText('Falta elegir 1 etiqueta');
  await shot('32-personas-vista-previa-por-confirmar');
  // Cada cambio va al borrador del dispositivo y la vista previa se vuelve a pedir con él.
  await page.locator(`[data-person-map="${JARDINERO}"]`).selectOption(P_LUIS);
  await expect(page.locator(`[data-person-map="${JARDINERO}"]`)).toHaveValue(P_LUIS);
  await expect(sheet().locator(`[data-person-row="${JARDINERO}"]`)).not.toContainText('Por confirmar');
  await expect.poll(without).toBe(lost - 1);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('ikisai-tasks-people-mapping') || '{}')))[JARDINERO]).toBe(P_LUIS);
  await expect(page.locator('#peopleApply')).toBeEnabled();
  await shot('33-personas-vista-previa-lista');
});

test('al pulsar, la app pasa sola a Central; y «Volver a las etiquetas de persona» la deja exacta, con las etiquetas del servidor', async () => {
  const before = { vg: await labelsOf(T_VG), jard: await labelsOf(T_JARD), staff: await labelsOf(T_STAFF) };
  await page.locator('#peopleApply').click();
  await expect.poll(source).toBe('central');
  await settled(page);
  await openProject();
  await expect(chipsOf(T_VG)).toHaveText(['VG']);
  await expect(chipsOf(T_JARD)).toHaveText(['LP']);
  await expect(chipsOf(T_STAFF)).toHaveText(['Todo el staff']);
  const grifo = (await server.rows('tasks.tasks')).find((r) => r.id === T_VG)!;
  expect([grifo.owner_label_id, grifo.owner_person_id]).toEqual([null, P_VG]);
  expect(await menuItems(page)).not.toContain('peopleToCentral');
  expect(await menuItems(page)).toContain('people');
  expect(await page.evaluate(() => localStorage.getItem('ikisai-tasks-people-mapping'))).toBeNull();

  // Una persona puesta en modo central que no viene de ninguna etiqueta: al volver, se perdería.
  const res = await server.commit([{ op: 'insert', table: 'tasks.task_people', id: id(), fields: { tab_id: MANT, project_id: PUESTA, task_id: T_STAFF, person_id: P_ROSA } }]);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  await page.evaluate(() => syncNow());
  await settled(page);
  await expect(chipsOf(T_STAFF)).toHaveText(['Todo el staff', 'RV']);

  // «Personas», a la vista en «Trabajo», tras «Etiquetas».
  await page.locator('#moreBtn').click();
  const people = page.locator('#kebab [data-menu-group="work"] [data-menu-view="people"]');
  await expect(people).toBeVisible();
  await people.click();
  await expect(page.locator('.peoplelist')).toContainText('Rosa Vidal');
  await page.locator('#peopleToLabels').click();
  await expect(sheet()).toContainText('Las personas vuelven a ser etiquetas de persona');
  await expect(sheet()).toContainText('Se perderían (1)');
  await expect(sheet()).toContainText('Rosa Vidal · 1 tarea');
  await expect(page.locator('#peopleBackApply')).toBeDisabled();
  await page.locator('#peopleDrop').check();
  await expect(page.locator('#peopleBackApply')).toBeEnabled();
  await shot('35-personas-volver-a-las-etiquetas');
  await page.locator('#peopleBackApply').click();
  await expect.poll(source).toBe('labels');
  await settled(page);
  // Exacta: las mismas etiquetas que antes de pasar, y el responsable vuelve a su etiqueta.
  expect(await labelsOf(T_VG)).toEqual(before.vg);
  expect(await labelsOf(T_JARD)).toEqual(before.jard);
  expect(await labelsOf(T_STAFF)).toEqual(before.staff);
  expect((await server.rows('tasks.tasks')).find((r) => r.id === T_VG)!.owner_label_id).toBe(VG);
  expect((await server.rows('tasks.task_people')).filter((r) => !r.deleted_at)).toEqual([]);
  await openProject();
  // Con su única hija, la chip dice la madre (FB_2026_021), como antes de pasar.
  await expect(chipsOf(T_VG)).toHaveText(['Staff']);
  await expect(chipsOf(T_JARD)).toHaveText(['Jardinero']);
  expect(await menuItems(page)).toContain('peopleToCentral');
  // La propuesta confirmada se recuerda: al volver a abrir la vista previa, «Jardinero» ya sale con Luis.
  await page.evaluate(() => handleTopAction('peopleToCentral'));
  await expect(page.locator(`[data-person-map="${JARDINERO}"]`)).toHaveValue(P_LUIS);
  await expect(sheet().locator(`[data-person-row="${JARDINERO}"]`)).toContainText('confirmada antes');
  await page.locator('#peopleCancel').click();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
