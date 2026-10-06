/**
 * Ikisai Tasks · escenarios de interfaz de `tests/integration.cjs` (repo antiguo) portados con los mismos gestos,
 * sobre la semilla de demostración original (`fixtures/demo.json`) y la `tasks-api` real en PGlite.
 * El número entre corchetes es el del escenario original (docs/tasks/API.md §11.1). `ID` traduce los ids antiguos
 * (`p1`, `t1`, `trade`…) a los uuid de la semilla, también dentro de la página.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { OWNER, READER, VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, routeStorage, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

// Globales de la interfaz heredada (scripts clásicos), visibles dentro de page.evaluate.
declare const Sync: any;
declare let state: any;
declare const tab: any, project: any, taskLocation: any, label: any, filteredProjects: any, navigateView: any, savedViewsSheet: any, keepImportSheet: any;
declare const openProjectEditor: any, openTaskEditor: any, dependencyBlockers: any, closeSheet: any, syncNow: any, render: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let a: Page, b: Page;
const errors: string[] = [];
const shared: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
  server = await startE2EServer();
  ID = await seedDemo(server);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  a = await openApp(contextA, server, { aliases: ID, errors });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  b = await openApp(contextB, server, { aliases: ID, errors });
});
test.afterAll(async () => {
  await contextA?.close(); await contextB?.close(); await server?.close();
});
test.afterEach(() => { expect(errors, 'errores de JavaScript en la página').toEqual([]); });

const serverRow = async (table: string, rowId: string) => (await server.rows(table)).find((r) => r.id === rowId);
const sync = async (page: Page) => { await page.evaluate(() => syncNow()); await settled(page); };

test('[1][2][3][4][5][6] arranque, filtros, alta por formulario, etiqueta desde el borrador, catálogo y menú', async () => {
  await test.step('[1] arranque con la semilla del servidor', async () => {
    await expect(a.locator(`[data-open-project="${ID.p1}"]`)).toHaveCount(1);
  });

  await test.step('[2] el botón de filtros lleva icono, recuento y nombre accesible, y abre la hoja', async () => {
    await a.evaluate(() => { state.filters = { _state: ['pending'], _availability: ['ready'] }; render(); });
    await expect(a.locator('#filterBtn svg')).toHaveCount(1);
    await expect(a.locator('#filterBtn .filter-count')).toHaveText('2');
    await expect(a.locator('#filterBtn')).toHaveAttribute('aria-label', 'Filtros · 2 activos');
    expect(await a.locator('#filterBtn').innerText()).not.toContain('☷');
    await a.locator('#filterBtn').click();
    await expect(a.locator('#sheet')).toContainText('Disponibilidad');
    await a.locator('#closeDialog').click();
    await a.evaluate(() => { state.filters = {}; render(); });
  });

  await test.step('[3] crear una tarea con el formulario la guarda por la API', async () => {
    await a.locator(`[data-open-project="${ID.p1}"]`).click();
    await a.locator('#quickAdd').click();
    await a.locator('#teText').fill('Integración online');
    await a.locator('#teNote').fill('Desde interfaz');
    await a.locator('#teOwner').selectOption(ID.vg!);
    await a.locator('#saveTaskBtn').click();
    await settled(a);
    shared.task = await a.evaluate(() => project().tasks.find((t: any) => t.text === 'Integración online').id);
    const row = await serverRow('tasks.tasks', shared.task!);
    expect([row.title, row.note, row.owner_label_id, row.project_id]).toEqual(['Integración online', 'Desde interfaz', ID.vg, ID.p1]);
  });

  await test.step('[4] crear una etiqueta desde el selector conserva el borrador y sincroniza etiqueta y tarea', async () => {
    await a.locator(`[data-edit-task="${shared.task}"]`).click();
    await a.locator('#teText').fill('Integración online');
    await a.locator('#teNote').fill('Borrador conservado al crear etiqueta');
    await a.locator('#editLabelsBtn').click();
    await a.locator(`[data-picker-new-label="${ID.trade}"]`).click();
    await a.locator('#nlText').fill('Etiqueta nueva de prueba');
    await a.locator('#saveNewLabel').click();
    await a.locator('#labelsDone').click();
    await expect(a.locator('#teNote')).toHaveValue('Borrador conservado al crear etiqueta');
    await a.evaluate(() => syncNow());
    await a.waitForFunction(() => !Sync.busy);
    await a.locator('#saveTaskBtn').click();
    await settled(a);
    shared.label = await a.evaluate(() => tab().labels.find((l: any) => l.text === 'Etiqueta nueva de prueba').id);
    expect(await a.evaluate(({ task, lab }) => taskLocation(task).t.labels.includes(lab), { task: shared.task!, lab: shared.label! })).toBe(true);
    expect((await server.rows('tasks.task_labels')).some((r) => r.task_id === shared.task && r.label_id === shared.label && !r.deleted_at)).toBe(true);
  });

  await test.step('[5] renombrar, archivar y reactivar una etiqueta conserva su id y sus referencias', async () => {
    await a.locator('[data-nav="labels"]').click();
    await a.locator(`[data-edit-label="${shared.label}"]`).click();
    await a.locator('#nlText').fill('Etiqueta renombrada');
    await a.locator('#saveNewLabel').click();
    await settled(a);
    expect(await a.evaluate(({ task, lab }) => taskLocation(task).t.labels.includes(lab), { task: shared.task!, lab: shared.label! })).toBe(true);
    expect((await serverRow('tasks.labels', shared.label!)).name).toBe('Etiqueta renombrada');
    await a.locator(`[data-edit-label="${shared.label}"]`).click();
    await a.locator('#archiveLabel').click();
    await settled(a);
    expect(await a.evaluate((lab) => label(lab).archived, shared.label!)).toBe(true);
    await a.locator(`[data-edit-label="${shared.label}"]`).click();
    await a.locator('#archiveLabel').click();
    await settled(a);
    expect(await a.evaluate((lab) => label(lab).archived, shared.label!)).toBe(false);
    expect((await serverRow('tasks.labels', shared.label!)).archived).toBe(false);
  });

  await test.step('[6] el menú móvil tiene cinco grupos e icono en cada acción', async () => {
    await a.locator('#moreBtn').click();
    await expect(a.locator('.menugroup')).toHaveCount(5);
    expect(await a.locator('.menuitem').count()).toBe(await a.locator('.menuitem .menuicon').count());
    await a.locator('#closeMenu').click();
    await expect(a.locator('#moreBtn')).toHaveAttribute('aria-expanded', 'false');
    await a.locator('[data-nav="projects"]').click();
    await a.locator(`[data-open-project="${ID.p1}"]`).click();
  });
});

test('[20][21][23][25] orden de proyectos, vistas guardadas, importación de Keep y recarga sin red', async () => {
  await test.step('[20] ordenar proyectos por menú y por arrastre se sincroniza entre dispositivos', async () => {
    await a.locator('[data-nav="projects"]').click();
    await a.locator(`[data-project-order="${ID.p2}"]`).click();
    await a.locator('#orderTarget').selectOption(ID.inbox!);
    await a.locator('#orderApply').click();
    await settled(a);
    await expect(a.locator('[data-drop-project]').first()).toHaveAttribute('data-drop-project', ID.p2!);
    const from = (await a.locator(`[data-project-drag="${ID.p1}"]`).boundingBox())!, to = (await a.locator(`[data-drop-project="${ID.p2}"]`).boundingBox())!;
    await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await a.mouse.down();
    await a.mouse.move(to.x + 30, to.y + 8, { steps: 10 });
    await a.mouse.up();
    await settled(a);
    await expect(a.locator('[data-drop-project]').first()).toHaveAttribute('data-drop-project', ID.p1!);
    await sync(b);
    await b.waitForFunction((id) => filteredProjects()[0].id === id, ID.p1, { timeout: 20_000 });
  });

  await test.step('[21] agrupar por familia y combinar filtros; la vista guardada se reabre en otro dispositivo', async () => {
    await a.locator('[data-nav="tasks"]').click();
    await a.locator('#groupBy').selectOption(ID.trade!);
    await expect(a.locator('#groupBy')).toHaveValue(ID.trade!);
    await a.locator('#filterBtn').click();
    await a.locator('[data-state-filter="pending"]').click();
    await a.locator(`[data-project-filter="${ID.p2}"]`).click();
    await a.locator('#applyFilterSheet').click();
    expect(await a.evaluate(() => filteredProjects().every((p: any) => p.id === (window as any).ID.p2))).toBe(true);
    await a.locator('#savedViews').click();
    await a.locator('#viewName').fill('Oficios pendientes · proyecto 2');
    await a.locator('#saveView').click();
    await settled(a);
    shared.view = await a.evaluate(() => tab().views.find((v: any) => v.name === 'Oficios pendientes · proyecto 2').id);
    const row = await serverRow('tasks.saved_views', shared.view!);
    expect([row.group_by, row.filters._project]).toEqual([ID.trade, [ID.p2]]);
    await sync(b);
    await b.evaluate(() => savedViewsSheet());
    await b.locator(`[data-load-view="${shared.view}"]`).click();
    await expect(b.locator('#groupBy')).toHaveValue(ID.trade!);
    expect(await b.evaluate(() => state.filters._project)).toEqual([ID.p2]);
  });

  await test.step('[23] importar texto de Keep: casillas, niveles aplanados y padre calculado', async () => {
    await a.evaluate(() => keepImportSheet());
    await a.locator('#keepTitle').fill('Importación Keep validada');
    await a.locator('#keepText').fill('[x] Puerta importada\n  [x] Medir marco\n    [ ] Montar herrajes\n[ ] Revisar ventana <img src=x>');
    await a.locator('#keepPreview').click();
    await expect(a.locator('#keepApply')).toBeEnabled();
    await a.locator('#keepApply').click();
    await settled(a);
    const imported = await a.evaluate(() => project());
    expect(imported.tasks.length).toBe(4);
    const byText = (text: string) => imported.tasks.find((t: any) => t.text === text);
    expect(byText('Montar herrajes').parentId).toBe(byText('Puerta importada').id);
    expect(byText('Puerta importada').done).toBe(false);
    await expect(a.locator('.tasklist img')).toHaveCount(0);
    await expect(a.locator('.task.child')).toHaveCount(2);
    expect((await server.rows('tasks.tasks')).filter((r) => r.project_id === imported.id)).toHaveLength(4);
  });

  await test.step('[25] shell, agrupación y vistas guardadas sobreviven a una recarga sin red', async () => {
    await a.locator('[data-nav="tasks"]').click();
    await a.locator('#groupBy').selectOption(ID.person!);
    expect(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await contextA.setOffline(true);
    await a.reload();
    await a.waitForFunction(() => typeof Sync !== 'undefined' && Sync.ready && Sync.actor && state.tabs.length > 0, null, { timeout: 20_000 });
    await expect(a.locator('#groupBy')).toHaveValue(ID.person!);
    expect(await a.evaluate((view) => tab().views.some((v: any) => v.id === view), shared.view!)).toBe(true);
    await contextA.setOffline(false);
    await sync(a);
  });
});

test('[38][39][40][41][42] escritorio, cambio a móvil y borradores frente a cambios remotos', async () => {
  await test.step('[38] escritorio: barra lateral visible, contenido a todo el ancho y diálogos arriba al centro', async () => {
    await b.setViewportSize({ width: 1440, height: 1000 });
    await b.evaluate(() => closeSheet());
    await b.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.filters = {}; navigateView('projects'); });
    await expect(b.locator('#kebab')).toBeVisible();
    await expect(b.locator('#moreBtn')).toBeHidden();
    await expect(b.locator('.bottomnav')).toBeHidden();
    const sidebar = (await b.locator('#kebab').boundingBox())!, content = (await b.locator('.screen').boundingBox())!;
    expect(content.width).toBeGreaterThan(1000);
    expect(content.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
    await b.locator('[data-menu-view="tasks"]').click();
    await expect(b.locator('#groupBy')).toHaveCount(1);
    await b.locator(`[data-edit-task="${ID.t1}"]`).first().click();
    const popup = (await b.locator('#sheet').boundingBox())!;
    expect(popup.y).toBeGreaterThanOrEqual(24); expect(popup.y).toBeLessThan(120);
    expect(Math.abs(popup.x + popup.width / 2 - 720)).toBeLessThan(2);
    await b.locator('#closeDialog').click();
    expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });

  await test.step('[39] al estrechar vuelven la navegación inferior y las hojas inferiores', async () => {
    await b.setViewportSize({ width: 390, height: 844 });
    await expect(b.locator('#kebab')).toBeHidden();
    await expect(b.locator('.bottomnav')).toBeVisible();
    await b.locator(`[data-edit-task="${ID.t1}"]`).first().click();
    const popup = (await b.locator('#sheet').boundingBox())!;
    expect(Math.abs(popup.y + popup.height - 844)).toBeLessThan(2);
    await b.locator('#closeDialog').click();
  });

  await test.step('[40] el borrador de un proyecto y una etiqueta nueva sobreviven a una sincronización antes de guardar', async () => {
    await b.evaluate(() => openProjectEditor((window as any).ID.p1));
    await b.locator('#peNote').fill('Borrador del proyecto con nueva etiqueta');
    await b.locator('#editProjectLabels').click();
    await b.locator(`[data-picker-new-label="${ID.trade}"]`).click();
    await b.locator('#nlText').fill('Etiqueta del proyecto');
    await b.locator('#saveNewLabel').click();
    await b.locator('#labelsDone').click();
    await expect(b.locator('#peNote')).toHaveValue('Borrador del proyecto con nueva etiqueta');
    await b.evaluate(() => syncNow());
    await b.waitForFunction(() => !Sync.busy);
    await b.locator('#saveProjectBtn').click();
    await settled(b);
    expect(await b.evaluate(() => tab().projects.find((p: any) => p.id === (window as any).ID.p1).note)).toBe('Borrador del proyecto con nueva etiqueta');
    const projectTag = await b.evaluate(() => tab().labels.find((l: any) => l.text === 'Etiqueta del proyecto').id);
    expect(await b.evaluate((tag) => tab().projects.find((p: any) => p.id === (window as any).ID.p1).ownLabels.includes(tag), projectTag)).toBe(true);
    expect((await server.rows('tasks.project_labels')).some((r) => r.project_id === ID.p1 && r.label_id === projectTag && !r.deleted_at)).toBe(true);
  });

  await test.step('[41] una edición remota del mismo campo mantiene el borrador abierto y no pisa el dato canónico', async () => {
    await b.evaluate(() => openTaskEditor((window as any).ID.t1));
    await b.locator('#teNote').fill('Mi borrador todavía abierto');
    const row = await serverRow('tasks.tasks', ID.t1!);
    expect((await server.commit([{ op: 'update', table: 'tasks.tasks', id: ID.t1, expectedRevision: row.revision, fields: { note: 'Nota concurrente del servidor' } }], server.app.tokens.editor)).status).toBe(200);
    await b.evaluate(() => syncNow());
    await b.waitForFunction(() => !Sync.busy && taskLocation((window as any).ID.t1).t.note === 'Nota concurrente del servidor');
    await b.locator('#saveTaskBtn').click();
    await expect(b.locator('#teNote')).toHaveValue('Mi borrador todavía abierto');
    expect(await b.evaluate(() => taskLocation((window as any).ID.t1).t.note)).toBe('Nota concurrente del servidor');
    expect(await b.evaluate(() => Sync.record.queue.length)).toBe(0);
    await b.locator('#closeDialog').click();
  });

  await test.step('[42] el editor abierto guarda solo lo cambiado y conserva una edición remota de otro campo', async () => {
    await b.evaluate(() => openTaskEditor((window as any).ID.t1));
    await b.locator('#teNote').fill('Nota combinada desde editor abierto');
    const row = await serverRow('tasks.tasks', ID.t1!);
    expect((await server.commit([{ op: 'update', table: 'tasks.tasks', id: ID.t1, expectedRevision: row.revision, fields: { priority: 'critical' } }], server.app.tokens.editor)).status).toBe(200);
    await b.evaluate(() => syncNow());
    await b.waitForFunction(() => !Sync.busy && taskLocation((window as any).ID.t1).t.priority === 'critical');
    await b.locator('#saveTaskBtn').click();
    await settled(b);
    const saved = await serverRow('tasks.tasks', ID.t1!);
    expect([saved.note, saved.priority]).toEqual(['Nota combinada desde editor abierto', 'critical']);
  });
});

test('[43][46][47][48][51] dependencias en los editores: bloqueo, herencia, disponibilidad y móvil', async () => {
  const createDependencyTask = async (text: string, projectId: string, parentId: string | null = null, dependsOn: string[] = []): Promise<string> => {
    await b.evaluate(({ projectId, parentId }) => { state.currentProject = projectId; openTaskEditor(null, null, { parentId }); }, { projectId, parentId });
    await b.locator('#teText').fill(text);
    if (dependsOn.length) {
      await b.locator('#dependencyPicker').evaluate((el: HTMLDetailsElement) => { el.open = true; });
      for (const dep of dependsOn) await b.locator(`[data-dependency="${dep}"]`).check();
    }
    await b.locator('#saveTaskBtn').click();
    await settled(b);
    return b.evaluate((t) => tab().projects.flatMap((p: any) => p.tasks).find((x: any) => x.text === t).id, text);
  };

  await test.step('[43] dependencias entre proyectos; completar una tarea bloqueada se rechaza en la interfaz y en la API', async () => {
    await b.setViewportSize({ width: 1440, height: 1000 });
    await b.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.filters = {}; state.search = ''; state.currentProject = (window as any).ID.p2; state.view = 'project'; render(); });
    shared.plaster = await createDependencyTask('Enfoscar pared MVP', ID.p2!);
    shared.paint = await createDependencyTask('Pintar pared MVP', ID.p1!, null, [shared.plaster]);
    expect(await b.evaluate((t) => taskLocation(t).t.dependsOn, shared.paint)).toEqual([shared.plaster]);
    await expect(b.locator(`[data-row="${shared.paint}"] .dependency-blocked`)).toContainText('Enfoscar pared MVP');
    await b.locator(`[data-toggle-task="${shared.paint}"]`).click();
    expect(await b.evaluate((t) => taskLocation(t).t.done, shared.paint)).toBe(false);
    expect(await b.evaluate(() => Sync.record.queue.length)).toBe(0);
    const row = await serverRow('tasks.tasks', shared.paint);
    const blocked = await server.commit([{ op: 'update', table: 'tasks.tasks', id: shared.paint, expectedRevision: row.revision, fields: { done: true } }], server.app.tokens.editor);
    expect([blocked.status, blocked.data.error.code]).toEqual([422, 'TASK_BLOCKED']);
    const dependency = (await server.rows('tasks.task_dependencies')).find((r) => r.task_id === shared.paint);
    expect([dependency.depends_on_id, dependency.project_id]).toEqual([shared.plaster, ID.p1]);
  });

  await test.step('[46] la selección de dependencias sobrevive al selector de etiquetas', async () => {
    await b.evaluate((t) => openTaskEditor(t), shared.paint!);
    await b.locator('#teNote').fill('Dependencia y borrador conservados');
    await b.locator('#editLabelsBtn').click();
    await b.locator('#labelsDone').click();
    await expect(b.locator(`[data-dependency="${shared.plaster}"]`)).toBeChecked();
    await b.locator('#saveTaskBtn').click();
    await settled(b);
    expect((await serverRow('tasks.tasks', shared.paint!)).note).toBe('Dependencia y borrador conservados');
  });

  await test.step('[47] «Disponibles» muestra las hijas que proceden y deja al padre de contexto sin acción', async () => {
    shared.group = await createDependencyTask('Grupo MVP', ID.p1!);
    shared.readyChild = await createDependencyTask('Hija disponible MVP', ID.p1!, shared.group);
    shared.blockedChild = await createDependencyTask('Hija bloqueada MVP', ID.p1!, shared.group, [shared.plaster!]);
    await b.evaluate(() => { state.filters = { _availability: ['ready'] }; render(); });
    await expect(b.locator(`[data-row="${shared.readyChild}"]`)).toHaveCount(1);
    await expect(b.locator(`[data-row="${shared.blockedChild}"]`)).toHaveCount(0);
    await expect(b.locator(`[data-toggle-task="${shared.group}"]`)).toBeDisabled();
  });

  await test.step('[48] las condiciones del padre se heredan y se explican en el editor de las hijas', async () => {
    await b.evaluate(() => { state.filters = {}; render(); });
    await b.evaluate((t) => openTaskEditor(t), shared.group!);
    await b.locator('#dependencyPicker').evaluate((el: HTMLDetailsElement) => { el.open = true; });
    await b.locator(`[data-dependency="${shared.plaster}"]`).check();
    await b.locator('#saveTaskBtn').click();
    await settled(b);
    expect(await b.evaluate((t) => dependencyBlockers(taskLocation(t).t, taskLocation(t).p).length > 0, shared.readyChild!)).toBe(true);
    await b.evaluate((t) => openTaskEditor(t), shared.readyChild!);
    await expect(b.locator('.dependency-field')).toContainText('Heredadas del padre');
    await b.locator('#closeDialog').click();
    // El servidor aplica la misma herencia.
    const row = await serverRow('tasks.tasks', shared.readyChild!);
    const inherited = await server.commit([{ op: 'update', table: 'tasks.tasks', id: shared.readyChild, expectedRevision: row.revision, fields: { done: true } }], server.app.tokens.editor);
    expect(inherited.data.error?.code).toBe('TASK_BLOCKED');
  });

  await test.step('[51] el selector de dependencias funciona en móvil sin desbordes', async () => {
    await b.setViewportSize({ width: 390, height: 844 });
    await b.evaluate((t) => openTaskEditor(t), shared.paint!);
    await expect(b.locator(`[data-dependency="${shared.plaster}"]`)).toBeChecked();
    expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await b.locator('#closeDialog').click();
  });
});

declare const importSheet: any, filterCount: any, setTheme: any, closeNavigation: any, manageTab: any, batchMode: any;

test('[52][53] copia JSON: remapea dependencias y etiquetas, y rechaza dependencias externas sin resolver', async () => {
  await a.evaluate(async () => { closeSheet(); await syncNow(); });
  await settled(a);
  const count = await a.evaluate(() => state.tabs.length);
  const fixture = { tabs: [{ id: 'json-source', name: 'JSON dependencias MVP', families: [{ id: 'trade', name: 'Oficio', color: '#b76b3d' }], labels: [{ id: 'same-id', text: 'Etiqueta con ID repetido', family: 'trade' }], projects: [
    { id: 'source-inbox', system: 'inbox', title: 'Entrada', status: 'active', ownLabels: [], tasks: [] },
    { id: 'source-project', title: 'Proyecto JSON', status: 'active', ownLabels: ['same-id'], tasks: [
      { id: 'same-id', text: 'Enfoscar JSON', labels: ['same-id'], parentId: null, order: 1024, done: false },
      { id: 'copy-paint', text: 'Pintar JSON', labels: [], parentId: null, order: 2048, done: false, dependsOn: ['same-id'] as string[] }] }] }] };
  await test.step('[52] la copia se importa como área independiente con ids nuevos y relaciones intactas', async () => {
    await a.evaluate(() => importSheet());
    await a.locator('#importFile').setInputFiles({ name: 'copia.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
    await a.waitForFunction(() => !(document.getElementById('confirmImport') as HTMLButtonElement).disabled);
    await a.locator('#confirmImport').click();
    await a.waitForFunction((n) => state.tabs.length === n + 1, count);
    await settled(a);
    const copy = await a.evaluate(() => state.tabs.find((t: any) => t.name === 'JSON dependencias MVP (importado)'));
    const tasks = copy.projects.flatMap((p: any) => p.tasks);
    const plaster = tasks.find((t: any) => t.text === 'Enfoscar JSON'), paint = tasks.find((t: any) => t.text === 'Pintar JSON');
    expect(paint.dependsOn).toEqual([plaster.id]);
    expect(plaster.id).not.toBe(copy.labels[0].id);
    expect(plaster.labels[0]).toBe(copy.labels[0].id);
    expect(copy.families[0].system).toBe('trade');
    const dependency = (await server.rows('tasks.task_dependencies')).find((r) => r.task_id === paint.id);
    expect(dependency.depends_on_id).toBe(plaster.id);
    expect((await server.rows('tasks.projects')).filter((r) => r.tab_id === copy.id && r.system === 'inbox')).toHaveLength(1);
  });
  await test.step('[53] una copia con dependencias externas se rechaza antes de tocar los datos locales', async () => {
    await a.evaluate(() => importSheet());
    fixture.tabs[0]!.projects[1]!.tasks[1]!.dependsOn = ['missing'];
    await a.locator('#importFile').setInputFiles({ name: 'incompleta.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
    await a.waitForFunction(() => !(document.getElementById('confirmImport') as HTMLButtonElement).disabled);
    await a.locator('#confirmImport').click();
    expect(await a.evaluate(() => state.tabs.length)).toBe(count + 1);
    expect(await a.evaluate(() => Sync.record.queue.length)).toBe(0);
    await a.locator('#closeDialog').click();
  });
});

test('[54][55] filtros con recuento en vivo y «Todas las tareas» entre áreas', async () => {
  await test.step('[54] la hoja de filtros cuenta en vivo y bloquea las etiquetas que dejarían cero tareas', async () => {
    await b.setViewportSize({ width: 1440, height: 1000 });
    await b.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.search = ''; navigateView('tasks'); });
    await b.locator('#filterBtn').click();
    await expect(b.locator('#filterCount')).toContainText('tareas en Ikisai');
    await b.locator(`[data-filter="${ID.person}|${ID.juan}"]`).click();
    const juanCount = await b.evaluate(() => filterCount(state.filters));
    expect(juanCount).toBeGreaterThan(0);
    expect((await b.locator('#filterCount').innerText()).startsWith(String(juanCount))).toBe(true);
    expect(await b.locator('.filterchip.unavailable').count()).toBeGreaterThan(0);
    await expect(b.locator('.filterchip.unavailable:not(:disabled)')).toHaveCount(0);
    await expect(b.locator('.filterchip:not(.unavailable):not(.on):disabled')).toHaveCount(0);
    expect(await b.locator(`[data-filter="${ID.person}|${ID.juan}"]`).evaluate((el: HTMLButtonElement) => el.classList.contains('on') && !el.disabled)).toBe(true);
    await b.locator('#applyFilterSheet').click();
    await expect(b.locator('.task:not(.context)')).toHaveCount(juanCount);
  });
  await test.step('[55] «Todas las tareas» abarca todas las áreas, filtra por etiquetas de otra área y abre su proyecto', async () => {
    await b.locator('#taskScope').selectOption('*');
    expect(await b.evaluate(() => state.taskScope)).toBe('all');
    expect(await b.locator('[data-area-block]').count()).toBe(await b.evaluate(() => state.tabs.filter((t: any) => !t.deleted).length));
    await b.locator('.activefilters .activechip').first().click();
    await b.locator('#filterBtn').click();
    await expect(b.locator('#filterCount')).toContainText('todas las áreas');
    await b.locator(`[data-filter="${ID['personal:building']}|${ID.casa}"]`).click();
    await b.locator('#applyFilterSheet').click();
    await expect(b.locator(`[data-area-block="${ID.personal}"] .task`)).toHaveCount(1);
    await expect(b.locator(`[data-area-block="${ID.ikisai}"] .task`)).toHaveCount(0);
    await b.locator(`[data-area-block="${ID.personal}"] [data-open-project="${ID.pp1}"]`).click();
    expect(await b.evaluate(() => [state.activeTab, state.view, state.currentProject].join('/'))).toBe(`${ID.personal}/project/${ID.pp1}`);
    await b.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; navigateView('projects'); });
    expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
});

test('[56][57][58][59][60] tema, área General, alta en la fila, edición en el sitio, fijar y colores', async () => {
  await test.step('[56] un botón alterna el tema; Etiquetas vive en Trabajo y Organización desaparece', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; navigateView('projects'); });
    await a.locator('#moreBtn').click();
    await a.evaluate(() => setTheme('system'));
    const wasDark = await a.evaluate(() => document.documentElement.classList.contains('dark'));
    await a.locator('#themeToggle').click();
    expect(await a.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(!wasDark);
    expect(await a.evaluate(() => localStorage.getItem('ikisai-theme'))).toBe(wasDark ? 'light' : 'dark');
    await a.locator('#themeToggle').click();
    expect(await a.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(wasDark);
    await a.evaluate(() => setTheme('system'));
    expect(await a.evaluate(() => localStorage.getItem('ikisai-theme'))).toBeNull();
    await expect(a.locator('[data-menu-group="organize"]')).toBeHidden();
    await expect(a.locator('[data-menu-group="work"] [data-menu-view="labels"]')).toHaveCount(1);
    await a.evaluate(() => closeNavigation());
    expect(await a.locator('#kebab').innerText()).not.toContain('Tu espacio');
    await expect(a.locator('.screen > .notice:visible')).toHaveCount(0);
  });

  await test.step('[57] el área General lista todas las áreas y crea un proyecto en línea dentro de la elegida', async () => {
    await a.locator('[data-general-area]').click();
    expect(await a.evaluate(() => state.taskScope + '/' + state.view)).toBe('all/projects');
    expect(await a.locator('[data-area-block] .project').count()).toBe(await a.evaluate(() => state.tabs.filter((t: any) => !t.deleted && t.name !== 'Plantillas').flatMap((t: any) => t.projects).filter((p: any) => !p.deleted && p.status !== 'archived' && !(p.system && !p.tasks.some((t: any) => !t.deleted))).length));
    await a.locator(`[data-area-block="${ID.personal}"] [data-add-project="${ID.personal}"]`).click();
    await a.locator('.newproject input').fill('Proyecto desde General');
    await a.locator('.newproject input').press('Enter');
    await settled(a);
    expect(await a.evaluate(() => state.tabs.find((t: any) => t.id === (window as any).ID.personal).projects.some((p: any) => p.title === 'Proyecto desde General'))).toBe(true);
    expect((await server.rows('tasks.projects')).some((r) => r.tab_id === ID.personal && r.title === 'Proyecto desde General')).toBe(true);
    expect(await a.evaluate(() => state.taskScope)).toBe('all');
  });

  await test.step('[58] la fila de alta escribe en el sitio y sigue en el último nivel; las hechas bajan; las fechas son plazos', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.groupBy = 'project'; navigateView('tasks'); });
    expect(await a.locator(`[data-project-drag="${ID.p1}"]`).count()).toBeGreaterThan(0);
    expect(await a.locator(`.sectionlabel[data-drop-project="${ID.p1}"]`).count()).toBeGreaterThan(0);
    await expect(a.locator('.tasklist > .empty:visible')).toHaveCount(0);
    const lastRow = await a.locator(`[data-open-project="${ID.p1}"]`).locator('xpath=ancestor::*[contains(@class,"sectionlabel")][1]/following-sibling::*[contains(@class,"tasklist")][1]').locator('[data-row]').last().getAttribute('data-row');
    const expectedParent = await a.evaluate((row) => taskLocation(row).t.parentId || '', lastRow);
    await a.locator(`[data-add-task="${ID.p1}"]`).click();
    await a.locator('.task.newtask .newstar').click();
    await a.locator('.task.newtask input').fill('Tarea añadida a continuación');
    await a.locator('.task.newtask input').press('Enter');
    await settled(a);
    const added = await a.evaluate(() => { const t = tab().projects.find((p: any) => p.id === (window as any).ID.p1).tasks.find((x: any) => x.text === 'Tarea añadida a continuación'); return t && { id: t.id, parent: t.parentId || '', priority: t.priority }; });
    expect([added.parent, added.priority]).toEqual([expectedParent, 'high']);
    shared.added = added.id;
    expect(await a.locator(`[data-row="${added.id}"] .tasktext .star-high`).count()).toBeGreaterThan(0);
    await expect(a.locator('.task.newtask input')).toHaveCount(1);
    await a.locator('.task.newtask input').press('Escape');
    await expect(a.locator('.task.newtask')).toHaveCount(0);
    const orderOk = await a.evaluate(() => {
      const section = document.querySelector(`[data-open-project="${(window as any).ID.p1}"]`)!.closest('.sectionlabel')!.nextElementSibling!;
      const done = [...section.querySelectorAll('.task:not(.child)')].map((r) => r.classList.contains('done') && !r.classList.contains('context'));
      const firstDone = done.indexOf(true), lastPending = done.lastIndexOf(false);
      return firstDone === -1 || lastPending === -1 || firstDone > lastPending;
    });
    expect(orderOk).toBe(true);
    expect(await a.locator('.taskmeta .due').count()).toBeGreaterThan(0);
    await expect(a.locator(`[data-project-pin="${ID.inbox}"]`)).toHaveCount(0);
    await expect(a.locator(`[data-project-drag="${ID.inbox}"]`)).toHaveCount(0);
    await a.locator(`[data-task-menu="${ID.t1}"]`).click();
    expect(await a.evaluate(() => getComputedStyle(document.getElementById('menuChild')!).opacity)).toBe('0');
    await a.evaluate(() => closeSheet());
    const row = await serverRow('tasks.tasks', added.id);
    expect([row.priority, row.parent_id ?? '']).toEqual(['high', expectedParent]);
  });

  await test.step('[59] el texto se edita en el sitio y el editor conserva el borrador al elegir etiquetas en línea', async () => {
    const added = shared.added!;
    await a.locator(`[data-row="${added}"] .tasktext`).click();
    await a.locator(`[data-row="${added}"] .inlineedit`).fill('Tarea editada en línea');
    await a.locator(`[data-row="${added}"] .inlineedit`).press('Enter');
    await settled(a);
    expect(await a.evaluate((t) => taskLocation(t).t.text, added)).toBe('Tarea editada en línea');
    await a.evaluate((t) => openTaskEditor(t), added);
    await expect(a.locator('#teParent')).toBeHidden();
    await a.locator('#priorityStar').click();
    await expect(a.locator('#tePriority')).toHaveValue('critical');
    await a.locator('#teNote').fill('Nota conservada');
    expect(await a.locator('.inlinepicker [data-inline-label]').count()).toBeGreaterThan(0);
    await a.locator(`.inlinepicker [data-inline-label="${ID.elec}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await a.locator(`.inlinepicker [data-inline-label="${ID.elec}"]`).click();
    expect(await a.locator(`.inlinepicker [data-inline-label="${ID.elec}"]`).evaluate((el) => el.classList.contains('on'))).toBe(true);
    await expect(a.locator('#teNote')).toHaveValue('Nota conservada');
    await expect(a.locator('#tePriority')).toHaveValue('critical');
    await a.locator('#saveTaskBtn').click();
    await settled(a);
    expect(await a.evaluate((t) => { const x = taskLocation(t).t; return [x.note, x.priority, x.labels.includes((window as any).ID.elec)]; }, added)).toEqual(['Nota conservada', 'critical', true]);
    const row = await serverRow('tasks.tasks', added);
    expect([row.title, row.note, row.priority]).toEqual(['Tarea editada en línea', 'Nota conservada', 'critical']);
  });

  await test.step('[60] fijar un proyecto en primera posición y elegir colores de proyecto y de área, guardados en el servidor', async () => {
    await a.evaluate(() => navigateView('projects'));
    await a.locator(`[data-project-pin="${ID.p2}"]`).click();
    await settled(a);
    expect(await a.evaluate(() => filteredProjects()[0].id)).toBe(ID.p2);
    await expect(a.locator('[data-project-color]')).toHaveCount(0);
    expect(await a.locator(`[data-project-pin="${ID.p2}"].pinned`).count()).toBeGreaterThan(0);
    await a.evaluate(() => openProjectEditor((window as any).ID.p2));
    await expect(a.locator('#pePriority')).toBeHidden();
    await a.locator('#sheet [data-pick-color="#3f6d8e"]').click();
    await a.locator('#saveProjectBtn').click();
    await settled(a);
    expect(await a.evaluate(() => tab().projects.find((p: any) => p.id === (window as any).ID.p2).color)).toBe('#3f6d8e');
    expect(await a.locator('.project.colored[style*="--item-ink"]').count()).toBeGreaterThan(0);
    expect(await a.locator(`[data-drop-project="${ID.p1}"] .projecttitle .star`).count()).toBeGreaterThan(0);
    await a.locator('.tabstrip [data-areas-tool]').click();
    await expect(a.locator('#sheet')).toContainText('Áreas de trabajo');
    await a.evaluate(() => manageTab((window as any).ID.personal));
    await a.locator('#sheet [data-pick-color="#a3537a"]').click();
    await settled(a);
    expect(await a.evaluate(() => state.tabs.find((t: any) => t.id === (window as any).ID.personal).color)).toBe('#a3537a');
    expect((await serverRow('tasks.tabs', ID.personal!)).color).toBe('#a3537a');
    await a.evaluate(() => closeSheet());
    expect(await a.locator(`.tabpill.colored[data-tab="${ID.personal}"]`).count()).toBeGreaterThan(0);
    await expect(a.locator('#savedViews')).toHaveCount(1);
    expect((await serverRow('tasks.projects', ID.p2!)).color).toBe('#3f6d8e');
    expect(await a.locator('.project.colored').count()).toBeGreaterThan(0);
    expect(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
});

test('[61][62] barra de facetas en escritorio y acciones en lote', async () => {
  await test.step('[61] las facetas filtran en el sitio, los chips activos se quitan solos y las vistas guardadas se aplican desde la tira', async () => {
    await b.setViewportSize({ width: 1440, height: 1000 });
    await sync(b);
    await b.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.groupBy = 'project'; state.filters = {}; navigateView('tasks'); });
    expect(await b.locator('.facetbar [data-facet]').count()).toBeGreaterThanOrEqual(4);
    expect(await b.locator('[data-quick-view]').count()).toBeGreaterThan(0);
    await b.locator(`[data-facet="${ID.person}"]`).click();
    await expect(b.locator('.facet.open .facetpanel')).toHaveCount(1);
    await b.locator(`.facetpanel [data-facet-toggle="${ID.person}"][data-facet-value="${ID.juan}"]`).click();
    expect(await b.evaluate(() => state.filters[(window as any).ID.person])).toEqual([ID.juan]);
    await expect(b.locator('.facet.open .facetpanel')).toHaveCount(1);
    await expect(b.locator('.activefilters .activechip')).toHaveCount(1);
    await expect(b.locator('.facettotal')).toContainText('de');
    await b.locator('.activefilters .activechip').first().click();
    expect(await b.evaluate(() => Object.values(state.filters).flat().length)).toBe(0);
    await b.locator('[data-facet="_state"]').click();
    await b.locator('.facetpanel [data-facet-value="pending"]').click();
    await b.keyboard.press('Escape');
    await expect(b.locator('.facetpanel')).toHaveCount(0);
    expect(await b.evaluate(() => state.filters._state)).toEqual(['pending']);
    await b.locator('#clearAllFilters').click();
    expect(await b.evaluate(() => Object.values(state.filters).flat().length)).toBe(0);
    await b.locator('[data-quick-view]').first().click();
    expect(await b.evaluate(() => state.view)).toBe('tasks');
    expect(await b.locator('.viewpill.active').count()).toBeGreaterThan(0);
    expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await b.setViewportSize({ width: 390, height: 844 });
    await expect(b.locator('.facetbar')).toHaveCount(1);
    await b.locator('[data-facet="_state"]').first().click();
    expect(await b.locator('#filterCount').count()).toBeGreaterThan(0);
    await b.evaluate(() => closeSheet());
  });

  await test.step('[62] la selección múltiple cambia la prioridad y mueve varias tareas en un solo lote', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.view = 'project'; state.currentProject = (window as any).ID.p2; state.filters = {}; state.search = ''; render(); });
    const batchIds: string[] = await a.evaluate(() => project().tasks.filter((t: any) => !t.deleted && !t.parentId && !t.done).slice(0, 2).map((t: any) => t.id));
    expect(batchIds).toHaveLength(2);
    await a.locator('#batchToggle').click();
    await expect(a.locator('#batchBar')).toHaveCount(1);
    for (const taskId of batchIds) await a.locator(`[data-select="${taskId}"]`).click();
    await expect(a.locator('.task.selected')).toHaveCount(2);
    expect((await a.locator('.batchcount').innerText()).startsWith('2')).toBe(true);
    const cursorBefore = (await server.app.call('/api/v1/bootstrap', { token: server.app.tokens.editor })).data.cursor;
    await a.locator('#batchPriority').click();
    await a.locator('[data-batch-priority="critical"]').click();
    await settled(a);
    expect(await a.evaluate((ids) => ids.map((t: string) => taskLocation(t).t.priority), batchIds)).toEqual(['critical', 'critical']);
    expect((await server.app.call('/api/v1/bootstrap', { token: server.app.tokens.editor })).data.cursor).toBe(cursorBefore + 1);
    expect(await a.evaluate(() => typeof batchMode !== 'undefined' && batchMode)).toBe(false);
    await a.locator('#batchToggle').click();
    for (const taskId of batchIds) await a.locator(`[data-select="${taskId}"]`).click();
    await a.locator('#batchMove').click();
    await a.locator(`[data-batch-move="${ID.p1}"]`).click();
    await settled(a);
    expect(await a.evaluate((ids) => ids.map((t: string) => taskLocation(t).p.id), batchIds)).toEqual([ID.p1, ID.p1]);
    expect((await server.rows('tasks.tasks')).filter((r) => batchIds.includes(r.id)).every((r) => r.project_id === ID.p1)).toBe(true);
    expect((await server.app.call('/api/v1/bootstrap', { token: server.app.tokens.editor })).data.cursor).toBe(cursorBefore + 2);
    expect(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
});

declare const cachedAttachment: any;
declare const aliasSheet: any, touch: any, save: any, leaves: any, boardDay: any, duplicateProject: any;
const cursor = async () => (await server.app.call('/api/v1/bootstrap', { token: server.app.tokens.editor })).data.cursor as number;

test('[63][64] duplicar proyectos, plantillas entre áreas, alias y «Mis tareas»', async () => {
  test.setTimeout(120_000);
  await test.step('[63] un proyecto se duplica con ids nuevos, se guarda como plantilla y siembra otra área con etiquetas por nombre', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
    const sourceCount = await a.evaluate(() => ({ tasks: project().tasks.filter((t: any) => !t.deleted).length, children: project().tasks.filter((t: any) => !t.deleted && t.parentId).length, done: project().tasks.filter((t: any) => !t.deleted && t.done).length }));
    await a.evaluate(() => openProjectEditor((window as any).ID.p1));
    await a.locator('#projectDuplicateIcon').click();
    await a.locator('#dupTitle').fill('Copia de prueba');
    await a.locator('#dupApply').click();
    await settled(a);
    const copyInfo = await a.evaluate(() => { const p = tab().projects.find((x: any) => x.title === 'Copia de prueba'); return p && { id: p.id, tasks: p.tasks.length, children: p.tasks.filter((t: any) => t.parentId).length, done: p.tasks.filter((t: any) => t.done).length, orphans: p.tasks.filter((t: any) => t.parentId && !p.tasks.some((x: any) => x.id === t.parentId)).length, current: state.currentProject === p.id, ids: new Set(p.tasks.map((t: any) => t.id)).size }; });
    expect(copyInfo).toBeTruthy();
    expect([copyInfo.tasks, copyInfo.children, copyInfo.done, copyInfo.orphans, copyInfo.ids, copyInfo.current]).toEqual([sourceCount.tasks, sourceCount.children, 0, 0, sourceCount.tasks, true]);
    expect((await server.rows('tasks.tasks')).filter((r) => r.project_id === copyInfo.id && !r.deleted_at)).toHaveLength(sourceCount.tasks);

    // La plantilla debe ser autocontenida: se quitan las dependencias hacia otros proyectos (los bloqueos externos se prueban en [72]).
    await a.evaluate(() => { const p = tab().projects.find((x: any) => x.id === (window as any).ID.p1), ids = new Set(p.tasks.filter((t: any) => !t.deleted).map((t: any) => t.id)); for (const t of p.tasks) { const keep = (t.dependsOn || []).filter((d: string) => ids.has(d)); if (keep.length !== (t.dependsOn || []).length) { t.dependsOn = keep; touch(t); } } save(); render(); });
    await settled(a);
    await a.evaluate(() => openProjectEditor((window as any).ID.p1));
    await a.locator('#projectDuplicateIcon').click();
    await a.locator('#dupTemplate').check();
    await a.locator('#dupApply').click();
    await settled(a);
    expect(await a.evaluate(() => state.tabs.some((t: any) => t.name === 'Plantillas' && t.projects.some((p: any) => p.title === 'Edificio inferior')))).toBe(true);
    const templates = (await server.rows('tasks.tabs')).find((r) => r.name === 'Plantillas');
    expect(templates).toBeTruthy();
    expect((await server.rows('tasks.families')).filter((r) => r.tab_id === templates.id && r.system_key).length).toBe(5);

    await a.evaluate(() => { state.activeTab = (window as any).ID.personal; navigateView('projects'); });
    await a.locator('#fromTemplate').click();
    await a.locator('[data-template]').first().click();
    await a.locator('#templateName').fill('Obra desde plantilla');
    await a.locator('#templateApply').click();
    await settled(a);
    const fromTemplate = await a.evaluate(() => { const area = state.tabs.find((t: any) => t.id === (window as any).ID.personal), p = area.projects.find((x: any) => x.title === 'Obra desde plantilla'); return p && { tasks: p.tasks.length, labelsResolved: p.tasks.every((t: any) => t.labels.every((l: string) => area.labels.some((x: any) => x.id === l))), families: area.families.map((f: any) => f.name) }; });
    expect(fromTemplate && fromTemplate.tasks).toBe(sourceCount.tasks);
    expect(fromTemplate.labelsResolved).toBe(true);
    expect(fromTemplate.families).toContain('Oficio');
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; navigateView('projects'); });
  });

  await test.step('[64] un alias elegido una vez da el atajo «Mis tareas» entre áreas, y las pestañas de área muestran pendientes', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; navigateView('projects'); });
    await expect(a.locator('[data-area-block] [data-add-project]')).toHaveCount(0);
    await a.evaluate(() => aliasSheet());
    await a.locator('[data-alias="Juan"]').click();
    await a.locator('#aliasSave').click();
    expect(await a.evaluate(() => localStorage.getItem('ikisai-alias'))).toBe('Juan');
    await a.locator('[data-quick-mine]').click();
    expect(await a.evaluate(() => state.taskScope + '/' + state.view)).toBe('all/tasks');
    expect(await a.evaluate(() => Object.values(state.filters).flat().some((l: any) => tab().labels.find((x: any) => x.id === l)?.text === 'Juan'))).toBe(true);
    expect(await a.locator('.task[data-row]:not(.context)').count()).toBeGreaterThan(0);
    await expect(a.locator('.viewpill.mine.active')).toHaveCount(1);
    await expect(a.locator('#aliasBtn')).toHaveCount(1);
    await expect(a.locator('#themeToggle')).toHaveCount(1);
    expect(await a.evaluate(() => document.getElementById('aliasBtn')!.textContent!.trim())).toBe('Juan');
    expect(await a.locator(`.tabpill[data-tab="${ID.ikisai}"] .tabcount`).count()).toBeGreaterThan(0);
  });
});

test('[65][66][67][68] importes en los editores, guardado atómico, coste vaciado y deshacer rápido', async () => {
  await test.step('[65] coste de tarea y presupuesto de proyecto se guardan en el servidor y se ven en filas, tarjetas y página', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
    await a.evaluate(() => openTaskEditor((window as any).ID.t2));
    await a.locator('#teCost').fill('150');
    await a.locator('#saveTaskBtn').click();
    await settled(a);
    expect(await a.evaluate(() => taskLocation((window as any).ID.t2).t.cost)).toBe(150);
    expect((await serverRow('tasks.tasks', ID.t2!)).cost).toBe(150);
    expect(await a.locator(`[data-row="${ID.t2}"] .cost`).count()).toBeGreaterThan(0);
    await a.evaluate(() => openProjectEditor((window as any).ID.p1));
    await expect(a.locator('#pePriority')).toBeHidden();
    await a.locator('#peBudget').fill('1000');
    await a.locator('#saveProjectBtn').click();
    await settled(a);
    expect(await a.evaluate(() => tab().projects.find((p: any) => p.id === (window as any).ID.p1).budget)).toBe(1000);
    expect((await serverRow('tasks.projects', ID.p1!)).budget).toBe(1000);
    expect(await a.locator('.project-detail-head ~ .money, main .money').count()).toBeGreaterThan(0);
    await a.evaluate(() => navigateView('projects'));
    expect(await a.locator(`[data-drop-project="${ID.p1}"] .money .moneybar`).count()).toBeGreaterThan(0);
  });

  await test.step('[66] nota, color y presupuesto sobreviven al selector de etiquetas y se confirman en un único lote', async () => {
    await a.evaluate(() => openProjectEditor((window as any).ID.p1));
    await a.locator('#peNote').fill('Atomic visual save');
    await a.locator('#peBudget').fill('1200');
    await a.locator('#sheet [data-pick-color="#3f6d8e"]').click();
    await a.locator('#editProjectLabels').click();
    await a.locator('#labelsDone').click();
    await expect(a.locator('#peBudget')).toHaveValue('1200');
    await expect(a.locator('#peColor')).toHaveValue('#3f6d8e');
    const before = await cursor();
    await a.locator('#saveProjectBtn').click();
    await settled(a);
    expect(await cursor()).toBe(before + 1);
    const row = await serverRow('tasks.projects', ID.p1!);
    expect([row.color, row.budget, row.note]).toEqual(['#3f6d8e', 1200, 'Atomic visual save']);
  });

  await test.step('[67] el coste vaciado sobrevive al selector, y una edición concurrente del coste mantiene el borrador sin pisar el dato remoto', async () => {
    await a.evaluate(() => openTaskEditor((window as any).ID.t2));
    await a.locator('#teCost').fill('');
    await a.locator('#editLabelsBtn').click();
    await a.locator('#labelsDone').click();
    await expect(a.locator('#teCost')).toHaveValue('');
    await a.locator('#saveTaskBtn').click();
    await settled(a);
    expect(await a.evaluate(() => taskLocation((window as any).ID.t2).t.cost)).toBeNull();
    expect((await serverRow('tasks.tasks', ID.t2!)).cost).toBeNull();
    await a.evaluate(() => openTaskEditor((window as any).ID.t2));
    await a.locator('#teCost').fill('30');
    const row = await serverRow('tasks.tasks', ID.t2!);
    expect((await server.commit([{ op: 'update', table: 'tasks.tasks', id: ID.t2, expectedRevision: row.revision, fields: { cost: 40 } }], server.app.tokens.editor)).status).toBe(200);
    await a.evaluate(() => syncNow());
    await a.waitForFunction(() => !Sync.busy && taskLocation((window as any).ID.t2).t.cost === 40);
    await a.locator('#saveTaskBtn').click();
    await expect(a.locator('#teCost')).toHaveValue('30');
    expect(await a.evaluate(() => taskLocation((window as any).ID.t2).t.cost)).toBe(40);
    expect(await a.evaluate(() => Sync.record.queue.length)).toBe(0);
    await a.locator('#closeDialog').click();
  });

  await test.step('[68] completar ofrece Deshacer, y los atajos de teclado llegan a la búsqueda y a la fila de alta', async () => {
    await a.evaluate(() => { state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
    const target = await a.evaluate(() => project().tasks.find((t: any) => !t.deleted && !t.done && !t.parentId && !project().tasks.some((c: any) => !c.deleted && c.parentId === t.id) && !dependencyBlockers(t, project()).length)?.id);
    expect(target).toBeTruthy();
    await a.locator(`[data-toggle-task="${target}"]`).click();
    await a.locator('#undoToast.show #undoNow').click({ timeout: 15_000 });
    await a.locator('#confirmUndo').click();
    await a.waitForFunction((t) => taskLocation(t).t.done === false && Sync.mode === 'online' && !Sync.busy, target, { timeout: 20_000 });
    expect((await serverRow('tasks.tasks', target)).done).toBe(false);
    await a.evaluate(() => closeSheet());
    await a.keyboard.press('/');
    expect(await a.evaluate(() => document.activeElement?.id)).toBe('searchInput');
    await a.keyboard.press('Escape');
    await a.evaluate(() => (document.activeElement as HTMLElement).blur());
    await a.keyboard.press('n');
    await expect(a.locator('.task.newtask input')).toHaveCount(1);
    await a.keyboard.press('Escape');
  });
});

test('[69][70][71][72] Inicio, acento «Taller», paleta, tablero por fechas y copias con dependencias', async () => {
  await test.step('[69] Inicio muestra indicadores, proyectos, semana, personas, calor y actividad, y es la vista de entrada de un área', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; navigateView('home'); });
    await expect(a.locator('main.home')).toHaveCount(1);
    await expect(a.locator('.kpi')).toHaveCount(4);
    expect(await a.locator('.homeproject').count()).toBeGreaterThan(0);
    expect(await a.locator('.hometask[data-home-task]').count()).toBeGreaterThan(0);
    expect(await a.locator('.weekday').count()).toBeGreaterThanOrEqual(8);
    expect(await a.locator('.personrow').count()).toBeGreaterThan(0);
    expect(await a.locator('.heat').count()).toBeGreaterThan(0);
    await a.waitForFunction(() => document.querySelector('#homeActivity .activityrow'));
    expect(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await a.locator(`.homeproject[data-home-project="${ID.p1}"]`).click();
    expect(await a.evaluate(() => state.view + '/' + state.currentProject)).toBe(`project/${ID.p1}`);
    await a.evaluate(() => navigateView('home'));
    await a.locator(`.tabpill[data-tab="${ID.personal}"]`).click();
    expect(await a.evaluate(() => state.view + '/' + state.activeTab)).toBe(`home/${ID.personal}`);
    await a.evaluate(() => { state.taskScope = 'all'; render(); });
    await expect(a.locator('.homehead .title')).toContainText('General');
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; navigateView('projects'); });
  });

  await test.step('[70] el acento sigue al color del área y del proyecto, vuelve a neutro en General, y los chips son pastel', async () => {
    await a.evaluate(() => { state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; tab().color = '#3f6d8e'; tab().projects.find((x: any) => x.id === (window as any).ID.p1).color = '#6f5a8f'; save(); navigateView('projects'); });
    await settled(a);
    expect(await a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#3f6d8e');
    expect(await a.locator('.project:not(.system) .cardring svg').count()).toBeGreaterThan(0);
    expect(await a.evaluate(() => document.querySelectorAll('.chip').length - document.querySelectorAll('.chip[data-pastel]').length)).toBe(0);
    await a.evaluate(() => { state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
    expect(await a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#6f5a8f');
    expect(await a.locator('.task.prio-critical, .task.prio-high').count()).toBeGreaterThan(0);
    await a.evaluate(() => { state.taskScope = 'all'; navigateView('home'); });
    expect(await a.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('');
    expect(await a.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px Fraunces') && document.fonts.check('16px Inter'); })).toBe(true);
    await a.evaluate(() => { state.taskScope = 'area'; state.activeTab = (window as any).ID.ikisai; tab().color = ''; tab().projects.find((x: any) => x.id === (window as any).ID.p1).color = ''; save(); navigateView('projects'); });
    await settled(a);
    expect((await serverRow('tasks.tabs', ID.ikisai!)).color).toBeNull();
  });

  await test.step('[71] la paleta Ctrl K salta a proyectos y vistas; el tablero agrupa por plazo y arrastrar una tarjeta cambia su fecha', async () => {
    await a.keyboard.press('Control+k');
    await a.locator('#paletteInput').fill('coc');
    await a.keyboard.press('Enter');
    await a.waitForFunction(() => state.view === 'project' && project()?.title === 'Cocina operativa');
    await a.keyboard.press('Control+k');
    await a.locator('#paletteInput').fill('inicio');
    await a.keyboard.press('Enter');
    await a.waitForFunction(() => state.view === 'home');
    await a.evaluate(() => { state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
    await a.locator('[data-board-mode="board"]').click();
    expect(await a.locator('.boardcol').count()).toBeGreaterThanOrEqual(5);
    expect(await a.locator('.boardcard').count()).toBe(await a.evaluate(() => leaves(project()).length));
    await expect(a.locator('#batchToggle')).toHaveCount(0);
    const target = await a.evaluate(() => { const t = leaves(project()).find((x: any) => !x.done); t.due = boardDay(-1); touch(t); save(); render(); return t.id; });
    await settled(a);
    await expect(a.locator(`.boardcol[data-board-col="overdue"] [data-board-task="${target}"]`)).toHaveCount(1);
    const today = (await a.locator('.boardcol[data-board-col="today"]').boundingBox())!, card = (await a.locator(`[data-board-task="${target}"]`).boundingBox())!;
    await a.mouse.move(card.x + 40, card.y + 12);
    await a.mouse.down();
    await a.mouse.move(card.x + 60, card.y + 30, { steps: 4 });
    await a.mouse.move(today.x + 40, today.y + 60, { steps: 6 });
    await a.mouse.up();
    await a.waitForFunction((t) => taskLocation(t).t.due === boardDay(0), target);
    await expect(a.locator(`.boardcol[data-board-col="today"] [data-board-task="${target}"]`)).toHaveCount(1);
    await a.locator(`[data-board-task="${target}"]`).click();
    await expect(a.locator('#teText')).toHaveCount(1);
    await a.evaluate(() => closeSheet());
    await a.locator('[data-board-mode="list"]').click();
    expect(await a.locator('.task').count()).toBeGreaterThan(0);
    await settled(a);
    expect((await serverRow('tasks.tasks', target)).due).toBe(await a.evaluate(() => boardDay(0)));
  });

  await test.step('[72] las copias en la misma área conservan dependencias externas e importes; entre áreas, las no resueltas se rechazan sin tocar nada', async () => {
    await a.evaluate(() => {
      const before = structuredClone(state), area = state.tabs.find((t: any) => t.id === (window as any).ID.ikisai), dest = state.tabs.find((t: any) => t.id === (window as any).ID.personal), source = structuredClone(area.projects.find((p: any) => p.id === (window as any).ID.p1));
      source.tasks.find((t: any) => t.id === (window as any).ID.t2).dependsOn = [(window as any).ID.t5]; source.budget = 250; source.tasks.find((t: any) => t.id === (window as any).ID.t2).cost = 25;
      const cross = duplicateProject(source, area, dest, { title: 'Rejected', createLabels: true, keepDone: false, keepDates: false });
      if (cross !== null || JSON.stringify(state) !== JSON.stringify(before)) throw Error('Una dependencia entre áreas sin resolver modificó el estado');
      const same = duplicateProject(source, area, area, { title: 'Safe copy', createLabels: true, keepDone: false, keepDates: false });
      if (same.budget !== 250 || !same.tasks.some((t: any) => t.cost === 25 && t.dependsOn.includes((window as any).ID.t5))) throw Error('La copia en la misma área perdió la dependencia o los importes');
      state = before; render();
    });
  });
});

test('[15] responsable y adjuntos del proyecto: subida diferida, descarga y apertura sin red', async () => {
  await routeStorage(contextA, server);
  await a.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });

  await test.step('el adjunto y el responsable sobreviven al selector de etiquetas y se guardan; el archivo llega a Storage', async () => {
    await a.locator(`[data-edit-project="${ID.p1}"]`).click();
    await a.locator('#peOwner').selectOption(ID.juan!);
    await a.locator('#peFiles').setInputFiles({ name: 'nota-proyecto.txt', mimeType: 'text/plain', buffer: Buffer.from('Adjunto de prueba') });
    await expect(a.locator('#projectFilesList a')).toHaveCount(1);
    await a.locator('#editProjectLabels').click();
    await a.locator('#labelsDone').click();
    await expect(a.locator('#peOwner')).toHaveValue(ID.juan!);
    await expect(a.locator('#projectFilesList a')).toHaveCount(1);
    await a.locator('#saveProjectBtn').click();
    await settled(a);
    expect(await a.evaluate(() => project().owner)).toBe(ID.juan);
    const attachment = await a.evaluate(() => project().attachments[0]);
    expect(attachment.data).toBeUndefined();
    expect([attachment.name, attachment.mime, attachment.size]).toEqual(['nota-proyecto.txt', 'text/plain', 17]);
    const row = (await server.rows('tasks.attachments')).find((r) => r.id === attachment.id);
    expect([row.project_id, row.task_id, row.sha256]).toEqual([ID.p1, null, attachment.sha256]);
    const file = (await server.app.t.db.query<{ status: string; path: string }>('select status, path from core.files where id = $1', [row.file_id])).rows[0]!;
    expect(file.status).toBe('verified');
    expect(new TextDecoder().decode(server.app.supabase.storage.get(file.path))).toBe('Adjunto de prueba');
    shared.attachment = attachment.id;
  });

  await test.step('se descarga desde el editor, también sin red en el dispositivo que lo adjuntó', async () => {
    await a.locator(`[data-edit-project="${ID.p1}"]`).click();
    let download = a.waitForEvent('download');
    await a.locator('#projectFilesList a').click();
    expect((await download).suggestedFilename()).toBe('nota-proyecto.txt');
    await a.evaluate(() => closeSheet());
    await contextA.setOffline(true);
    await a.locator(`[data-edit-project="${ID.p1}"]`).click();
    download = a.waitForEvent('download');
    await a.locator('#projectFilesList a').click();
    await download;
    await a.evaluate(() => closeSheet());
    await contextA.setOffline(false);
    await sync(a);
  });

  await test.step('otro dispositivo lo descarga del servidor y después lo abre sin red', async () => {
    await b.setViewportSize({ width: 1280, height: 900 });
    await sync(b);
    await b.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
    await b.evaluate(() => openProjectEditor((window as any).ID.p1));
    await expect(b.locator('#projectFilesList a')).toHaveCount(1);
    const before = server.requests.filter((r) => r.path === `/api/v1/attachments/${shared.attachment}`).length;
    let download = b.waitForEvent('download');
    await b.locator('#projectFilesList a').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('nota-proyecto.txt');
    // El contenido que llegó al navegador es el que guardó en su caché local para abrirlo sin red.
    expect(await b.evaluate(async (attachmentId) => (await (await cachedAttachment(attachmentId)).blob.text()), shared.attachment!)).toBe('Adjunto de prueba');
    expect(server.requests.filter((r) => r.path === `/api/v1/attachments/${shared.attachment}`).length).toBe(before + 1);
    await contextB.setOffline(true);
    download = b.waitForEvent('download');
    await b.locator('#projectFilesList a').click();
    await download;
    await contextB.setOffline(false);
    await b.evaluate(() => closeSheet());
    await sync(b);
  });

  await test.step('quitar el adjunto lo manda a la papelera en el servidor', async () => {
    await a.locator(`[data-edit-project="${ID.p1}"]`).click();
    await a.locator('[data-remove-project-file="0"]').click();
    await a.locator('#saveProjectBtn').click();
    await settled(a);
    expect((await server.rows('tasks.attachments')).find((r) => r.id === shared.attachment).deleted_at).toBeTruthy();
  });
});

test('[36] sesión caducada con cola pendiente: se conserva, otra cuenta no puede entrar y la misma la envía', async () => {
  await a.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; navigateView('projects'); });
  await contextA.setOffline(true);
  await a.evaluate(() => { const t = taskLocation((window as any).ID.t4).t; t.note = 'Cambio con sesión caducada'; touch(t); save(); render(); });
  await a.waitForFunction(() => Sync.record.queue.length === 1);
  await server.app.t.revokeSessions(server.app.users.owner);
  await contextA.setOffline(false);
  await a.evaluate(() => syncNow());
  await a.waitForFunction(() => Sync.mode === 'unauthorized' && !Sync.busy);
  expect(await a.evaluate(() => Sync.record.queue.length)).toBe(1);
  await expect(a.locator('#accountLoginForm')).toBeVisible();
  expect((await serverRow('tasks.tasks', ID.t4!)).note).not.toBe('Cambio con sesión caducada');

  await test.step('otra cuenta no puede entrar mientras haya cambios pendientes', async () => {
    await a.locator('#loginUsername').fill(READER.email);
    await a.locator('#loginPassword').fill(READER.password);
    await a.locator('#accountLogin').click();
    await expect(a.locator('#loginError')).toContainText('cambios pendientes de otra cuenta');
    expect(await a.evaluate(() => Sync.record.queue.length)).toBe(1);
    expect(await a.evaluate(() => taskLocation((window as any).ID.t4).t.note)).toBe('Cambio con sesión caducada');
    await server.app.t.createUser(server.app.users.reader);
  });

  await test.step('la misma cuenta vuelve a entrar y la cola se envía', async () => {
    await server.app.t.createUser(server.app.users.owner);
    await a.locator('#loginUsername').fill(OWNER.email);
    await a.locator('#loginPassword').fill(OWNER.password);
    await expect(a.locator('#accountLogin')).toBeEnabled();
    await a.locator('#accountLogin').click();
    await settled(a);
    expect(await a.evaluate(() => taskLocation((window as any).ID.t4).t.note)).toBe('Cambio con sesión caducada');
    expect((await serverRow('tasks.tasks', ID.t4!)).note).toBe('Cambio con sesión caducada');
  });
});

declare const usersSheet: any, handleTopAction: any;

test('[27][28][30][34] invitar a una persona a un solo proyecto: lo que ve, lo que puede y retirarle el acceso', async ({ browser }) => {
  test.setTimeout(120_000);
  const GUEST = { email: 'invitada@example.invalid', password: '' };
  let guestId = '';

  await test.step('[27][34] la propietaria crea desde el móvil una cuenta de editora limitada a un proyecto', async () => {
    await a.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; navigateView('projects'); });
    await a.evaluate(() => handleTopAction('users'));
    await a.locator('#newUser').click();
    await a.locator('#userUsername').fill(GUEST.email);
    await a.locator('#userName').fill('Invitada navegador');
    await a.locator('#userRole').selectOption('editor');
    await a.locator(`[data-user-project="${ID.ikisai}|${ID.p1}"]`).check();
    await a.locator('#saveUser').click();
    GUEST.password = await a.locator('#issuedPassword').inputValue();
    expect(GUEST.password.length).toBeGreaterThan(10);
    await a.locator('#userDone').click();
    await expect(a.locator('#newUser')).toBeVisible();
    await expect(a.locator('#sheet')).toContainText('Invitada navegador');
    const membership = (await server.app.t.db.query<{ user_id: string; role: string; scopes: any }>(`select user_id, role, scopes from core.memberships where app = 'tasks' and role = 'editor' and scopes::text like '%projects%'`)).rows[0]!;
    expect(membership.scopes).toEqual({ tabs: [], projects: { [ID.ikisai!]: [ID.p1] } });
    guestId = membership.user_id;
    await a.evaluate(() => closeSheet());
  });

  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guestErrors: string[] = [];
  const guest = await openApp(guestContext, server, { user: GUEST, aliases: ID, errors: guestErrors });

  await test.step('[28] la invitada solo ve su proyecto, crea tareas en él y no toca lo privado ni el catálogo', async () => {
    await expect(guest.locator('[data-drop-project]')).toHaveCount(1);
    await expect(guest.locator(`[data-open-project="${ID.inbox}"]`)).toHaveCount(0);
    expect(await guest.evaluate(() => [Sync.actor.role, state.tabs.length, state.tabs[0].restricted, state.tabs[0].projects.length])).toEqual(['editor', 1, true, 1]);
    await expect(guest.locator('#fab')).toBeDisabled();
    expect(await guest.evaluate(() => Sync.record.queue.length)).toBe(0);
    // Catálogo completo del área en solo lectura (decisión D1), sin vistas guardadas.
    expect(await guest.evaluate(() => [state.tabs[0].families.length, state.tabs[0].views.length])).toEqual([5, 0]);
    expect(await guest.evaluate(() => state.tabs[0].labels.length)).toBe((await server.rows('tasks.labels')).filter((r) => r.tab_id === ID.ikisai && !r.deleted_at).length);
    await guest.locator(`[data-open-project="${ID.p1}"]`).click();
    await guest.locator('#quickAdd').click();
    await guest.locator('#teText').fill('Tarea de proyecto compartido');
    await guest.locator('#saveTaskBtn').click();
    await settled(guest);
    const created = (await server.rows('tasks.tasks')).find((r) => r.title === 'Tarea de proyecto compartido');
    expect([created.project_id, created.updated_by]).toEqual([ID.p1, guestId]);
    // Lo privado no existe para ella: ni en su espejo ni por la API.
    expect(await guest.evaluate(() => JSON.stringify(state.tabs).includes('Cocina operativa'))).toBe(false);
    const hidden = await guest.evaluate(async () => { try { await Sync.core.api('/read/tasks.targets', { method: 'POST', json: { kind: 'task', id: (window as any).ID.t5 } }); return 0; } catch (e: any) { return e.status; } });
    expect(hidden).toBe(404);
    const forbidden = await server.commit([{ op: 'update', table: 'tasks.tasks', id: ID.t5, expectedRevision: (await serverRow('tasks.tasks', ID.t5!)).revision, fields: { note: 'intrusa' } }], server.app.supabase.tokenFor(guestId));
    expect(forbidden.status).toBe(403);
    await guest.locator('[data-nav="labels"]').click();
    await expect(guest.locator('#newFamily')).toBeDisabled();
    await expect(guest.locator('[data-edit-label]').first()).toBeDisabled();
    await guest.locator('#moreBtn').click();
    await guest.locator('[data-action="areas"]').click();
    await expect(guest.locator('#newArea')).toHaveCount(0);
    await expect(guest.locator('[data-edit-area]')).toHaveCount(0);
    await guest.locator('#closeDialog').click();
    await guest.evaluate(() => closeNavigation());
    expect(await guest.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(guestErrors).toEqual([]);
  });

  await test.step('la propietaria ve la tarea de la invitada', async () => {
    await sync(a);
    await a.waitForFunction(() => state.tabs.find((t: any) => t.id === (window as any).ID.ikisai).projects.find((p: any) => p.id === (window as any).ID.p1).tasks.some((t: any) => t.text === 'Tarea de proyecto compartido'), null, { timeout: 20_000 });
  });

  await test.step('[30] la propietaria le retira el acceso y el servidor deja de servirle datos', async () => {
    await a.evaluate(() => usersSheet());
    await a.locator(`[data-edit-user="${guestId}"]`).click();
    await a.locator('#revokeUser').click();
    await expect(a.locator('#newUser')).toBeVisible();
    await expect(a.locator('#sheet')).toContainText('Sin acceso');
    await a.evaluate(() => closeSheet());
    const token = server.app.supabase.tokenFor(guestId);
    const snapshot = await server.app.call('/api/v1/snapshot', { token });
    expect(snapshot.data.tables.every((t: any) => t.rows.length === 0)).toBe(true);
    const write = await server.commit([{ op: 'insert', table: 'tasks.tasks', id: crypto.randomUUID(), fields: { tab_id: ID.ikisai, project_id: ID.p1, title: 'Ya no', position: 1 } }], token);
    expect(write.status).toBe(403);
    // Al volver a abrir la app, su espejo local se vacía.
    await guest.reload();
    await guest.waitForFunction(() => typeof Sync !== 'undefined' && Sync.ready && state.tabs.length === 0, null, { timeout: 20_000 });
    await expect(guest.locator('#app')).toContainText('ningún área compartida');
  });
  await guestContext.close();
});

declare const csvImportSheet: any, csvExport: any, downloadServerBackup: any, portableExport: any, portableImportSheet: any, openFilters: any, persistUI: any, api: any;

test('[24][32][33][44] respaldo, copia portable, CSV y filtros de disponibilidad por REST', async () => {
  test.setTimeout(120_000);
  await sync(a);
  await a.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.search = ''; navigateView('projects'); });

  await test.step('[33] CSV: previsualizar en el servidor, importar un nivel de hijas y exportar', async () => {
    const projectCount = await a.evaluate(() => tab().projects.length);
    await a.evaluate(() => csvImportSheet());
    await a.locator('#csvFile').setInputFiles({ name: 'tareas.csv', mimeType: 'text/csv', buffer: Buffer.from('project,task_id,parent_id,text,note,done\nCSV navegador,1,,Padre CSV,Nota,0\nCSV navegador,2,1,Hija CSV,,1\n') });
    await a.waitForFunction(() => !(document.getElementById('csvApply') as HTMLButtonElement).disabled);
    await expect(a.locator('#csvPreview')).toContainText('1 proyectos · 2 tareas · 1 hijas');
    await a.locator('#csvApply').click();
    await a.waitForFunction((n) => tab().projects.length === n + 1 && !Sync.busy, projectCount);
    await settled(a);
    const csvProject = await a.evaluate(() => tab().projects.find((p: any) => p.title === 'CSV navegador (CSV)'));
    const parent = csvProject.tasks.find((t: any) => t.text === 'Padre CSV'), child = csvProject.tasks.find((t: any) => t.text === 'Hija CSV');
    expect(child.parentId).toBe(parent.id);
    expect(parent.done).toBe(true);
    expect((await server.rows('tasks.tasks')).filter((r) => r.project_id === csvProject.id)).toHaveLength(2);
    const download = a.waitForEvent('download');
    await a.evaluate(() => csvExport());
    expect((await download).suggestedFilename()).toBe('Ikisai-tareas.csv');
  });

  await test.step('[24] la propietaria descarga el respaldo completo en ZIP', async () => {
    const download = a.waitForEvent('download');
    await a.evaluate(() => downloadServerBackup());
    const backup = await download;
    expect(backup.suggestedFilename()).toBe('Ikisai-respaldo.zip');
    const fs = await import('node:fs');
    expect(fs.readFileSync(await backup.path()).subarray(0, 2).equals(Buffer.from('PK'))).toBe(true);
  });

  await test.step('[32] la copia portable se descarga, se verifica en la previsualización y se importa como áreas independientes', async () => {
    const download = a.waitForEvent('download');
    await a.evaluate(() => portableExport());
    const portablePath = await (await download).path();
    const countBefore = await a.evaluate(() => state.tabs.length);
    await a.evaluate(() => portableImportSheet());
    await a.locator('#portableFile').setInputFiles(portablePath);
    await a.locator('#portableApply').waitFor({ state: 'visible' });
    await a.waitForFunction(() => !(document.getElementById('portableApply') as HTMLButtonElement).disabled);
    await expect(a.locator('#portablePreview')).toContainText('adjuntos verificados');
    await a.locator('#portableApply').click();
    await a.waitForFunction((n) => state.tabs.length === n * 2 && Sync.mode === 'online' && !Sync.busy, countBefore, { timeout: 30_000 });
    expect(await a.evaluate(() => state.tabs.length)).toBe(countBefore * 2);
    expect(await a.evaluate(() => state.tabs.filter((t: any) => t.name === 'Ikisai (copia)').length)).toBe(1);
    expect(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await a.evaluate(() => closeSheet());
  });

  await test.step('[44] los filtros de disponibilidad funcionan en la interfaz y por REST sin proponer la tarea bloqueada', async () => {
    await b.setViewportSize({ width: 1440, height: 1000 });
    await sync(b);
    // La dependencia de Pintar se retiró al preparar la plantilla en [63]: se vuelve a declarar.
    await b.evaluate(({ paint, plaster }) => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.search = ''; const t = taskLocation(paint).t; t.dependsOn = [plaster]; touch(t); save(); state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); }, { paint: shared.paint!, plaster: shared.plaster! });
    await settled(b);
    await b.evaluate(() => openFilters());
    await b.locator('[data-availability="ready"]').click();
    await b.evaluate(() => { closeSheet(); persistUI(); render(); });
    await expect(b.locator(`[data-row="${shared.paint}"]`)).toHaveCount(0);
    expect((await b.evaluate(() => api(`tabs/${(window as any).ID.ikisai}/tasks?availability=blocked`))).items.some((t: any) => t.id === shared.paint)).toBe(true);
    expect((await b.evaluate(() => api(`tabs/${(window as any).ID.ikisai}/tasks?availability=ready&limit=500`))).items.some((t: any) => t.id === shared.paint)).toBe(false);
    await b.evaluate(() => openFilters());
    await b.locator('[data-availability="ready"]').click();
    await b.locator('[data-availability="blocked"]').click();
    await b.evaluate(() => { closeSheet(); persistUI(); render(); });
    await expect(b.locator(`[data-row="${shared.paint}"] .dependency-blocked`)).toHaveCount(1);
    await b.evaluate(() => { state.filters = {}; persistUI(); render(); });
  });
});

declare const showTrash: any;

test('vaciar papelera: la propietaria confirma con el recuento y los demás dispositivos dejan de ver lo purgado', async () => {
  await sync(a);
  await a.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.search = ''; navigateView('projects'); });
  // Un proyecto con una tarea viva va a la papelera: la tarea no está borrada, pero cuelga de un contenedor borrado.
  await a.evaluate(() => { const p = tab().projects.find((x: any) => x.id === (window as any).ID.p3); p.deleted = true; touch(p); save(); render(); });
  await settled(a);
  // Espera al estado, no al instante: el otro dispositivo puede adoptar lo recibido un momento después de sincronizar.
  await expect.poll(async () => (await server.rows('tasks.projects')).find((r) => r.id === ID.p3)?.deleted_at ?? null, { timeout: 20_000 }).not.toBeNull();
  await sync(b);
  await b.waitForFunction(() => state.tabs.find((t: any) => t.id === (window as any).ID.ikisai).projects.find((p: any) => p.id === (window as any).ID.p3)?.deleted === true, null, { timeout: 20_000 });
  const count = await a.evaluate(() => (window as any).trashCount());
  expect(count).toBeGreaterThan(0);
  await a.evaluate(() => showTrash());
  await expect(a.locator('#emptyTrash')).toHaveText(`Vaciar papelera (${count})`);
  await a.locator('#emptyTrash').click();
  await expect(a.locator('#sheet')).toContainText(`Se eliminarán definitivamente ${count} elementos`);
  await a.locator('#emptyTrashConfirm').click();
  await a.waitForFunction(() => (window as any).trashCount() === 0, null, { timeout: 20_000 });
  await settled(a);
  for (const table of ['tasks.tabs', 'tasks.projects', 'tasks.tasks', 'tasks.saved_views', 'tasks.task_labels', 'tasks.task_dependencies', 'tasks.attachments']) {
    expect((await server.rows(table)).filter((r) => r.deleted_at), table).toHaveLength(0);
  }
  expect((await server.rows('tasks.projects')).some((r) => r.id === ID.p3)).toBe(false);
  expect((await server.rows('tasks.tasks')).some((r) => r.id === ID.t8)).toBe(false);
  // El otro dispositivo recibe la purga y deja de tener el proyecto y sus tareas.
  await sync(b);
  await b.waitForFunction(() => !state.tabs.find((t: any) => t.id === (window as any).ID.ikisai).projects.some((p: any) => p.id === (window as any).ID.p3), null, { timeout: 20_000 });
  await a.evaluate(() => closeSheet());
});

test('foto de 3200 px: se recomprime a 1600 px en WebP sin conservar el original y se adjunta a la tarea', async () => {
  await routeStorage(contextA, server);
  await sync(a);
  await a.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; state.search = ''; state.view = 'project'; state.currentProject = (window as any).ID.p1; render(); });
  // Una foto sintética de 3200 × 2000 generada en la propia página (ruido de color para que no comprima a casi nada).
  const png: number[] = await a.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 3200; canvas.height = 2000;
    const context = canvas.getContext('2d')!;
    for (let i = 0; i < 400; i++) { context.fillStyle = `hsl(${(i * 47) % 360} 70% ${30 + (i % 5) * 10}%)`; context.fillRect((i * 131) % 3200, (i * 71) % 2000, 400, 260); }
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await a.evaluate(() => openTaskEditor((window as any).ID.t1));
  await a.locator('#teFiles').setInputFiles({ name: 'obra.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await a.waitForFunction(() => document.querySelectorAll('#sheet a[download]').length === 1, null, { timeout: 20_000 });
  await a.locator('#saveTaskBtn').click();
  await settled(a);
  const attachment = await a.evaluate(() => taskLocation((window as any).ID.t1).t.attachments.at(-1));
  expect([attachment.name, attachment.mime]).toEqual(['obra.webp', 'image/webp']);
  expect(attachment.size).toBeLessThan(png.length);
  expect(attachment.data).toBeUndefined();
  const row = (await server.rows('tasks.attachments')).find((r) => r.id === attachment.id);
  expect([row.task_id, row.mime, row.size, row.sha256]).toEqual([ID.t1, 'image/webp', attachment.size, attachment.sha256]);
  // Lo que llegó a Storage es la versión reducida: lado mayor 1600 px.
  const file = (await server.app.t.db.query<{ path: string; status: string }>('select path, status from core.files where id = $1', [row.file_id])).rows[0]!;
  expect(file.status).toBe('verified');
  const stored = server.app.supabase.storage.get(file.path)!;
  expect(stored.byteLength).toBe(attachment.size);
  const size = await a.evaluate(async (bytes) => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/webp' })); return [image.width, image.height]; }, [...stored]);
  expect(size).toEqual([1600, 1000]);
});

test('importación portable: si se pierde la respuesta final, reintentar desde la interfaz crea una sola copia', async () => {
  test.setTimeout(120_000);
  await sync(a);
  await a.evaluate(() => { closeSheet(); state.activeTab = (window as any).ID.ikisai; state.taskScope = 'area'; state.filters = {}; navigateView('projects'); });
  const download = a.waitForEvent('download');
  await a.evaluate(() => portableExport());
  const portablePath = await (await download).path();
  const countBefore = await a.evaluate(() => state.tabs.length);
  const serverBefore = (await server.rows('tasks.tabs')).length;

  // La primera petición de importación llega al servidor y se confirma, pero su respuesta no vuelve al navegador.
  let calls = 0;
  const pattern = '**/api/v1/portable/import';
  await contextA.route(pattern, async (route) => {
    calls += 1;
    if (calls === 1) { await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
  });
  await a.evaluate(() => portableImportSheet());
  await a.locator('#portableFile').setInputFiles(portablePath);
  await a.waitForFunction(() => !(document.getElementById('portableApply') as HTMLButtonElement).disabled);
  await a.locator('#portableApply').click();
  await a.waitForFunction(() => !(document.getElementById('portableApply') as HTMLButtonElement)?.disabled && document.getElementById('toast')!.classList.contains('show'), null, { timeout: 20_000 });
  expect((await server.rows('tasks.tabs')).length, 'el servidor ya había importado').toBe(serverBefore * 2);
  await a.locator('#portableApply').click();
  await a.waitForFunction((n) => state.tabs.length === n * 2 && Sync.mode === 'online' && !Sync.busy, countBefore, { timeout: 30_000 });
  await contextA.unroute(pattern);
  expect(calls).toBe(2);
  expect((await server.rows('tasks.tabs')).length, 'el reintento no duplica').toBe(serverBefore * 2);
  expect(await a.evaluate(() => state.tabs.length)).toBe(countBefore * 2);
  await a.evaluate(() => closeSheet());
});
