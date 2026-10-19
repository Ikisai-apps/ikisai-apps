/**
 * Ikisai Tasks · regla de nombres de etiquetas en la interfaz (FB_2026_033; docs/tasks/API.md §27.2), en un móvil de
 * 390 px: el editor avisa al escribir un nombre que choca y no deja guardar; la misma hija bajo otra madre sí se guarda;
 * restaurar una archivada que choca, no; y el lote que rechaza el servidor (DUPLICATE_LABEL) se explica en palabras.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, openLabelEditor: any, failureText: any, generalMergeGroups: any;

let server: E2EServer;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const MEJ = crypto.randomUUID(), MEJ_FAM = crypto.randomUUID(), MEJ_ALBERGUE = crypto.randomUUID(), TERMAS = crypto.randomUUID();
const TAB = crypto.randomUUID(), FAM = crypto.randomUUID(), ALBERGUE = crypto.randomUUID(), SALAS = crypto.randomUUID(), BANO = crypto.randomUUID(), VIEJA = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  const aliases = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ id: TAB, name: 'Retiros', position: 100_000 }));
  const label = (id: string, name: string, parent: string | null, position: number, archived = false) => ({ op: 'insert', table: 'tasks.labels', id, fields: { tab_id: TAB, family_id: FAM, parent_id: parent, name, position, archived } });
  await ok([{ op: 'insert', table: 'tasks.families', id: FAM, fields: { tab_id: TAB, name: 'Lugares', color: '#7a6a55', position: 90_000 } },
    label(ALBERGUE, 'Albergue', null, 1024), label(SALAS, 'Salas', null, 2048), label(VIEJA, 'Salas', null, 3072, true)]);
  await ok([label(BANO, 'Baño', ALBERGUE, 4096)]);
  // Otra área con la misma familia: «Albergue › Baño» (la misma madre) y «Termas › Baño» (otra madre).
  const mej = (id: string, name: string, parent: string | null, position: number) => ({ op: 'insert', table: 'tasks.labels', id, fields: { tab_id: MEJ, family_id: MEJ_FAM, parent_id: parent, name, position } });
  await ok(createTabOps({ id: MEJ, name: 'Mejoras', position: 101_024 }));
  await ok([{ op: 'insert', table: 'tasks.families', id: MEJ_FAM, fields: { tab_id: MEJ, name: 'lugares', color: '#7a6a55', position: 90_000 } },
    mej(MEJ_ALBERGUE, 'Albergue', null, 1024), mej(TERMAS, 'Termas', null, 2048)]);
  await ok([mej(crypto.randomUUID(), 'baño', MEJ_ALBERGUE, 3072), mej(crypto.randomUUID(), 'Baño', TERMAS, 4096)]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases, errors });
  await page.evaluate((id) => { state.activeTab = id; state.view = 'labels'; render(); }, TAB);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const named = async (name: string) => (await server.rows('tasks.labels')).filter((l) => l.tab_id === TAB && l.name.trim().toLowerCase() === name.toLowerCase());

test('el editor avisa al escribir una hija repetida en la misma madre y no deja guardar', async () => {
  await page.evaluate((fid) => openLabelEditor(fid), FAM);
  await page.locator('#labelParent').selectOption(ALBERGUE);
  await page.locator('#nlText').fill(' BAÑO');
  await expect(page.locator('#nlClash')).toBeVisible();
  await expect(page.locator('#nlClash')).toHaveText('Ya hay una «Baño» en «Albergue».');
  await expect(page.locator('#saveNewLabel')).toBeDisabled();
  await page.screenshot({ path: '../coordinacion/tasks/nombres-aviso.png' }).catch(() => {});
  // Una madre repetida, igual: con tildes de más.
  await page.locator('#labelParent').selectOption('');
  await page.locator('#nlText').fill('Albérgue');
  await expect(page.locator('#nlClash')).toHaveText('Ya hay una «Albergue» en «Lugares».');
  await expect(page.locator('#saveNewLabel')).toBeDisabled();
  expect(await named('baño')).toHaveLength(1);
});

test('la misma hija bajo otra madre sí se guarda', async () => {
  await page.locator('#nlText').fill('Baño');
  await page.locator('#labelParent').selectOption(SALAS);
  await expect(page.locator('#nlClash')).toBeHidden();
  await expect(page.locator('#saveNewLabel')).toBeEnabled();
  await page.locator('#saveNewLabel').click();
  await expect.poll(async () => (await named('baño')).map((l) => l.parent_id).sort(), { timeout: 15_000 }).toEqual([ALBERGUE, SALAS].sort());
  await settled(page);
});

test('«Repetidas → General»: la misma hija bajo la misma madre es repetida; bajo madres distintas, no', async () => {
  const groups = await page.evaluate(() => generalMergeGroups().map((g: any) => ({ name: g.name.toLowerCase(), areas: [...g.areas].sort(), parents: g.parentNames })));
  expect(groups.filter((g: any) => g.name === 'baño')).toEqual([{ name: 'baño', areas: ['Mejoras', 'Retiros'], parents: ['Albergue'] }]);
  expect(groups.filter((g: any) => g.name === 'albergue')).toEqual([{ name: 'albergue', areas: ['Mejoras', 'Retiros'], parents: [] }]);
});

test('restaurar una archivada que choca, no; el editor lo dice', async () => {
  await page.evaluate(([fid, id]) => openLabelEditor(fid, id), [FAM, VIEJA]);
  await expect(page.locator('#nlClash')).toContainText('Ya hay una «Salas» en «Lugares». Está archivada');
  await page.locator('#archiveLabel').click();
  await expect(page.locator('#toast')).toContainText('Cámbiale el nombre antes de restaurarla');
  expect((await server.rows('tasks.labels')).find((l) => l.id === VIEJA).archived).toBe(true);
});

test('el rechazo del servidor (DUPLICATE_LABEL) se explica y no se pierde nada', async () => {
  const text = await page.evaluate(() => failureText({ code: 'DUPLICATE_LABEL', message: 'La operación no pudo completarse: DUPLICATE_LABEL',
    details: { name: 'baño', tabId: 't', where: 'Albergue', conflictName: 'Baño', conflictTabId: 't' } }));
  expect(text).toContain('Ya hay una «Baño» en «Albergue».');
  expect(text).toContain('sigue guardado en este dispositivo');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
