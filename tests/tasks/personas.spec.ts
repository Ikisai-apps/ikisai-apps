/**
 * Ikisai Tasks · caracterización de personas y acciones antes de la fase P2 (coordinacion/ampliacion/RECURSOS.md §13 y §17).
 * Fija lo que ve y hace hoy la persona con la familia de responsables del área («Grupo: Persona», Staff › VG) y la
 * familia General «Tipo: Acción» (Fontanería › ACS): chips, filtro con descendientes y tres estados, agrupar sin
 * duplicar, la ficha (etiquetas y «Responsable principal»), la selección múltiple, el arrastre, y General frente a un área.
 * En P2 las personas pasan a ser fichas de Central y las acciones, oficios: solo cambiará la fuente del dato (la siembra
 * de `seedPeople` y `seedActions` y el «conductor» de abajo), no lo que estas pruebas esperan ver.
 * Lo que ya fijan otras pruebas: responsables desde Central (FB_2026_015, `qa.spec.ts`) y «Staff: VG» en Proyectos
 * (FB_2026_036/040, `bloque1.spec.ts`).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { fichaBloque, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, filteredTasks: any, project: any, openTaskEditor: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), RET = id(), PINTURA = id(), OTONO = id();
const ACCION = id(), FONT = id(), ACS = id(), FRIA = id(), ELEC = id(), CUADRO = id(), PINT = id();
const STAFF = id(), VG = id(), AN = id(), OUT = id(), MARTA = id(), RET_VG = id();
const T_GRIFO = id(), T_CUADRO = id(), T_PARED = id(), T_NADA = id(), T_RET = id();
let PERSON = '', RET_PERSON = '', PHASE = '', REPASO = '';

/** Hoy: etiquetas de la familia de responsables de cada área, renombrada «Grupo: Persona». En P2: fichas de Central con su nivel de casa. */
async function seedPeople(ok: (ops: any[]) => Promise<void>) {
  await server.app.t.db.query(`update tasks.families set name = 'Grupo: Persona' where id = any($1)`, [[PERSON, RET_PERSON]]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: STAFF, fields: { tab_id: MANT, family_id: PERSON, name: 'Staff', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: OUT, fields: { tab_id: MANT, family_id: PERSON, name: 'Outsiders', position: 2048 } },
    // La misma persona, copiada en otra área (como en producción antes de P2).
    { op: 'insert', table: 'tasks.labels', id: RET_VG, fields: { tab_id: RET, family_id: RET_PERSON, name: 'VG', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: MANT, family_id: PERSON, parent_id: STAFF, name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: AN, fields: { tab_id: MANT, family_id: PERSON, parent_id: STAFF, name: 'AN', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: MARTA, fields: { tab_id: MANT, family_id: PERSON, parent_id: OUT, name: 'Marta', position: 1024 } },
  ]);
}
/** Hoy: la familia General «Tipo: Acción». En P2: el árbol de oficios de Central (`trade_options`). */
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
    { op: 'insert', table: 'tasks.tasks', id: T_RET, fields: { tab_id: RET, project_id: OTONO, title: 'Purgar el agua fría', position: 1024, owner_label_id: RET_VG } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: PINTURA, label_id: STAFF } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: PINTURA, label_id: VG } },
  ]);
  await ok([
    // La fase va antes en la lista de la tarea; las chips salen en el orden de las familias.
    tl(MANT, PINTURA, T_GRIFO, REPASO), tl(MANT, PINTURA, T_GRIFO, ACS), tl(MANT, PINTURA, T_GRIFO, FONT), tl(MANT, PINTURA, T_GRIFO, VG), tl(MANT, PINTURA, T_GRIFO, STAFF),
    tl(MANT, PINTURA, T_CUADRO, ELEC), tl(MANT, PINTURA, T_CUADRO, CUADRO), tl(MANT, PINTURA, T_CUADRO, OUT), tl(MANT, PINTURA, T_CUADRO, MARTA),
    // Solo la hija, sin la madre guardada (como quedará una persona en P2).
    tl(MANT, PINTURA, T_PARED, PINT), tl(MANT, PINTURA, T_PARED, AN),
    tl(RET, OTONO, T_RET, FONT), tl(RET, OTONO, T_RET, FRIA), tl(RET, OTONO, T_RET, RET_VG),
  ]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

// --- Conductor: cómo se llega hoy a cada cosa (en P2 cambia esto, no lo que se espera) -------------------------------
const openProject = (tab: string, p: string) => page.evaluate(([t, pr]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = pr; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [tab, p]);
const shown = () => page.evaluate(() => filteredTasks(project()).map((t: any) => t.text).sort());
const option = (label: string) => page.locator(`.facet.open .facetpanel [data-facet-value="${label}"]`);
const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/p2-hoy/${name}.png` }).catch(() => {}); };
const serverLabels = async (task: string) => (await server.rows('tasks.task_labels')).filter((r) => r.task_id === task && !r.deleted_at).map((r) => r.label_id).sort();
const serverOwner = async (task: string) => (await server.rows('tasks.tasks')).find((r) => r.id === task)!.owner_label_id;

test('chips: «Staff: VG» y «Fontanería: ACS», sin madres sueltas y en el orden de las familias; y en la tarjeta del proyecto', async () => {
  await openProject(MANT, PINTURA);
  await expect(chipsOf(T_GRIFO)).toHaveText(['Fontanería: ACS', 'Staff: VG', 'Repaso']);
  // Cuadro y Marta son las únicas hijas de su madre: la chip dice solo la madre (FB_2026_021).
  await expect(chipsOf(T_CUADRO)).toHaveText(['Electricidad', 'Outsiders']);
  await expect(chipsOf(T_PARED)).toHaveText(['Pintura', 'Staff: AN']);
  await shot('1-tarjetas-de-tarea');
  await page.evaluate((t) => { state.activeTab = t; state.view = 'projects'; render(); }, MANT);
  // La tarjeta junta las etiquetas del proyecto y las de sus tareas, compactadas por madre.
  // Proyectos con portada (MUELA-041, tanda 31): la tarjeta lleva una fila de chips de espacio y oficio (decisión de Core hasta la n.º 7).
  await expect(page.locator(`.project:has([data-open-project="${PINTURA}"]) .chip`)).toHaveText(['Fontanería: ACS', 'Electricidad', 'Pintura']);
  await shot('2-tarjeta-de-proyecto');
});

test('filtro de persona: la madre (Staff), la hija sola y los tres estados', async () => {
  await openProject(MANT, PINTURA);
  await page.locator(`[data-facet="${PERSON}"]`).click();
  await expect(page.locator('.facet.open .facetpanel')).toContainText('Outsiders');
  await option(STAFF).click();
  // Hoy la madre solo encuentra las tareas que la guardan: «Pintar la pared» solo guarda AN (sin Staff) y no sale.
  // En P2 la madre incluirá a sus hijas (como los espacios en R2): es lo único que esta prueba cambiará, y a mejor.
  expect(await shown()).toEqual(['Cambiar el grifo del ACS']);
  await option(STAFF).click();
  expect(await shown()).toEqual(['Comprar material', 'Pintar la pared', 'Revisar el cuadro']);
  await option(STAFF).click();
  expect(await shown()).toEqual(['Cambiar el grifo del ACS', 'Comprar material', 'Pintar la pared', 'Revisar el cuadro']);
  await option(MARTA).click();
  expect(await shown()).toEqual(['Revisar el cuadro']);
  await shot('3-filtro-persona');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { state.filters = {}; render(); });
});

test('filtro de acción: la madre (Fontanería) y la hija sola', async () => {
  await openProject(MANT, PINTURA);
  await page.locator(`[data-facet="${ACCION}"]`).click();
  await option(FONT).click();
  expect(await shown()).toEqual(['Cambiar el grifo del ACS']);
  await option(FONT).click();
  expect(await shown()).toEqual(['Comprar material', 'Pintar la pared', 'Revisar el cuadro']);
  await option(FONT).click();
  await option(CUADRO).click();
  expect(await shown()).toEqual(['Revisar el cuadro']);
  await shot('4-filtro-accion');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { state.filters = {}; render(); });
});

test('agrupar por persona y por acción: cada tarea una sola vez, en el grupo de su hija', async () => {
  const sectionOf = (task: string) => page.locator('main section', { has: page.locator(`[data-toggle-task="${task}"]`) });
  await page.evaluate((g) => { state.view = 'tasks'; state.groupBy = g; state.filters = {}; render(); }, PERSON);
  await expect(sectionOf(T_GRIFO)).toHaveCount(1);
  await expect(sectionOf(T_GRIFO).locator('h2')).toContainText('Staff: VG');
  await expect(sectionOf(T_CUADRO).locator('h2')).toContainText('Outsiders: Marta');
  await shot('5-agrupar-por-persona');
  await page.evaluate((g) => { state.groupBy = g; render(); }, ACCION);
  await expect(sectionOf(T_GRIFO)).toHaveCount(1);
  await expect(sectionOf(T_GRIFO).locator('h2')).toContainText('Fontanería: ACS');
  await expect(sectionOf(T_PARED).locator('h2')).toContainText('Pintura');
  await shot('6-agrupar-por-accion');
  await page.evaluate(() => { state.groupBy = 'project'; render(); });
});

test('ficha: la acción se marca con la familia plegada; el «Responsable principal» lista las etiquetas Persona del área', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  await fichaBloque(page, 'quien'); // Ficha «Portada y foco» (tanda 31): responsable, oficio y personas en «Quién».
  // El responsable: una lista plana con todas las etiquetas Persona del área, madres incluidas («Staff» se puede elegir
  // como responsable), sin las de otras áreas y sin agrupar por madre (el orden sigue la posición y no es estable).
  const owners = await page.locator('#teOwner option').allTextContents();
  expect(owners[0]).toBe('Sin asignar');
  expect(owners.slice(1).sort()).toEqual(['AN', 'Marta', 'Outsiders', 'Staff', 'VG']);
  await shot('7-ficha-cerrada');
  await fichaBloque(page, 'etiquetas');
  const chip = page.locator(`#sheet [data-inline-label="${ACS}"]`);
  if (!(await chip.isVisible())) await page.locator('#sheet details:has([data-inline-label="' + ACS + '"]) > summary').click();
  await chip.click();
  await expect(chip).toHaveClass(/on/);
  await fichaBloque(page, 'quien');
  await page.locator('#teOwner').selectOption(MARTA);
  await shot('8-ficha-accion-y-responsable');
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  expect(await serverLabels(T_NADA)).toEqual([FONT, ACS].sort());
  // El responsable principal no es una etiqueta de la tarea: no sale como chip.
  expect(await serverOwner(T_NADA)).toBe(MARTA);
  await expect(chipsOf(T_NADA)).toHaveText(['Fontanería: ACS']);
});

