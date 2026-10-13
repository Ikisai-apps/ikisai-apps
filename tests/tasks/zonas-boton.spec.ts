/**
 * Ikisai Tasks · R2, PR 3: la vista previa y el botón «Pasar las zonas a espacios», y la vuelta atrás desde «Espacios».
 * Solo la propietaria con acceso a todo lo ve. Una zona sin espacio en uso bloquea hasta marcarla «Quitar»; tras pulsar,
 * la app pasa sola a modo espacios (chips «Albergue › Hab 3»), y al volver, a las etiquetas de antes.
 * Capturas en `coordinacion/tasks/r2-despues/`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, EDITOR, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, navigationGroups: any, handleTopAction: any, navigateView: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), PINTURA = id(), ZONA = id(), ALBERGUE = id(), HAB3 = id(), TRASTERO = id(), S_ALB = id(), S_HAB3 = id();
const T_HAB = id(), T_TRAST = id();
let seq = 0;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ id: MANT, name: 'Mantenimiento', position: 90_000 }));
  await ok([{ op: 'insert', table: 'tasks.families', id: ZONA, fields: { tab_id: null, name: 'Zona: Espacio', color: '#9c744e', position: 1 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: ALBERGUE, fields: { tab_id: null, family_id: ZONA, name: 'Albergue', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: TRASTERO, fields: { tab_id: null, family_id: ZONA, name: 'Trastero viejo', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PINTURA, fields: { tab_id: MANT, title: 'Pintura', position: 2048 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: HAB3, fields: { tab_id: null, family_id: ZONA, parent_id: ALBERGUE, name: 'Hab 3', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_HAB, fields: { tab_id: MANT, project_id: PINTURA, title: 'Pintar Hab 3', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_TRAST, fields: { tab_id: MANT, project_id: PINTURA, title: 'Vaciar trastero', position: 2048 } },
  ]);
  const tl = (task: string, label: string) => ({ op: 'insert', table: 'tasks.task_labels', id: id(), fields: { tab_id: MANT, project_id: PINTURA, task_id: task, label_id: label } });
  await ok([tl(T_HAB, ALBERGUE), tl(T_HAB, HAB3), tl(T_TRAST, TRASTERO)]);
  const altura = (await server.app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  const space = (sid: string, parent: string, kind: string, name: string, label: string) =>
    ({ op: 'insert', table: 'resources.spaces', id: sid, fields: { parent_id: parent, kind, name, position: 1024, source_refs: [`tasks.label:${label}`] } });
  for (const operations of [[space(S_ALB, altura, 'edificio', 'Albergue', ALBERGUE)], [space(S_HAB3, S_ALB, 'habitacion', 'Hab 3', HAB3)]]) {
    const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${++seq}`, operations } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  }
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const chipsOf = (task: string) => page.locator(`.task:has([data-toggle-task="${task}"]) .taskchips .chip`);
const source = () => page.evaluate(() => (window as any).eval('Sync.core.zoneSource()'));
const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `../coordinacion/tasks/r2-despues/${name}.png` }).catch(() => {}); };
const openProject = () => page.evaluate(([t, p]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; state.filters = {}; state.search = ''; render(); }, [MANT, PINTURA]);
const menuItems = (p: Page) => p.evaluate(() => navigationGroups().flatMap((g: any) => g.items.map((i: any) => i[0])));

test('el botón solo lo ve la propietaria; la vista previa bloquea hasta resolver la zona sin espacio', async () => {
  expect(await menuItems(page)).toContain('zonesToSpaces');
  const editorContext = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
  const editor = await openApp(editorContext, server, { user: EDITOR, aliases: ID });
  expect(await menuItems(editor)).not.toContain('zonesToSpaces');
  await editorContext.close();

  await page.evaluate(() => handleTopAction('zonesToSpaces'));
  const sheet = page.locator('#sheet');
  await expect(sheet).toContainText('Hab 3 → Albergue › Hab 3');
  await expect(sheet).toContainText('Por resolver (1)');
  await expect(sheet).toContainText('Trastero viejo · sin espacio · 1 tarea');
  await expect(sheet).toContainText('1 se queda sin espacio');
  await expect(page.locator('#zonesApply')).toBeDisabled();
  await shot('9-vista-previa-por-resolver');
  await page.locator(`[data-zone-remove="${TRASTERO}"]`).check();
  await expect(sheet).toContainText('Se quitan (1)');
  // Quitarla no le da espacio a su tarea: la vista previa lo sigue diciendo.
  await expect(sheet).toContainText('Trastero viejo · 1 tarea · 1 se queda sin espacio');
  await expect(page.locator('#zonesApply')).toBeEnabled();
  await shot('10-vista-previa-lista');
});

test('al pulsar, la app pasa sola a espacios; y «Volver a las zonas» la deja como estaba', async () => {
  await page.locator('#zonesApply').click();
  await expect.poll(source).toBe('spaces');
  await openProject();
  await expect(chipsOf(T_HAB)).toHaveText(['Albergue › Hab 3']);
  await expect(chipsOf(T_TRAST)).toHaveCount(0);
  expect(await menuItems(page)).not.toContain('zonesToSpaces');
  expect(await menuItems(page)).toContain('spaces');

  await page.evaluate(() => navigateView('spaces'));
  await page.locator('#spacesToZones').click();
  await expect(page.locator('#sheet')).toContainText('Las zonas vuelven a ser etiquetas');
  await shot('11-volver-a-las-zonas');
  await page.locator('#zonesBackApply').click();
  await expect.poll(source).toBe('labels');
  await settled(page);
  await openProject();
  // Como antes de pasar: la tarea vuelve a tener la madre y la hija (y, al ser su única hija, la chip dice la madre, FB_2026_021).
  const labels = (await server.rows('tasks.task_labels')).filter((r) => r.task_id === T_HAB && !r.deleted_at).map((r) => r.label_id).sort();
  expect(labels).toEqual([ALBERGUE, HAB3].sort());
  await expect(chipsOf(T_HAB)).toHaveText(['Albergue']);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
