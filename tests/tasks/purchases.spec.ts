/**
 * Ikisai Tasks · compras no alimentarias, interfaz (docs/tasks/API.md §18.9 paso 3): responsable de compras en el
 * editor de área, suministro bajo mínimo con aviso en Inicio y «Queda poco: pedir», aprobación solo del responsable,
 * plan por proveedor con hoja de ruta reordenable y casillas, y recepción que suma al almacén.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, E2E_WORKER_KEY, EDITOR, startE2EServer, type E2EServer } from './e2e-server.ts';
import { menuRow, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { simulateServiceIdentity } from './fixtures.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, navigateView: any, manageTab: any, Sync: any, IkisaiTasks: any, purchaseRun: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, editor: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  editor = await openApp(contextB, server, { user: EDITOR, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

const go = (page: Page, view: string) => page.evaluate((v) => navigateView(v), view);
const syncBoth = async () => { await settled(owner); await editor.evaluate(() => (window as any).syncNow?.()); await settled(editor); };
// R6: el almacén es el inventario común de Recursos (piezas del kit). Conductor: el artículo nace en Recursos por la API (como
// si lo diera de alta otra app o la ficha del kit), el segundo cliente se pone al día a mano y los movimientos van por el kit.
const CLORO = crypto.randomUUID(), ALMACEN = crypto.randomUUID();
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

test('la propietaria nombra responsable de compras en el editor de área', async () => {
  const editorId = (await server.app.t.db.query<{ user_id: string }>(`select user_id from core.memberships where app = 'tasks' and role = 'editor' and scopes is null`)).rows[0]!.user_id;
  await owner.evaluate(() => manageTab());
  await expect(owner.locator('#tabApprover')).toBeVisible();
  await owner.locator('#tabApprover').selectOption(editorId);
  await expect.poll(async () => (await server.rows('tasks.tabs')).find((t) => t.id === ID.ikisai)?.purchase_approver_id, { timeout: 10_000 }).toBe(editorId);
  await settled(owner);
  await owner.evaluate(() => (window as any).closeSheet());
});

test('suministro bajo mínimo: aviso en Inicio y «Queda poco: pedir»', async () => {
  const altura = (await server.app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  await resources([{ op: 'insert', table: 'resources.spaces', id: ALMACEN, fields: { parent_id: altura, kind: 'edificio', name: 'Almacén piscina', position: 1024 } }]);
  await resources([{ op: 'insert', table: 'resources.items', id: CLORO, fields: { name: 'Cloro granulado', kind: 'material', base_unit: 'kg', min_quantity: 5, reorder_quantity: 10, default_space_id: ALMACEN } }]);
  await syncResources(owner);
  await go(owner, 'supplies');
  await expect(itemRow(owner, CLORO)).toHaveCount(1);
  // Entrada de 3 kg: sigue por debajo del mínimo.
  await kitMove(owner, CLORO, 'Entrada', '3');
  await expect.poll(() => stock(CLORO)).toBe(3);
  await expect(itemRow(owner, CLORO)).toContainText('3 kg');
  await go(owner, 'home');
  await expect(owner.locator('.lowstock')).toContainText('Queda poco de 1 suministro');
  await owner.locator('[data-open-supplies]').click();
  await itemRow(owner, CLORO).getByRole('button', { name: 'Queda poco: pedir' }).click();
  await expect(owner.locator('#prTitle')).toHaveValue('Cloro granulado');
  await expect(owner.locator('#prQuantity')).toHaveValue('10');
  await expect(owner.locator('#prUnit')).toHaveValue('kg');
  await expect(owner.locator('#prItem')).toContainText('Cloro granulado');
  await owner.locator('#prSupplier').fill('Piscinas Norte');
  await owner.locator('#prSave').click();
  await expect(itemRow(owner, CLORO).getByRole('button', { name: 'Pedido' })).toHaveCount(1);
  await settled(owner);
  expect((await server.rows('tasks.purchase_requests')).find((r) => r.title === 'Cloro granulado')?.item_id).toBe(CLORO);
});

test('solo el responsable aprueba; el plan agrupa por proveedor y se reordena', async () => {
  // Una segunda solicitud de otro proveedor, para que el plan tenga dos paradas.
  await go(owner, 'purchases');
  await owner.locator('#newPurchase').click();
  await owner.locator('#prTitle').fill('Bombillas LED');
  await owner.locator('#prQuantity').fill('6');
  await owner.locator('#prSupplier').fill('Ferretería Centro');
  await owner.locator('#prSave').click();
  await owner.locator('[data-purchase]', { hasText: 'Bombillas LED' }).click();
  await expect(owner.locator('#prApprove')).toHaveCount(0);
  await owner.evaluate(() => (window as any).closeSheet());
  await go(owner, 'plans');
  await expect(owner.locator('#preparePlan')).toHaveCount(0);
  await syncBoth();

  await go(editor, 'purchases');
  for (const title of ['Cloro granulado', 'Bombillas LED']) {
    await editor.locator('[data-purchase]', { hasText: title }).click();
    await editor.locator('#prApprove').click();
    await expect(editor.locator('[data-purchase]', { hasText: title })).toContainText('Aprobada');
  }
  await go(editor, 'plans');
  await editor.locator('#preparePlan').click();
  await editor.locator('[data-plan]').first().click();
  const stops = editor.locator('[data-stop]');
  await expect(stops).toHaveCount(2);
  const first = (await stops.nth(0).locator('strong').textContent())!.replace(/^1\. /, '');
  await editor.locator('[data-stop-move$="|1"]').first().click();
  await expect(editor.locator('[data-stop]').nth(1).locator('strong')).toContainText(first);
  // Casilla de la hoja de ruta → comprada.
  await editor.locator('[data-stop]', { hasText: 'Piscinas Norte' }).locator('[data-route-item]').check();
  await settled(editor);
  const cloro = (await server.rows('tasks.purchase_requests')).find((r) => r.title === 'Cloro granulado');
  expect(cloro.status).toBe('purchased');
  // Imprimir abre una página aparte con la lista.
  const [popup] = await Promise.all([editor.waitForEvent('popup'), editor.evaluate(() => { (window as any).print = () => {}; document.getElementById('planPrint')!.click(); })]);
  await expect(popup.locator('h2')).toHaveCount(2);
  await popup.close();
  await editor.evaluate(() => (window as any).closeSheet());
});

test('«No se compró» tras terminar el plan por error, con «Deshacer», y «Reabrir el plan» (0337, VG)', async () => {
  const bombillas = async () => (await server.rows('tasks.purchase_requests')).find((r) => r.title === 'Bombillas LED');
  await go(editor, 'plans');
  await editor.locator('[data-plan]').first().click();
  await editor.locator('[data-stop]', { hasText: 'Ferretería Centro' }).locator('[data-route-item]').check();
  await editor.locator('#planDone').click();
  await settled(editor);
  const stop = (await bombillas()).plan_stop_id;
  expect([(await bombillas()).status, stop]).toEqual(['purchased', expect.any(String)]);
  // En la ficha, «No se compró»: vuelve a aprobada y sale del plan terminado; «Deshacer» la deja como estaba.
  await go(editor, 'purchases');
  await editor.locator('[data-purchase]', { hasText: 'Bombillas LED' }).click();
  await expect(editor.locator('#prInvoiced')).toHaveCount(0);
  await editor.locator('#prUndoPurchase').click();
  await editor.getByRole('button', { name: 'Deshacer' }).click();
  await settled(editor);
  await expect.poll(async () => { const r = await bombillas(); return [r.status, r.plan_stop_id]; }).toEqual(['purchased', stop]);
  await editor.locator('[data-purchase]', { hasText: 'Bombillas LED' }).click();
  await editor.locator('#prUndoPurchase').click();
  await settled(editor);
  await expect.poll(async () => { const r = await bombillas(); return [r.status, r.plan_stop_id, r.purchased_at]; }).toEqual(['approved', null, null]);
  await expect(editor.locator('[data-purchase]', { hasText: 'Bombillas LED' })).toContainText('Aprobada');
  // El plan terminado se reabre: vuelve a «De compras» y su casilla se puede desmarcar.
  await go(editor, 'plans');
  await editor.locator('[data-plan]').first().click();
  await expect(editor.locator('[data-route-item]').first()).toBeDisabled();
  await editor.locator('#planReopen').click();
  await settled(editor);
  expect((await server.rows('tasks.purchase_plans'))[0].status).toBe('shopping');
  await expect(editor.locator('[data-stop]', { hasText: 'Piscinas Norte' }).locator('[data-route-item]')).toBeEnabled();
  await editor.evaluate(() => (window as any).closeSheet());
});

test('recibir suma al almacén y quita el aviso', async () => {
  await go(editor, 'purchases');
  await editor.locator('[data-purchase]', { hasText: 'Cloro granulado' }).click();
  await editor.locator('#prReceive').click();
  // La entrada va a Recursos, en el sitio habitual del artículo, una sola vez.
  await expect.poll(() => stock(CLORO)).toBe(13);
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => r.title === 'Cloro granulado').map((r) => r.status)).toEqual(['received']);
  const entry = (await server.app.t.db.query<Record<string, unknown>>(`select kind, space_id, source_app, source_ref from resources.movements where item_id = $1 and source_app = 'tasks' and source_ref like 'purchase_request:%'`, [CLORO])).rows;
  const req = (await server.rows('tasks.purchase_requests')).find((r) => r.title === 'Cloro granulado');
  expect(entry).toEqual([{ kind: 'entrada_manual', space_id: ALMACEN, source_app: 'tasks', source_ref: `purchase_request:${req.id}` }]);
  await settled(editor);
  await syncResources(editor);
  await go(editor, 'supplies');
  await expect(itemRow(editor, CLORO)).toContainText('13 kg');
  await expect(itemRow(editor, CLORO).getByRole('button', { name: 'Queda poco: pedir' })).toHaveCount(0);
  await owner.evaluate(() => (window as any).syncNow?.());
  await settled(owner);
  await syncResources(owner);
  await go(owner, 'home');
  await expect(owner.locator('.lowstock')).toHaveCount(0);
});

test('Inicio se entera sin cambiar de pantalla: el aviso sale y se va con los movimientos de otro dispositivo', async () => {
  // El aviso depende del almacén, que no cambia el modelo de tareas: Inicio tiene que repintarse igual.
  await go(owner, 'home');
  await expect(owner.locator('.lowstock')).toHaveCount(0);
  const move = async (kind: 'Entrada' | 'Gastar', amount: string) => {
    await kitMove(editor, CLORO, kind, amount);
    await expect.poll(() => stock(CLORO)).toBe(kind === 'Gastar' ? 3 : 13);
    await syncResources(owner);
  };
  await go(editor, 'supplies');
  await move('Gastar', '10');
  await expect(owner.locator('.lowstock')).toContainText('Queda poco de 1 suministro');
  await move('Entrada', '10');
  await expect(owner.locator('.lowstock')).toHaveCount(0);
  expect(await owner.evaluate(() => state.view)).toBe('home');
});

test('Finance: factura asignada en la solicitud y proveedor del catálogo (con nombre libre de respaldo)', async () => {
  // Las dos lecturas son de Invoices (y las prueba Invoices); aquí se simulan sus respuestas para probar la interfaz.
  const cloro = (await server.rows('tasks.purchase_requests')).find((r) => r.title === 'Cloro granulado');
  await owner.route('**/read/invoices.allocations_by_target', async (route) => {
    const args = route.request().postDataJSON();
    expect(args).toMatchObject({ targetApp: 'tasks', targetKind: 'purchase_request' });
    const rows = args.ids.includes(cloro.id) ? [{ target_id: cloro.id, invoice_id: 'f1', invoice_code: 'F-2026-0042', status: 'revisada', invoice_date: '2026-10-07', allocated_amount: 48.4, allocated_quantity: 10 }] : [];
    await route.fulfill({ json: { rows } });
  });
  await owner.route('**/read/invoices.supplier_options', async (route) => {
    const { q } = route.request().postDataJSON();
    const all = [{ id: 'sup-piscinas', name: 'Piscinas Norte SL', slug: 'piscinas-norte' }, { id: 'sup-ferre', name: 'Ferretería Centro', slug: 'ferreteria-centro' }];
    await route.fulfill({ json: { items: all.filter((x) => !q || x.name.toLowerCase().includes(q)) } });
  });
  await go(owner, 'purchases');
  await expect(owner.locator('[data-purchase]', { hasText: 'Cloro granulado' })).toContainText('Factura F-2026-0042');
  await owner.locator('[data-purchase]', { hasText: 'Cloro granulado' }).click();
  const link = owner.locator('.pinvoice');
  await expect(link).toContainText('F-2026-0042');
  await expect(link).toHaveAttribute('href', 'https://finance.ikisai.com/#/facturas/F-2026-0042');
  await owner.evaluate(() => (window as any).closeSheet());

  // Proveedor habitual del artículo (ficha del kit): se elige del catálogo de Finance y queda enlazado por su id.
  const SUPPLIER = crypto.randomUUID();
  await owner.unroute('**/read/invoices.supplier_options');
  await owner.route('**/read/invoices.supplier_options', async (route) => {
    const { q } = route.request().postDataJSON();
    const all = [{ id: SUPPLIER, name: 'Piscinas Norte SL', slug: 'piscinas-norte' }];
    await route.fulfill({ json: { items: all.filter((x) => !q || x.name.toLowerCase().includes(q)) } });
  });
  await go(owner, 'supplies');
  await itemRow(owner, CLORO).getByRole('button', { name: 'Abrir Cloro granulado' }).click();
  await kitDialog(owner).getByRole('tab', { name: 'Datos' }).click();
  await kitDialog(owner).locator('#itemSupplier').pressSequentially('pisc');
  await expect(kitDialog(owner).locator('#itemSupplierList option')).toHaveAttribute('value', 'Piscinas Norte SL');
  await kitDialog(owner).locator('#itemSupplier').fill('Piscinas Norte SL');
  await kitDialog(owner).getByRole('button', { name: 'Guardar' }).click();
  await expect.poll(async () => (await server.app.t.db.query<{ s: string }>(`select default_supplier_id::text s from resources.items where id = $1`, [CLORO])).rows[0]!.s).toBe(SUPPLIER);
  await owner.keyboard.press('Escape');
  // Un nombre que no está en el catálogo se guarda como nombre libre, sin id.
  await go(owner, 'purchases');
  await owner.locator('#newPurchase').click();
  await owner.locator('#prTitle').fill('Guantes de nitrilo');
  await owner.locator('#prSupplier').fill('Mercado del barrio');
  await owner.locator('#prSave').click();
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).find((r) => r.title === 'Guantes de nitrilo')?.supplier_name).toBe('Mercado del barrio');
  expect((await server.rows('tasks.purchase_requests')).find((r) => r.title === 'Guantes de nitrilo').supplier_id).toBeNull();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('tarea pedida desde otra app (§19): el editor dice de dónde viene', async () => {
  const asked = await server.app.call('/api/v1/requests/task', { body: { source: 'central', external_ref: 'LEG_2026_004', title: 'Renovar licencia de piscina', tab_id: ID.ikisai } });
  expect(asked.status, JSON.stringify(asked.data)).toBe(200);
  await owner.evaluate(() => (window as any).syncNow?.());
  await settled(owner);
  await expect.poll(() => owner.evaluate((id) => !!Sync.core.data['tasks.tasks'].find((t: any) => t.id === id), asked.data.task.id)).toBe(true);
  await owner.evaluate((id) => (window as any).openTaskEditor(id), asked.data.task.id);
  await expect(owner.locator('#taskOrigin')).toContainText('Pedida desde');
  await expect(owner.locator('#taskOrigin')).toContainText('LEG_2026_004');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('entradas (§20): por clasificar, mover a…, crear regla y mover las que esperaban, descartar', async () => {
  const ask = (body: Record<string, unknown>) => server.app.call('/api/v1/requests/task', { body: { source: 'central', kind: 'central.compliance_due', kind_label: 'Vencimientos', ...body } });
  const first = await ask({ external_ref: 'VTO_1', title: 'Renovar seguro', external_url: 'https://central.ikisai.com/#/cumplimiento/VTO_1' });
  expect(first.data.routed, JSON.stringify(first.data)).toBe('pending');
  const sync = async () => { await owner.evaluate(() => (window as any).syncNow?.()); await settled(owner); };
  await sync();
  await expect.poll(() => owner.evaluate(() => Sync.core.data['tasks.requests'].length)).toBeGreaterThan(0);
  await owner.evaluate(() => (window as any).render());
  // El menú lleva la entrada con su contador (en el móvil, dentro del menú; puede estar en un grupo plegado).
  await expect(await menuRow(owner, 'tasks.menu.por_clasificar', 'work')).toContainText('Por clasificar · 1');
  await owner.evaluate(() => (window as any).closeNavigation());
  await owner.evaluate(() => (window as any).navigateView('triage'));
  await expect(owner.locator('.inboxgroup h2')).toContainText('Vencimientos');
  await expect(owner.locator('[data-request-row] a')).toHaveAttribute('href', 'https://central.ikisai.com/#/cumplimiento/VTO_1');

  // Mover a… la Entrada del área: se crea la tarea con su origen.
  await owner.locator('[data-request-move]').click();
  await owner.locator('#moveRequest').click();
  await expect(owner.locator('.empty')).toContainText('Nada por clasificar');
  await settled(owner);
  const task = (await server.rows('tasks.tasks')).find((t) => t.id === first.data.task.id);
  expect([task.external_kind, task.external_url]).toEqual(['central.compliance_due', 'https://central.ikisai.com/#/cumplimiento/VTO_1']);
  await owner.evaluate((id) => (window as any).openTaskEditor(id), task.id);
  await expect(owner.locator('#taskOrigin')).toContainText('Vencimientos');
  await expect(owner.locator('#taskOrigin a')).toHaveAttribute('href', 'https://central.ikisai.com/#/cumplimiento/VTO_1');
  await owner.evaluate(() => (window as any).closeSheet());

  // Otra del mismo tipo: «Crear regla para este tipo» y mover también la que esperaba.
  await ask({ external_ref: 'VTO_2', title: 'Revisar extintores' });
  await sync();
  await owner.evaluate(() => (window as any).navigateView('triage'));
  await owner.locator('[data-route-new="central.compliance_due"]').click();
  await expect(owner.locator('#routeKind')).toBeDisabled();
  await expect(owner.locator('#routeLabel')).toHaveValue('Vencimientos');
  await owner.locator('#routeSave').click();
  await owner.locator('#routeWaiting').click();
  await expect(owner.locator('.empty')).toContainText('Nada por clasificar');
  await settled(owner);
  expect((await server.rows('tasks.request_routes')).map((r) => r.kind)).toEqual(['central.compliance_due']);
  expect((await server.rows('tasks.requests')).find((r) => r.external_ref === 'central:VTO_2').status).toBe('routed');
  // Con la regla, lo nuevo de ese tipo ya no pasa por «Por clasificar».
  expect((await ask({ external_ref: 'VTO_3', title: 'Pasar la ITV' })).data.routed).toBe('rule');

  // Descartar lo que no es trabajo.
  await server.app.call('/api/v1/requests/task', { body: { source: 'booking', kind: 'booking.space_incident', external_ref: 'INC_1', title: 'Prueba' } });
  await sync();
  await owner.evaluate(() => (window as any).navigateView('triage'));
  await owner.locator('[data-request-dismiss]').click();
  await settled(owner);
  expect((await server.rows('tasks.requests')).find((r) => r.external_ref === 'booking:INC_1').status).toBe('dismissed');

  // Un área «Comercial» para las peticiones de los portales de organizadores (T3).
  const commercial = crypto.randomUUID();
  await server.commit(createTabOps({ id: commercial, name: 'Comercial', position: 99_000, inboxId: crypto.randomUUID() }), server.app.tokens.owner);
  await sync();
  // «Gestionar entradas» lista los tipos conocidos con su destino.
  await owner.locator('#manageRoutes').click();
  await expect(owner.locator('[data-route-edit="central.compliance_due"]')).toContainText('Vencimientos');
  await expect(owner.locator('[data-route-edit="booking.space_incident"]')).toContainText('Por clasificar');
  // Los tipos de los portales salen aunque aún no haya llegado ninguno, y su regla propone el área comercial.
  await expect(owner.locator('[data-route-edit="booking.organizer_dates"]')).toContainText('Organizador · Fechas posibles');
  await expect(owner.locator('[data-route-edit="booking.retreat_project"]')).toContainText('Retiro · Proyecto');
  await owner.locator('[data-route-edit="booking.organizer_confirm"]').click();
  await expect(owner.locator('#routeLabel')).toHaveValue('Organizador · Quiere confirmar');
  await expect(owner.locator('#destTab')).toHaveValue(commercial);
  await owner.locator('#routeSave').click();
  await expect.poll(async () => (await server.rows('tasks.request_routes')).find((r) => r.kind === 'booking.organizer_confirm')?.tab_id).toBe(commercial);
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('enlace directo del panel de Central (§21): #/supplies abre Suministros y limpia el hash', async () => {
  await owner.goto(server.url + '/#/supplies');
  await settled(owner);
  await expect.poll(() => owner.evaluate('state.view')).toBe('supplies');
  expect(await owner.evaluate(() => location.hash)).toBe('');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('enlace de un reporte de Feedback (§22.4): #/feedback/<código> enseña el reporte y su tarea', async () => {
  const asked = await server.app.call('/api/v1/requests/task', { body: { source: 'feedback', kind: 'feedback.space.damage', external_ref: 'FB_2026_0042', title: 'Persiana rota en la sala 2', tab_id: ID.ikisai } });
  expect(asked.status, JSON.stringify(asked.data)).toBe(200);
  await owner.goto(server.url + '/#/feedback/FB_2026_0042');
  await settled(owner);
  // MUELA-064 (tanda 31): el resguardo lleva el título y el estado; el código no se ve (va en el enlace que se copia).
  await owner.evaluate(() => (window as any).syncNow?.());
  await settled(owner);
  await expect(owner.locator('main h1')).toHaveText('Persiana rota en la sala 2');
  await expect(owner.locator('#tkrState')).toHaveText('En marcha');
  await expect(owner.locator('main')).not.toContainText('FB_2026_0042');
  await owner.locator('[data-tkr-open]').click();
  await expect(owner.locator('#taskOrigin')).toContainText('FB_2026_0042');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('reporte de huésped por el worker de Feedback (§22.2): entra por la regla y el editor dice quién informó', async () => {
  // La identidad de servicio es de Core (0067); aquí se simula.
  await simulateServiceIdentity(server.app.t.db, crypto.randomUUID());
  await server.commit([{ op: 'insert', table: 'tasks.request_routes', id: crypto.randomUUID(), fields: { kind: 'feedback.space.damage', tab_id: ID.ikisai, position: 1 } }], server.app.tokens.owner);
  const res = await server.app.handler(new Request('http://localhost/api/v1/worker/requests/task', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': E2E_WORKER_KEY }, body: JSON.stringify({
    source: 'feedback', kind: 'feedback.space.damage', kind_label: 'Espacio · Avería', external_ref: 'FB_2026_000429', title: 'Ducha no evacúa bien · Habitación 3',
    note: 'Reporte de huésped. Ver detalle autorizado.', external_url: 'https://tasks.ikisai.com/#/feedback/FB_2026_000429', on_behalf_of: { kind: 'guest', report_code: 'FB_2026_000429' } }) }));
  const out = await res.json() as any;
  expect(out.status, JSON.stringify(out)).toBe('open');
  await owner.evaluate(() => (window as any).syncNow?.());
  await settled(owner);
  await expect.poll(() => owner.evaluate((id) => !!Sync.core.data['tasks.tasks'].find((t: any) => t.id === id), out.taskId)).toBe(true);
  await owner.evaluate((id) => (window as any).openTaskEditor(id), out.taskId);
  await expect(owner.locator('#taskOrigin')).toContainText('Reporte de huésped · Espacio · Avería · FB_2026_000429');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('«Por clasificar» siempre a mano para la propietaria, y aviso del área de los retiros que falta', async () => {
  // Sin nada pendiente sigue en el menú, sin contador: por ahí se entra a «Gestionar entradas».
  const pending = await owner.evaluate(() => IkisaiTasks.requests.pendingRequests(Sync.core.data).length);
  if (pending) await owner.evaluate(() => { for (const r of IkisaiTasks.requests.pendingRequests(Sync.core.data)) purchaseRun((d: any) => IkisaiTasks.requests.dismissRequestOps(d, r.id)); });
  await settled(owner);
  await owner.evaluate(() => (window as any).render());
  await expect(await menuRow(owner, 'tasks.menu.por_clasificar', 'work')).toHaveText(/^\s*Por clasificar\s*$/);
  await owner.evaluate(() => (window as any).closeNavigation());
  await owner.evaluate(() => (window as any).navigateView('triage'));
  await expect(owner.locator('#retreatRouteMissing')).toContainText('Falta elegir el área de los proyectos de retiro');
  await owner.locator('#retreatRouteMissing [data-route-new="booking.retreat_project"]').click();
  await expect(owner.locator('#routeLabel')).toHaveValue('Retiro · Proyecto');
  await expect(owner.locator('#routeAreaOnly')).toBeVisible();
  await owner.locator('#routeSave').click();
  await expect.poll(async () => (await server.rows('tasks.request_routes')).some((r) => r.kind === 'booking.retreat_project' && !r.deleted_at)).toBe(true);
  await owner.evaluate(() => (window as any).navigateView('triage'));
  await expect(owner.locator('#retreatRouteMissing')).toHaveCount(0);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('compras por proveedor (8-10-2026): lo pendiente de cada proveedor, esté o no en un plan', async () => {
  await go(owner, 'purchases');
  await owner.locator('[data-purchase-grouping="supplier"]').click();
  await expect(owner.locator('[data-purchase-grouping="supplier"]')).toHaveAttribute('aria-pressed', 'true');
  const labels = await owner.locator('main.purchases .sectionlabel').allTextContents();
  expect(labels.some((l) => /Ferretería Centro/.test(l)), labels.join(' | ')).toBe(true);
  expect(labels.every((l) => !/^\s*(Pedidas|Aprobadas|Compradas)\b/.test(l)), 'sin las secciones por estado').toBe(true);
  // Se recuerda en el dispositivo.
  await go(owner, 'home');
  await go(owner, 'purchases');
  await expect(owner.locator('[data-purchase-grouping="supplier"]')).toHaveAttribute('aria-pressed', 'true');
  await owner.locator('[data-purchase-grouping="status"]').click();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});


test('la regla propuesta busca también el proyecto por su nombre (estructura del 8-10-2026)', async () => {
  // Un proyecto «Administración y fiscal» en un área «Gestiones»: la regla del plazo de SES lo propone directamente.
  const tab = crypto.randomUUID(), project = crypto.randomUUID();
  await server.commit(createTabOps({ id: tab, name: 'Gestiones', position: 98_000, inboxId: crypto.randomUUID() }), server.app.tokens.owner);
  await server.commit([{ op: 'insert', table: 'tasks.projects', id: project, fields: { tab_id: tab, title: 'Administración y fiscal', position: 2048 } }], server.app.tokens.owner);
  await owner.evaluate(() => (window as any).syncNow?.());
  await settled(owner);
  await go(owner, 'triage');
  await owner.locator('#manageRoutes').click();
  await owner.locator('[data-route-edit="booking.ses_deadline"]').click();
  await expect(owner.locator('#destTab')).toHaveValue(tab);
  await expect(owner.locator('#destProject')).toHaveValue(project);
  // Los tipos de Central y del feedback del espacio también salen como conocidos.
  await owner.evaluate(() => (window as any).closeSheet());
  await owner.locator('#manageRoutes').click();
  await expect(owner.locator('[data-route-edit="central.compliance_due"]')).toContainText('Vencimientos');
  await expect(owner.locator('[data-route-edit="feedback.space.damage"]')).toContainText('Avería');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
