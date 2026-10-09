/**
 * Ikisai Tasks · catálogo General con datos como los de producción, interfaz (FB_2026_023, aviso urgente del 9-10-2026):
 * los botones están siempre a la vista para la propietaria; «Repetidas → General» ofrece VG (con su madre distinta en
 * Mejoras, a la raíz) y las zonas (con marcas distintas), y las claves por corregir; corrige y fusiona en una pasada;
 * «Hacer General» en una etiqueta y «+ Nueva familia General».
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, openLabelEditor: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const AREAS = ['Apps', 'Gestiones', 'Mantenimiento', 'Personales', 'Mejoras', 'Retiros'];
const ZONES = ['Albergue', 'Depósito', 'Entre Edificios', 'Piscina', 'Salas'];
const tab: Record<string, string> = {}, person: Record<string, string> = {}, phase: Record<string, string> = {};
let solo = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  let position = 100_000;
  for (const name of AREAS) {
    const ops = createTabOps({ id: (tab[name] = crypto.randomUUID()), name, position: (position += 1024) });
    person[name] = ops.find((o) => o.fields?.system_key === 'person')!.id!;
    phase[name] = ops.find((o) => o.fields?.system_key === 'phase')!.id!;
    await ok(ops);
  }
  for (const name of ['Apps', 'Gestiones', 'Mantenimiento', 'Personales']) await ok([{ op: 'insert', table: 'tasks.labels', id: crypto.randomUUID(), fields: { tab_id: tab[name], family_id: person[name], name: 'VG', position: 1024 } }]);
  const staff = crypto.randomUUID(), zonaMejoras = crypto.randomUUID();
  solo = crypto.randomUUID();
  await ok([{ op: 'insert', table: 'tasks.labels', id: staff, fields: { tab_id: tab.Mejoras, family_id: person.Mejoras, name: 'Staff', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: crypto.randomUUID(), fields: { tab_id: tab.Mejoras, family_id: person.Mejoras, parent_id: staff, name: 'VG', position: 2048 } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: solo, fields: { tab_id: tab.Personales, family_id: person.Personales, name: 'Solo mía', position: 3072 } }]);
  await ok([{ op: 'insert', table: 'tasks.families', id: zonaMejoras, fields: { tab_id: tab.Mejoras, name: 'Zona: Espacio', color: '#7a6a55', position: 90_000, system_key: null } }]);
  // Como en producción: familias renombradas que conservan su clave.
  await server.app.t.db.query(`update tasks.families set name = 'Zona: Espacio' where id = $1`, [person.Retiros]);
  await server.app.t.db.query(`update tasks.families set name = 'Persona' where id = $1`, [phase.Mejoras]);
  for (const [i, z] of ZONES.entries()) await ok([
    { op: 'insert', table: 'tasks.labels', id: crypto.randomUUID(), fields: { tab_id: tab.Mejoras, family_id: zonaMejoras, name: z, position: (i + 1) * 1024 } },
    { op: 'insert', table: 'tasks.labels', id: crypto.randomUUID(), fields: { tab_id: tab.Retiros, family_id: person.Retiros, name: z, position: (i + 1) * 1024 } },
  ]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases: ID, errors });
  await page.evaluate((id) => { state.activeTab = id; state.view = 'labels'; render(); }, tab.Apps);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('sin General todavía, la propietaria ve «Repetidas → General» y «+ Nueva familia General»', async () => {
  await expect(page.locator('#catalogGeneral')).toBeVisible();
  await expect(page.locator('#generalMergeOpen')).toBeVisible();
  await expect(page.locator('#generalFamilyNew')).toBeVisible();
  await expect(page.locator('[data-general-family]').first()).toBeVisible();
});

test('la vista previa ofrece VG (madre distinta, a la raíz), las zonas (marcas distintas) y las claves por corregir; corrige y fusiona', async () => {
  await page.locator('#generalMergeOpen').click();
  const vg = page.locator('.generalgroup', { hasText: 'VG' });
  await expect(vg).toContainText('en 5 áreas');
  await expect(vg).toContainText('la General quedará en la raíz');
  await expect(page.locator('.generalgroup', { hasText: 'Albergue' })).toContainText('marcas distintas');
  const conflicts = page.locator('.generalconflict');
  await expect(conflicts.filter({ hasText: 'Zona: Espacio' })).toContainText('Retiros');
  await expect(conflicts.filter({ hasText: 'marcada como Fase' })).toContainText('Persona · Mejoras');
  await expect(conflicts).toHaveCount(2);
  await page.screenshot({ path: '../coordinacion/tasks/general-real-vista-previa.png', fullPage: true }).catch(() => {});
  await page.locator('#generalMerge').click();
  // VG, las cinco zonas (y «Vera», repetida en las áreas de la demo).
  await expect.poll(async () => (await server.rows('tasks.labels')).filter((l) => l.tab_id === null && !l.deleted_at).map((l) => l.name).sort(), { timeout: 20_000 }).toEqual([...ZONES, 'VG', 'Vera'].sort());
  await settled(page);
  const families = await server.rows('tasks.families'), labels = await server.rows('tasks.labels');
  expect(families.find((f) => f.id === person.Retiros).system_key).toBeNull();
  expect(families.find((f) => f.id === phase.Mejoras).system_key).toBeNull();
  const general = labels.find((l) => l.tab_id === null && l.name === 'VG');
  expect([general.parent_id, families.find((f) => f.id === general.family_id).system_key]).toEqual([null, 'person']);
  const zone = labels.find((l) => l.tab_id === null && l.name === 'Albergue');
  expect(families.find((f) => f.id === zone.family_id)).toMatchObject({ tab_id: null, name: 'Zona: Espacio', system_key: null });
});

test('«Hacer General» en una etiqueta, y «+ Nueva familia General»', async () => {
  await page.evaluate((id) => { state.activeTab = id; state.view = 'labels'; render(); }, tab.Personales);
  await page.evaluate(([fid, id]) => openLabelEditor(fid, id), [person.Personales, solo]);
  await page.locator('[data-general-label]').click();
  await expect(page.locator('#sheet')).toContainText('Solo mía');
  await page.locator('#generalMakeGo').click();
  await expect.poll(async () => (await server.rows('tasks.labels')).some((l) => l.tab_id === null && l.name === 'Solo mía'), { timeout: 15_000 }).toBe(true);
  await settled(page);
  await page.locator('#generalFamilyNew').click();
  await page.locator('#feName').fill('Proveedores');
  await page.locator('#sheet .actions .primary').click();
  await settled(page);
  expect((await server.rows('tasks.families')).find((f) => f.name === 'Proveedores')?.tab_id).toBeNull();
  await expect(page.locator('.generalfamily', { hasText: 'Proveedores' })).toBeVisible();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
