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

const settled = (page: Page) => page.waitForFunction(() => {
  return typeof Sync !== 'undefined' && Sync.mode === 'online' && !Sync.busy && Sync.record.queue.length === 0;
}, null, { timeout: 20_000 });

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
