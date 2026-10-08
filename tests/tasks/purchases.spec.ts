/**
 * Ikisai Tasks · compras no alimentarias, interfaz (docs/tasks/API.md §18.9 paso 3): responsable de compras en el
 * editor de área, suministro bajo mínimo con aviso en Inicio y «Queda poco: pedir», aprobación solo del responsable,
 * plan por proveedor con hoja de ruta reordenable y casillas, y recepción que suma al almacén.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { E2E_WORKER_KEY, EDITOR, VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { simulateServiceIdentity } from './fixtures.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const navigateView: any, manageTab: any, Sync: any, IkisaiTasks: any, purchaseRun: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, editor: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
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
  await go(owner, 'supplies');
  await owner.locator('#newSupply').click();
  await owner.locator('#suName').fill('Cloro granulado');
  await owner.locator('#suCategory').selectOption('pool');
  await owner.locator('#suUnit').fill('kg');
  await owner.locator('#suMin').fill('5');
  await owner.locator('#suReorder').fill('10');
  await owner.locator('#suSupplier').fill('Piscinas Norte');
  await owner.locator('#suSave').click();
  await expect(owner.locator('.supplyrow')).toHaveCount(1);
  // Entrada de 3 kg: sigue por debajo del mínimo.
  await owner.locator('[data-supply-move$="|in"]').click();
  await owner.locator('#moveAmount').fill('3');
  await owner.locator('#moveSave').click();
  await expect(owner.locator('.supplyrow [data-stock]')).toHaveText('3 kg');
  await go(owner, 'home');
  await expect(owner.locator('.lowstock')).toContainText('Queda poco de 1 suministro');
  await owner.locator('[data-open-supplies]').click();
  await owner.locator('[data-reorder]').click();
  await expect(owner.locator('#prTitle')).toHaveValue('Cloro granulado');
  await expect(owner.locator('#prQuantity')).toHaveValue('10');
  await expect(owner.locator('#prSupplier')).toHaveValue('Piscinas Norte');
  await owner.locator('#prSave').click();
  await expect(owner.locator('.supplyrow')).toContainText('Pedido');
  await settled(owner);
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

test('recibir suma al almacén y quita el aviso', async () => {
  await go(editor, 'purchases');
  await editor.locator('[data-purchase]', { hasText: 'Cloro granulado' }).click();
  await editor.locator('#prReceive').click();
  await go(editor, 'supplies');
  await expect(editor.locator('.supplyrow [data-stock]')).toHaveText('13 kg');
  await expect(editor.locator('[data-reorder]')).toHaveCount(0);
  await settled(editor);
  await owner.evaluate(() => (window as any).syncNow?.());
  await settled(owner);
  await go(owner, 'home');
  await expect(owner.locator('.lowstock')).toHaveCount(0);
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

  // Proveedor habitual del suministro: se elige del catálogo y queda enlazado por su id.
  await go(owner, 'supplies');
  await owner.locator('[data-supply]').first().click();
  await owner.locator('#suSupplier').fill('');
  await owner.locator('#suSupplier').pressSequentially('pisc');
  await expect(owner.locator('#suSupplierList option')).toHaveCount(1);
  await expect(owner.locator('#suSupplierList option')).toHaveAttribute('value', 'Piscinas Norte SL');
  await owner.locator('#suSupplier').fill('Piscinas Norte SL');
  await owner.locator('#suSave').click();
  await expect.poll(async () => (await server.rows('tasks.supply_items')).find((x) => x.name === 'Cloro granulado')?.supplier_id).toBe('sup-piscinas');
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
  await expect(owner.locator('[data-menu-view="triage"]').first()).toContainText('Por clasificar · 1');
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
  await expect(owner.locator('main h1')).toHaveText('Reporte FB_2026_0042');
  await owner.locator('[data-feedback-task]').click();
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
  await expect(owner.locator('[data-menu-view="triage"]').first()).toHaveText(/^\s*Por clasificar\s*$/);
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
