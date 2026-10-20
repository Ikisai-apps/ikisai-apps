/**
 * Ikisai Tasks · R6 PR 4 en el navegador (docs/tasks/API.md §37): coste de la tarea (materiales gastados × coste medio de
 * Recursos y costes a mano) y del proyecto frente al presupuesto. Los importes los ven la propietaria y el responsable de
 * compras del área; un editor ve las cantidades, sin importes, hasta que lo nombran responsable. Capturas en
 * coordinacion/tasks/r6-despues/.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, EDITOR, startE2EServer, type E2EServer } from './e2e-server.ts';
import { fichaBloque, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const Sync: any, openTaskEditor: any, state: any, render: any, manageTab: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, editor: Page;
const errors: string[] = [];
const ALMACEN = crypto.randomUUID(), LEJIA = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

const resources = async (operations: unknown[]) => {
  const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${crypto.randomUUID()}`, operations } });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const refresh = async (page: Page) => { await page.evaluate(() => (window as any).syncNow?.()); await settled(page); await page.evaluate(() => Sync.core.resources?.sync()); };
const openProject = (page: Page) => page.evaluate(([t, p]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; render(); }, [ID.ikisai!, ID.p1!]);
const openProjects = (page: Page) => page.evaluate((t) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'projects'; render(); }, ID.ikisai!);
const close = (page: Page) => page.evaluate(() => (window as any).closeSheet());
const shot = async (name: string) => { await owner.waitForTimeout(450); await owner.screenshot({ path: `../coordinacion/tasks/r6-despues/${name}.png` }).catch(() => {}); };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const altura = (await server.app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  await resources([{ op: 'insert', table: 'resources.spaces', id: ALMACEN, fields: { parent_id: altura, kind: 'edificio', name: 'Almacén', position: 1024 } }]);
  await resources([{ op: 'insert', table: 'resources.items', id: LEJIA, fields: { name: 'Lejía', kind: 'limpieza', base_unit: 'l', default_space_id: ALMACEN } }]);
  // Entrada con coste: 2 €/l. La tarea t1 gastó 1,5 l (apuntado al confirmar el consumo).
  await resources([{ op: 'insert', table: 'resources.movements', id: crypto.randomUUID(), fields: { item_id: LEJIA, space_id: ALMACEN, quantity: 10, kind: 'entrada_manual', unit_cost: 2 } }]);
  const task = (await server.rows('tasks.tasks')).find((t) => t.id === ID.t1)!;
  const res = await server.commit([{ op: 'insert', table: 'tasks.task_materials', id: crypto.randomUUID(), fields: { tab_id: task.tab_id, project_id: task.project_id, task_id: task.id, item_id: LEJIA, quantity: 2, consumed: 1.5 } }], server.app.tokens.owner);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  editor = await openApp(contextB, server, { user: EDITOR, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('la propietaria ve el coste: materiales × coste medio y un coste a mano; el proyecto lo suma', async () => {
  await refresh(owner);
  await owner.evaluate((id) => openTaskEditor(id), ID.t1);
  // Ficha «Portada y foco» (tanda 31): un solo «Coste», en la baldosa «Material y coste»; el campo suelto ya no se ve.
  await expect(owner.locator('[data-tkf-tile="material"]')).toContainText('Material y coste');
  await fichaBloque(owner, 'material');
  const box = owner.locator('#taskCosts');
  await expect(box.locator('.costline', { hasText: 'Lejía' })).toContainText('1,5 l × 2 €');
  await expect(box.locator('.costline', { hasText: 'Lejía' })).toContainText('3 €');
  await expect(owner.locator('#sheet .costfield')).toBeHidden();
  await box.locator('#costDesc').fill('Alquiler de andamio');
  await box.locator('#costAmount').fill('120');
  await box.locator('#costAdd').click();
  await expect.poll(async () => (await server.app.t.db.query<{ r: string; a: string }>(`select target_ref r, amount a from resources.cost_entries where deleted_at is null`)).rows.map((x) => [x.r, Number(x.a)]))
    .toEqual([[`task:${ID.t1}`, 120]]);
  await owner.evaluate(() => Sync.core.resources?.sync());
  await expect(owner.locator('#taskCostTotal')).toHaveText('123 €');
  await shot('22-coste-tarea');
  await close(owner);
  await openProject(owner);
  await expect(owner.locator('main .money')).toContainText('123 €');
  await shot('23-coste-proyecto');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('un editor (sin ser responsable de compras) ve los materiales, pero no los importes', async () => {
  await refresh(editor);
  await editor.evaluate((id) => openTaskEditor(id), ID.t1);
  // Sin importes, la baldosa se llama «Material» y no lleva euros.
  await expect(editor.locator('[data-tkf-tile="material"] .tkf-tname')).toHaveText(/^Material(\s|$)/);
  await expect(editor.locator('[data-tkf-tile="material"]')).not.toContainText('€');
  await fichaBloque(editor, 'material');
  await expect(editor.locator('#taskMaterials .materialrow')).toContainText('Lejía');
  await expect(editor.locator('#taskCosts')).toHaveCount(0);
  await expect(editor.locator('#sheet .costfield')).toBeHidden();
  await close(editor);
  await openProject(editor);
  await expect(editor.locator('main .money')).toHaveCount(0);
  await openProjects(editor);
  await expect(editor.locator('.project .money')).toHaveCount(0);
  await expect(editor.locator('.task .cost')).toHaveCount(0);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('al nombrarlo responsable de compras del área, ve los importes', async () => {
  const editorId = (await server.app.t.db.query<{ user_id: string }>(`select user_id from core.memberships where app = 'tasks' and role = 'editor' and scopes is null`)).rows[0]!.user_id;
  await owner.evaluate(() => manageTab());
  await owner.locator('#tabApprover').selectOption(editorId);
  await expect.poll(async () => (await server.rows('tasks.tabs')).find((t) => t.id === ID.ikisai)?.purchase_approver_id).toBe(editorId);
  await settled(owner);
  await close(owner);
  await refresh(editor);
  await editor.evaluate((id) => openTaskEditor(id), ID.t1);
  await expect(editor.locator('#taskCostTotal')).toHaveText('123 €');
  await close(editor);
  await openProject(editor);
  await expect(editor.locator('main .money')).toContainText('123 €');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('el «Coste (€)» de antes sigue tras guardar, sale en «Coste» y se corrige con el lápiz o se quita con «×»', async () => {
  // Un valor del campo antiguo, como lo dejaba la ficha de antes.
  await refresh(owner);
  await owner.evaluate((id) => { const loc = (window as any).taskLocation(id); loc.t.cost = 40; (window as any).touch(loc.t); (window as any).record('edit', [id]); (window as any).save(); }, ID.t1);
  await settled(owner);
  const row = async () => (await server.rows('tasks.tasks')).find((t) => t.id === ID.t1)!;
  expect(Number((await row()).cost)).toBe(40);
  await owner.evaluate((id) => openTaskEditor(id), ID.t1);
  // Guardar otra cosa de la ficha no lo toca: el campo oculto lo sigue guardando.
  await fichaBloque(owner, 'nota');
  await owner.locator('#teNote').fill('Con coste antiguo');
  await owner.locator('#saveTaskBtn').click();
  await settled(owner);
  expect(Number((await row()).cost)).toBe(40);
  await owner.evaluate((id) => openTaskEditor(id), ID.t1);
  const box = await fichaBloque(owner, 'material');
  const line = box.locator('#taskCosts [data-cost-legacy]');
  await expect(line).toContainText('Coste (€) de la tarea');
  await expect(line).toContainText('40 €');
  await line.locator('[data-cost-legacy-edit]').click();
  await owner.locator('#costLegacyInput').fill('45');
  await owner.locator('#costLegacyInput').press('Enter');
  await settled(owner);
  await expect.poll(async () => Number((await row()).cost)).toBe(45);
  await expect(owner.locator('#taskCosts [data-cost-legacy]')).toContainText('45 €');
  await expect(owner.locator('#teCost')).toHaveValue('45');
  await owner.locator('#taskCosts [data-cost-legacy-remove]').click();
  await settled(owner);
  await expect.poll(async () => (await row()).cost ?? null).toBeNull();
  await expect(owner.locator('#taskCosts [data-cost-legacy]')).toHaveCount(0);
  // «Deshacer» lo devuelve.
  await owner.locator('.ikisai-toast span', { hasText: 'Coste (€) de la tarea quitado' }).locator('xpath=following-sibling::button').click();
  await settled(owner);
  await expect.poll(async () => Number((await row()).cost)).toBe(45);
  await close(owner);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
