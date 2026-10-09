/**
 * Ikisai Tasks · catálogo General de etiquetas, interfaz (FB_2026_023): «Repetidas → General» en «Etiquetas», con la
 * vista previa de los grupos y los parecidos, la fusión, y la app trabajando después con lo General (sale en todas las
 * áreas, se guarda una vez). La lógica del servidor la prueba a fondo `general.test.ts`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, tab: any, label: any, save: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const A = crypto.randomUUID(), B = crypto.randomUUID(), VG_A = crypto.randomUUID(), VG_B = crypto.randomUUID(), JARDIN = crypto.randomUUID(), JARDIN2 = crypto.randomUUID(), T = crypto.randomUUID(), P = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const a = createTabOps({ id: A, name: 'Casa', position: 90_000 }), b = createTabOps({ id: B, name: 'Finca', position: 91_000 });
  const person = (ops: any[]) => ops.find((o) => o.fields?.system_key === 'person').id, phase = (ops: any[]) => ops.find((o) => o.fields?.system_key === 'phase').id;
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok([...a, ...b]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: VG_A, fields: { tab_id: A, family_id: person(a), name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: VG_B, fields: { tab_id: B, family_id: person(b), name: 'VG', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: JARDIN, fields: { tab_id: A, family_id: phase(a), name: 'Jardín', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: JARDIN2, fields: { tab_id: B, family_id: phase(b), name: 'jardin.', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: A, title: 'Seto', position: 2048 } },
  ]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: T, fields: { tab_id: A, project_id: P, title: 'Podar', owner_label_id: VG_A, position: 1024 } }]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases: ID, errors });
  await page.evaluate((id) => { state.activeTab = id; state.view = 'labels'; render(); }, A);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('vista previa: el grupo repetido y los parecidos; fusionar crea la General y archiva las copias', async () => {
  await page.locator('#generalMergeOpen').click();
  const group = page.locator('.generalgroup', { hasText: 'VG' });
  await expect(group).toContainText('en 2 áreas');
  await expect(group.locator('input')).toBeChecked();
  await expect(page.locator('#sheet .notice')).toContainText('Jardín');
  await page.screenshot({ path: '../coordinacion/tasks/general-vista-previa-movil.png' }).catch(() => {});
  await page.locator('#generalMerge').click();
  await expect.poll(async () => (await server.rows('tasks.labels')).filter((l) => l.tab_id === null && l.name === 'VG' && !l.deleted_at).length, { timeout: 15_000 }).toBe(1);
  await settled(page);
  const general = (await server.rows('tasks.labels')).find((l) => l.tab_id === null && l.name === 'VG');
  expect((await server.rows('tasks.labels')).filter((l) => [VG_A, VG_B].includes(l.id)).every((l) => l.archived)).toBe(true);
  expect((await server.rows('tasks.tasks')).find((t) => t.id === T).owner_label_id).toBe(general.id);
  // En la app, la General sale en las dos áreas, marcada.
  for (const area of [A, B]) expect(await page.evaluate(([a, g]) => state.tabs.find((t: any) => t.id === a).labels.find((l: any) => l.id === g)?.general, [area, general.id])).toBe(true);
  await expect(page.locator('#generalMergeOpen')).toHaveCount(0);
});

test('después, la app guarda con lo General: renombrarla desde un área la cambia una sola vez', async () => {
  const general = (await server.rows('tasks.labels')).find((l) => l.tab_id === null && l.name === 'VG');
  await page.evaluate((g) => { state.activeTab = state.tabs.find((t: any) => t.name === 'Finca').id; label(g).text = 'VG Gil'; save(); render(); }, general.id);
  await settled(page);
  const after = (await server.rows('tasks.labels')).filter((l) => l.tab_id === null && !l.deleted_at);
  expect(after.find((l) => l.id === general.id).name).toBe('VG Gil');
  expect(after.filter((l) => l.name.startsWith('VG')).length).toBe(1);
  // Y vale en una tarea de otra área.
  await page.evaluate((g) => { const t = tab(); const p = t.projects.find((x: any) => x.system === 'inbox'); p.tasks.push({ id: crypto.randomUUID(), text: 'En Finca con VG', note: '', done: false, priority: 'normal', due: '', labels: [g], owner: g, parentId: null, order: 99999, attachments: [], deleted: false, deletedAt: null, deleteBatch: null, dependsOn: [], cost: null, version: 0, updatedAt: '' }); save(); render(); }, general.id);
  await settled(page);
  const task = (await server.rows('tasks.tasks')).find((t) => t.title === 'En Finca con VG');
  expect(task.owner_label_id).toBe(general.id);
  expect((await server.rows('tasks.task_labels')).some((l) => l.task_id === task.id && l.label_id === general.id && !l.deleted_at)).toBe(true);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('«Etiquetas»: General arriba y «Solo de <área>» debajo; crear General y solo del área; el selector junta la familia', async () => {
  await page.evaluate((id) => { state.activeTab = id; state.view = 'labels'; render(); }, A);
  const generalSection = page.locator('.generalfamily');
  await expect(page.locator('#catalogGeneral')).toBeVisible();
  await expect(page.locator('#catalogOwn')).toContainText('Solo de Casa');
  const person = generalSection.filter({ hasText: 'Persona' });
  await expect(person).toContainText('VG Gil');
  // La General va antes que las del área en la página.
  expect((await page.locator('#catalogGeneral').boundingBox())!.y).toBeLessThan((await page.locator('#catalogOwn').boundingBox())!.y);
  await page.screenshot({ path: '../coordinacion/tasks/etiquetas-general-movil.png', fullPage: true }).catch(() => {});

  // + General: una etiqueta para todas las áreas.
  await person.locator('[data-new-general-label]').click();
  await expect(page.locator('#sheet')).toContainText('General, en todas las áreas');
  await page.locator('#nlText').fill('AN');
  await page.locator('#saveNewLabel').click();
  await settled(page);
  const an = (await server.rows('tasks.labels')).find((l) => l.name === 'AN');
  expect(an.tab_id).toBeNull();
  // + Solo de Casa, dentro de la familia General.
  await page.locator('.generalfamily', { hasText: 'Persona' }).locator('[data-new-label]').click();
  await expect(page.locator('#sheet')).toContainText('solo de Casa');
  await page.locator('#nlText').fill('Jardinero');
  await page.locator('#saveNewLabel').click();
  await settled(page);
  const jardinero = (await server.rows('tasks.labels')).find((l) => l.name === 'Jardinero');
  expect([jardinero.tab_id, jardinero.family_id]).toEqual([A, an.family_id]);
  await expect(page.locator('.generalfamily', { hasText: 'Persona' }).locator('.chip.arealabel', { hasText: 'Jardinero' })).toContainText('solo de Casa');

  // En el selector, «Persona» sale una vez, con las General primero y las de Casa.
  await page.evaluate(() => (window as any).openLabelPicker([], () => {}));
  const persona = page.locator('#sheet section.family', { hasText: 'Persona' });
  await expect(persona).toHaveCount(1);
  await expect(persona).toContainText('AN');
  await expect(persona).toContainText('Jardinero');
  await page.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
