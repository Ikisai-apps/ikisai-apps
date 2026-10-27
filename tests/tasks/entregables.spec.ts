/**
 * Ikisai Tasks · entregables y unidades en la app (entregables-ui.js, docs/tasks/API.md §55 y §57): crear un entregable
 * desde la banda, ponerlo en una tarea, darle unidades a la tarea y marcarlas una a una hasta que queda hecha, marcarlo
 * entregado, y la lectora sin controles. Datos sintéticos.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const state: any, render: any, openTaskEditor: any, syncNow: any, closeSheet: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, reader: Page;
const errors: string[] = [];
const projectId = crypto.randomUUID(), taskId = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

const showProject = async (page: Page) => {
  await page.evaluate(async ([t, p]) => { await syncNow(); closeSheet(); state.taskScope = 'area'; state.activeTab = t; state.filters = {}; state.search = ''; state.view = 'project'; state.currentProject = p; render(); }, [ID.ikisai, projectId]);
  await settled(page);
};
const deliverables = async () => (await server.rows('tasks.project_deliverables')).filter((d: any) => d.project_id === projectId && !d.deleted_at);
const theTask = async () => (await server.rows('tasks.tasks')).find((t: any) => t.id === taskId);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const out = await server.app.call('/api/v1/commands', { body: { requestId: 'entregables-seed', operations: [
    { op: 'insert', table: 'tasks.projects', id: projectId, fields: { tab_id: ID.ikisai, title: 'Marcos acústicos', position: 99_000 } },
    { op: 'insert', table: 'tasks.tasks', id: taskId, fields: { tab_id: ID.ikisai, project_id: projectId, title: 'Montar marcos', position: 1024 } },
  ] } });
  expect(out.status, JSON.stringify(out.data)).toBe(200);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  reader = await openApp(contextB, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('crear un entregable desde la banda del proyecto', async () => {
  await showProject(owner);
  await owner.locator('#tkdvNew').click();
  await owner.locator('#tkdvName').fill('2 marcos acústicos');
  await owner.locator('#tkdvQty').fill('2');
  await owner.locator('#tkdvSave').click();
  await expect.poll(async () => (await deliverables()).map((d: any) => [d.name, Number(d.quantity)])).toEqual([['2 marcos acústicos', 2]]);
});

test('la tarea: su entregable y sus unidades desde la ficha', async () => {
  const d = (await deliverables())[0];
  await owner.evaluate((id) => openTaskEditor(id), taskId);
  await owner.locator('#tkdvTask').selectOption(d.id);
  await expect.poll(async () => (await theTask()).deliverable_id).toBe(d.id);
  await owner.evaluate((id) => openTaskEditor(id), taskId);
  await owner.locator('#tkdvUnits').fill('2');
  await owner.locator('#tkdvUnits').dispatchEvent('change');
  await expect.poll(async () => (await theTask()).unit_count).toBe(2);
});

test('marcar las unidades una a una: con las dos, la tarea queda hecha', async () => {
  await owner.evaluate(async (id) => { await syncNow(); openTaskEditor(id); }, taskId);
  await owner.locator('[data-tkdv-unit="1"]').click();
  await expect.poll(async () => (await server.rows('tasks.task_units')).filter((u: any) => u.task_id === taskId && !u.deleted_at).length).toBe(1);
  expect((await theTask()).done).toBe(false);
  await owner.locator('[data-tkdv-unit="2"]').click();
  await expect.poll(async () => (await theTask()).done).toBe(true);
});

test('marcar el entregable como entregado', async () => {
  await showProject(owner);
  const d = (await deliverables())[0];
  await expect(owner.locator('#tkdvBand')).toContainText('Hecho');
  await owner.locator(`[data-tkdv="${d.id}"]`).click();
  await owner.locator('#tkdvStatus').selectOption('delivered');
  await owner.locator('#tkdvSave').click();
  await expect.poll(async () => (await deliverables())[0].status).toBe('delivered');
});

test('la lectora ve los entregables, sin «+ Entregable» ni guardar', async () => {
  await showProject(reader);
  const band = reader.locator('#tkdvBand');
  await expect(band).toContainText('Entregado');
  await expect(band.locator('#tkdvNew')).toHaveCount(0);
  await band.locator('[data-tkdv]').first().click();
  await expect(reader.locator('#tkdvSave')).toHaveCount(0);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
