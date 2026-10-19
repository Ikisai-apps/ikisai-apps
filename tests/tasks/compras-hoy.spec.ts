/**
 * Ikisai Tasks · caracterización de Compras antes de R6 (RECURSOS §6 «Tasks», PR 1).
 *
 * Fija lo que hoy hace la interfaz de Suministros, Solicitudes de compra y Planes de compra y que R6 no puede perder:
 * la ficha y los movimientos del almacén (gastar, entrada, recontar, papelera), el ciclo de una solicitud desde su hoja
 * (aprobar, rechazar y «Ver rechazadas», marcar comprada, recibida, recurrente y «Pedir la siguiente», papelera), los
 * estados de un plan (salir de compras, terminar, quitar) y lo que ven la lectura y el acceso a algunos proyectos.
 * Lo que ya cubre `purchases.spec.ts` (aviso en Inicio, «Queda poco: pedir», plan por proveedor, hoja de ruta, Finance,
 * agrupar por proveedor) no se repite.
 *
 * Al pasar a Recursos cambia el «conductor» (cómo se llega a cada cosa), no lo que se espera.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, EDITOR, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const navigateView: any, state: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext, contextC: BrowserContext;
let owner: Page, editor: Page, reader: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contextC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  editor = await openApp(contextB, server, { user: EDITOR, aliases: ID, errors });
  reader = await openApp(contextC, server, { user: READER, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await contextC?.close(); await server?.close(); });

// --- Conductor: cómo se llega hoy a cada cosa (en R6 cambia esto, no lo que se espera) -------------------------------
const go = (page: Page, view: string) => page.evaluate((v) => navigateView(v), view);
const sync = async (page: Page) => { await settled(page); await page.evaluate(() => (window as any).syncNow?.()); await settled(page); };
const close = (page: Page) => page.evaluate(() => (window as any).closeSheet());
const supplyRow = (page: Page, name: string) => page.locator('.supplyrow', { hasText: name });
const request = (page: Page, title: string) => page.locator('[data-purchase]', { hasText: title });
const shot = async (name: string) => { await owner.waitForTimeout(450); await owner.screenshot({ path: `../coordinacion/tasks/r6-hoy/${name}.png` }).catch(() => {}); };
const serverRequest = async (title: string) => (await server.rows('tasks.purchase_requests')).filter((r) => r.title === title && !r.deleted_at);
const newSupply = async (page: Page, v: { name: string; category: string; unit: string; location: string; min: string }) => {
  await go(page, 'supplies');
  await page.locator('#newSupply').click();
  await page.locator('#suName').fill(v.name);
  await page.locator('#suCategory').selectOption(v.category);
  await page.locator('#suUnit').fill(v.unit);
  await page.locator('#suLocation').fill(v.location);
  await page.locator('#suMin').fill(v.min);
  await page.locator('#suSave').click();
  await expect(supplyRow(page, v.name)).toHaveCount(1);
};
const move = async (page: Page, name: string, kind: 'in' | 'out' | 'count', amount: string) => {
  await supplyRow(page, name).locator(`[data-supply-move$="|${kind}"]`).click();
  await page.locator('#moveAmount').fill(amount);
  await page.locator('#moveSave').click();
};
const ask = async (page: Page, v: { title: string; quantity?: string; unit?: string; supplier?: string; project?: string; repeat?: string }) => {
  await go(page, 'purchases');
  await page.locator('#newPurchase').click();
  await page.locator('#prTitle').fill(v.title);
  if (v.quantity) await page.locator('#prQuantity').fill(v.quantity);
  if (v.unit) await page.locator('#prUnit').fill(v.unit);
  if (v.supplier) await page.locator('#prSupplier').fill(v.supplier);
  if (v.project) await page.locator('#prProject').selectOption(v.project);
  if (v.repeat) await page.locator('#prRepeat').fill(v.repeat);
  await page.locator('#prSave').click();
  await expect(request(page, v.title)).toHaveCount(1);
};

test('suministros: fila con tipo y sitio, ficha con stock y mínimo, gastar, entrada y recontar', async () => {
  await newSupply(owner, { name: 'Lejía', category: 'cleaning', unit: 'l', location: 'Almacén limpieza', min: '4' });
  await newSupply(owner, { name: 'Bombillas E27', category: 'maintenance', unit: 'ud', location: 'Taller', min: '0' });
  await expect(supplyRow(owner, 'Lejía').locator('.pmeta').first()).toHaveText('Limpieza · Almacén limpieza');
  await expect(owner.locator('main.supplies .subtitle')).toContainText('2 en el almacén · 1 con poco');
  await expect(supplyRow(owner, 'Lejía').locator('[data-reorder]')).toHaveCount(1);

  await move(owner, 'Lejía', 'in', '10');
  await expect(supplyRow(owner, 'Lejía').locator('[data-stock]')).toHaveText('10 l');
  await expect(owner.locator('main.supplies .subtitle')).toContainText('2 en el almacén');
  await expect(owner.locator('main.supplies .subtitle')).not.toContainText('con poco');
  await move(owner, 'Lejía', 'out', '2.5');
  await expect(supplyRow(owner, 'Lejía').locator('[data-stock]')).toHaveText('7,5 l');
  // Recontar propone lo que hay; si coincide, no apunta nada.
  await supplyRow(owner, 'Lejía').locator('[data-supply-move$="|count"]').click();
  await expect(owner.locator('#moveAmount')).toHaveValue('7.5');
  await owner.locator('#moveSave').click();
  await expect(owner.locator('#toast')).toHaveText('Sin cambios: coincide con lo que había.');
  await move(owner, 'Lejía', 'count', '6');
  await expect(supplyRow(owner, 'Lejía').locator('[data-stock]')).toHaveText('6 l');
  await settled(owner);
  const lejia = (await server.rows('tasks.supply_items')).find((s) => s.name === 'Lejía');
  const moves = (await server.rows('tasks.supply_movements')).filter((m) => m.supply_item_id === lejia.id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((m) => [m.kind, Number(m.delta)]);
  expect(moves).toEqual([['in', 10], ['out', -2.5], ['adjust', -1.5]]);
  await shot('1-suministros');

  // Ficha: stock y mínimo arriba; cambiar el sitio se guarda.
  await supplyRow(owner, 'Lejía').locator('[data-supply]').click();
  await expect(owner.locator('#sheet')).toContainText('En el almacén: 6 l · mínimo 4 l');
  await expect(owner.locator('#suLocation')).toHaveValue('Almacén limpieza');
  await shot('2-ficha-suministro');
  await owner.locator('#suLocation').fill('Lavandería');
  await owner.locator('#suSave').click();
  await expect(supplyRow(owner, 'Lejía').locator('.pmeta').first()).toHaveText('Limpieza · Lavandería');
  await supplyRow(owner, 'Lejía').locator('[data-supply-move$="|out"]').click();
  await shot('3-movimiento');
  await close(owner);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('suministro a la papelera: se va con sus movimientos', async () => {
  await move(owner, 'Bombillas E27', 'in', '12');
  await expect(supplyRow(owner, 'Bombillas E27').locator('[data-stock]')).toHaveText('12 ud');
  await supplyRow(owner, 'Bombillas E27').locator('[data-supply]').click();
  await owner.locator('#suDelete').click();
  await expect(supplyRow(owner, 'Bombillas E27')).toHaveCount(0);
  await settled(owner);
  const item = (await server.rows('tasks.supply_items')).find((s) => s.name === 'Bombillas E27');
  expect(item.deleted_at).not.toBeNull();
  expect((await server.rows('tasks.supply_movements')).filter((m) => m.supply_item_id === item.id).every((m) => m.deleted_at)).toBe(true);
});

test('solicitud: pedir con proyecto y repetición, aprobar, marcar comprada, recibida y pedir la siguiente', async () => {
  const project = await owner.evaluate(() => (window as any).tab().projects.find((p: any) => !p.system && !p.deleted).id);
  const projectTitle = await owner.evaluate((id) => (window as any).tab().projects.find((p: any) => p.id === id).title, project);
  await ask(owner, { title: 'Pastillas de cloro', quantity: '5', unit: 'kg', supplier: 'Piscinas Norte', project, repeat: '30' });
  await expect(request(owner, 'Pastillas de cloro')).toContainText('Pedida');
  await expect(request(owner, 'Pastillas de cloro').locator('.pmeta')).toHaveText(`5 kg · Piscinas Norte · ${projectTitle} · cada 30 días`);
  await expect(owner.locator('main.purchases .subtitle')).toContainText('1 abiertas · aprueba la propietaria');
  await shot('4-solicitudes');

  // Sin responsable de compras, aprueba la propietaria.
  await request(owner, 'Pastillas de cloro').click();
  await shot('5-hoja-solicitud');
  await owner.locator('#prApprove').click();
  await expect(request(owner, 'Pastillas de cloro')).toContainText('Aprobada');
  await request(owner, 'Pastillas de cloro').click();
  await expect(owner.locator('#prSave')).toHaveCount(1);
  await owner.locator('#prPurchased').click();
  await expect(request(owner, 'Pastillas de cloro')).toContainText('Comprada');
  // Comprada: ya no se edita.
  await request(owner, 'Pastillas de cloro').click();
  await expect(owner.locator('#prSave')).toHaveCount(0);
  await expect(owner.locator('#prTitle')).toBeDisabled();
  await expect(owner.locator('#prDelete')).toHaveCount(0);
  await owner.locator('#prReceive').click();
  // Recurrente: al recibir pregunta si se pide ya la siguiente.
  await expect(owner.locator('#sheet')).toContainText('se repite cada 30 días');
  await owner.locator('#prNextNow').click();
  await settled(owner);
  const rows = await serverRequest('Pastillas de cloro');
  expect(rows.map((r) => r.status).sort()).toEqual(['received', 'requested']);
  const next = rows.find((r) => r.status === 'requested');
  expect([Number(next.quantity), next.unit, next.supplier_name, next.project_id, Number(next.repeat_days)]).toEqual([5, 'kg', 'Piscinas Norte', project, 30]);
  // La siguiente vence 30 días después de recibir (hoy, salvo que se cruce la medianoche).
  const days = (Date.parse(String(next.due).slice(0, 10)) - Date.parse(new Date().toISOString().slice(0, 10))) / 86_400_000;
  expect(days).toBeGreaterThanOrEqual(29);
  expect(days).toBeLessThanOrEqual(31);
  await expect(owner.locator('main.purchases .sectionlabel', { hasText: 'Recibidas' })).toHaveCount(1);
  // Desde la recibida también se puede pedir la siguiente.
  await owner.locator('[data-purchase]', { hasText: 'Pastillas de cloro' }).filter({ hasText: 'Recibida' }).click();
  await expect(owner.locator('#prNext')).toHaveCount(1);
  await close(owner);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('solicitud: rechazar la esconde tras «Ver rechazadas»; la papelera la quita', async () => {
  await ask(owner, { title: 'Sombrillas nuevas' });
  await request(owner, 'Sombrillas nuevas').click();
  await owner.locator('#prReject').click();
  await expect(request(owner, 'Sombrillas nuevas')).toHaveCount(0);
  await expect(owner.locator('#toggleRejectedPurchases')).toHaveText('Ver rechazadas (1)');
  await owner.locator('#toggleRejectedPurchases').click();
  await expect(request(owner, 'Sombrillas nuevas')).toContainText('Rechazada');
  await owner.locator('#toggleRejectedPurchases').click();
  await expect(owner.locator('#toggleRejectedPurchases')).toHaveText('Ver rechazadas (1)');

  await ask(owner, { title: 'Pedido por error' });
  await request(owner, 'Pedido por error').click();
  await owner.locator('#prDelete').click();
  await expect(request(owner, 'Pedido por error')).toHaveCount(0);
  await settled(owner);
  expect(await serverRequest('Pedido por error')).toEqual([]);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('planes: preparar, salir de compras y terminar; quitar un plan devuelve sus solicitudes', async () => {
  for (const title of ['Pastillas de cloro', 'Cinta americana']) {
    if (title === 'Cinta americana') await ask(owner, { title, quantity: '3', supplier: 'Ferretería Centro' });
    await go(owner, 'purchases');
    await request(owner, title).filter({ hasText: 'Pedida' }).click();
    await owner.locator('#prApprove').click();
  }
  await go(owner, 'plans');
  await expect(owner.locator('main.plans .subtitle')).toContainText('2 aprobadas sin plan');
  await owner.locator('#preparePlan').click();
  await expect(owner.locator('[data-plan]')).toHaveCount(1);
  await expect(owner.locator('[data-plan]')).toContainText('Preparando');
  await expect(owner.locator('[data-plan] .pmeta')).toContainText('2 proveedores');
  await expect(owner.locator('main.plans .subtitle')).toContainText('0 aprobadas sin plan');
  await shot('6-planes');
  await owner.locator('[data-plan]').click();
  await shot('7-hoja-de-ruta');
  await owner.locator('#planShop').click();
  await expect(owner.locator('#sheet .pstate')).toHaveText('De compras');
  await expect(owner.locator('#planShop')).toHaveCount(0);
  // Con algo comprado ya no se quita: se termina.
  await owner.locator('[data-stop]', { hasText: 'Ferretería Centro' }).locator('[data-route-item]').check();
  await owner.locator('#planDone').click();
  await expect(owner.locator('[data-plan]')).toContainText('Terminado');
  await owner.locator('[data-plan]').click();
  await expect(owner.locator('#planDone')).toHaveCount(0);
  await expect(owner.locator('[data-route-item]').first()).toBeDisabled();
  await close(owner);
  await settled(owner);
  expect((await server.rows('tasks.purchase_plans')).map((p) => p.status)).toEqual(['done']);

  // Un plan sin nada comprado se quita y lo suyo vuelve a «aprobadas sin plan».
  await ask(owner, { title: 'Guantes', supplier: 'Ferretería Centro' });
  await request(owner, 'Guantes').click();
  await owner.locator('#prApprove').click();
  await go(owner, 'plans');
  await expect(owner.locator('main.plans .subtitle')).toContainText('1 aprobadas sin plan');
  await owner.locator('#preparePlan').click();
  await expect(owner.locator('[data-plan]')).toHaveCount(2);
  await owner.locator('[data-plan]', { hasText: 'Preparando' }).click();
  await owner.locator('#planDelete').click();
  await expect(owner.locator('[data-plan]')).toHaveCount(1);
  await expect(owner.locator('main.plans .subtitle')).toContainText('1 aprobadas sin plan');
  await settled(owner);
  expect((await serverRequest('Guantes'))[0].plan_stop_id).toBeNull();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('lectura: ve el almacén, las solicitudes y los planes, sin botones para cambiar nada', async () => {
  await go(owner, 'supplies');
  await move(owner, 'Lejía', 'out', '5');
  await settled(owner);
  await sync(reader);
  await go(reader, 'supplies');
  await expect(supplyRow(reader, 'Lejía').locator('[data-stock]')).toHaveText('1 l');
  await expect(reader.locator('#newSupply')).toHaveCount(0);
  await expect(reader.locator('[data-supply-move]')).toHaveCount(0);
  await expect(supplyRow(reader, 'Lejía').locator('.pstate')).toHaveText('Queda poco');
  await go(reader, 'purchases');
  await expect(reader.locator('#newPurchase')).toHaveCount(0);
  await request(reader, 'Guantes').click();
  await expect(reader.locator('#prTitle')).toBeDisabled();
  await expect(reader.locator('#prSave, #prApprove, #prReject, #prPurchased, #prDelete')).toHaveCount(0);
  await close(reader);
  await go(reader, 'plans');
  await expect(reader.locator('#preparePlan')).toHaveCount(0);
  await expect(reader.locator('main.plans')).toContainText('Prepara los planes la propietaria.');
  await expect(reader.locator('[data-plan]')).toHaveCount(1);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('acceso a algunos proyectos: almacén y planes son del área entera; ve las solicitudes de su proyecto', async () => {
  const project = (await serverRequest('Pastillas de cloro'))[0].project_id;
  await server.app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [ID.ikisai!]: [project] } }), server.app.users.editor]);
  await editor.reload();
  await settled(editor);
  await editor.evaluate((t) => { state.activeTab = t; }, ID.ikisai);
  await go(editor, 'supplies');
  await expect(editor.locator('main .notice')).toHaveText('El almacén es del área entera; tu acceso es a algunos proyectos.');
  await go(editor, 'plans');
  await expect(editor.locator('main .notice')).toHaveText('Los planes de compra son del área entera.');
  await go(editor, 'purchases');
  await expect(request(editor, 'Pastillas de cloro')).not.toHaveCount(0);
  await expect(request(editor, 'Guantes')).toHaveCount(0);
  await expect(editor.locator('#newPurchase')).toHaveCount(1);
  // Inicio no avisa del almacén a quien no lo ve.
  await go(editor, 'home');
  await expect(editor.locator('.lowstock')).toHaveCount(0);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
