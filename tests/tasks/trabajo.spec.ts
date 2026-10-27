/**
 * Ikisai Tasks · «Vista de trabajo» de la tarea (FB_2026_071; VG eligió «Mesa de trabajo» con «Todo» y «Preparar» plegado):
 * la baldosa abre la mesa con todo lo que necesita la tarea y sus pasos (máquinas, sus EPI de Recursos con la parte del
 * cuerpo y materiales); tocar un paso deja solo lo suyo y «Todo» vuelve; «Preparar» sale plegado y se marca; un paso pasa a
 * «En cualquier momento» y se guarda; la lectora no tiene controles que guarden. Datos sintéticos.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { fichaBloque, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const state: any, render: any, openTaskEditor: any, Sync: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, reader: Page;
const errors: string[] = [];
const RADIAL = crypto.randomUUID(), GAFAS = crypto.randomUUID(), TUBO = crypto.randomUUID(), CORTAR = crypto.randomUUID(), MONTAR = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

const resources = async (operations: unknown[]) => {
  const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${crypto.randomUUID()}`, operations } });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const openTask = async (page: Page) => {
  await page.evaluate(async ([t, p, id]) => { await Sync.core.resources?.sync(); state.taskScope = 'area'; state.activeTab = t; state.filters = {}; state.search = ''; state.view = 'project'; state.currentProject = p; render(); openTaskEditor(id); }, [ID.ikisai!, ID.p1!, ID.t1!]);
  return fichaBloque(page, 'trabajo');
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  await resources([
    { op: 'insert', table: 'resources.items', id: RADIAL, fields: { name: 'Radial de prueba', kind: 'maquina', base_unit: 'ud' } },
    { op: 'insert', table: 'resources.items', id: GAFAS, fields: { name: 'Gafas de prueba', kind: 'epi', base_unit: 'ud', attributes: { body_parts: ['eyes'] } } },
    { op: 'insert', table: 'resources.items', id: TUBO, fields: { name: 'Tubo de prueba', kind: 'material', base_unit: 'm' } },
  ]);
  await resources([{ op: 'insert', table: 'resources.item_links', id: crypto.randomUUID(), fields: { item_id: RADIAL, linked_item_id: GAFAS } }]);
  const task = (await server.rows('tasks.tasks')).find((t) => t.id === ID.t1)!;
  const at = { tab_id: task.tab_id, project_id: task.project_id };
  let res = await server.commit([
    { op: 'insert', table: 'tasks.tasks', id: CORTAR, fields: { ...at, parent_id: task.id, title: 'Cortar el tramo viejo', position: 900001 } },
    { op: 'insert', table: 'tasks.tasks', id: MONTAR, fields: { ...at, parent_id: task.id, title: 'Montar el tubo nuevo', position: 900002 } },
  ], server.app.tokens.owner);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  res = await server.commit([
    { op: 'insert', table: 'tasks.task_materials', id: crypto.randomUUID(), fields: { ...at, task_id: CORTAR, item_id: RADIAL } },
    { op: 'insert', table: 'tasks.task_materials', id: crypto.randomUUID(), fields: { ...at, task_id: MONTAR, item_id: TUBO, quantity: 6 } },
  ], server.app.tokens.owner);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  reader = await openApp(contextB, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('la mesa: «Todo» con máquinas, sus EPI y materiales; un paso deja solo lo suyo; «Preparar» plegado y se marca', async () => {
  const mesa = await openTask(owner);
  const need = mesa.locator('#tkwNeed');
  await expect(mesa.locator('#tkwAll')).toHaveAttribute('aria-pressed', 'true');
  await expect(need).toContainText('Radial de prueba');
  await expect(need).toContainText('Gafas de prueba · Ojos');
  await expect(need).toContainText('Tubo de prueba · 6 m');

  await mesa.getByRole('button', { name: /Cortar el tramo viejo/ }).click();
  await expect(mesa.locator('#tkwAll')).toHaveAttribute('aria-pressed', 'false');
  await expect(need).toContainText('Radial de prueba');
  await expect(need).toContainText('Gafas de prueba');
  await expect(need).not.toContainText('Tubo de prueba');
  await mesa.locator('#tkwAll').click();
  await expect(need).toContainText('Tubo de prueba');

  const prep = mesa.locator('#tkwPrep');
  await expect(prep).not.toHaveAttribute('open', '');
  await prep.locator('summary').click();
  const boxes = prep.locator('[data-tkw-prep]');
  await expect(boxes).toHaveCount(3);
  await expect(prep).toContainText('la pide Radial de prueba');
  for (const box of await boxes.all()) await box.check();
  await expect(prep.locator('#tkwPrepLeft')).toContainText('todo listo');
});

test('fuera de orden: con «Pasos en orden», un paso pasa a «En cualquier momento» y se guarda', async () => {
  await fichaBloque(owner, 'pasos');
  const inOrder = owner.locator('#stepsInOrder');
  if (!(await inOrder.isChecked())) await inOrder.check();
  await settled(owner);
  const mesa = await fichaBloque(owner, 'trabajo');
  await expect(mesa.getByRole('heading', { name: /Pasos en orden/ })).toBeVisible();
  await mesa.getByRole('button', { name: /Montar el tubo nuevo/ }).click();
  await mesa.locator('#tkwFree').click();
  await expect(mesa.locator('.tkw-step.free')).toContainText('Montar el tubo nuevo');
  await settled(owner);
  await expect.poll(async () => (await server.rows('tasks.tasks')).find((t) => t.id === MONTAR)?.step_free).toBe(true);
  // «+ Paso» añade una hija.
  await mesa.locator('#tkwNewStep').fill('Probar sin fugas');
  await mesa.locator('#tkwAddStep').click();
  await expect(mesa.locator('.tkw-step', { hasText: 'Probar sin fugas' })).toHaveCount(1);
  await settled(owner);
  await expect.poll(async () => (await server.rows('tasks.tasks')).some((t) => t.parent_id === ID.t1 && t.title === 'Probar sin fugas' && !t.deleted_at)).toBe(true);
});

test('la lectora ve la mesa sin controles que guarden', async () => {
  const mesa = await openTask(reader);
  await expect(mesa.locator('#tkwNeed')).toContainText('Radial de prueba');
  await expect(mesa.locator('#tkwNewStep')).toHaveCount(0);
  for (const b of await mesa.locator('[data-tkw-done]').all()) await expect(b).toBeDisabled();
  expect(errors, errors.join('\n')).toEqual([]);
});
