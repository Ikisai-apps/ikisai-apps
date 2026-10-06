/**
 * Ikisai Tasks · escenarios de interfaz de `tests/integration.cjs` (repo antiguo) portados con los mismos gestos,
 * sobre la semilla de demostración original (`fixtures/demo.json`) y la `tasks-api` real en PGlite.
 * El número entre corchetes es el del escenario original (docs/tasks/API.md §11.1). `ID` traduce los ids antiguos
 * (`p1`, `t1`, `trade`…) a los uuid de la semilla, también dentro de la página.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

// Globales de la interfaz heredada (scripts clásicos), visibles dentro de page.evaluate.
declare const Sync: any;
declare const state: any;
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
    expect(await b.evaluate(() => filteredProjects()[0].id)).toBe(ID.p1);
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
