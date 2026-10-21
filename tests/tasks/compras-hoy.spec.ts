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
 * Al pasar a Recursos cambia el «conductor» (cómo se llega a cada cosa), no lo que se espera. Desde R6 (PR 2) el almacén es
 * el inventario común de Recursos con las piezas del kit: los artículos nacen por la API de Recursos (como los daría de alta
 * otra app o la ficha del kit) y los movimientos, la ficha y el recuento son los del kit.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, EDITOR, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const navigateView: any, state: any, Sync: any;

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
const request = (page: Page, title: string) => page.locator('[data-purchase]', { hasText: title });
// Compras R6 «Estantería» (MUELA-094): tocar la baldosa hace lo siguiente; la hoja de siempre está en «⋯ › Detalles».
// En «En casa» y «Ver rechazadas», tocar la abre directamente.
const openRequest = async (page: Page, title: string, has?: string) => {
  let el = page.locator('[data-purchase]', { hasText: title });
  if (has) el = el.filter({ hasText: has });
  el = el.first();
  if (await el.locator('.tile-more').count()) { await el.locator('.tile-more').click(); await page.locator('#tcrDetails').click(); } else await el.click();
  await expect(page.locator('#prTitle')).toBeVisible();
};
const shot = async (name: string) => { await owner.waitForTimeout(450); await owner.screenshot({ path: `../coordinacion/tasks/r6-despues/${name}.png` }).catch(() => {}); };
const serverRequest = async (title: string) => (await server.rows('tasks.purchase_requests')).filter((r) => r.title === title && !r.deleted_at);
const LEJIA = crypto.randomUUID(), BOMBILLAS = crypto.randomUUID(), ALMACEN = crypto.randomUUID();
const resources = async (operations: unknown[]) => {
  const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${crypto.randomUUID()}`, operations } });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const syncResources = (page: Page) => page.evaluate(() => Sync.core.resources?.sync());
const stock = async (item: string) => Number((await server.app.t.db.query<{ q: string }>(`select coalesce(sum(quantity), 0) as q from resources.movements where item_id = $1 and deleted_at is null`, [item])).rows[0]!.q);
const itemRow = (page: Page, id: string) => page.locator(`.stk-row[data-item-id="${id}"]`);
const kitDialog = (page: Page) => page.locator('#kitLayer [role="dialog"]');
const kitMove = async (page: Page, id: string, kind: 'Entrada' | 'Gastar', amount: string) => {
  await itemRow(page, id).getByRole('button', { name: kind, exact: true }).click();
  await kitDialog(page).getByLabel(kind === 'Entrada' ? 'Cuánto entra' : 'Cuánto sale', { exact: true }).fill(amount);
  await kitDialog(page).getByRole('button', { name: kind === 'Entrada' ? 'Registrar entrada' : 'Registrar salida' }).click();
  await expect(kitDialog(page)).toHaveCount(0);
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

test('suministros: catálogo de la casa con tipo y sitio, ficha con stock y mínimo, gastar, entrada y recontar', async () => {
  const altura = (await server.app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  await resources([{ op: 'insert', table: 'resources.spaces', id: ALMACEN, fields: { parent_id: altura, kind: 'edificio', name: 'Almacén limpieza', position: 1024 } }]);
  await resources([
    { op: 'insert', table: 'resources.items', id: LEJIA, fields: { name: 'Lejía', kind: 'limpieza', base_unit: 'l', min_quantity: 4, default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: BOMBILLAS, fields: { name: 'Bombillas E27', kind: 'material', base_unit: 'ud' } },
    // Lo de cocina es de Food: no sale en Suministros.
    { op: 'insert', table: 'resources.items', id: crypto.randomUUID(), fields: { name: 'Harina', kind: 'ingrediente', base_unit: 'kg' } },
  ]);
  await syncResources(owner);
  await go(owner, 'supplies');
  await expect(owner.locator('.stk-row')).toHaveCount(2);
  await expect(owner.locator('main.supplies .subtitle')).toContainText('Inventario de la casa · 2 suministros · 1 con poco');
  await expect(itemRow(owner, LEJIA).getByRole('button', { name: 'Queda poco: pedir' })).toHaveCount(1);

  await kitMove(owner, LEJIA, 'Entrada', '10');
  await expect.poll(() => stock(LEJIA)).toBe(10);
  await expect(owner.locator('main.supplies .subtitle')).not.toContainText('con poco');
  await expect(itemRow(owner, LEJIA).getByRole('button', { name: 'Queda poco: pedir' })).toHaveCount(0);
  await kitMove(owner, LEJIA, 'Gastar', '2.5');
  await expect.poll(() => stock(LEJIA)).toBe(7.5);
  await expect(itemRow(owner, LEJIA)).toContainText('7,5 l');
  await shot('1-suministros');
  // Recontar: el recuento del kit cuenta 6 y, al cerrar, ajusta la diferencia.
  await itemRow(owner, LEJIA).getByRole('button', { name: 'Contar', exact: true }).click();
  const line = kitDialog(owner).locator(`.stk-count-line[data-item-id="${LEJIA}"] input`);
  await line.fill('6');
  await line.press('Enter');
  await kitDialog(owner).getByRole('button', { name: 'Ver lo calculado' }).click();
  await kitDialog(owner).getByRole('button', { name: 'Ocultar lo calculado' }).click();
  await kitDialog(owner).getByRole('button', { name: 'Revisar y cerrar' }).click();
  await kitDialog(owner).getByRole('button', { name: 'Cerrar y ajustar' }).click();
  await expect.poll(() => stock(LEJIA), { timeout: 15_000 }).toBe(6);
  await owner.keyboard.press('Escape');
  const kinds = (await server.app.t.db.query<{ kind: string; q: string }>(`select kind, quantity as q from resources.movements where item_id = $1 order by at, kind`, [LEJIA])).rows.map((m) => [m.kind, Number(m.q)]);
  expect(kinds).toEqual([['entrada_manual', 10], ['salida_manual', -2.5], ['ajuste_recuento', -1.5]]);
  await syncResources(owner);

  // Ficha: stock y mínimo; el sitio es el del artículo.
  await itemRow(owner, LEJIA).getByRole('button', { name: 'Abrir Lejía' }).click();
  await expect(kitDialog(owner)).toContainText('Almacén limpieza');
  await expect(kitDialog(owner)).toContainText('6 l');
  await shot('2-ficha-suministro');
  await owner.keyboard.press('Escape');
  await expect(kitDialog(owner)).toHaveCount(0);
  await itemRow(owner, LEJIA).getByRole('button', { name: 'Gastar', exact: true }).click();
  await shot('3-movimiento');
  await owner.keyboard.press('Escape');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('solicitud: pedir con proyecto y repetición, aprobar, marcar comprada, recibida y pedir la siguiente', async () => {
  const project = await owner.evaluate(() => (window as any).tab().projects.find((p: any) => !p.system && !p.deleted).id);
  const projectTitle = await owner.evaluate((id) => (window as any).tab().projects.find((p: any) => p.id === id).title, project);
  await ask(owner, { title: 'Pastillas de cloro', quantity: '5', unit: 'kg', supplier: 'Piscinas Norte', project, repeat: '30' });
  await expect(request(owner, 'Pastillas de cloro')).toContainText('Pedida');
  // R6: la tienda es la estantería; en la baldosa, lo que se compra, el proyecto y la repetición.
  await expect(owner.locator('.shelf-row[data-shelf-row="Piscinas Norte"]').locator('[data-purchase]', { hasText: 'Pastillas de cloro' })).toHaveCount(1);
  await expect(request(owner, 'Pastillas de cloro').locator('.tile-value')).toHaveText('5 kg');
  await expect(request(owner, 'Pastillas de cloro').locator('.tcr-meta')).toHaveText(`${projectTitle} · cada 30 días`);
  await expect(owner.locator('main.purchases .subtitle')).toContainText('1 abiertas · aprueba la propietaria');
  await shot('4-solicitudes');

  // Sin responsable de compras, aprueba la propietaria.
  await openRequest(owner, 'Pastillas de cloro');
  await shot('5-hoja-solicitud');
  await owner.locator('#prApprove').click();
  await expect(request(owner, 'Pastillas de cloro')).toContainText('Aprobada');
  await openRequest(owner, 'Pastillas de cloro');
  await expect(owner.locator('#prSave')).toHaveCount(1);
  await owner.locator('#prPurchased').click();
  await expect(request(owner, 'Pastillas de cloro')).toContainText('Comprada');
  // Comprada: ya no se edita.
  await openRequest(owner, 'Pastillas de cloro');
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
  // R6: las recibidas van a «En casa», plegado.
  await expect(owner.locator('.tcr-done summary')).toHaveText('En casa · 1');
  await owner.locator('.tcr-done summary').click();
  // Desde la recibida también se puede pedir la siguiente.
  await openRequest(owner, 'Pastillas de cloro', 'Recibida');
  await expect(owner.locator('#prNext')).toHaveCount(1);
  await close(owner);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('solicitud: rechazar la esconde tras «Ver rechazadas»; la papelera la quita', async () => {
  await ask(owner, { title: 'Sombrillas nuevas' });
  await openRequest(owner, 'Sombrillas nuevas');
  await owner.locator('#prReject').click();
  await expect(request(owner, 'Sombrillas nuevas')).toHaveCount(0);
  await expect(owner.locator('#toggleRejectedPurchases')).toHaveText('Ver rechazadas (1)');
  await owner.locator('#toggleRejectedPurchases').click();
  await expect(request(owner, 'Sombrillas nuevas')).toContainText('Rechazada');
  await owner.locator('#toggleRejectedPurchases').click();
  await expect(owner.locator('#toggleRejectedPurchases')).toHaveText('Ver rechazadas (1)');

  await ask(owner, { title: 'Pedido por error' });
  await openRequest(owner, 'Pedido por error');
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
    await openRequest(owner, title, 'Pedida');
    await owner.locator('#prApprove').click();
  }
  await go(owner, 'plans');
  await expect(owner.locator('main.plans .subtitle')).toContainText('2 aprobadas sin plan');
  await owner.locator('#preparePlan').click();
  await expect(owner.locator('[data-plan]')).toHaveCount(1);
  // R6: cada plan es plegable; «Preparando» al momento y «2 tiendas» (hallazgos 1 y 2 de la 094).
  await expect(owner.locator('[data-plan-card]')).toContainText('Preparando');
  await expect(owner.locator('[data-plan-card] summary')).toContainText('2 tiendas');
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
  await expect(owner.locator('[data-plan-card]')).toContainText('Terminado');
  await owner.locator('[data-plan]').click();
  await expect(owner.locator('#planDone')).toHaveCount(0);
  await expect(owner.locator('[data-route-item]').first()).toBeDisabled();
  await close(owner);
  await settled(owner);
  expect((await server.rows('tasks.purchase_plans')).map((p) => p.status)).toEqual(['done']);

  // Un plan sin nada comprado se quita y lo suyo vuelve a «aprobadas sin plan».
  await ask(owner, { title: 'Guantes', supplier: 'Ferretería Centro' });
  await openRequest(owner, 'Guantes');
  await owner.locator('#prApprove').click();
  await go(owner, 'plans');
  await expect(owner.locator('main.plans .subtitle')).toContainText('1 aprobadas sin plan');
  await owner.locator('#preparePlan').click();
  await expect(owner.locator('[data-plan]')).toHaveCount(2);
  await owner.locator('[data-plan-card][data-status="draft"] [data-plan]').click();
  await owner.locator('#planDelete').click();
  await expect(owner.locator('[data-plan]')).toHaveCount(1);
  await expect(owner.locator('main.plans .subtitle')).toContainText('1 aprobadas sin plan');
  await settled(owner);
  expect((await serverRequest('Guantes'))[0].plan_stop_id).toBeNull();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('lectura: ve el almacén, las solicitudes y los planes, sin botones para cambiar nada', async () => {
  await go(owner, 'supplies');
  await kitMove(owner, LEJIA, 'Gastar', '5');
  await expect.poll(() => stock(LEJIA)).toBe(1);
  await settled(owner);
  await sync(reader);
  await syncResources(reader);
  await go(reader, 'supplies');
  await expect(itemRow(reader, LEJIA)).toContainText('1 l');
  await expect(itemRow(reader, LEJIA)).toContainText('Bajo mínimo');
  await expect(reader.locator('.stk-row button', { hasText: /^(Gastar|Entrada|Contar|Queda poco: pedir)$/ })).toHaveCount(0);
  await go(reader, 'purchases');
  await expect(reader.locator('#newPurchase')).toHaveCount(0);
  await openRequest(reader, 'Guantes');
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
