/**
 * Ikisai Tasks · extremo a extremo de `apps/tasks` (interfaz heredada + adaptador sobre sync-client) contra la
 * `tasks-api` real en PGlite. Porta los escenarios de `tests/integration.cjs` del repo antiguo (docs/tasks/API.md §11.1);
 * el número entre corchetes es el del escenario original.
 *
 *   npx playwright test tests/tasks
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';
import { EDITOR, OWNER, READER, VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';

// Globales de la interfaz heredada (ligaduras léxicas de sus scripts clásicos), visibles dentro de page.evaluate.
declare const Sync: any;
declare const state: any;
declare function save(): boolean;
declare function render(): void;
declare function syncNow(): Promise<void>;
declare function uid(prefix?: string): string;

let server: E2EServer;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const insert = (table: string, rowId: string, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id: rowId, fields });

/** Semilla sintética equivalente a la demo antigua: dos áreas, proyectos, jerarquía, etiquetas y una dependencia. */
const S = {
  obra: id(1), obraInbox: id(2), personal: id(3), personalInbox: id(4),
  reforma: id(10), jardin: id(11),
  puerta: id(20), marco: id(21), pedir: id(22), enfoscar: id(23), pintar: id(24), riego: id(25),
  juan: id(30), carpinteria: id(31),
};
let families: Record<string, string> = {};

async function seed(): Promise<void> {
  const obra = createTabOps({ id: S.obra, name: 'Obra', position: 1024, inboxId: S.obraInbox });
  families = Object.fromEntries(obra.filter((o) => o.table === 'tasks.families').map((o) => [String(o.fields!.system_key), o.id!]));
  const personal = createTabOps({ id: S.personal, name: 'Personal', position: 2048, inboxId: S.personalInbox });
  const task = (taskId: string, project: string, title: string, position: number, extra: Record<string, unknown> = {}) =>
    insert('tasks.tasks', taskId, { tab_id: S.obra, project_id: project, title, position, ...extra });
  const result = await server.commit([
    ...obra, ...personal,
    insert('tasks.labels', S.juan, { tab_id: S.obra, family_id: families.person, name: 'Juan' }),
    insert('tasks.labels', S.carpinteria, { tab_id: S.obra, family_id: families.trade, name: 'Carpintería' }),
    insert('tasks.projects', S.reforma, { tab_id: S.obra, title: 'Reforma del baño', position: 2048 }),
    insert('tasks.projects', S.jardin, { tab_id: S.obra, title: 'Jardín', position: 3072 }),
    task(S.puerta, S.reforma, 'Cambiar la puerta', 1024),
    task(S.marco, S.reforma, 'Comprobar marco y medidas', 2048, { parent_id: S.puerta, done: true }),
    task(S.pedir, S.reforma, 'Pedir la puerta', 3072, { parent_id: S.puerta }),
    task(S.enfoscar, S.reforma, 'Enfoscar', 4096),
    task(S.pintar, S.reforma, 'Pintar', 5120),
    task(S.riego, S.jardin, 'Revisar el riego', 1024),
    insert('tasks.task_dependencies', id(40), { tab_id: S.obra, project_id: S.reforma, task_id: S.pintar, depends_on_id: S.enfoscar, position: 1024 }),
    insert('tasks.task_labels', id(41), { tab_id: S.obra, project_id: S.reforma, task_id: S.puerta, label_id: S.carpinteria }),
  ]);
  if (result.status !== 200) throw new Error('Semilla rechazada: ' + JSON.stringify(result.data));
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
  server = await startE2EServer();
  await seed();
});
test.afterAll(async () => { await server?.close(); });

/** Espera a que la interfaz quede al día con el servidor; si no llega, explica en qué estado se quedó. */
async function settled(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => typeof Sync !== 'undefined' && Sync.ready && Sync.mode === 'online' && !Sync.busy && Sync.record.queue.length === 0, null, { timeout: 20_000 });
  } catch (error) {
    const snapshot = await page.evaluate(() => JSON.stringify({ ready: Sync.ready, tabs: state.tabs.length, mode: Sync.mode, busy: Sync.busy, queue: Sync.record.queue.length, conflict: Sync.record.conflict, failure: Sync.record.failure, status: Sync.core?.status() })).catch(() => 'sin página');
    throw new Error(`La interfaz no quedó al día: ${snapshot}`);
  }
}

