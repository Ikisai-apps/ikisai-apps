/**
 * Ikisai Tasks · la ficha con cinco apartados que se editan en su sitio (ficha-cinco-ui.js; VG 06-11): la fase con la actual
 * marcada y las de antes en gris (elegibles) y el lápiz de «Etiquetas › Fases»; las etiquetas libres se añaden escribiendo y
 * se quitan con ×; las baldosas «Quién» y «Etiquetas» ya no se ven; la lectora ve el bloque sin poder cambiarlo. Datos
 * sintéticos.
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
const MVP = crypto.randomUUID(), F1 = crypto.randomUUID(), F2 = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

const openTask = async (page: Page) => {
  await page.evaluate(async ([t, p, id]) => { await syncNow(); closeSheet(); state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; render(); openTaskEditor(id); }, [ID.ikisai, projectId, taskId]);
  await settled(page);
  await expect(page.locator('#sheet #tk5')).toBeVisible();
};
const task = async () => (await server.rows('tasks.tasks')).find((t: any) => t.id === taskId);
const tagNames = async () => {
  const labels = await server.rows('tasks.labels');
  return (await server.rows('tasks.task_labels')).filter((r: any) => r.task_id === taskId && !r.deleted_at).map((r: any) => labels.find((l: any) => l.id === r.label_id)?.name).sort();
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const out = await server.app.call('/api/v1/commands', { body: { requestId: 'cinco-seed', operations: [
    { op: 'insert', table: 'tasks.projects', id: projectId, fields: { tab_id: ID.ikisai, title: 'Reforma del albergue', position: 99_000 } },
    { op: 'insert', table: 'tasks.project_phases', id: MVP, fields: { tab_id: ID.ikisai, project_id: projectId, name: 'MVP', position: 1024 } },
    { op: 'insert', table: 'tasks.project_phases', id: F1, fields: { tab_id: ID.ikisai, project_id: projectId, name: 'Fase 1', position: 2048, is_current: true } },
    { op: 'insert', table: 'tasks.project_phases', id: F2, fields: { tab_id: ID.ikisai, project_id: projectId, name: 'Fase 2', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: taskId, fields: { tab_id: ID.ikisai, project_id: projectId, title: 'Cambiar el grifo de la Hab 3', position: 1024 } },
  ] } });
  expect(out.status, JSON.stringify(out.data)).toBe(200);
  contextA = await browser.newContext({ viewport: { width: 400, height: 860 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  reader = await openApp(contextB, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('la fase: la actual elegida en la tarea nueva, las de antes en gris y elegibles; sin la página de todos los campos', async () => {
  expect((await task()).phase_id, 'la tarea nueva recibe la actual (0367)').toBe(F1);
  await openTask(owner);
  const card = owner.locator('#tk5 [data-tk5="fase"]');
  await expect(card.locator(`[data-tkph-pick="${F1}"]`)).toHaveAttribute('aria-checked', 'true');
  await expect(card.locator(`[data-tkph-pick="${MVP}"]`)).toHaveClass(/past/);
  await expect(card.locator(`[data-tkph-pick="${F2}"]`)).not.toHaveClass(/past/);
  await card.locator(`[data-tkph-pick="${MVP}"]`).click();
  await expect.poll(async () => (await task()).phase_id).toBe(MVP);
  // Las baldosas «Quién» y «Etiquetas» ya no se ven: lo suyo está en los apartados.
  for (const key of ['quien', 'etiquetas']) await expect(owner.locator(`#sheet [data-tkf-tile="${key}"]`)).toBeHidden();
  await expect(owner.locator('#sheet [data-tkf-tile="nota"]')).toBeVisible();
});

test('el lápiz abre «Etiquetas › Fases»: la actual se cambia ahí, sin fechas', async () => {
  await openTask(owner);
  await owner.locator('#tk5PhaseEdit').click();
  await expect(owner.locator('#sheet .sheettitle')).toHaveText('Etiquetas › Fases');
  await expect(owner.locator('#sheet input[type="date"]')).toHaveCount(0);
  await owner.locator('[data-tk5-pc="2"]').check();
  await owner.locator('#tk5PhSave').click();
  await expect.poll(async () => (await server.rows('tasks.project_phases')).filter((p: any) => p.project_id === projectId && p.is_current).map((p: any) => p.id)).toEqual([F2]);
  await expect(owner.locator('#sheet #tk5')).toBeVisible();
});

test('etiquetas libres: se añaden escribiendo y se quitan con ×', async () => {
  await openTask(owner);
  await owner.locator('#tk5TagIn').fill('urgente');
  await owner.locator('#tk5TagIn').press('Enter');
  await expect.poll(tagNames).toEqual(['urgente']);
  await expect(owner.locator('#tk5 [data-tk5="etiquetas"] .tk5-chip')).toHaveText(['urgente×']);
  await owner.locator('#tk5 [data-tk5-untag]').click();
  await expect.poll(tagNames).toEqual([]);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('la lectora ve los apartados sin poder cambiarlos', async () => {
  await openTask(reader);
  await expect(reader.locator('#tk5TagIn')).toHaveCount(0);
  await expect(reader.locator('#tk5PhaseEdit')).toHaveCount(0);
  for (const b of await reader.locator('#tk5 [data-tk5-tap]').all()) await expect(b).toBeDisabled();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
