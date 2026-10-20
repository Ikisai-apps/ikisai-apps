/**
 * Ikisai Tasks · regla de nombres de etiquetas en la interfaz (FB_2026_033; docs/tasks/API.md §27.2), en un móvil de
 * 390 px: el editor avisa al escribir un nombre que choca y no deja guardar; la misma hija bajo otra madre sí se guarda;
 * restaurar una archivada que choca, no; y el lote que rechaza el servidor (DUPLICATE_LABEL) se explica en palabras.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, openLabelCatalog, seedDemo, settled } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, openLabelEditor: any, failureText: any, generalMergeGroups: any, generalMerge: any, closeSheet: any;

let server: E2EServer;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const MEJ = crypto.randomUUID(), MEJ_FAM = crypto.randomUUID(), MEJ_ALBERGUE = crypto.randomUUID(), TERMAS = crypto.randomUUID();
const ANA = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()], JARDIN = [crypto.randomUUID(), crypto.randomUUID()];
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
  // «Jardin» en Retiros (el área actual) y «Jardín» en Mejoras: solo cambian en tildes; la General se queda con tildes.
  await ok([label(JARDIN[0]!, 'Jardin', null, 5120), mej(JARDIN[1]!, 'Jardín', null, 5120)]);
  // «Ana» en Cocina y Huerta (familia «Persona») y en Granja, cuya familia de responsables se llama «Equipo»: no sale en
  // el mismo grupo (otro nombre de familia), pero para la regla es la misma familia (la misma clave).
  for (const [i, name] of ['Cocina', 'Huerta', 'Granja'].entries()) {
    const ops = createTabOps({ id: crypto.randomUUID(), name, position: 102_048 + i * 1024 });
    const person = ops.find((o) => o.table === 'tasks.families' && o.fields?.system_key === 'person')!;
    if (name === 'Granja') person.fields = { ...person.fields, name: 'Equipo' };
    await ok([...ops, { op: 'insert', table: 'tasks.labels', id: ANA[i]!, fields: { tab_id: ops[0]!.id, family_id: person.id, parent_id: null, name: ['Ana', 'ana', 'ANA'][i], position: 1024 } }]);
  }
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases, errors });
  await page.evaluate((id) => { state.activeTab = id; state.view = 'labels'; render(); }, TAB);
  await openLabelCatalog(page);
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
  await expect(page.locator('.ikisai-toast')).toContainText('Cámbiale el nombre antes de restaurarla');
  expect((await server.rows('tasks.labels')).find((l) => l.id === VIEJA).archived).toBe(true);
});

/** En la hoja «Repetidas → General», deja marcado solo ese grupo. */
async function onlyGroup(key: string) {
  for (;;) {
    const other = page.locator(`input[data-general-group]:checked:not([data-general-group="${key}"])`).first();
    if (!(await other.count())) break;
    await other.click(); // repinta la hoja: el elemento cambia
  }
  await expect(page.locator('#generalMerge')).toHaveText('Fusionar 1');
}

test('«Repetidas → General» anticipa el DUPLICATE_LABEL: aviso en el grupo, casilla desactivada y se ofrece incluirla', async () => {
  await page.evaluate((id) => { closeSheet(); state.activeTab = id; state.view = 'labels'; render(); }, TAB);
  await openLabelCatalog(page);
  await page.locator('#generalMergeOpen').click();
  const ana = page.locator('[data-general-box="persona||ana"]');
  await expect(ana).toContainText('en 2 áreas');
  await expect(ana.locator('[data-general-clash]')).toHaveText('En Granja quedaría otra «ANA» en «Equipo»: archívala o renómbrala antes.');
  await expect(ana.locator('input[data-general-group]')).toBeDisabled();
  await expect(ana.locator('input[data-general-group]')).not.toBeChecked();
  // Los demás grupos siguen funcionando.
  await expect(page.locator('[data-general-box="lugares||albergue"] input')).toBeEnabled();
  await expect(page.locator('[data-general-box="lugares||albergue"] input')).toBeChecked();
  await expect(page.locator('#generalMerge')).toBeEnabled();
  await page.screenshot({ path: '../coordinacion/tasks/general-choque-movil.png' }).catch(() => {});
  // Aunque se llamara a mano, el lote que el hook rechazaría no sale.
  const sent = await page.evaluate(async () => { try { await generalMerge(generalMergeGroups().filter((g: any) => g.name.toLowerCase() === 'ana')); return 'mandado'; } catch (e: any) { return e.message; } });
  expect(sent).toBe('En Granja quedaría otra «ANA» en «Equipo»: archívala o renómbrala antes.');
  expect((await server.rows('tasks.labels')).filter((l) => l.tab_id === null && l.name.toLowerCase() === 'ana')).toHaveLength(0);

  // Incluirla: el grupo pasa a 3 áreas, sin aviso, y se puede fusionar.
  await ana.locator('[data-general-include]').click();
  await expect(ana).toContainText(/en 3 áreas: .*Granja/);
  await expect(ana.locator('[data-general-clash]')).toHaveCount(0);
  await expect(ana.locator('input[data-general-group]')).toBeEnabled();
  await expect(ana.locator('input[data-general-group]')).toBeChecked();
  await onlyGroup('persona||ana');
  await page.locator('#generalMerge').click();
  await expect.poll(async () => (await server.rows('tasks.labels')).filter((l) => l.tab_id === null && l.name.toLowerCase() === 'ana' && !l.deleted_at && !l.archived).length, { timeout: 15_000 }).toBe(1);
  expect((await server.rows('tasks.labels')).filter((l) => ANA.includes(l.id)).every((l) => l.archived)).toBe(true);
  await settled(page);
});

test('«Repetidas → General» junta lo que solo cambia en tildes: «se quedará como «Jardín»» y el servidor lo acepta', async () => {
  await page.evaluate((id) => { closeSheet(); state.activeTab = id; state.view = 'labels'; render(); }, TAB);
  await openLabelCatalog(page);
  await page.locator('#generalMergeOpen').click();
  const jardin = page.locator('[data-general-box="lugares||jardin"]');
  await expect(jardin).toContainText('en 2 áreas');
  await expect(jardin).toContainText('se quedará como «Jardín»');
  await expect(jardin.locator('[data-general-clash]')).toHaveCount(0);
  await expect(jardin.locator('input[data-general-group]')).toBeEnabled();
  await expect(jardin.locator('input[data-general-group]')).toBeChecked();
  await onlyGroup('lugares||jardin');
  await page.locator('#generalMerge').click();
  await expect.poll(async () => (await server.rows('tasks.labels')).filter((l) => l.tab_id === null && !l.deleted_at && !l.archived && l.name.toLowerCase().startsWith('jard')).map((l) => l.name), { timeout: 15_000 }).toEqual(['Jardín']);
  expect((await server.rows('tasks.labels')).filter((l) => JARDIN.includes(l.id)).every((l) => l.archived)).toBe(true);
  await settled(page);
});

test('el rechazo del servidor (DUPLICATE_LABEL) se explica y no se pierde nada', async () => {
  const text = await page.evaluate(() => failureText({ code: 'DUPLICATE_LABEL', message: 'La operación no pudo completarse: DUPLICATE_LABEL',
    details: { name: 'baño', tabId: 't', where: 'Albergue', conflictName: 'Baño', conflictTabId: 't' } }));
  expect(text).toContain('Ya hay una «Baño» en «Albergue».');
  expect(text).toContain('sigue guardado en este dispositivo');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