async function open(context: BrowserContext, user = OWNER): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => { throw new Error('Error de JavaScript en la página: ' + error.message); });
  await page.goto(server.url + '/');
  await page.locator('#loginUsername').fill(user.email);
  await page.locator('#loginPassword').fill(user.password);
  await page.locator('#accountLogin').click();
  await settled(page);
  return page;
}

/** Edita el modelo como lo hace la interfaz y guarda. */
const edit = (page: Page, fn: (s: typeof S) => void) => page.evaluate(`(() => { const S = ${JSON.stringify(S)}; (${fn.toString()})(S); if (!save()) throw new Error('save() devolvió false: ' + document.getElementById('toast').textContent); render(); })()`);
const taskOf = (page: Page, taskId: string) => page.evaluate((t) => state.tabs.flatMap((x: any) => x.projects.flatMap((p: any) => p.tasks)).find((x: any) => x.id === t), taskId);
const serverTask = async (taskId: string) => (await server.rows('tasks.tasks')).find((r) => r.id === taskId);

test.describe.configure({ mode: 'serial' });

test('arranque, edición, sin red, fusión y conflicto', async ({ browser }) => {
  test.setTimeout(240_000);
  const contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await open(contextA);

  await test.step('[1] arranque autenticado con los datos del servidor', async () => {
    await expect(a.locator(`[data-open-project="${S.reforma}"]`)).toHaveCount(1);
    expect(await a.evaluate(() => Sync.actor.role)).toBe('owner');
    await expect(a.locator('#syncBadge')).toHaveText('Al día');
    expect(server.requests.some((r) => r.path === '/api/v1/snapshot')).toBeTruthy();
  });

  await test.step('[3] crear una tarea desde la interfaz la guarda por la API', async () => {
    await a.locator(`[data-open-project="${S.reforma}"]`).click();
    await edit(a, (s) => {
      const project = state.tabs.find((t: any) => t.id === s.obra).projects.find((p: any) => p.id === s.reforma);
      project.tasks.push({ id: uid('t'), text: 'Alicatar', note: '', done: false, priority: 'normal', due: '', labels: [], owner: null, parentId: null, order: 9000, attachments: [], dependsOn: [] });
    });
    await settled(a);
    const rows = await server.rows('tasks.tasks');
    expect(rows.filter((r) => r.title === 'Alicatar' && r.project_id === S.reforma && !r.deleted_at)).toHaveLength(1);
    await expect(a.locator('.task', { hasText: 'Alicatar' })).toHaveCount(1);
  });

  const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const b = await open(contextB);
  await test.step('[7] un segundo dispositivo ve los datos canónicos', async () => {
    const titles = await b.evaluate((p) => state.tabs.flatMap((t: any) => t.projects).find((x: any) => x.id === p).tasks.map((t: any) => t.text), S.reforma);
    expect(titles).toContain('Alicatar');
  });

  await test.step('[8][9] edición sin red, recarga con la cola intacta y reconexión', async () => {
    await contextA.setOffline(true);
    await edit(a, (s) => { state.tabs[0].projects.find((p: any) => p.id === s.reforma).tasks.find((t: any) => t.id === s.enfoscar).note = 'Dos capas, sin red'; });
    await a.waitForFunction(() => Sync.record.queue.length === 1);
    await expect(a.locator('#syncBadge')).toHaveText('Sin conexión');
    expect((await serverTask(S.enfoscar)).note).toBe('');
    await a.reload().catch(() => undefined);
  });
  // La recarga sin red necesita el service worker, que en http://127.0.0.1 sí es contexto seguro.
  await test.step('[8] tras recargar sin red, el borrador y la cola siguen ahí', async () => {
    await a.waitForFunction(() => typeof Sync !== 'undefined' && Sync.record?.queue.length === 1 && state.tabs.length > 0, null, { timeout: 20_000 });
    expect((await taskOf(a, S.enfoscar)).note).toBe('Dos capas, sin red');
    await contextA.setOffline(false);
    await a.evaluate(() => syncNow());
    await settled(a);
    expect((await serverTask(S.enfoscar)).note).toBe('Dos capas, sin red');
  });

  await test.step('[10] ediciones concurrentes de campos distintos se fusionan', async () => {
    await b.evaluate(() => syncNow()); await settled(b);
    await contextA.setOffline(true);
    await edit(a, (s) => { state.tabs[0].projects.find((p: any) => p.id === s.reforma).tasks.find((t: any) => t.id === s.pintar).note = 'Blanco roto'; });
    await edit(b, (s) => { state.tabs[0].projects.find((p: any) => p.id === s.reforma).tasks.find((t: any) => t.id === s.pintar).priority = 'high'; });
    await settled(b);
    await contextA.setOffline(false);
    await a.evaluate(() => syncNow()); await settled(a);
    const row = await serverTask(S.pintar);
    expect([row.note, row.priority]).toEqual(['Blanco roto', 'high']);
    expect((await taskOf(a, S.pintar)).priority).toBe('high');
  });

  await test.step('[11] ediciones del mismo campo exigen una decisión explícita', async () => {
    await b.evaluate(() => syncNow()); await settled(b);
    await contextA.setOffline(true);
    await edit(a, (s) => { state.tabs[0].projects.find((p: any) => p.id === s.jardin).tasks[0].text = 'Revisar el riego (A)'; });
    await edit(b, (s) => { state.tabs[0].projects.find((p: any) => p.id === s.jardin).tasks[0].text = 'Revisar el riego (B)'; });
    await settled(b);
    await contextA.setOffline(false);
    await a.evaluate(() => syncNow());
    await a.waitForFunction(() => Sync.mode === 'conflict');
    await expect(a.locator('#syncBadge')).toHaveText('Revisar cambios');
    expect((await serverTask(S.riego)).title).toBe('Revisar el riego (B)');
    await a.locator('#syncBadge').click();
    await a.locator('#syncConflict').click();
    await expect(a.locator('#sheet')).toContainText('Revisar el riego (B)');
    await a.locator('#keepLocal').click();
    await settled(a);
    expect((await serverTask(S.riego)).title).toBe('Revisar el riego (A)');
  });

  await contextA.close();
  await contextB.close();
});