test('selección múltiple: «Etiquetas» › persona › Aplicar, a varias tareas a la vez', async () => {
  await openProject(MANT, PINTURA);
  await page.locator('#batchToggle').click();
  for (const t of [T_PARED, T_NADA]) await page.locator(`[data-select="${t}"]`).click();
  await page.locator('#batchLabels').click();
  await page.locator(`#sheet [data-pick-mother="${STAFF}"]`).click();
  await page.locator(`#sheet [data-pick-kid="${VG}"]`).click();
  await shot('9-lote-elegir-persona');
  await page.locator('#labelsDone').click();
  await settled(page);
  expect(await serverLabels(T_PARED)).toEqual([AN, PINT, STAFF, VG].sort());
  expect(await serverLabels(T_NADA)).toEqual([ACS, FONT, STAFF, VG].sort());
  // Con todas las hijas de la madre, la chip dice solo la madre (FB_2026_021).
  await expect(chipsOf(T_PARED)).toHaveText(['Pintura', 'Staff']);
  // El lote no toca el responsable principal.
  expect(await serverOwner(T_NADA)).toBe(MARTA);
  if (await page.locator('#batchCancel').count()) await page.locator('#batchCancel').click();
});

test('arrastre: reordenar con el asa no toca personas, acciones ni responsable', async () => {
  await openProject(MANT, PINTURA);
  const before = await serverLabels(T_CUADRO);
  // Con la portada y «Lo que toca ahora» arriba (tanda 31), la lista empieza más abajo: se lleva a la vista antes de arrastrar.
  await page.locator(`.task:has([data-toggle-task="${T_GRIFO}"])`).scrollIntoViewIfNeeded();
  const from = (await page.locator(`.task:has([data-toggle-task="${T_CUADRO}"]) [data-drag]`).boundingBox())!;
  const to = (await page.locator(`.task:has([data-toggle-task="${T_GRIFO}"])`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
  await settled(page);
  const order = (await server.rows('tasks.tasks')).filter((t) => t.project_id === PINTURA && !t.deleted_at).sort((a, b) => a.position - b.position).map((t) => t.title);
  expect(order[0]).toBe('Revisar el cuadro');
  expect(await serverLabels(T_CUADRO)).toEqual(before);
  expect(await serverOwner(T_CUADRO)).toBe(MARTA);
  await expect(chipsOf(T_CUADRO)).toHaveText(['Electricidad', 'Outsiders']);
});

test('General frente a un área: la acción es una sola en todas las áreas; la persona es una etiqueta por área', async () => {
  await openProject(RET, OTONO);
  await expect(chipsOf(T_RET)).toHaveText(['Fontanería: Agua fría', 'VG']);
  await page.evaluate((t) => openTaskEditor(t), T_RET);
  await fichaBloque(page, 'quien'); // Ficha «Portada y foco» (tanda 31): responsable, oficio y personas en «Quién».
  // En Retiros, el responsable solo ofrece su propia copia de VG.
  expect(await page.locator('#teOwner option').allTextContents()).toEqual(['Sin asignar', 'VG']);
  await page.evaluate(() => (window as any).closeSheet?.());
  await page.evaluate(() => { state.taskScope = 'all'; state.view = 'tasks'; state.groupBy = 'project'; state.search = ''; render(); });
  const titles = () => page.evaluate(() => [...document.querySelectorAll('main .task[data-row] .tasktext')].map((n) => n.textContent!.trim()).sort());
  await page.evaluate(([f, l]) => { state.filters = { [f as string]: [l] }; render(); }, [ACCION, FONT]);
  await expect.poll(titles).toEqual(['Cambiar el grifo del ACS', 'Comprar material', 'Purgar el agua fría']);
  await page.evaluate(() => { state.taskScope = 'area'; state.filters = {}; render(); });
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
