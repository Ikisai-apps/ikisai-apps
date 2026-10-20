/**
 * Ikisai Tasks · R6 PR 3 en el navegador (docs/tasks/API.md §36): materiales y equipos en la ficha de la tarea con el
 * selector de artículos del kit, «Confirmar consumo» al completar (gasta en Recursos una sola vez y lo apunta en la
 * tarea), «Ahora no» y confirmar después desde la ficha con «No se usó», y la lectura sin botones. El kit del oficio lo
 * prueba materials.test.ts (necesita los oficios de Central). Capturas en coordinacion/tasks/r6-despues/.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const Sync: any, openTaskEditor: any, toggleTask: any, taskLocation: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, reader: Page;
const errors: string[] = [];
const ALMACEN = crypto.randomUUID(), LEJIA = crypto.randomUUID(), TALADRO = crypto.randomUUID(), PINTURA = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

const resources = async (operations: unknown[]) => {
  const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${crypto.randomUUID()}`, operations } });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const syncResources = (page: Page) => page.evaluate(() => Sync.core.resources?.sync());
const stock = async (item: string) => Number((await server.app.t.db.query<{ q: string }>(`select coalesce(sum(quantity), 0) as q from resources.movements where item_id = $1 and deleted_at is null`, [item])).rows[0]!.q);
const materials = async (task: string) => (await server.rows('tasks.task_materials')).filter((m) => m.task_id === task && !m.deleted_at);
const shot = async (name: string) => { await owner.waitForTimeout(450); await owner.screenshot({ path: `../coordinacion/tasks/r6-despues/${name}.png` }).catch(() => {}); };
const close = (page: Page) => page.evaluate(() => (window as any).closeSheet());
async function addMaterial(page: Page, search: string, name: RegExp, quantity?: string) {
  const box = page.locator('#taskMaterials');
  await box.locator('input[placeholder="Busca o escribe uno nuevo"]').fill(search);
  await box.getByRole('option', { name }).first().click();
  if (quantity) await box.getByRole('textbox', { name: 'Cantidad', exact: true }).fill(quantity);
  await box.locator('#materialAdd').click();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const altura = (await server.app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  await resources([{ op: 'insert', table: 'resources.spaces', id: ALMACEN, fields: { parent_id: altura, kind: 'edificio', name: 'Almacén', position: 1024 } }]);
  await resources([
    { op: 'insert', table: 'resources.items', id: LEJIA, fields: { name: 'Lejía', kind: 'limpieza', base_unit: 'l', default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: PINTURA, fields: { name: 'Pintura blanca', kind: 'material', base_unit: 'l', default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: TALADRO, fields: { name: 'Taladro', kind: 'herramienta', base_unit: 'ud' } },
  ]);
  await resources([{ op: 'insert', table: 'resources.movements', id: crypto.randomUUID(), fields: { item_id: LEJIA, space_id: ALMACEN, quantity: 10, kind: 'entrada_manual' } },
    { op: 'insert', table: 'resources.movements', id: crypto.randomUUID(), fields: { item_id: PINTURA, space_id: ALMACEN, quantity: 4, kind: 'entrada_manual' } }]);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  reader = await openApp(contextB, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('materiales y equipos en la ficha; al completar, «Confirmar consumo» gasta en Recursos una vez', async () => {
  await syncResources(owner);
  await owner.evaluate((id) => openTaskEditor(id), ID.t1);
  const box = owner.locator('#taskMaterials');
  await expect(box).toContainText('Lo que hace falta para esta tarea');
  await addMaterial(owner, 'Lej', /Lejía/, '2');
  await expect(box.locator('.materialrow')).toHaveCount(1);
  await addMaterial(owner, 'Tala', /Taladro/);
  await expect(box.locator('.materialrow')).toHaveCount(2);
  await expect(box.locator('.materialrow.equipment')).toContainText('Hace falta');
  await expect(box.locator('[data-material-qty]')).toHaveValue('2');
  await shot('20-materiales-ficha');
  await close(owner);
  await settled(owner);
  expect((await materials(ID.t1!)).map((m) => [m.item_id, m.quantity == null ? null : Number(m.quantity)]).sort()).toEqual([[LEJIA, 2], [TALADRO, null]].sort());

  // Completar: pregunta solo por la lejía (el taladro es un equipo) con lo previsto.
  await owner.evaluate((id) => toggleTask(id), ID.t1);
  await expect(owner.locator('.consumeline')).toHaveCount(1);
  await expect(owner.locator('[data-consume-qty]')).toHaveValue('2');
  await shot('21-confirmar-consumo');
  await owner.locator('[data-consume-qty]').fill('1.5');
  await owner.locator('#consumeSave').click();
  await expect.poll(() => stock(LEJIA)).toBe(8.5);
  await settled(owner);
  await expect.poll(async () => (await materials(ID.t1!)).find((m) => m.item_id === LEJIA)?.consumed).toBe(1.5);
  const moves = (await server.app.t.db.query<Record<string, unknown>>(`select kind, source_app, source_ref from resources.movements where item_id = $1 and kind = 'consumo_tarea'`, [LEJIA])).rows;
  const lejia = (await materials(ID.t1!)).find((m) => m.item_id === LEJIA);
  expect(moves).toEqual([{ kind: 'consumo_tarea', source_app: 'tasks', source_ref: `task_material:${lejia.id}` }]);
  await owner.evaluate((id) => openTaskEditor(id), ID.t1);
  await expect(owner.locator('#taskMaterials .materialrow', { hasText: 'Lejía' })).toContainText('Gastado: 1,5 l');
  await expect(owner.locator('#materialConsume')).toHaveCount(0);
  await close(owner);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('«Confirmar consumo» sale cuando se va el aviso de «Hecha», nunca antes; con «Deshacer» no sale; reabrir lo gastado avisa', async () => {
  // t1 ya tiene lo gastado apuntado: reabrirla avisa de que no vuelve al inventario (y el stock no cambia).
  await owner.evaluate((id) => toggleTask(id), ID.t1);
  await expect(owner.locator('.ikisai-toast')).toContainText('Lo gastado no vuelve al inventario');
  await settled(owner);
  expect(await stock(LEJIA)).toBe(8.5);
  // Otra tarea abierta y sin hijas del mismo proyecto, con lejía prevista.
  const target: string = await owner.evaluate(([t1, t2]) => { const loc = taskLocation(t1); const x = loc.p.tasks.find((t: any) => t.id !== t1 && t.id !== t2 && !t.deleted && !t.done && !t.parentId && !loc.p.tasks.some((c: any) => !c.deleted && c.parentId === t.id)); return x.id; }, [ID.t1, ID.t2]);
  await owner.evaluate((id) => openTaskEditor(id), target);
  await addMaterial(owner, 'Lej', /Lejía/, '1');
  await expect(owner.locator('#taskMaterials .materialrow')).toHaveCount(1);
  await close(owner);
  await settled(owner);
  const undo = () => owner.locator('.ikisai-toast span', { hasText: 'Tarea completada' }).locator('xpath=following-sibling::button');
  // Con «Deshacer»: la hoja no sale nunca.
  await owner.evaluate((id) => toggleTask(id), target);
  await owner.waitForTimeout(1500);
  await expect(owner.locator('.consumeline')).toHaveCount(0);
  await undo().click();
  await owner.waitForTimeout(7000);
  await expect(owner.locator('.consumeline')).toHaveCount(0);
  // Sin deshacer: no sale mientras está el aviso, y sale al irse.
  await owner.evaluate((id) => toggleTask(id), target);
  await owner.waitForTimeout(1500);
  await expect(owner.locator('.consumeline')).toHaveCount(0);
  await expect(owner.locator('.consumeline')).toHaveCount(1, { timeout: 10_000 });
  await owner.locator('#consumeLater').click();
  await settled(owner);
  expect(await stock(LEJIA)).toBe(8.5);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('«Ahora no» y confirmar después desde la ficha con «No se usó»: no se gasta nada', async () => {
  await owner.evaluate((id) => openTaskEditor(id), ID.t2);
  await addMaterial(owner, 'Pint', /Pintura blanca/, '1');
  await expect(owner.locator('#taskMaterials .materialrow')).toHaveCount(1);
  await close(owner);
  await settled(owner);
  await owner.evaluate((id) => toggleTask(id), ID.t2);
  await owner.locator('#consumeLater').click();
  await settled(owner);
  await owner.evaluate((id) => openTaskEditor(id), ID.t2);
  await owner.locator('#materialConsume').click();
  await owner.locator('[data-consume-none]').check();
  await expect(owner.locator('[data-consume-qty]')).toBeDisabled();
  await owner.locator('#consumeSave').click();
  await settled(owner);
  await expect.poll(async () => (await materials(ID.t2!))[0]?.consumed).toBe(0);
  expect(await stock(PINTURA)).toBe(4);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('lectura: ve los materiales de la tarea, sin botones para cambiarlos', async () => {
  await reader.evaluate(() => (window as any).syncNow?.());
  await settled(reader);
  await syncResources(reader);
  await reader.evaluate((id) => openTaskEditor(id), ID.t1);
  await expect(reader.locator('#taskMaterials .materialrow')).toHaveCount(2);
  await expect(reader.locator('#materialAdd, #materialConsume, [data-material-remove], [data-material-qty]')).toHaveCount(0);
  await close(reader);
  // Inicio de la lectora (MUELA-055): cifras y «Lo primero», sin «✓ Hecha» ni «⋯ Mover a…» (solo «Abrir»).
  await reader.evaluate(() => (window as any).navigateView('home'));
  await expect(reader.locator('#homeStats .stat-item')).toHaveCount(6);
  expect(await reader.locator('#homeLead .lead-card').count()).toBeGreaterThan(0);
  await expect(reader.locator('#homeLead [data-feedback-id="tasks.inicio.lo_primero.hecha"], #homeLead [data-feedback-id="tasks.inicio.lo_primero.mover"]')).toHaveCount(0);
  await expect(reader.locator('#homeLead [data-feedback-id="tasks.inicio.lo_primero.abrir"]').first()).toBeVisible();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
