/**
 * Ikisai Tasks · R2, PR 2b: la caracterización de `zonas.spec.ts` pasada en modo espacios. Misma siembra de zonas, más los
 * espacios de Recursos con su `source_refs` (como en producción), y la ida real (`zones/to-spaces`) antes de abrir la app.
 * Se espera lo mismo que hoy salvo lo que decidió el usuario: la chip dice «Albergue › Hab 3» y hay una chip por espacio
 * (sin juntar en la madre). Además: buscar por espacio, la herencia del espacio del proyecto y la pantalla «Espacios».
 * Las capturas («después») van a `coordinacion/tasks/r2-despues/`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { fichaBloque, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, filteredTasks: any, project: any, openTaskEditor: any, navigateView: any, startInlineNew: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), RET = id(), MEJ = id(), PINTURA = id(), SALAS_P = id(), OTONO = id();
const ZONA = id(), ALBERGUE = id(), SALAS = id(), HAB3 = id(), BANO = id(), ROBLE = id(), PINO = id(), MEJ_ZONA = id(), MEJ_ALB = id();
const S_ALB = id(), S_SALAS = id(), S_HAB3 = id(), S_BANO = id(), S_ROBLE = id(), S_PINO = id();
const T_HAB = id(), T_ALB = id(), T_ROBLE = id(), T_NADA = id(), T_RET = id(), T_SOLO = id();
let VG = '', PHASE = '', seq = 0;

/** Las zonas de hoy (etiquetas General) y sus espacios de Recursos, que nombran la etiqueta de la que vienen. */
async function seedZones(ok: (ops: any[]) => Promise<void>) {
  await ok([{ op: 'insert', table: 'tasks.families', id: ZONA, fields: { tab_id: null, name: 'Zona: Espacio', color: '#9c744e', position: 1 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: ALBERGUE, fields: { tab_id: null, family_id: ZONA, name: 'Albergue', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: SALAS, fields: { tab_id: null, family_id: ZONA, name: 'Salas', position: 2048 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: HAB3, fields: { tab_id: null, family_id: ZONA, parent_id: ALBERGUE, name: 'Hab 3', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: BANO, fields: { tab_id: null, family_id: ZONA, parent_id: ALBERGUE, name: 'Baño Hombres', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: ROBLE, fields: { tab_id: null, family_id: ZONA, parent_id: SALAS, name: 'Sala Roble', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: PINO, fields: { tab_id: null, family_id: ZONA, parent_id: SALAS, name: 'Sala Pino', position: 2048 } },
  ]);
  await ok([{ op: 'insert', table: 'tasks.families', id: MEJ_ZONA, fields: { tab_id: MEJ, name: 'Zona: Espacio', color: '#9c744e', position: 50 } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: MEJ_ALB, fields: { tab_id: MEJ, family_id: MEJ_ZONA, name: 'Albergue viejo', position: 1024, archived: true } }]);
}
async function seedSpaces() {
  const altura = (await server.app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  const space = (sid: string, parent: string, kind: string, name: string, label: string, position = 1024) =>
    ({ op: 'insert', table: 'resources.spaces', id: sid, fields: { parent_id: parent, kind, name, position, source_refs: [`tasks.label:${label}`] } });
  const resources = async (operations: unknown[]) => {
    const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${++seq}`, operations } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  };
  await resources([space(S_ALB, altura, 'edificio', 'Albergue', ALBERGUE, 1024), space(S_SALAS, altura, 'edificio', 'Salas', SALAS, 2048)]);
  await resources([space(S_HAB3, S_ALB, 'habitacion', 'Hab 3', HAB3, 1024), space(S_BANO, S_ALB, 'bano', 'Baño Hombres', BANO, 2048),
    space(S_ROBLE, S_SALAS, 'sala', 'Sala Roble', ROBLE, 1024), space(S_PINO, S_SALAS, 'sala', 'Sala Pino', PINO, 2048)]);
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
  const fam = (k: string) => mant.find((o) => o.fields?.system_key === k)!.id!;
  PHASE = fam('phase');
  await ok(mant);
  await ok(createTabOps({ id: RET, name: 'Retiros', position: 91_000 }));
  await ok(createTabOps({ id: MEJ, name: 'Mejoras', position: 92_000 }));
  await seedZones(ok);
  VG = id();
  const REPASO = id();
  await ok([
    { op: 'insert', table: 'tasks.projects', id: PINTURA, fields: { tab_id: MANT, title: 'Pintura', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: SALAS_P, fields: { tab_id: MANT, title: 'Salas', position: 3072 } },
    { op: 'insert', table: 'tasks.projects', id: OTONO, fields: { tab_id: RET, title: 'Retiro de otoño', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: VG, fields: { tab_id: MANT, family_id: fam('person'), name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: REPASO, fields: { tab_id: MANT, family_id: PHASE, name: 'Repaso', position: 1024 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_HAB, fields: { tab_id: MANT, project_id: PINTURA, title: 'Pintar Hab 3', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_ALB, fields: { tab_id: MANT, project_id: PINTURA, title: 'Revisar el albergue', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: T_ROBLE, fields: { tab_id: MANT, project_id: PINTURA, title: 'Pintar Sala Roble', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: T_NADA, fields: { tab_id: MANT, project_id: PINTURA, title: 'Comprar pintura', position: 4096 } },
    { op: 'insert', table: 'tasks.tasks', id: T_RET, fields: { tab_id: RET, project_id: OTONO, title: 'Preparar el baño', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_SOLO, fields: { tab_id: RET, project_id: OTONO, title: 'Arreglar la ventana', position: 2048 } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: SALAS_P, label_id: SALAS } },
    { op: 'insert', table: 'tasks.project_labels', id: id(), fields: { tab_id: MANT, project_id: SALAS_P, label_id: ROBLE } },
  ]);
  await ok([
    tl(MANT, PINTURA, T_HAB, REPASO), tl(MANT, PINTURA, T_HAB, HAB3), tl(MANT, PINTURA, T_HAB, ALBERGUE), tl(MANT, PINTURA, T_HAB, VG),
    tl(MANT, PINTURA, T_ALB, ALBERGUE),
    tl(MANT, PINTURA, T_ROBLE, SALAS), tl(MANT, PINTURA, T_ROBLE, ROBLE),
    tl(RET, OTONO, T_RET, ALBERGUE), tl(RET, OTONO, T_RET, BANO),
    tl(RET, OTONO, T_SOLO, HAB3),
  ]);
  await seedSpaces();
  // La ida real, como la hará el botón de la PR 3.
  const done = await server.app.call('/api/v1/zones/to-spaces', { body: { requestId: `zr-${++seq}` } });
  expect(done.status, JSON.stringify(done.data)).toBe(200);
  expect(done.data.source).toBe('spaces');
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
  await expect.poll(() => page.evaluate(() => (window as any).eval('Sync.core.zoneSource()+":"+Sync.core.spaces.length'))).toMatch(/^spaces:([6-9]|\d\d)/);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

// --- Conductor en modo espacios ---------------------------------------------------------------------------------------
const openProject = (tab: string, p: string) => page.evaluate(([t, pr]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = pr; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [tab, p]);
const shown = () => page.evaluate(() => filteredTasks(project()).map((t: any) => t.text).sort());
const zoneOption = (space: string) => page.locator(`.facet.open .facetpanel [data-facet-value="${space}"]`);
const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/r2-despues/${name}.png` }).catch(() => {}); };
const serverSpaces = async (task: string) => (await server.rows('tasks.task_spaces')).filter((r) => r.task_id === task && !r.deleted_at).map((r) => r.space_id).sort();
const quick = (name: string) => page.locator('#sheet .space-quick-chip', { hasText: new RegExp(`^${name}$`) });

test('chips: «Albergue › Hab 3» en el sitio de la zona, una por espacio; y en la tarjeta del proyecto', async () => {
  await openProject(MANT, PINTURA);
  await expect(chipsOf(T_HAB)).toHaveText(['Albergue › Hab 3', 'VG', 'Repaso']);
  await expect(chipsOf(T_ALB)).toHaveText(['Albergue']);
  await shot('1-tarjetas-de-tarea');
  await page.evaluate((t) => { state.activeTab = t; state.view = 'projects'; render(); }, MANT);
  await expect(page.locator(`.project:has([data-open-project="${SALAS_P}"]) .chip`)).toHaveText(['Salas › Sala Roble']);
  await shot('2-tarjeta-de-proyecto');
});

test('filtro: la madre incluye lo de dentro; la hija sola; y los tres estados', async () => {
  await openProject(MANT, PINTURA);
  await page.locator('[data-facet="_space"]').click();
  await expect(page.locator('.facet.open .facetpanel')).toContainText('Albergue');
  await expect(page.locator('.facet.open .facetpanel')).not.toContainText('Albergue viejo');
  await zoneOption(S_ALB).click();
  expect(await shown()).toEqual(['Pintar Hab 3', 'Revisar el albergue']);
  await zoneOption(S_ALB).click();
  await expect(zoneOption(S_ALB)).toHaveClass(/excluded/);
  expect(await shown()).toEqual(['Comprar pintura', 'Pintar Sala Roble']);
  await zoneOption(S_ALB).click();
  expect(await shown()).toEqual(['Comprar pintura', 'Pintar Hab 3', 'Pintar Sala Roble', 'Revisar el albergue']);
  await shot('3-filtro-espacio');
  await zoneOption(S_HAB3).click();
  expect(await shown()).toEqual(['Pintar Hab 3']);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { state.filters = {}; render(); });
});

test('buscar: el nombre del espacio encuentra sus tareas', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate(() => { state.search = 'hab 3'; render(); });
  expect(await shown()).toEqual(['Pintar Hab 3']);
  await page.evaluate(() => { state.search = 'albergue'; render(); });
  expect(await shown()).toEqual(['Pintar Hab 3', 'Revisar el albergue']);
  await page.evaluate(() => { state.search = ''; render(); });
});

test('agrupar por espacio: cada tarea una sola vez, en el grupo de su espacio', async () => {
  await page.evaluate(() => { state.view = 'tasks'; state.groupBy = '_space'; state.filters = {}; render(); });
  await expect(page.locator('#groupBy option[value="_space"]')).toHaveCount(1);
  const sectionOf = (task: string) => page.locator('main section', { has: page.locator(`[data-toggle-task="${task}"]`) });
  await expect(sectionOf(T_HAB)).toHaveCount(1);
  await expect(sectionOf(T_HAB).locator('h2')).toContainText('Albergue › Hab 3');
  await expect(sectionOf(T_ALB)).toHaveCount(1);
  await expect(sectionOf(T_ALB).locator('h2')).toContainText('Albergue');
  await expect(sectionOf(T_ROBLE).locator('h2')).toContainText('Salas › Sala Roble');
  await shot('4-agrupar-por-espacio');
  await page.evaluate(() => { state.groupBy = 'project'; render(); });
});

test('ficha: el espacio se marca de un toque (los más usados)', async () => {
  await openProject(MANT, PINTURA);
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  // Ficha «Portada y foco» (tanda 31): el Espacio va en la baldosa «Etiquetas».
  await fichaBloque(page, 'etiquetas');
  await shot('5-ficha-cerrada');
  await quick('Hab 3').click();
  await expect(quick('Hab 3')).toHaveClass(/on/);
  await shot('6-ficha-espacio-marcado');
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  expect(await serverSpaces(T_NADA)).toEqual([S_HAB3]);
  await expect(chipsOf(T_NADA)).toHaveText(['Albergue › Hab 3']);
});

test('selección múltiple: «Espacio» › el espacio › Aplicar, a varias tareas a la vez', async () => {
  await openProject(MANT, PINTURA);
  await page.locator('#batchToggle').click();
  for (const t of [T_ALB, T_NADA]) await page.locator(`[data-select="${t}"]`).click();
  await page.locator('#batchSpace').click();
  await quick('Baño Hombres').click();
  await shot('7-lote-elegir-espacio');
  await page.locator('#batchSpaceDone').click();
  await settled(page);
  // «Albergue» deja paso a «Baño Hombres», que está dentro; «Hab 3» se queda (una chip por espacio).
  expect(await serverSpaces(T_ALB)).toEqual([S_BANO]);
  expect(await serverSpaces(T_NADA)).toEqual([S_HAB3, S_BANO].sort());
  await expect(chipsOf(T_NADA)).toHaveText(['Albergue › Hab 3', 'Albergue › Baño Hombres']);
  await expect(chipsOf(T_ALB)).toHaveText(['Albergue › Baño Hombres']);
  if (await page.locator('#batchCancel').count()) await page.locator('#batchCancel').click();
});

test('arrastre: reordenar con el asa no toca los espacios de la tarea', async () => {
  await openProject(MANT, PINTURA);
  const before = await serverSpaces(T_ROBLE);
  expect(before).toEqual([S_ROBLE]);
  // Con la portada y «Lo que toca ahora» arriba (tanda 31), la lista empieza más abajo: se lleva a la vista antes de arrastrar.
  await page.locator(`.task:has([data-toggle-task="${T_HAB}"])`).scrollIntoViewIfNeeded();
  const from = (await page.locator(`.task:has([data-toggle-task="${T_ROBLE}"]) [data-drag]`).boundingBox())!;
  const to = (await page.locator(`.task:has([data-toggle-task="${T_HAB}"])`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
  await settled(page);
  const order = (await server.rows('tasks.tasks')).filter((t) => t.project_id === PINTURA && !t.deleted_at).sort((a, b) => a.position - b.position).map((t) => t.title);
  expect(order[0]).toBe('Pintar Sala Roble');
  expect(await serverSpaces(T_ROBLE)).toEqual(before);
  await expect(chipsOf(T_ROBLE)).toHaveText(['Salas › Sala Roble']);
});

test('herencia: las tareas nuevas de un proyecto con espacio lo llevan (ficha y alta en línea)', async () => {
  await openProject(MANT, SALAS_P);
  await page.evaluate(() => openTaskEditor(null));
  await expect(page.locator('#sheet .space-picked .chip')).toHaveText(['Salas › Sala Roble']);
  await page.locator('#teText').fill('Barnizar el suelo');
  await page.locator('#saveTaskBtn').click();
  await page.evaluate((p) => startInlineNew(p), SALAS_P);
  await page.locator('.newinput').fill('Cambiar bombillas');
  await page.locator('.newinput').press('Enter');
  await settled(page);
  const tasks = (await server.rows('tasks.tasks')).filter((t) => t.project_id === SALAS_P && !t.deleted_at);
  for (const title of ['Barnizar el suelo', 'Cambiar bombillas']) {
    const task = tasks.find((t) => t.title === title);
    expect(task, title).toBeTruthy();
    expect(await serverSpaces(task.id), title).toEqual([S_ROBLE]);
  }
});

test('General frente a un área: el espacio vale en todas las áreas y en la vista General junta las dos', async () => {
  await openProject(RET, OTONO);
  await expect(chipsOf(T_RET)).toHaveText(['Albergue › Baño Hombres']);
  await expect(page.locator('[data-facet="_space"]')).toHaveCount(1);
  await page.evaluate(() => { state.taskScope = 'all'; state.view = 'tasks'; state.groupBy = 'project'; state.filters = {}; state.search = ''; render(); });
  await page.evaluate((s) => { state.filters = { _space: [s] }; render(); }, S_BANO);
  const titles = () => page.evaluate(() => [...document.querySelectorAll('main .task[data-row] .tasktext')].map((n) => n.textContent!.trim()).sort());
  await expect.poll(titles).toEqual(['Comprar pintura', 'Preparar el baño', 'Revisar el albergue']);
  await page.evaluate((s) => { state.filters = { _space: [s] }; render(); }, S_ALB);
  await expect.poll(titles).toEqual(['Arreglar la ventana', 'Comprar pintura', 'Pintar Hab 3', 'Preparar el baño', 'Revisar el albergue']);
  await page.evaluate(() => { state.taskScope = 'area'; state.filters = {}; render(); });
});

test('pantalla «Espacios»: el árbol común, desde el menú', async () => {
  await page.evaluate(() => navigateView('spaces'));
  await expect(page.locator('#spacesTree')).toContainText('Albergue');
  await expect(page.locator('#spacesTree')).toContainText('Salas');
  await shot('8-pantalla-espacios');
  await page.evaluate(() => navigateView('projects'));
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

/** Tareas abiertas que llevan alguno de estos espacios, contadas aparte con lo que hay en el dispositivo. */
const openIn = (spaces: string[]) => page.evaluate((ids) => {
  let open = 0;
  for (const a of state.tabs) for (const p of a.projects) if (!p.deleted && p.status !== 'archived') for (const t of p.tasks) if (!t.deleted && !t.done && (t.spaces || []).some((x: string) => ids.includes(x))) open += 1;
  return open;
}, spaces);
const t31 = async (name: string, fullPage = false) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/t31-capturas/${name}.png`, fullPage }).catch(() => {}); };

test('Espacios (MUELA-090): «Plano | Lista»; el plano del kit con la capa «Tareas abiertas», sin gestos de edición; cada estancia se toca y con el teclado; lo que no tiene dibujo, en filas; la hoja y «Ver en Tareas»; y se recuerda la vista', async () => {
  // El dibujo del Albergue (sin imagen: la capa va sobre papel) con Hab 3 y Baño Hombres colocados, como lo deja Central.
  const PLAN = id();
  const resources = async (operations: unknown[]) => {
    const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${++seq}`, operations } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  };
  const rev = async (sid: string) => Number((await server.app.t.db.query<{ revision: string }>(`select revision from resources.spaces where id = $1`, [sid])).rows[0]!.revision);
  await resources([{ op: 'insert', table: 'resources.floor_plans', id: PLAN, fields: { building_id: S_ALB, floor: 'Planta baja', position: 0, width: 1000, height: 700 } }]);
  await resources([
    { op: 'update', table: 'resources.spaces', id: S_HAB3, expectedRevision: await rev(S_HAB3), fields: { plan_id: PLAN, plan_shape: { points: [[0.05, 0.08], [0.45, 0.08], [0.45, 0.9], [0.05, 0.9]] } } },
    { op: 'update', table: 'resources.spaces', id: S_BANO, expectedRevision: await rev(S_BANO), fields: { plan_id: PLAN, plan_shape: { points: [[0.55, 0.08], [0.95, 0.08], [0.95, 0.9], [0.55, 0.9]] } } },
  ]);
  // Una tarea que solo dice «Albergue» (las de antes ya pueden haber pasado a una estancia en las pruebas de arriba).
  const T_ALB2 = id();
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok([{ op: 'insert', table: 'tasks.tasks', id: T_ALB2, fields: { tab_id: MANT, project_id: PINTURA, title: 'Revisar el tejado del albergue', position: 9216 } }]);
  await ok([{ op: 'insert', table: 'tasks.task_spaces', id: id(), fields: { tab_id: MANT, project_id: PINTURA, task_id: T_ALB2, space_id: S_ALB } }]);
  await page.evaluate(() => (window as any).eval('Promise.all([Sync.core.resources.sync(), syncNow()])'));
  await settled(page);
  await page.evaluate(() => { localStorage.removeItem('ikisai-tasks-spaces-view'); navigateView('spaces'); });

  // «Plano» por defecto (hay dibujo); dos chips de 46 px con aria-pressed; el árbol, oculto.
  const plan = page.locator('[data-tko-view="plan"]'), list = page.locator('[data-tko-view="list"]');
  await expect(page.locator('[data-tko-view]')).toHaveText(['Plano', 'Lista']);
  await expect(plan).toHaveAttribute('aria-pressed', 'true');
  for (const chip of [plan, list]) expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(46);
  await expect(page.locator('#spacesTree')).toBeHidden();
  await expect(page.locator('#tkoLegend')).toContainText('tareas abiertas');
  // La pieza del kit en «solo plano» (kit 0.55): sin conmutador ni lista propios (la lista es el árbol), y todos los dibujos a la vez.
  await expect(page.locator('#tkoSpacesMap .map-view, #tkoSpacesMap .map-plans')).toHaveCount(0);
  await expect(page.locator('#tkoSpacesMap .map-list')).toBeHidden();
  await expect(page.locator('#tkoSpacesMap .map-figcap')).toHaveText(['Albergue · Planta baja']);

  // Cada estancia es un botón con la capa en su nombre accesible.
  const hab = page.locator(`#tkoSpacesMap polygon.map-shape[data-space-id="${S_HAB3}"]`);
  const habOpen = await openIn([S_HAB3]);
  expect(habOpen).toBeGreaterThan(0);
  await expect(hab).toHaveAttribute('role', 'button');
  // El nombre accesible lleva la frase de la capa; en el dibujo, solo la cifra (`short`).
  await expect(hab).toHaveAttribute('aria-label', new RegExp(`^Hab 3 · ${habOpen} tareas? abiertas?(, \\d+ vencidas?)?$`));
  await expect(page.locator('#tkoSpacesMap .map-room-short')).toContainText([String(habOpen)]);
  await expect(page.locator('#tkoSpacesMap .map-labels')).not.toContainText('abierta');
  // Sin ningún gesto de edición: ni «Colocar» ni nada que se arrastre.
  await expect(page.locator('#tkoPlan')).not.toContainText('Colocar');
  await expect(page.locator('#tkoPlan [draggable="true"], #tkoPlan .map-handle')).toHaveCount(0);

  // Lo que tiene tareas y no sale en ningún dibujo, en filas: el Albergue (con lo de dentro) y la Sala Roble.
  const albOpen = await openIn([S_ALB, S_HAB3, S_BANO]);
  const albRow = page.locator(`.tko-offplan [data-tko-space="${S_ALB}"]`);
  await expect(page.locator('#tkoOffPlanTitle')).toHaveText('Sin dibujo en el plano');
  await expect(albRow).toHaveAttribute('aria-label', new RegExp(`^Albergue: ${albOpen} tareas? abiertas?`));
  await expect(page.locator(`.tko-offplan [data-tko-space="${S_ROBLE}"]`)).toContainText('Sala Roble');
  await expect(page.locator(`.tko-offplan [data-tko-space="${S_HAB3}"]`)).toHaveCount(0);
  await t31('zona4-espacios-plano', true);

  // Tocar la estancia abre su hoja: nombre, ruta y tipo; sus tareas abiertas; «Ver en Tareas (N)».
  await hab.click();
  await expect(page.locator('#sheet .sheettitle')).toHaveText('Hab 3');
  await expect(page.locator('#sheet .subtitle')).toHaveText(/^Albergue › Hab 3 · /);
  await expect(page.locator('#sheet [data-tko-task]')).toHaveCount(habOpen);
  await expect(page.locator('#tkoSpaceTasks')).toHaveText(`Ver en Tareas (${habOpen})`);
  await expect(page.locator('#sheet')).not.toContainText(/Aprende|Sabe hacerlo|Experto|disponib/i);
  await t31('zona4-espacios-hoja');
  await page.locator('#tkoSpaceClose').click();
  // Con el teclado: Intro sobre la estancia.
  await hab.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sheet .sheettitle')).toHaveText('Hab 3');
  // Cada tarea de la hoja abre su ficha.
  await page.locator('#sheet [data-tko-task]').first().click();
  await expect(page.locator('#saveTaskBtn')).toBeVisible();
  await page.evaluate(() => (window as any).eval('closeSheet()'));

  // La fila del Albergue: «Ver en Tareas» filtra por el espacio (con lo de dentro) y «‹ Volver a Espacios» vuelve.
  await albRow.click();
  await expect(page.locator('#sheet [data-tko-task]')).toHaveCount(albOpen);
  await page.locator('#tkoSpaceTasks').click();
  await expect.poll(() => page.evaluate(() => [state.view, state.taskScope, JSON.stringify(state.filters)].join('|'))).toBe(`tasks|all|{"_space":["${S_ALB}"]}`);
  await expect(page.locator('#tkoBack')).toHaveText('‹ Volver a Espacios');
  await expect(page.locator('main')).toContainText('Pintar Hab 3');
  await page.locator('#tkoBack').click();
  await expect.poll(() => page.evaluate(() => [state.view, JSON.stringify(state.filters)].join('|'))).toBe('spaces|{}');

  // «Lista» oculta el plano y enseña el árbol de hoy; se recuerda en el dispositivo.
  await list.click();
  await expect(list).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#tkoPlan')).toBeHidden();
  await expect(page.locator('#spacesTree')).toBeVisible();
  await expect(page.locator('#spacesTree')).toContainText('Albergue');
  await t31('zona4-espacios-lista');
  expect(await page.evaluate(() => localStorage.getItem('ikisai-tasks-spaces-view'))).toBe('list');
  await page.evaluate(() => { navigateView('projects'); navigateView('spaces'); });
  await expect(page.locator('[data-tko-view="list"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#spacesTree')).toBeVisible();
  await page.locator('[data-tko-view="plan"]').click();
  await expect(page.locator('#tkoPlan')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ikisai-tasks-spaces-view'))).toBe('plan');
  await page.evaluate(() => navigateView('projects'));
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