const reforma = (s: typeof S) => state.tabs.find((t: any) => t.id === s.obra).projects.find((p: any) => p.id === s.reforma);
const allTasks = () => state.tabs.flatMap((t: any) => t.projects.flatMap((p: any) => p.tasks));
// Estas dos funciones se serializan dentro de page.evaluate: se inyectan como texto junto al cuerpo de cada edición.
const HELPERS = `const reforma = ${reforma.toString()}; const allTasks = ${allTasks.toString()};`;
const editWith = (page: Page, fn: (s: typeof S) => void) => page.evaluate(`(() => { const S = ${JSON.stringify(S)}; ${HELPERS} (${fn.toString()})(S); if (!save()) throw new Error('save() devolvió false: ' + document.getElementById('toast').textContent); render(); })()`);
/** Como `editWith`, pero devuelve si `save()` aceptó el cambio y el aviso mostrado. */
const tryWith = (page: Page, fn: (s: typeof S) => void): Promise<{ saved: boolean; toast: string }> =>
  page.evaluate(`(() => { const S = ${JSON.stringify(S)}; ${HELPERS} (${fn.toString()})(S); const saved = save(); render(); return { saved, toast: document.getElementById('toast').textContent }; })()`);

test('jerarquía, papelera, áreas, dependencias, rechazos y permisos', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await open(context);

  await test.step('[12] mover una tarea a otro proyecto arrastra sus etiquetas', async () => {
    await editWith(a, (s) => {
      const from = reforma(s), to = state.tabs[0].projects.find((p: any) => p.id === s.jardin);
      const moving = from.tasks.filter((t: any) => t.id === s.puerta || t.parentId === s.puerta);
      from.tasks = from.tasks.filter((t: any) => !moving.includes(t)); to.tasks.push(...moving);
    });
    await settled(a);
    const rows = await server.rows('tasks.tasks');
    expect(rows.filter((r) => [S.puerta, S.marco, S.pedir].includes(r.id)).every((r) => r.project_id === S.jardin)).toBeTruthy();
    expect((await server.rows('tasks.task_labels')).find((r) => r.task_id === S.puerta).project_id).toBe(S.jardin);
  });

  await test.step('[13] un área nueva nace con una sola Entrada protegida y sus familias', async () => {
    await a.evaluate(() => (window as any).handleTopAction('newtab'));
    await a.locator('#tabName').fill('Taller');
    await a.locator('#createTab').click();
    await settled(a);
    const tab = (await server.rows('tasks.tabs')).find((r) => r.name === 'Taller');
    expect(tab).toBeTruthy();
    expect((await server.rows('tasks.projects')).filter((r) => r.tab_id === tab.id).map((r) => [r.system, r.title])).toEqual([['inbox', 'Entrada']]);
    expect((await server.rows('tasks.families')).filter((r) => r.tab_id === tab.id).map((r) => r.system_key).sort()).toEqual(['building', 'person', 'phase', 'space', 'trade']);
    await a.evaluate((obra) => { state.activeTab = obra; state.view = 'projects'; render(); }, S.obra);
  });

  await test.step('[14] completar hijas completa al padre; borrar el padre arrastra a las hijas; restaurar devuelve el lote', async () => {
    await editWith(a, (s) => { allTasks().find((t: any) => t.id === s.pedir).done = true; });
    await settled(a);
    expect((await taskOf(a, S.puerta)).done).toBe(true);
    expect((await serverTask(S.puerta)).done).toBe(false);
    await editWith(a, (s) => { allTasks().find((t: any) => t.id === s.puerta).deleted = true; });
    await settled(a);
    let rows = (await server.rows('tasks.tasks')).filter((r) => [S.puerta, S.marco, S.pedir].includes(r.id));
    expect(rows.every((r) => r.deleted_at)).toBeTruthy();
    // Restaurar desde la papelera, como hace la interfaz: todo el lote de borrado.
    await editWith(a, (s) => { const batch = allTasks().find((t: any) => t.id === s.marco).deleteBatch; for (const t of allTasks()) if (t.deleteBatch === batch) t.deleted = false; });
    await settled(a);
    rows = (await server.rows('tasks.tasks')).filter((r) => [S.puerta, S.marco, S.pedir].includes(r.id));
    expect(rows.every((r) => !r.deleted_at)).toBeTruthy();
  });

  await test.step('[19] renombrar, borrar y restaurar un área conserva su contenido', async () => {
    await editWith(a, (s) => { state.tabs.find((x: any) => x.id === s.personal).name = 'Casa'; });
    await settled(a);
    await editWith(a, (s) => { state.tabs.find((x: any) => x.id === s.personal).deleted = true; });
    await settled(a);
    const deleted = (await server.rows('tasks.tabs')).find((r) => r.id === S.personal);
    expect(deleted.name).toBe('Casa');
    expect(deleted.deleted_at).toBeTruthy();
    await editWith(a, (s) => { state.tabs.find((x: any) => x.id === s.personal).deleted = false; });
    await settled(a);
    expect((await server.rows('tasks.tabs')).find((r) => r.id === S.personal).deleted_at).toBeNull();
    expect((await server.rows('tasks.projects')).filter((r) => r.tab_id === S.personal && !r.deleted_at)).toHaveLength(1);
  });

  await test.step('[43] completar una tarea bloqueada se rechaza en la interfaz y en la API', async () => {
    const local = await tryWith(a, (s) => { allTasks().find((t: any) => t.id === s.pintar).done = true; });
    expect(local.saved).toBe(false);
    expect(await a.evaluate(() => Sync.record.queue.length)).toBe(0);
    const row = await serverTask(S.pintar);
    const remote = await server.commit([{ op: 'update', table: 'tasks.tasks', id: S.pintar, expectedRevision: row.revision, fields: { done: true } }]);
    expect([remote.status, remote.data.error.code]).toEqual([422, 'TASK_BLOCKED']);
    expect((await taskOf(a, S.pintar)).blocked).toBe(true);
  });

  await test.step('[45] una dependencia circular no entra en la cola', async () => {
    const result = await tryWith(a, (s) => { allTasks().find((t: any) => t.id === s.enfoscar).dependsOn = [s.pintar]; });
    expect(result.saved).toBe(false);
    expect(await a.evaluate(() => Sync.record.queue.length)).toBe(0);
    expect((await server.rows('tasks.task_dependencies')).filter((r) => r.task_id === S.enfoscar)).toHaveLength(0);
  });

  await test.step('[49][50] completar en secuencia sin red; una condición reabierta en remoto rechaza el lote y lo conserva', async () => {
    await context.setOffline(true);
    await editWith(a, (s) => { allTasks().find((t: any) => t.id === s.enfoscar).done = true; });
    await editWith(a, (s) => { allTasks().find((t: any) => t.id === s.pintar).done = true; });
    await a.waitForFunction(() => Sync.record.queue.length === 2);
    await context.setOffline(false);
    await a.evaluate(() => syncNow()); await settled(a);
    expect((await serverTask(S.pintar)).done).toBe(true);

    // Se reabre Pintar; sin red vuelve a completarla mientras otro dispositivo reabre Enfoscar.
    await editWith(a, (s) => { allTasks().find((t: any) => t.id === s.pintar).done = false; });
    await settled(a);
    await context.setOffline(true);
    await editWith(a, (s) => { allTasks().find((t: any) => t.id === s.pintar).done = true; });
    const enfoscar = await serverTask(S.enfoscar);
    expect((await server.commit([{ op: 'update', table: 'tasks.tasks', id: S.enfoscar, expectedRevision: enfoscar.revision, fields: { done: false } }], server.app.tokens.editor)).status).toBe(200);
    await context.setOffline(false);
    await a.evaluate(() => syncNow());
    await a.waitForFunction(() => Sync.mode === 'error');
    await expect(a.locator('#syncBadge')).toHaveText('Revisar guardado');
    expect(await a.evaluate(() => Sync.record.failure.code)).toBe('TASK_BLOCKED');
    expect((await serverTask(S.pintar)).done).toBe(false);
    await a.locator('#syncBadge').click();
    await a.locator('#syncFailure').click();
    await expect(a.locator('#sheet')).toContainText('Revisar lote fallido');
    await a.locator('#discardFailed').click();
    await settled(a);
    expect((await taskOf(a, S.pintar)).done).toBe(false);
    expect((await taskOf(a, S.enfoscar)).done).toBe(false);
  });

  await test.step('[16] Entrada protegida: el editor no deja renombrarla y el servidor rechaza el intento', async () => {
    await a.evaluate((inbox) => (window as any).openProjectEditor(inbox), S.obraInbox);
    await expect(a.locator('#peTitle')).toBeDisabled();
    await expect(a.locator('#peStatus')).toBeDisabled();
    await a.evaluate(() => (window as any).closeSheet());
    await editWith(a, (s) => { state.tabs[0].projects.find((p: any) => p.id === s.obraInbox).title = 'Bandeja'; });
    await a.waitForFunction(() => Sync.mode === 'error');
    expect(await a.evaluate(() => Sync.record.failure.code)).toBe('INBOX_PROTECTED');
    await a.evaluate(() => (window as any).showFailure());
    await a.locator('#discardFailed').click();
    await settled(a);
    expect(await a.evaluate((inbox) => state.tabs[0].projects.find((p: any) => p.id === inbox).title, S.obraInbox)).toBe('Entrada');
  });

  await test.step('[35] respuesta perdida tras confirmar: el reintento no duplica', async () => {
    server.app.supabase.loseNextCommitReply();
    await editWith(a, (s) => { reforma(s).tasks.push({ id: uid('t'), text: 'Una sola vez', note: '', done: false, priority: 'normal', due: '', labels: [], owner: null, parentId: null, order: 12000, attachments: [], dependsOn: [] }); });
    await a.waitForFunction(() => Sync.record.queue.length === 1 && !Sync.busy);
    await a.evaluate(() => syncNow()); await settled(a);
    expect((await server.rows('tasks.tasks')).filter((r) => r.title === 'Una sola vez')).toHaveLength(1);
  });

  await test.step('[5][22][60][65] etiquetas, vistas, colores e importes se guardan en el servidor', async () => {
    await editWith(a, (s) => {
      const tab = state.tabs.find((t: any) => t.id === s.obra);
      tab.labels.find((l: any) => l.id === s.carpinteria).text = 'Carpintería fina';
      tab.labels.find((l: any) => l.id === s.juan).archived = true;
      tab.views.push({ id: uid('view-'), name: 'Pendientes de Juan', search: '', filters: { _state: ['pending'], [tab.labels.find((l: any) => l.id === s.juan).family]: [s.juan] }, groupBy: 'state' });
      const project = reforma(s); project.color = '#b76b3d'; project.budget = 1800.5;
      project.tasks.find((t: any) => t.id === s.enfoscar).cost = 240;
      tab.color = '#46513b';
    });
    await settled(a);
    const labels = await server.rows('tasks.labels');
    expect(labels.find((r) => r.id === S.carpinteria).name).toBe('Carpintería fina');
    expect(labels.find((r) => r.id === S.juan).archived).toBe(true);
    expect((await server.rows('tasks.task_labels')).find((r) => r.task_id === S.puerta && !r.deleted_at).label_id).toBe(S.carpinteria);
    const view = (await server.rows('tasks.saved_views')).find((r) => r.name === 'Pendientes de Juan');
    expect(view.group_by).toBe('state');
    const project = (await server.rows('tasks.projects')).find((r) => r.id === S.reforma);
    expect([project.color, project.budget]).toEqual(['#b76b3d', 1800.5]);
    expect((await serverTask(S.enfoscar)).cost).toBe(240);
    await editWith(a, (s) => { state.tabs.find((t: any) => t.id === s.obra).views[0].deleted = true; });
    await settled(a);
    expect((await server.rows('tasks.saved_views')).find((r) => r.id === view.id).deleted_at).toBeTruthy();
    await editWith(a, (s) => { state.tabs.find((t: any) => t.id === s.obra).views[0].deleted = false; });
    await settled(a);
    expect((await server.rows('tasks.saved_views')).find((r) => r.id === view.id).deleted_at).toBeNull();
  });

  await test.step('[17] una segunda pestaña del mismo navegador queda en solo lectura', async () => {
    const second = await context.newPage();
    await second.goto(server.url + '/');
    await second.waitForFunction(() => typeof Sync !== 'undefined' && Sync.secondary === true && state.tabs.length > 0, null, { timeout: 20_000 });
    await expect(second.locator('#syncBadge')).toHaveText('Otra pestaña activa');
    const result = await tryWith(second, (s) => { reforma(s).tasks[0].note = 'desde la secundaria'; });
    expect(result.saved).toBe(false);
    await second.close();
  });

  await test.step('[37] cerrar sesión borra los datos locales y vuelve a pedir la cuenta', async () => {
    await a.evaluate(() => (window as any).sessionsSheet());
    await a.locator('#logoutAccount').click();
    await expect(a.locator('#accountLoginForm')).toBeVisible();
    await a.waitForFunction(() => Sync.mode === 'unauthorized' && Sync.actor === null && state.tabs.length === 0 && Sync.token === '');
    expect(await a.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve, reject) => { const r = indexedDB.open('ikisai-tasks-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const count: number = await new Promise((resolve) => { const r = db.transaction('tasks.tasks').objectStore('tasks.tasks').count(); r.onsuccess = () => resolve(r.result); });
      db.close(); return count;
    })).toBe(0);
  });
  await context.close();
  // El Auth simulado identifica la sesión con el usuario: tras el cierre de sesión hay que volver a abrirla para las pruebas siguientes.
  await server.app.t.createUser(server.app.users.owner);

  await test.step('[18] lector: interfaz y API en solo lectura', async () => {
    const readerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const r = await open(readerContext, READER);
    await expect(r.locator('#app')).toHaveAttribute('data-readonly', 'true');
    const result = await tryWith(r, (s) => { reforma(s).tasks[0].note = 'no debería'; });
    expect(result).toEqual({ saved: false, toast: 'Tu acceso es de solo lectura.' });
    const denied = await server.commit([{ op: 'update', table: 'tasks.tasks', id: S.enfoscar, expectedRevision: 1, fields: { note: 'x' } }], server.app.tokens.reader);
    expect(denied.status).toBe(403);
    await readerContext.close();
  });

  await test.step('un editor con acceso completo edita tareas', async () => {
    const editorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const e = await open(editorContext, EDITOR);
    await editWith(e, (s) => { reforma(s).tasks.find((t: any) => t.id === s.enfoscar).note = 'Nota de la editora'; });
    await settled(e);
    expect((await serverTask(S.enfoscar)).note).toBe('Nota de la editora');
    await editorContext.close();
  });
});

