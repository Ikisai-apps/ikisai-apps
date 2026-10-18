/**
 * Ikisai Tasks · P2, PR 3b: la caracterización de `personas.spec.ts` pasada a las personas de Central (docs/tasks/API.md §33).
 * Misma siembra (más «Barrer el patio», que solo lleva la madre «Staff» y pasa a «Todo el staff»), las personas de Central
 * sembradas con SQL (`central.people`, con iniciales y nivel de casa; la de VG enlazada a la cuenta de la propietaria) y la ida
 * real (`actions/people-to-central` con un `mapping`) antes de abrir la app. Se espera lo mismo que hoy salvo lo decidido:
 * la chip dice las iniciales (o el nombre de pila; el grupo, «Todo el staff»), una por persona o grupo, en el sitio de la
 * persona; el nivel del filtro incluye a sus personas (la tarea que solo tenía AN sí sale) y a las tareas del grupo; el
 * «Responsable principal» va agrupado por nivel. Además: buscar, agrupar, la ficha, el lote, el arrastre, la herencia,
 * «Mis tareas» por la cuenta, las reglas de Entrada, vistas guardadas, texto legible, la pantalla «Personas», sin red y la
 * vista General. Capturas («después») en `coordinacion/tasks/p2-despues/`.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const Sync: any, state: any, render: any, filteredTasks: any, project: any, openTaskEditor: any, openProjectEditor: any, navigateView: any, startInlineNew: any, savedViewsSheet: any, readableExport: any, handleTopAction: any, routeSheet: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), RET = id(), PINTURA = id(), OTONO = id();
const ACCION = id(), FONT = id(), ACS = id(), FRIA = id(), ELEC = id(), CUADRO = id(), PINT = id();
const STAFF = id(), VG = id(), AN = id(), OUT = id(), MARTA = id(), RET_VG = id();
const T_GRIFO = id(), T_CUADRO = id(), T_PARED = id(), T_NADA = id(), T_RET = id(), T_PATIO = id();
// Personas de Central (nombres inventados): VG y AN, de staff, con iniciales; Marta, outsider y sin iniciales.
const P_VG = id(), P_AN = id(), P_MARTA = id();
let PERSON = '', RET_PERSON = '', PHASE = '', REPASO = '', seq = 0;

async function seedPeople(ok: (ops: any[]) => Promise<void>) {
  await server.app.t.db.query(`update tasks.families set name = 'Grupo: Persona' where id = any($1)`, [[PERSON, RET_PERSON]]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: STAFF, fields: { tab_id: MANT, family_id: PERSON, name: 'Staff', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: OUT, fields: { tab_id: MANT, family_id: PERSON, name: 'Outsiders', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: RET_VG, fields: { tab_id: RET, family_id: RET_PERSON, name: 'VG', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: MANT, family_id: PERSON, parent_id: STAFF, name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: AN, fields: { tab_id: MANT, family_id: PERSON, parent_id: STAFF, name: 'AN', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: MARTA, fields: { tab_id: MANT, family_id: PERSON, parent_id: OUT, name: 'Marta', position: 1024 } },
  ]);
}
async function seedActions(ok: (ops: any[]) => Promise<void>) {
  await ok([{ op: 'insert', table: 'tasks.families', id: ACCION, fields: { tab_id: null, name: 'Tipo: Acción', color: '#5a7a8a', position: 2 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: FONT, fields: { tab_id: null, family_id: ACCION, name: 'Fontanería', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: ELEC, fields: { tab_id: null, family_id: ACCION, name: 'Electricidad', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: PINT, fields: { tab_id: null, family_id: ACCION, name: 'Pintura', position: 3072 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: ACS, fields: { tab_id: null, family_id: ACCION, parent_id: FONT, name: 'ACS', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: FRIA, fields: { tab_id: null, family_id: ACCION, parent_id: FONT, name: 'Agua fría', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: CUADRO, fields: { tab_id: null, family_id: ACCION, parent_id: ELEC, name: 'Cuadro', position: 1024 } },
  ]);
}
/** En P2: las fichas de Central con su nivel de casa y sus iniciales. */
async function seedCentralPeople() {
  const person = (pid: string, name: string, level: string, initials: string | null, user: string | null) =>
    server.app.t.db.query(`insert into central.people (id, display_name, relation, house_level, initials, active, user_id) values ($1, $2, 'equipo', $3, $4, true, $5)`, [pid, name, level, initials, user]);
  await person(P_VG, 'Valeria Gómez', 'staff', 'VG', server.app.users.owner);
  await person(P_AN, 'Andrés Navarro', 'staff', 'AN', null);
  await person(P_MARTA, 'Marta Ruiz', 'outsider', null, null);
}
const tl = (tab: string, p: string, task: string, label: string) => ({ op: 'insert', table: 'tasks.task_labels', id: id(), fields: { tab_id: tab, project_id: p, task_id: task, label_id: label } });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  const mant = createTabOps({ id: MANT, name: 'Mantenimiento', position: 90_000 });
  const ret = createTabOps({ id: RET, name: 'Retiros', position: 91_000 });
  PERSON = mant.find((o) => o.fields?.system_key === 'person')!.id!;
  PHASE = mant.find((o) => o.fields?.system_key === 'phase')!.id!;
  RET_PERSON = ret.find((o) => o.fields?.system_key === 'person')!.id!;
  await ok(mant);
  await ok(ret);
  await seedPeople(ok);
  await seedActions(ok);
  REPASO = id();
  await ok([
    { op: 'insert', table: 'tasks.projects', id: PINTURA, fields: { tab_id: MANT, title: 'Puesta a punto', position: 2048, owner_label_id: VG } },
    { op: 'insert', table: 'tasks.projects', id: OTONO, fields: { tab_id: RET, title: 'Retiro de otoño', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: REPASO, fields: { tab_id: MANT, family_id: PHASE, name: 'Repaso', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_GRIFO, fields: { tab_id: MANT, project_id: PINTURA, title: 'Cambiar el grifo del ACS', position: 1024, owner_label_id: VG } },
    { op: 'insert', table: 'tasks.tasks', id: T_CUADRO, fields: { tab_id: MANT, project_id: PINTURA, title: 'Revisar el cuadro', position: 2048, owner_label_id: MARTA } },
    { op: 'insert', table: 'tasks.tasks', id: T_PARED, fields: { tab_id: MANT, project_id: PINTURA, title: 'Pintar la pared', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: T_NADA, fields: { tab_id: MANT, project_id: PINTURA, title: 'Comprar material', position: 4096 } },
    { op: 'insert', table: 'tasks.tasks', id: T_PATIO, fields: { tab_id: MANT, project_id: PINTURA, title: 'Barrer el patio', position: 5120 } },
    { op: 'insert', table: 'tasks.tasks', id: T_RET, fields: { tab_id: RET, project_id: OTONO, title: 'Purgar el agua fría', position: 1024, owner_label_id: RET_VG } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: PINTURA, label_id: STAFF } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: PINTURA, label_id: VG } },
  ]);
  await ok([
    tl(MANT, PINTURA, T_GRIFO, REPASO), tl(MANT, PINTURA, T_GRIFO, ACS), tl(MANT, PINTURA, T_GRIFO, FONT), tl(MANT, PINTURA, T_GRIFO, VG), tl(MANT, PINTURA, T_GRIFO, STAFF),
    tl(MANT, PINTURA, T_CUADRO, ELEC), tl(MANT, PINTURA, T_CUADRO, CUADRO), tl(MANT, PINTURA, T_CUADRO, OUT), tl(MANT, PINTURA, T_CUADRO, MARTA),
    tl(MANT, PINTURA, T_PARED, PINT), tl(MANT, PINTURA, T_PARED, AN),
    // Solo la madre: el grupo entero («Todo el staff»).
    tl(MANT, PINTURA, T_PATIO, STAFF),
    tl(RET, OTONO, T_RET, FONT), tl(RET, OTONO, T_RET, FRIA), tl(RET, OTONO, T_RET, RET_VG),
  ]);
  await seedCentralPeople();
  // La ida real, como la hace el botón (personas-boton.spec.ts), con lo que confirma la propietaria.
  const mapping: Record<string, string> = { [STAFF]: 'level:staff', [OUT]: 'level:outsider', [VG]: P_VG, [AN]: P_AN, [MARTA]: P_MARTA, [RET_VG]: P_VG };
  // Las etiquetas de persona de la demostración (otras áreas) no tienen ficha: se quitan.
  const preview = await server.app.call('/api/v1/read/tasks.people_preview', { body: {} });
  expect(preview.status, JSON.stringify(preview.data)).toBe(200);
  for (const l of preview.data.labels) if (!(l.labelIds as string[]).some((x) => x in mapping)) mapping[l.labelId] = 'remove';
  const done = await server.app.call('/api/v1/actions/people-to-central', { body: { requestId: `pp-${++seq}`, mapping } });
  expect(done.status, JSON.stringify(done.data)).toBe(200);
  expect(done.data.source).toBe('central');
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
  await expect.poll(() => page.evaluate(() => (window as any).eval('Sync.core.peopleSource()+":"+Sync.core.people.length'))).toBe('central:3');
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

// --- Conductor en modo central ------------------------------------------------------------------------------------------
const openProject = (tab: string, p: string) => page.evaluate(([t, pr]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = pr; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [tab, p]);
const shown = () => page.evaluate(() => filteredTasks(project()).map((t: any) => t.text).sort());
const option = (key: string) => page.locator(`.facet.open .facetpanel [data-facet-value="${key}"]`);
const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/p2-despues/${name}.png` }).catch(() => {}); };
const keyOf = (r: any) => r.person_id ?? `level:${r.house_level}`;
const serverPeople = async (table: 'tasks.task_people' | 'tasks.project_people', key: 'task_id' | 'project_id', owner: string) =>
  (await server.rows(table)).filter((r) => r[key] === owner && !r.deleted_at).map(keyOf).sort();
const taskPeople = (task: string) => serverPeople('tasks.task_people', 'task_id', task);
const quick = (name: string) => page.locator('#sheet .space-quick-chip', { hasText: new RegExp(`^${name}$`) });
const ALL = ['Barrer el patio', 'Cambiar el grifo del ACS', 'Comprar material', 'Pintar la pared', 'Revisar el cuadro'];

test('chips: las iniciales (o el nombre de pila) y «Todo el staff», donde iba la persona; en la tarjeta del proyecto y en el tablero', async () => {
  // La ida dejó lo más hondo: la persona (no su madre) y el grupo donde solo estaba la madre.
  expect(await taskPeople(T_GRIFO)).toEqual([P_VG]);
  expect(await taskPeople(T_PATIO)).toEqual(['level:staff']);
  const grifo = (await server.rows('tasks.tasks')).find((r) => r.id === T_GRIFO)!;
  expect([grifo.owner_label_id, grifo.owner_person_id]).toEqual([null, P_VG]);
  expect(await page.evaluate(() => Sync.actor.id)).toBe(server.app.users.owner);
  await openProject(MANT, PINTURA);
  // Después de la acción y antes de la fase, como «Staff: VG» hoy (personas.spec.ts).
  await expect(chipsOf(T_GRIFO)).toHaveText(['Fontanería: ACS', 'VG', 'Repaso']);
  await expect(chipsOf(T_CUADRO)).toHaveText(['Electricidad', 'Marta']);
  await expect(chipsOf(T_PARED)).toHaveText(['Pintura', 'AN']);
  await expect(chipsOf(T_PATIO)).toHaveText(['Todo el staff']);
  await expect(chipsOf(T_GRIFO).nth(1)).toHaveAttribute('title', 'Valeria Gómez');
  await shot('20-personas-tarjetas-de-tarea');
  await page.locator('[data-board-mode="board"]').click();
  await expect(page.locator(`[data-board-task="${T_GRIFO}"] .chips .chip`)).toHaveText(['Fontanería: ACS', 'VG', 'Repaso']);
  await expect(page.locator(`[data-board-task="${T_PATIO}"] .chips .chip`)).toHaveText(['Todo el staff']);
  await shot('21-personas-tablero');
  await page.locator('[data-board-mode="list"]').click();
  await page.evaluate((t) => { state.activeTab = t; state.view = 'projects'; render(); }, MANT);
  // Una chip por persona o grupo, sin compactar: el grupo delante de sus personas, por nivel y por nombre.
  await expect(page.locator(`.project:has([data-open-project="${PINTURA}"]) .chip`)).toHaveText(['Fontanería: ACS', 'Electricidad', 'Pintura', 'Todo el staff', 'AN', 'VG', 'Marta', 'Repaso']);
  await shot('22-personas-tarjeta-de-proyecto');
});

test('faceta «Persona» en árbol por nivel: Staff incluye a VG, a AN y «Todo el staff»; tres estados y búsqueda', async () => {
  await openProject(MANT, PINTURA);
  await page.locator('[data-facet="_person"]').click();
  const panel = page.locator('.facet.open .facetpanel');
  await expect(panel.locator('[data-facet-toggle="_person"]')).toHaveText([/^Staff/, /^Andrés Navarro · AN/, /^Valeria Gómez · VG/, /^Outsider/, /^Marta Ruiz/]);
  await option('level:staff').click();
  // La tarea que solo tenía AN (sin la madre) sí sale, y también la del grupo.
  expect(await shown()).toEqual(['Barrer el patio', 'Cambiar el grifo del ACS', 'Pintar la pared']);
  await option('level:staff').click();
  await expect(option('level:staff')).toHaveClass(/excluded/);
  expect(await shown()).toEqual(['Comprar material', 'Revisar el cuadro']);
  await option('level:staff').click();
  expect(await shown()).toEqual(ALL);
  await option(P_MARTA).click();
  expect(await shown()).toEqual(['Revisar el cuadro']);
  await option(P_MARTA).click();
  await option(P_MARTA).click();
  // Persona sola: no arrastra a las del grupo.
  await option(P_AN).click();
  expect(await shown()).toEqual(['Pintar la pared']);
  await option(P_AN).click();
  await option(P_AN).click();
  expect(await shown()).toEqual(ALL);
  // Búsqueda dentro de la faceta: por las iniciales y por el nombre.
  await panel.locator('.personfacetsearch').fill('vg');
  await expect(option(P_VG)).toBeVisible();
  await expect(option(P_AN)).toBeHidden();
  await expect(option(P_MARTA)).toBeHidden();
  await expect(option('level:staff')).toBeVisible();
  await panel.locator('.personfacetsearch').fill('marta');
  await expect(option(P_MARTA)).toBeVisible();
  await expect(option(P_VG)).toBeHidden();
  await shot('23-personas-faceta');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { state.filters = {}; render(); });
});

test('buscar: el nombre o las iniciales encuentran sus tareas, sin mirar tildes', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate(() => { state.search = 'andres'; render(); });
  expect(await shown()).toEqual(['Pintar la pared']);
  await page.evaluate(() => { state.search = 'gomez'; render(); });
  expect(await shown()).toEqual(['Cambiar el grifo del ACS']);
  await page.evaluate(() => { state.search = 'todo el staff'; render(); });
  expect(await shown()).toEqual(['Barrer el patio']);
  await page.evaluate(() => { state.search = ''; render(); });
});

test('agrupar por persona: cada tarea una sola vez, en lo más hondo', async () => {
  await page.evaluate(() => { state.view = 'tasks'; state.groupBy = '_person'; state.filters = {}; render(); });
  await expect(page.locator('#groupBy option[value="_person"]')).toHaveCount(1);
  const sectionOf = (task: string) => page.locator('main section', { has: page.locator(`[data-toggle-task="${task}"]`) });
  await expect(sectionOf(T_GRIFO)).toHaveCount(1);
  await expect(sectionOf(T_GRIFO).locator('h2')).toContainText('Valeria Gómez');
  await expect(sectionOf(T_CUADRO).locator('h2')).toContainText('Marta Ruiz');
  await expect(sectionOf(T_PATIO).locator('h2')).toContainText('Todo el staff');
  await expect(sectionOf(T_NADA).locator('h2')).toContainText('Sin persona');
  await shot('24-personas-agrupar');
  await page.evaluate(() => { state.groupBy = 'project'; render(); });
});

test('ficha: «Personas» con «Más usados» a un toque y el «Responsable principal» agrupado por nivel', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  await expect(page.locator('#sheet [data-feedback-id="tasks.editor_tarea.personas"]')).toBeVisible();
  // El responsable: por nivel (Dirección, Staff, Outsider), el grupo delante y las personas por nombre; siempre igual.
  expect(await page.locator('#teOwner optgroup').evaluateAll((g) => g.map((x: any) => x.label))).toEqual(['Dirección', 'Staff', 'Outsider']);
  expect(await page.locator('#teOwner option').allTextContents()).toEqual(['Sin asignar', 'Toda la dirección', 'Todo el staff', 'Andrés Navarro', 'Valeria Gómez', 'Todos los outsiders', 'Marta Ruiz']);
  await shot('25-personas-ficha');
  await quick('Andrés Navarro').click();
  await expect(quick('Andrés Navarro')).toHaveClass(/on/);
  await page.locator('#teOwner').selectOption('level:staff');
  await shot('26-personas-ficha-responsable');
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  expect(await taskPeople(T_NADA)).toEqual([P_AN]);
  const row = (await server.rows('tasks.tasks')).find((r) => r.id === T_NADA)!;
  expect([row.owner_label_id, row.owner_person_id, row.owner_house_level]).toEqual([null, null, 'staff']);
  await expect(chipsOf(T_NADA)).toHaveText(['AN']);
  // Al volver a abrirla, el responsable sigue elegido.
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  await expect(page.locator('#teOwner')).toHaveValue('level:staff');
  await page.locator('#teOwner').selectOption(P_VG);
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  const again = (await server.rows('tasks.tasks')).find((r) => r.id === T_NADA)!;
  expect([again.owner_label_id, again.owner_person_id, again.owner_house_level]).toEqual([null, P_VG, null]);
});

test('ficha: la búsqueda encuentra por iniciales y por nombre', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((t) => openTaskEditor(t), T_GRIFO);
  await page.locator('#sheet .personfield .space-search').fill('an');
  await expect(page.locator('#sheet .personfield .space-result-name').first()).toHaveText('Andrés Navarro');
  await page.locator('#sheet .personfield .space-search').fill('zzz');
  await expect(page.locator('#sheet .personfield .space-result.empty')).toContainText('Ninguna persona coincide');
  await page.evaluate(() => (window as any).closeSheet?.());
});

test('selección múltiple: «Persona» › la persona › Aplicar, a varias tareas a la vez', async () => {
  await openProject(MANT, PINTURA);
  await page.locator('#batchToggle').click();
  for (const t of [T_PARED, T_NADA]) await page.locator(`[data-select="${t}"]`).click();
  await page.locator('#batchPerson').click();
  await quick('Marta Ruiz').click();
  await shot('27-personas-lote');
  await page.locator('#batchPersonDone').click();
  await settled(page);
  expect(await taskPeople(T_PARED)).toEqual([P_AN, P_MARTA].sort());
  expect(await taskPeople(T_NADA)).toEqual([P_AN, P_MARTA].sort());
  await expect(chipsOf(T_PARED)).toHaveText(['Pintura', 'AN', 'Marta']);
  // El lote no toca el responsable principal.
  expect((await server.rows('tasks.tasks')).find((r) => r.id === T_NADA)!.owner_person_id).toBe(P_VG);
  if (await page.locator('#batchCancel').count()) await page.locator('#batchCancel').click();
});

test('arrastre: reordenar con el asa no toca personas ni responsable', async () => {
  await openProject(MANT, PINTURA);
  const before = await taskPeople(T_CUADRO);
  expect(before).toEqual([P_MARTA]);
  const from = (await page.locator(`.task:has([data-toggle-task="${T_CUADRO}"]) [data-drag]`).boundingBox())!;
  const to = (await page.locator(`.task:has([data-toggle-task="${T_GRIFO}"])`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
  await settled(page);
  const order = (await server.rows('tasks.tasks')).filter((t) => t.project_id === PINTURA && !t.deleted_at).sort((a, b) => a.position - b.position).map((t) => t.title);
  expect(order[0]).toBe('Revisar el cuadro');
  expect(await taskPeople(T_CUADRO)).toEqual(before);
  expect((await server.rows('tasks.tasks')).find((r) => r.id === T_CUADRO)!.owner_person_id).toBe(P_MARTA);
  await expect(chipsOf(T_CUADRO)).toHaveText(['Electricidad', 'Marta']);
});

test('herencia: las personas del proyecto pasan a sus tareas nuevas (ficha y alta en línea)', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((p) => openProjectEditor(p), PINTURA);
  await expect(page.locator('#sheet [data-feedback-id="tasks.editor_proyecto.personas"]')).toBeVisible();
  await expect(page.locator('#sheet .personfield .space-picked .chip')).toHaveText(['Valeria Gómez']);
  await expect(page.locator('#peOwner')).toHaveValue(P_VG);
  await quick('Todo el staff').click();
  await page.locator('#saveProjectBtn').click();
  await settled(page);
  expect(await serverPeople('tasks.project_people', 'project_id', PINTURA)).toEqual([P_VG, 'level:staff'].sort());
  const project = (await server.rows('tasks.projects')).find((r) => r.id === PINTURA)!;
  expect([project.owner_label_id, project.owner_person_id]).toEqual([null, P_VG]);
  await openProject(MANT, PINTURA);
  await page.evaluate(() => openTaskEditor(null));
  await expect(page.locator('#sheet .personfield .space-picked .chip')).toHaveText(['Valeria Gómez', 'Todo el staff']);
  await page.locator('#teText').fill('Lijar la puerta');
  await page.locator('#saveTaskBtn').click();
  await page.evaluate((p) => startInlineNew(p), PINTURA);
  await page.locator('.newinput').fill('Comprar rodillos');
  await page.locator('.newinput').press('Enter');
  await settled(page);
  const tasks = (await server.rows('tasks.tasks')).filter((t) => t.project_id === PINTURA && !t.deleted_at);
  for (const title of ['Lijar la puerta', 'Comprar rodillos']) {
    const task = tasks.find((t) => t.title === title);
    expect(task, title).toBeTruthy();
    expect(await taskPeople(task.id), title).toEqual([P_VG, 'level:staff'].sort());
  }
});

test('«Mis tareas»: la persona de Central enlazada a la cuenta, en todas las áreas', async () => {
  await page.evaluate(() => { state.view = 'projects'; render(); handleTopAction('mine'); });
  await expect.poll(() => page.evaluate(() => JSON.stringify(state.filters))).toBe(JSON.stringify({ _person: [P_VG] }));
  const titles = () => page.evaluate(() => [...document.querySelectorAll('main .task[data-row] .tasktext')].map((n) => n.textContent!.trim()).sort());
  await expect.poll(titles).toEqual(['Cambiar el grifo del ACS', 'Comprar rodillos', 'Lijar la puerta', 'Purgar el agua fría']);
  await expect(page.locator('[data-quick-mine]')).toHaveCount(1);
  await page.evaluate(() => { state.taskScope = 'area'; state.filters = {}; render(); });
});

test('reglas de Entrada: el responsable sale de Central y no crea etiquetas', async () => {
  const labelsBefore = (await server.rows('tasks.labels')).filter((l) => !l.deleted_at).length;
  await page.evaluate((t) => { state.activeTab = t; state.view = 'triage'; render(); routeSheet('central.compliance_due'); }, MANT);
  expect(await page.locator('#destOwner optgroup').evaluateAll((g) => g.map((x: any) => x.label))).toEqual(['Dirección', 'Staff', 'Outsider']);
  await page.locator('#destOwner').selectOption(P_AN);
  await shot('28-personas-regla-de-entrada');
  await page.locator('#routeSave').click();
  await settled(page);
  const route = (await server.rows('tasks.request_routes')).find((r) => r.kind === 'central.compliance_due' && !r.deleted_at)!;
  expect([route.owner_label_id, route.owner_person_id, route.owner_house_level]).toEqual([null, P_AN, null]);
  expect((await server.rows('tasks.labels')).filter((l) => !l.deleted_at).length).toBe(labelsBefore);
  // Al volver a abrirla, el responsable sigue ahí; y un grupo se guarda como nivel.
  await page.evaluate(() => routeSheet('central.compliance_due'));
  await expect(page.locator('#destOwner')).toHaveValue(P_AN);
  await page.locator('#destOwner').selectOption('level:outsider');
  await page.locator('#routeSave').click();
  await settled(page);
  const group = (await server.rows('tasks.request_routes')).find((r) => r.kind === 'central.compliance_due' && !r.deleted_at)!;
  expect([group.owner_label_id, group.owner_person_id, group.owner_house_level]).toEqual([null, null, 'outsider']);
  await page.evaluate(() => (window as any).closeSheet?.());
  await page.evaluate(() => { state.view = 'projects'; render(); });
});

test('General frente a un área: la persona es una sola en todas las áreas y la vista General junta las dos', async () => {
  await openProject(RET, OTONO);
  await expect(chipsOf(T_RET)).toHaveText(['Fontanería: Agua fría', 'VG']);
  await page.evaluate((t) => openTaskEditor(t), T_RET);
  // En Retiros, el responsable ofrece las mismas personas de Central que en cualquier área.
  expect(await page.locator('#teOwner option').allTextContents()).toEqual(['Sin asignar', 'Toda la dirección', 'Todo el staff', 'Andrés Navarro', 'Valeria Gómez', 'Todos los outsiders', 'Marta Ruiz']);
  await expect(page.locator('#teOwner')).toHaveValue(P_VG);
  await page.evaluate(() => (window as any).closeSheet?.());
  await page.evaluate(() => { state.taskScope = 'all'; state.view = 'tasks'; state.groupBy = 'project'; state.search = ''; state.filters = {}; render(); });
  await expect(page.locator('[data-facet="_person"]')).toHaveCount(1);
  const titles = () => page.evaluate(() => [...document.querySelectorAll('main .task[data-row] .tasktext')].map((n) => n.textContent!.trim()).sort());
  await page.evaluate((k) => { state.filters = { _person: [k] }; render(); }, P_VG);
  await expect.poll(titles).toEqual(['Cambiar el grifo del ACS', 'Comprar rodillos', 'Lijar la puerta', 'Purgar el agua fría']);
  await page.evaluate(() => { state.taskScope = 'area'; state.filters = {}; render(); });
});

test('vistas guardadas con `_person` y texto legible con «Personas:»', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate(() => { state.view = 'tasks'; state.currentProject = null; state.filters = { _person: ['level:staff'] }; state.groupBy = '_person'; render(); savedViewsSheet(); });
  await page.locator('#viewName').fill('Staff');
  await page.locator('#saveView').click();
  await settled(page);
  const view = (await server.rows('tasks.saved_views')).find((v) => v.name === 'Staff' && !v.deleted_at);
  expect(view.filters).toEqual({ _person: ['level:staff'] });
  expect(view.group_by).toBe('_person');
  await page.evaluate(() => { state.filters = {}; state.groupBy = 'project'; render(); savedViewsSheet(); });
  await page.locator(`[data-load-view="${view.id}"]`).click();
  await expect.poll(() => page.evaluate(() => [state.groupBy, (state.filters._person || []).join(',')].join(':'))).toBe('_person:level:staff');
  await page.evaluate(() => { state.filters = {}; state.groupBy = 'project'; render(); });

  const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => readableExport())]);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text).toMatch(/- \[ \] Cambiar el grifo del ACS\n(?: {2}.*\n)*? {2}Personas: Valeria Gómez\n/);
  expect(text).toMatch(/- \[ \] Barrer el patio\n(?: {2}.*\n)*? {2}Personas: Todo el staff\n/);
  expect(text).toMatch(/- \[ \] Pintar la pared\n(?: {2}.*\n)*? {2}Personas: Andrés Navarro, Marta Ruiz\n/);
});

test('pantalla «Personas»: las de Central por nivel, de solo lectura, con «Gestionar en Central»', async () => {
  await page.locator('#moreBtn').click();
  const item = page.locator('#kebab [data-menu-group="work"] [data-menu-view="people"]');
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('.peoplelist')).toContainText('Valeria Gómez');
  await expect(page.locator('.peoplelist .personnode')).toHaveCount(3);
  await expect(page.locator('.people-screen a', { hasText: 'Gestionar en Central' })).toHaveAttribute('href', 'https://central.ikisai.com');
  await expect(page.locator('#peopleToLabels')).toBeVisible();
  await shot('29-personas-pantalla');
  await page.evaluate(() => navigateView('projects'));
});

test('sin red: los nombres y las iniciales salen de lo guardado en el dispositivo', async () => {
  await page.evaluate(() => { (window as any).antesDeRecargar = true; });
  await context.setOffline(true);
  await page.reload().catch(() => undefined);
  await page.waitForFunction(() => typeof Sync !== 'undefined' && Sync.core && state.tabs.length > 0, null, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as any).antesDeRecargar)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).eval('Sync.core.refreshPeople()'))).toBe(false);
  expect(await page.evaluate(() => (window as any).eval('Sync.core.people.length'))).toBe(3);
  await openProject(MANT, PINTURA);
  await expect(chipsOf(T_GRIFO)).toHaveText(['Fontanería: ACS', 'VG', 'Repaso']);
  await expect(chipsOf(T_PATIO)).toHaveText(['Todo el staff']);
  await shot('30-personas-sin-red');
  await context.setOffline(false);
  await page.evaluate(() => (window as any).eval('syncNow()'));
  await settled(page);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
