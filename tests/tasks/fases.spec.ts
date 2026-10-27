/**
 * Ikisai Tasks · las fases del proyecto en la app (fases-ui.js, docs/tasks/API.md §51): crear dos fases desde la banda,
 * poner una tarea en una fase desde su ficha, cerrar con tareas abiertas solo con nota, quitar una fase deja su tarea sin
 * fase, y la lectora ve la banda sin «+ Fase». Datos sintéticos.
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
const phases = async () => (await server.rows('tasks.project_phases')).filter((p: any) => p.project_id === projectId && !p.deleted_at);
const phaseOfTask = async () => (await server.rows('tasks.tasks')).find((t: any) => t.id === taskId)?.phase_id ?? null;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const out = await server.app.call('/api/v1/commands', { body: { requestId: 'fases-seed', operations: [
    { op: 'insert', table: 'tasks.projects', id: projectId, fields: { tab_id: ID.ikisai, title: 'Marcos acústicos', position: 99_000 } },
    { op: 'insert', table: 'tasks.tasks', id: taskId, fields: { tab_id: ID.ikisai, project_id: projectId, title: 'Cortar listones', position: 1024 } },
  ] } });
  expect(out.status, JSON.stringify(out.data)).toBe(200);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  reader = await openApp(contextB, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('crear dos fases desde la banda del proyecto', async () => {
  await showProject(owner);
  const band = owner.locator('#tkphBand');
  for (const name of ['Cortar', 'Montar']) {
    await band.locator('#tkphNew').click();
    await owner.locator('#tkphName').fill(name);
    await owner.locator('#tkphSave').click();
    await expect.poll(async () => (await phases()).map((p: any) => p.name)).toContain(name);
  }
  await showProject(owner);
  await expect(band).toContainText('Cortar');
  await expect(band).toContainText('Montar');
});

test('la tarea va a una fase desde su ficha', async () => {
  const cortar = (await phases()).find((p: any) => p.name === 'Cortar');
  await owner.evaluate((id) => openTaskEditor(id), taskId);
  await owner.locator('#tkphTask').selectOption(cortar.id);
  await expect.poll(phaseOfTask).toBe(cortar.id);
  await showProject(owner);
  await expect(owner.locator('#tkphBand')).toContainText('0 de 1');
});

test('cerrar con la tarea abierta pide nota', async () => {
  const cortar = (await phases()).find((p: any) => p.name === 'Cortar');
  await owner.locator(`[data-tkph="${cortar.id}"]`).click();
  await owner.locator('#tkphStatus').selectOption('done');
  await owner.locator('#tkphSave').click();
  await expect(owner.locator('#sheet')).toBeVisible();
  expect((await phases()).find((p: any) => p.id === cortar.id).status).toBe('pending');
  await owner.locator('#tkphNote').fill('Los listones que faltan llegan la semana que viene.');
  await owner.locator('#tkphSave').click();
  await expect.poll(async () => (await phases()).find((p: any) => p.id === cortar.id).status).toBe('done');
});

test('quitar una fase deja su tarea sin fase', async () => {
  await showProject(owner);
  const cortar = (await phases()).find((p: any) => p.name === 'Cortar');
  await owner.locator(`[data-tkph="${cortar.id}"]`).click();
  await owner.locator('#tkphDel').click();
  await expect.poll(async () => (await phases()).map((p: any) => p.name)).toEqual(['Montar']);
  await expect.poll(phaseOfTask).toBe(null);
});

test('la lectora ve las fases, sin «+ Fase» ni guardar', async () => {
  await showProject(reader);
  const band = reader.locator('#tkphBand');
  await expect(band).toContainText('Montar');
  await expect(band.locator('#tkphNew')).toHaveCount(0);
  await band.locator('[data-tkph]').first().click();
  await expect(reader.locator('#tkphSave')).toHaveCount(0);
  await expect(reader.locator('#tkphName')).toBeDisabled();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