test('gestos reales: alta en línea, casilla, deshacer, papelera, historial y catálogo', async ({ browser }) => {
  test.setTimeout(240_000);
  const G = { project: id(100), parent: id(101), child: id(102), single: id(103), label: id(104) };
  const seeded = await server.commit([
    insert('tasks.projects', G.project, { tab_id: S.obra, title: 'Gestos', position: 9000 }),
    insert('tasks.tasks', G.parent, { tab_id: S.obra, project_id: G.project, title: 'Montar el andamio', position: 1024 }),
    insert('tasks.tasks', G.child, { tab_id: S.obra, project_id: G.project, title: 'Revisar anclajes', position: 2048, parent_id: G.parent }),
    insert('tasks.tasks', G.single, { tab_id: S.obra, project_id: G.project, title: 'Barrer', position: 3072 }),
    insert('tasks.labels', G.label, { tab_id: S.obra, family_id: families.phase, name: 'Acabados' }),
  ], server.app.tokens.editor);
  expect(seeded.status).toBe(200);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await open(context);
  await a.evaluate((obra) => { state.activeTab = obra; state.view = 'projects'; render(); }, S.obra);
  await a.locator(`[data-open-project="${G.project}"]`).first().click();

  await test.step('[58] la fila de alta escribe la tarea en el sitio y la guarda', async () => {
    await a.locator('[data-add-task]').first().click();
    await a.keyboard.type('Alicatar la ducha');
    await a.keyboard.press('Enter');
    await a.keyboard.press('Escape');
    await settled(a);
    expect((await server.rows('tasks.tasks')).filter((r) => r.title === 'Alicatar la ducha' && r.project_id === G.project)).toHaveLength(1);
  });

  await test.step('[68] completar con la casilla ofrece Deshacer, y deshacer restaura el estado en el servidor', async () => {
    await a.locator(`[data-toggle-task="${G.single}"]`).click();
    await settled(a);
    expect((await serverTask(G.single)).done).toBe(true);
    await a.locator('#undoNow').click({ timeout: 15_000 });
    await a.locator('#confirmUndo').click();
    await settled(a);
    expect((await serverTask(G.single)).done).toBe(false);
    await a.evaluate(() => (window as any).closeSheet());
  });

  await test.step('[14] enviar a la papelera un padre con su hija y restaurarlo desde la papelera', async () => {
    await a.locator(`[data-task-menu="${G.parent}"]`).click();
    await a.locator('#menuDelete').click();
    await settled(a);
    let rows = (await server.rows('tasks.tasks')).filter((r) => [G.parent, G.child].includes(r.id));
    expect(rows.every((r) => r.deleted_at) && rows[0].deleted_at === rows[1].deleted_at).toBeTruthy();
    await a.evaluate(() => (window as any).showTrash());
    await a.locator(`[data-restore-task$="${G.child}"]`).click();
    await settled(a);
    rows = (await server.rows('tasks.tasks')).filter((r) => [G.parent, G.child].includes(r.id));
    expect(rows.every((r) => !r.deleted_at)).toBeTruthy();
    await a.evaluate(() => (window as any).closeSheet());
  });

  await test.step('[31] el historial muestra los cambios con su autor', async () => {
    await a.evaluate(() => (window as any).handleTopAction('history'));
    await expect(a.locator('#sheet')).toContainText('Historial');
    await expect(a.locator('#sheet')).toContainText('Owner');
    await a.evaluate(() => (window as any).closeSheet());
  });

  await test.step('archivar una familia desde Etiquetas archiva sus etiquetas, y reactivarla las devuelve', async () => {
    await a.evaluate(() => { state.view = 'labels'; render(); });
    await a.locator(`[data-toggle-family="${families.phase}"]`).click();
    await settled(a);
    let label = (await server.rows('tasks.labels')).find((r) => r.id === G.label);
    expect([label.archived, label.archived_before_family]).toEqual([true, false]);
    expect((await server.rows('tasks.families')).find((r) => r.id === families.phase).archived).toBe(true);
    await a.locator(`[data-toggle-family="${families.phase}"]`).click();
    await settled(a);
    label = (await server.rows('tasks.labels')).find((r) => r.id === G.label);
    expect([label.archived, label.archived_before_family]).toEqual([false, null]);
  });

  await test.step('[26] sin errores de JavaScript y sin desbordes horizontales en móvil', async () => {
    await a.evaluate(() => { state.view = 'projects'; render(); });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= 390)).toBeTruthy();
  });
  await context.close();
});
