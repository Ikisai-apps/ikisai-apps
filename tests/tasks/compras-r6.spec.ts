/**
 * Ikisai Tasks · Compras R6 «Estantería» (MUELA-094, tanda 40; docs/tasks/API.md §18.10). Las PRUEBAS del traspaso y las de
 * Sevilla: aprobar con «Deshacer» y «Aprobar las N» en lote, comprada con «Deshacer» (no con factura), arrastrar de tienda
 * (y no si está en un plan o comprada), recibir con confirmación y el envase entero en la unidad base, el cuadre con
 * Finance (cuadrada, con diferencia, sin factura, fallo con «Reintentar» y cola sin red), Suministros (−1 con «Deshacer»,
 * «Pedir lo que falta», otro sitio con traslado), Planes (sin lo quitado, «Preparando», añadir y sacar, casilla, «Deshacer»
 * con recurrentes), PURCHASE_INVOICED tras el rechazo, fichas (pedir con la tarea, − y + en el consumo) y papeles.
 * Datos ficticios.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, E2E_WORKER_KEY, EDITOR, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { fichaBloque, openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const navigateView: any, Sync: any, IkisaiTasks: any, purchaseRun: any, openTaskEditor: any, consumptionSheet: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext, contextC: BrowserContext;
let owner: Page, juan: Page, reader: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

const ALMACEN = crypto.randomUUID(), CUARTO = crypto.randomUUID();
const LEJIA = crypto.randomUUID(), BUTANO = crypto.randomUUID(), GUANTES = crypto.randomUUID(), MASILLA = crypto.randomUUID();
const LIMPIA = crypto.randomUUID(), BOLSAS = crypto.randomUUID(), BARNIZ = crypto.randomUUID();
const R = { lejia: crypto.randomUUID(), guantes: crypto.randomUUID(), butano: crypto.randomUUID(), masilla: crypto.randomUUID(), cinta: crypto.randomUUID() };

const go = (page: Page, view: string) => page.evaluate((v) => navigateView(v), view);
const sync = async (page: Page) => { await settled(page); await page.evaluate(() => (window as any).syncNow?.()); await settled(page); await page.evaluate(() => Sync.core.resources?.sync()); };
const resources = async (operations: unknown[]) => {
  const res = await server.app.call('/api/v1/resources/commands', { body: { requestId: `r-${crypto.randomUUID()}`, operations } });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const sql = (q: string, args: unknown[] = []) => server.app.t.db.query<any>(q, args);
const stock = async (item: string) => Number((await sql(`select coalesce(sum(quantity), 0) as q from resources.movements where item_id = $1 and deleted_at is null`, [item])).rows[0]!.q);
const req = async (id: string) => (await server.rows('tasks.purchase_requests')).find((r) => r.id === id);
const tile = (page: Page, id: string) => page.locator(`.tile-box[data-purchase="${id}"]`);
const more = async (page: Page, id: string) => { await tile(page, id).locator('.tile-more').click(); await expect(page.locator('#sheet .tcr-menu')).toBeVisible(); };
const undo = (page: Page) => page.getByRole('button', { name: 'Deshacer' });
const openDone = async (page: Page) => { const d = page.locator('.tcr-done'); if (!(await d.evaluate((e) => (e as HTMLDetailsElement).open))) await d.locator('summary').click(); };
const queue = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tasks.compras.cuadre_pendiente') || '[]'));

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const altura = (await sql(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  await resources([
    { op: 'insert', table: 'resources.spaces', id: ALMACEN, fields: { parent_id: altura, kind: 'edificio', name: 'Almacén', position: 1024 } },
    { op: 'insert', table: 'resources.spaces', id: CUARTO, fields: { parent_id: altura, kind: 'edificio', name: 'Cuarto de limpieza', position: 2048 } },
  ]);
  await resources([
    { op: 'insert', table: 'resources.items', id: LEJIA, fields: { name: 'Lejía', kind: 'limpieza', base_unit: 'l', min_quantity: 4, default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: BUTANO, fields: { name: 'Butano', kind: 'material', base_unit: 'ud', default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: GUANTES, fields: { name: 'Guantes de nitrilo', kind: 'limpieza', base_unit: 'ud', default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: MASILLA, fields: { name: 'Masilla', kind: 'material', base_unit: 'ud', default_space_id: ALMACEN } },
    { op: 'insert', table: 'resources.items', id: LIMPIA, fields: { name: 'Limpiacristales', kind: 'limpieza', base_unit: 'l', min_quantity: 3, default_space_id: CUARTO } },
    { op: 'insert', table: 'resources.items', id: BOLSAS, fields: { name: 'Bolsas de basura', kind: 'limpieza', base_unit: 'ud', min_quantity: 10, default_space_id: CUARTO } },
    { op: 'insert', table: 'resources.items', id: BARNIZ, fields: { name: 'Barniz', kind: 'material', base_unit: 'l', default_space_id: ALMACEN } },
  ]);
  await resources([
    { op: 'insert', table: 'resources.item_units', id: crypto.randomUUID(), fields: { item_id: LEJIA, unit: 'garrafa de 5 l', factor: 5, usual: true, price: 9.7 } },
    { op: 'insert', table: 'resources.item_units', id: crypto.randomUUID(), fields: { item_id: GUANTES, unit: 'caja de 100', factor: 100, usual: true } },
    { op: 'insert', table: 'resources.item_units', id: crypto.randomUUID(), fields: { item_id: LIMPIA, unit: 'botella de 750 ml', factor: 0.75, usual: true, price: 2.4 } },
    { op: 'insert', table: 'resources.item_units', id: crypto.randomUUID(), fields: { item_id: BARNIZ, unit: 'bote de 15 l', factor: 15, usual: true, price: 54 } },
    { op: 'insert', table: 'resources.movements', id: crypto.randomUUID(), fields: { item_id: BARNIZ, space_id: ALMACEN, quantity: 3, kind: 'entrada_manual', source_app: 'tasks' } },
  ]);
  const tab = ID.ikisai!;
  const base = { tab_id: tab, position: 1024, priority: 'normal' };
  const res = await server.commit([
    { op: 'insert', table: 'tasks.purchase_requests', id: R.lejia, fields: { ...base, title: 'Lejía', item_id: LEJIA, quantity: 19, unit: 'l', need_quantity: 19, supplier_name: 'Droguería Sol' } },
    { op: 'insert', table: 'tasks.purchase_requests', id: R.guantes, fields: { ...base, position: 2048, title: 'Guantes de nitrilo', item_id: GUANTES, quantity: 165, unit: 'ud', need_quantity: 165, needs_invoice: false, supplier_name: 'Droguería Sol' } },
    { op: 'insert', table: 'tasks.purchase_requests', id: R.butano, fields: { ...base, position: 3072, title: 'Butano', item_id: BUTANO, quantity: 2, unit: 'ud', estimated_amount: 38.8, supplier_name: 'Gasolinera Norte' } },
    { op: 'insert', table: 'tasks.purchase_requests', id: R.masilla, fields: { ...base, position: 4096, title: 'Masilla', item_id: MASILLA, quantity: 1, unit: 'ud', estimated_amount: 6.9, supplier_name: 'Ferretería Centro' } },
    { op: 'insert', table: 'tasks.purchase_requests', id: R.cinta, fields: { ...base, position: 5120, title: 'Cinta de carrocero', quantity: 3, supplier_name: 'Ferretería Centro' } },
  ] as any, server.app.tokens.owner);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contextC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  juan = await openApp(contextB, server, { user: EDITOR, aliases: ID, errors });
  reader = await openApp(contextC, server, { user: READER, aliases: ID, errors });
  // Finance (simulado, como en purchases.spec.ts): el butano y la masilla tienen factura; la masilla, 0,50 € más.
  await owner.route('**/read/invoices.allocations_by_target', async (route) => {
    const { ids } = route.request().postDataJSON();
    const all = [
      { target_id: R.butano, invoice_id: 'f1', invoice_code: 'F-2026-0412', status: 'validada', invoice_date: '2026-10-20', allocated_amount: 38.8 },
      { target_id: R.masilla, invoice_id: 'f2', invoice_code: 'F-2026-0377', status: 'validada', invoice_date: '2026-10-18', allocated_amount: 7.4 },
    ];
    await route.fulfill({ json: { rows: all.filter((x) => ids.includes(x.target_id)) } });
  });
  for (const p of [owner, juan, reader]) await sync(p);
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await contextC?.close(); await server?.close(); });

test('papeles: Juan edita y no aprueba («aprueba la propietaria»); la lectora no tiene mandos', async () => {
  await go(juan, 'purchases');
  await expect(tile(juan, R.lejia)).toContainText('Pedida');
  await expect(juan.locator('#tcrApproveAll')).toHaveCount(0);
  await expect(juan.locator('.tile-main[aria-label^="Aprobar"]')).toHaveCount(0);
  await expect(juan.locator('.tcr-howto')).toHaveText('Aprueba la propietaria.');
  await go(reader, 'purchases');
  await expect(tile(reader, R.lejia)).toHaveCount(1);
  await expect(reader.locator('#newPurchase, #tcrApproveAll, .tile-main[aria-label^="Aprobar"], button.tile-media')).toHaveCount(0);
  await more(reader, R.lejia);
  await expect(reader.locator('#tcrMoreNext, #tcrMoreReject, #tcrMoreFormat, #tcrMoreMove')).toHaveCount(0);
  await reader.evaluate(() => (window as any).closeSheet());
  await go(reader, 'supplies');
  await expect(reader.locator('.tile-box[data-supply-item]')).not.toHaveCount(0);
  await expect(reader.locator('.tile-box[data-supply-item] .tile-main, .tile-box[data-supply-item] .tile-more')).toHaveCount(0);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('aprobar con un toque y «Deshacer»; «Aprobar las 5» en un lote y su «Deshacer» las devuelve todas', async () => {
  await go(owner, 'purchases');
  await expect(owner.locator('.tcr-banner')).toContainText('Te toca aprobar · 5');
  // Envase: la lejía se compra en 4 garrafas de 5 l; hace falta 19 l y 1 l va al almacén.
  await expect(tile(owner, R.lejia).locator('.tile-value')).toHaveText('4 garrafas de 5 l');
  await expect(tile(owner, R.lejia)).toContainText('hace falta 19 l · 1 l al almacén');
  await tile(owner, R.lejia).locator('.tile-main').click();
  await expect.poll(async () => (await req(R.lejia)).status).toBe('approved');
  await undo(owner).click();
  await expect.poll(async () => (await req(R.lejia)).status).toBe('requested');
  await owner.locator('#tcrApproveAll').click();
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => Object.values(R).includes(r.id) && r.status === 'approved').length).toBe(5);
  await undo(owner).click();
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => Object.values(R).includes(r.id) && r.status === 'requested').length).toBe(5);
  await owner.locator('#tcrApproveAll').click();
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => Object.values(R).includes(r.id) && r.status === 'approved').length).toBe(5);
  await expect(owner.locator('#tcrApproveAll')).toHaveCount(0);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('comprada con «Deshacer»; con la factura conocida no se ofrece', async () => {
  await tile(owner, R.lejia).locator('.tile-main').click();
  await expect.poll(async () => (await req(R.lejia)).status).toBe('purchased');
  await undo(owner).click();
  await expect.poll(async () => (await req(R.lejia)).status).toBe('approved');
  await tile(owner, R.lejia).locator('.tile-main').click();
  await expect.poll(async () => (await req(R.lejia)).status).toBe('purchased');
  // La masilla ya tiene factura en Finance: comprada, sin «Deshacer».
  await expect(tile(owner, R.masilla)).toContainText('Factura F-2026-0377');
  await tile(owner, R.masilla).locator('.tile-main').click();
  await expect.poll(async () => (await req(R.masilla)).status).toBe('purchased');
  await expect(owner.getByText('«Masilla» comprada.')).toBeVisible();
  await expect(undo(owner)).toHaveCount(0);
  for (const id of [R.butano, R.guantes]) { await tile(owner, id).locator('.tile-main').click(); await expect.poll(async () => (await req(id)).status).toBe('purchased'); }
  // Los guantes no llevan «Llegará factura» ni cuadre.
  await expect(tile(owner, R.guantes).locator('.tcr-cuadreline')).toHaveCount(0);
  await expect(tile(owner, R.lejia).locator('.tcr-cuadreline')).toHaveText('Llegará factura');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('arrastrar a otra tienda (y «Mover a otra tienda» del «⋯»), con «Deshacer»; comprada no se mueve', async () => {
  // Con el «⋯»: la cinta pasa a Droguería Sol y «Deshacer» la devuelve.
  await more(owner, R.cinta);
  await owner.locator('#tcrMoreMove').click();
  await owner.locator('#kitLayer [role="dialog"]').getByRole('button', { name: 'Droguería Sol' }).click();
  await expect.poll(async () => (await req(R.cinta)).supplier_name).toBe('Droguería Sol');
  await undo(owner).click();
  await expect.poll(async () => (await req(R.cinta)).supplier_name).toBe('Ferretería Centro');
  // Con el ratón (Juan, en el ordenador): arrastrar a la estantería de Gasolinera Norte.
  await sync(juan);
  await go(juan, 'purchases');
  const from = tile(juan, R.cinta), to = juan.locator('.shelf-row[data-shelf-row="Gasolinera Norte"] .shelf-head');
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  await juan.mouse.move(a.x + 20, a.y + a.height - 12);
  await juan.mouse.down();
  await juan.mouse.move(a.x + 40, a.y + a.height, { steps: 4 });
  await juan.mouse.move(b.x + 60, b.y + 10, { steps: 12 });
  await juan.mouse.up();
  await expect.poll(async () => (await req(R.cinta)).supplier_name).toBe('Gasolinera Norte');
  // Comprada: ni se arrastra ni el «⋯» la mueve; dice por qué.
  await sync(owner);
  await expect(owner.locator(`.shelf-cell[data-shelf-key="${R.lejia}"]`)).toHaveAttribute('data-shelf-drag', '0');
  await more(owner, R.lejia);
  await expect(owner.locator('#tcrMoreMove')).toHaveCount(0);
  await expect(owner.locator('#tcrMoreWhy')).toHaveText('Ya está comprada: la tienda no cambia.');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('ha llegado con confirmación: la lejía pide 19 l y entran 20 (4 garrafas de 5 l); el butano entra tal cual y cuadra', async () => {
  await tile(owner, R.lejia).locator('.tile-main').click();
  await expect(owner.locator('#tcrEntryText')).toHaveText('Entran 4 garrafas de 5 l (20 l) en Almacén · 1 l más de lo que hacía falta.');
  expect(await stock(LEJIA), 'nada entra sin confirmar').toBe(0);
  await owner.locator('#tcrReceiveOk').click();
  await expect.poll(() => stock(LEJIA)).toBe(20);
  const entry = (await sql(`select quantity::text q, unit_cost::text c from resources.movements where item_id = $1 and source_app = 'tasks'`, [LEJIA])).rows;
  expect(entry.map((e: any) => [Number(e.q), Number(e.c)])).toEqual([[20, 1.94]]);
  await expect.poll(async () => (await req(R.lejia)).status).toBe('received');
  // El butano (sin envase en la ficha) entra tal cual: +2; el aviso dice el cuadre con su factura.
  await tile(owner, R.butano).locator('.tile-main').click();
  await owner.locator('#tcrReceiveOk').click();
  await expect.poll(() => stock(BUTANO)).toBe(2);
  await expect(owner.getByText(/Cuadrada con F-2026-0412: 38,80\s€/).last()).toBeVisible();
  // La masilla, con 0,50 € más; los guantes, 2 cajas de 100 para 165 y sin cuadre.
  await tile(owner, R.masilla).locator('.tile-main').click();
  await owner.locator('#tcrReceiveOk').click();
  await tile(owner, R.guantes).locator('.tile-main').click();
  await expect(owner.locator('#tcrEntryText')).toHaveText('Entran 2 cajas de 100 (200 unidades) en Almacén · 35 unidades más de lo que hacía falta.');
  await owner.locator('#tcrReceiveOk').click();
  await expect.poll(() => stock(GUANTES)).toBe(200);
  await openDone(owner);
  await expect(owner.locator('.tcr-doneitem', { hasText: 'Masilla' })).toContainText(/Cuadrada con F-2026-0377: 7,40\s€ · \+0,50\s€ sobre lo previsto/);
  await expect(owner.locator('.tcr-doneitem', { hasText: 'Guantes de nitrilo' }).locator('.tcr-cuadreline')).toHaveCount(0);
  // En la hoja: el envase y el cuadre arriba.
  await owner.locator('.tcr-doneitem', { hasText: 'Lejía' }).click();
  await expect(owner.locator('#tcrPack')).toContainText('Se compra 4 garrafas de 5 l');
  await expect(owner.locator('#tcrPack')).toContainText('Hace falta 19 l · 1 l al almacén');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('el cuadre que falla se ve y se apunta; «Reintentar» lo hace y el foco vuelve al bloque del cuadre', async () => {
  const id = crypto.randomUUID();
  await server.commit([{ op: 'insert', table: 'tasks.purchase_requests', id, fields: { tab_id: ID.ikisai, title: 'Detergente', quantity: 1, status: 'approved', supplier_name: 'Droguería Sol', position: 9000 } }] as any, server.app.tokens.owner);
  await sync(owner);
  await go(owner, 'purchases');
  await tile(owner, id).locator('.tile-main').click();
  await expect.poll(async () => (await req(id)).status).toBe('purchased');
  await owner.route('**/purchases/reconcile', (route) => route.abort());
  await tile(owner, id).locator('.tile-main').click();
  await owner.locator('#tcrReceiveOk').click();
  await expect(owner.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await expect.poll(() => queue(owner)).toContain(id);
  await openDone(owner);
  await expect(owner.locator('.tcr-doneitem', { hasText: 'Detergente' })).toContainText('El cuadre con Finance no se pudo hacer · se reintenta');
  await owner.locator('.tcr-doneitem', { hasText: 'Detergente' }).click();
  await expect(owner.locator('.tcr-cuadre')).toContainText('No se pudo cuadrar');
  // Vuelve el servicio: «Reintentar» a mano (también se reintenta solo al volver la red o al abrir Compras).
  await owner.unroute('**/purchases/reconcile');
  await owner.locator('#tcrRetry').click();
  await expect.poll(() => queue(owner)).not.toContain(id);
  await expect(owner.locator('.tcr-cuadre')).toBeFocused();
  await expect(owner.locator('.tcr-cuadre')).toContainText('Sin factura todavía');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('sin red, el cuadre queda en la cola del dispositivo y se hace solo al volver la red', async () => {
  const id = crypto.randomUUID();
  await server.commit([{ op: 'insert', table: 'tasks.purchase_requests', id, fields: { tab_id: ID.ikisai, title: 'Estropajos', quantity: 4, status: 'approved', supplier_name: 'Droguería Sol', position: 9100 } }] as any, server.app.tokens.owner);
  await sync(owner);
  await go(owner, 'purchases');
  await tile(owner, id).locator('.tile-main').click();
  await expect.poll(async () => (await req(id)).status).toBe('purchased');
  await contextA.setOffline(true);
  await tile(owner, id).locator('.tile-main').click();
  await owner.locator('#tcrReceiveOk').click();
  await expect.poll(() => queue(owner)).toContain(id);
  await expect(owner.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await contextA.setOffline(false);
  await owner.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => queue(owner), { timeout: 20_000 }).not.toContain(id);
  await expect.poll(async () => (await req(id)).status).toBe('received');
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('suministros: −1 con «Deshacer» (el movimiento contrario), «Pedir lo que falta» y otro sitio con traslado', async () => {
  await sync(owner);
  await go(owner, 'supplies');
  const lejia = owner.locator(`.tile-box[data-supply-item="${LEJIA}"]`);
  await expect(lejia.locator('.tile-value')).toHaveText('20 l');
  await lejia.locator('.tile-main').click();
  await expect.poll(() => stock(LEJIA)).toBe(19);
  await undo(owner).click();
  await expect.poll(() => stock(LEJIA)).toBe(20);
  const kinds = (await sql(`select kind, quantity::text q from resources.movements where item_id = $1 and source_app = 'tasks' order by at, created_at`, [LEJIA])).rows.map((m: any) => [m.kind, Number(m.q)]);
  expect(kinds).toEqual([['entrada_manual', 20], ['salida_manual', -1], ['entrada_manual', 1]]);
  // «Pedir lo que falta»: una solicitud por artículo con lo que hace falta (el envase lo redondea).
  await expect(owner.locator('.tcr-banner')).toContainText('Queda poco de 2');
  await owner.locator('#tcrOrderAll').click();
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => [LIMPIA, BOLSAS].includes(r.item_id) && !r.deleted_at).map((r) => [r.title, Number(r.need_quantity)]).sort()).toEqual([['Bolsas de basura', 10], ['Limpiacristales', 3]]);
  await expect(owner.locator(`.tile-box[data-supply-item="${LIMPIA}"]`)).toContainText('Pedido · pedida');
  // Otro sitio: la lejía pasa a guardarse en el cuarto de limpieza y se apunta el traslado de lo que había.
  await owner.locator(`.tile-box[data-supply-item="${LEJIA}"] .tile-more`).click();
  await owner.locator('[data-tcr-supply="move"]').click();
  await owner.locator('#kitLayer [role="dialog"]').getByRole('button', { name: 'Cuarto de limpieza' }).click();
  await expect.poll(async () => (await sql(`select default_space_id::text s from resources.items where id = $1`, [LEJIA])).rows[0].s).toBe(CUARTO);
  const form = owner.locator('#kitLayer [role="dialog"]').last();
  await expect(form).toContainText('Trasladar');
  await form.getByLabel('Cuánto', { exact: true }).fill('20');
  // «A»: el sitio nuevo, a un toque (el «De» ya es el de antes).
  await expect(form.getByText('Almacén', { exact: false }).first()).toBeVisible();
  await form.getByRole('button', { name: 'Cuarto de limpieza', exact: true }).last().click();
  await form.getByRole('button', { name: 'Trasladar', exact: true }).click();
  await expect.poll(async () => (await sql(`select count(*)::int n from resources.movements where item_id = $1 and kind = 'traslado'`, [LEJIA])).rows[0].n).toBe(2);
  expect(await stock(LEJIA)).toBe(20);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('planes: «Preparando» al momento, sin lo quitado; «Deshacer» borra las recurrentes; añadir, sacar y casilla', async () => {
  // Una recurrente que toca (recibida hace 40 días, cada 30).
  const recur = crypto.randomUUID();
  await server.commit([{ op: 'insert', table: 'tasks.purchase_requests', id: recur, fields: { tab_id: ID.ikisai, title: 'Pastillas de cloro', quantity: 5, unit: 'kg', repeat_days: 30, status: 'approved', supplier_name: 'Piscinas Sur', position: 9200 } }] as any, server.app.tokens.owner);
  await sql(`set session_replication_role = replica`);
  await sql(`update tasks.purchase_requests set status = 'received', received_at = now() - interval '40 days' where id = $1`, [recur]);
  await sql(`set session_replication_role = origin`);
  // Un cambio normal después, para que la fila (con su fecha de recepción) llegue a los dispositivos.
  const rev = (await req(recur)).revision;
  expect((await server.commit([{ op: 'update', table: 'tasks.purchase_requests', id: recur, expectedRevision: rev, fields: { note: 'Cada mes' } }] as any, server.app.tokens.owner)).status).toBe(200);
  await sync(owner);
  await go(owner, 'purchases');
  await owner.locator('#tcrApproveAll').click();
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => [LIMPIA, BOLSAS].includes(r.item_id) && r.status === 'approved').length).toBe(2);
  await go(owner, 'plans');
  await expect(owner.locator('main.plans .subtitle')).toContainText('· 1 recurrentes que tocan');
  await expect(owner.locator('.tcr-pills')).toContainText('Pastillas de cloro · Piscinas Sur · recurrente');
  // Quitar las bolsas: no entran.
  await owner.locator('.tcr-pill', { hasText: 'Bolsas de basura' }).locator('[data-tcr-skip]').click();
  await expect(owner.locator('#preparePlan')).toContainText('Crear el plan con 3 cosas');
  await owner.locator('#preparePlan').click();
  await expect(owner.locator('[data-plan-card]')).toContainText('Preparando');
  await settled(owner);
  const plans = async () => (await server.rows('tasks.purchase_plans')).filter((p) => !p.deleted_at);
  expect((await plans()).map((p) => p.status)).toEqual(['draft']);
  const bolsas = (await server.rows('tasks.purchase_requests')).find((r) => r.item_id === BOLSAS);
  expect(bolsas.plan_stop_id).toBeNull();
  // «Deshacer»: el plan se va y la recurrente que creó, también.
  await undo(owner).click();
  await expect.poll(async () => (await plans()).length).toBe(0);
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => r.title === 'Pastillas de cloro' && !r.deleted_at).map((r) => r.status)).toEqual(['received']);
  // Otra vez, con todo.
  await owner.locator('#preparePlan').click();
  await expect.poll(async () => (await plans()).length).toBe(1);
  const card = owner.locator('[data-plan-card]');
  await expect(card.locator('summary')).toContainText('0 de 4 compradas');
  // Sacar la cinta del plan y volver a añadirla.
  const cinta = card.locator(`[data-tcr-line="${R.cinta}"]`);
  await cinta.locator('[data-tcr-out]').click();
  await expect.poll(async () => (await req(R.cinta)).plan_stop_id).toBeNull();
  await card.locator('[data-tcr-addto]').click();
  await owner.locator(`[data-tcr-add="${R.cinta}"]`).click();
  await expect.poll(async () => (await req(R.cinta)).plan_stop_id).not.toBeNull();
  // Casilla de 46 px: comprada y deshacer.
  await card.locator(`[data-tcr-got="${R.cinta}"]`).click();
  await expect.poll(async () => (await req(R.cinta)).status).toBe('purchased');
  await card.locator(`[data-tcr-got="${R.cinta}"]`).click();
  await expect.poll(async () => (await req(R.cinta)).status).toBe('approved');
  // En un plan, no se cambia de tienda: el «⋯» dice en cuál está.
  await go(owner, 'purchases');
  await expect(owner.locator(`.shelf-cell[data-shelf-key="${R.cinta}"]`)).toHaveAttribute('data-shelf-drag', '0');
  await more(owner, R.cinta);
  await expect(owner.locator('#tcrMoreWhy')).toContainText('Está en el plan «Compra del');
  await owner.evaluate(() => (window as any).closeSheet());
  // Terminar y reabrir, en la hoja de siempre.
  await go(owner, 'plans');
  await card.locator('[data-plan]').click();
  await owner.locator('#planShop').click();
  await owner.locator('#planDone').click();
  await expect(card).toContainText('Terminado');
  await card.locator('[data-plan]').click();
  await owner.locator('#planReopen').click();
  await settled(owner);
  expect((await plans())[0].status).toBe('shopping');
  await owner.evaluate(() => (window as any).closeSheet());
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('PURCHASE_INVOICED tras el rechazo: «No se compró» sin saber de la factura vuelve a «comprada» y lo dice', async () => {
  await go(owner, 'plans');
  await owner.locator(`[data-plan-card] [data-tcr-got="${R.cinta}"]`).click();
  await expect.poll(async () => (await req(R.cinta)).status).toBe('purchased');
  // Finance liga la cinta a una factura; este dispositivo no lo sabe (su lectura no la trae).
  const supplier = crypto.randomUUID(), invoice = crypto.randomUUID(), line = crypto.randomUUID();
  await sql(`set session_replication_role = replica`);
  await sql(`insert into invoices.suppliers (id, name, slug) values ($1, 'Ferretería de prueba', 'ferreteria')`, [supplier]);
  await sql(`insert into invoices.invoices (id, supplier_id, object, invoice_date, status) values ($1, $2, 'Material', '2026-10-20', 'validada')`, [invoice, supplier]);
  await sql(`insert into invoices.invoice_lines (id, invoice_id, position, description, net_amount, quantity) values ($1, $2, 0, 'Cinta', 4, 3)`, [line, invoice]);
  await sql(`insert into invoices.allocations (id, invoice_line_id, invoice_id, target_app, target_kind, target_id, target_label, allocated_amount) values ($1, $2, $3, 'tasks', 'purchase_request', $4, 'Cinta', 4)`, [crypto.randomUUID(), line, invoice, R.cinta]);
  await sql(`set session_replication_role = origin`);
  await go(owner, 'purchases');
  await more(owner, R.cinta);
  await owner.locator('#tcrDetails').click();
  await owner.locator('#prUndoPurchase').click();
  await expect(owner.getByText('Ya está ligada a una factura: corrígelo en Finance.')).toBeVisible({ timeout: 15_000 });
  await settled(owner);
  expect((await req(R.cinta)).status).toBe('purchased');
  await expect(tile(owner, R.cinta)).toContainText('Comprada');
  expect(await owner.evaluate(() => Sync.record.failure)).toBeNull();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('fichas: «Pedir 1 bote de 15 l» crea la solicitud con la tarea; − y + suman a la cifra escrita; el coste con sus cifras', async () => {
  const taskId = await owner.evaluate(() => { const t = (window as any).tab().projects.find((p: any) => !p.system && !p.deleted && p.tasks?.length); return t.tasks[0].id; });
  await owner.evaluate(({ taskId, item }) => purchaseRun((d: any) => IkisaiTasks.materials.addMaterialOps(d, { taskId, itemId: item, quantity: 18 }), null), { taskId, item: BARNIZ });
  await settled(owner);
  await owner.evaluate((id) => openTaskEditor(id), taskId);
  await fichaBloque(owner, 'material');
  const row = owner.locator('#taskMaterials .materialrow');
  await expect(row).toContainText('En casa 3 l: faltan 15 l');
  await row.locator('[data-tcr-ask]').click();
  await expect.poll(async () => (await server.rows('tasks.purchase_requests')).filter((r) => r.item_id === BARNIZ && !r.deleted_at).map((r) => [r.task_id, Number(r.need_quantity)])).toEqual([[taskId, 15]]);
  await expect(owner.locator('#taskMaterials')).toContainText('Pedido: pedida');
  // El coste, arriba con las cifras del kit (la propietaria ve importes).
  await expect(owner.locator('#taskCosts .tcr-coststats')).toContainText('materiales');
  await owner.evaluate(() => (window as any).closeSheet());
  // «Confirmar consumo»: − y + suman o restan a lo escrito (2,5 → 3,5 → 2,5).
  await owner.evaluate((id) => consumptionSheet([id]), taskId);
  const input = owner.locator('#sheet [data-consume-qty]');
  await input.fill('2.5');
  await owner.locator('#sheet .tcr-step', { hasText: '+' }).click();
  await expect(input).toHaveValue('3.5');
  await owner.locator('#sheet .tcr-step', { hasText: '−' }).click();
  await expect(input).toHaveValue('2.5');
  await owner.locator('#consumeLater').click();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('«Compras del evento» en Suministros: lo pedido desde Flow, por proyecto, con «Ver en Flow ›»; con artículo, al recibir entra en el inventario', async () => {
  const project = await owner.evaluate(() => { const p = (window as any).tab().projects.find((x: any) => !x.system && x.status !== 'archived' && !x.deleted); return { id: p.id, title: p.title }; });
  // Flow pide desde su servidor (§45): con la clave de worker y X-Ikisai-Caller, además del token de la persona.
  const res = await server.app.call('/api/v1/requests/purchase', { headers: { 'X-Ikisai-Worker-Key': E2E_WORKER_KEY, 'X-Ikisai-Caller': 'flow' },
    body: { source: 'flow', external_ref: 'unit-e2e-1', title: 'Masilla del evento', quantity: 3, unit: 'ud', project_id: project.id, external_url: 'https://flow.ikisai.com/equipo/' } });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  const asked = res.data;
  expect(asked.created).toBe(true);
  const id = asked.purchase.id as string;
  await sync(owner);
  await go(owner, 'supplies');
  const box = owner.locator('#tcrEvent');
  await expect(box).toBeVisible();
  await expect(box.locator('#tcrEventTitle')).toContainText('Compras del evento');
  await expect(box.locator('.tcr-eventproject')).toContainText(project.title);
  const row = box.locator(`[data-event-purchase="${id}"]`);
  await expect(row).toContainText('Masilla del evento');
  await expect(row).toContainText('Sin artículo del inventario');
  await expect(row.locator('.tcr-eventlink')).toHaveText('Ver en Flow ›');
  expect(await row.locator('.tcr-eventlink').getAttribute('href')).toContain('flow.ikisai.com');
  await expect(row.locator('[data-event-item]')).toBeVisible();
  // El artículo (lo que hace «Usar este artículo» de la hoja): desde ahí, al recibirla entra en el inventario.
  expect(await owner.evaluate(([r, item]) => (window as any).tcrEventSetItem(r, item), [id, MASILLA])).toBe(true);
  await expect(owner.locator(`#tcrEvent [data-event-purchase="${id}"]`)).toContainText('Al recibirla entra en el inventario: Masilla');
  const before = await stock(MASILLA);
  // Lo siguiente, con los pasos de siempre: aprobar, comprada y ha llegado (con su confirmación).
  await owner.locator(`#tcrEvent [data-event-step="${id}"]`).click();
  await expect.poll(async () => (await req(id)).status).toBe('approved');
  await owner.locator(`#tcrEvent [data-event-step="${id}"]`).click();
  await expect.poll(async () => (await req(id)).status).toBe('purchased');
  await owner.locator(`#tcrEvent [data-event-step="${id}"]`).click();
  await owner.locator('#tcrReceiveOk').click();
  await expect.poll(async () => (await req(id)).status).toBe('received');
  await expect.poll(() => stock(MASILLA)).toBe(before + 3);
  await expect(owner.locator(`#tcrEvent [data-event-purchase="${id}"]`)).toContainText('Entró en el inventario: Masilla');
  // La lectora la ve, sin mandos.
  await sync(reader);
  await go(reader, 'supplies');
  await expect(reader.locator(`#tcrEvent [data-event-purchase="${id}"] [data-event-step], #tcrEvent [data-event-purchase="${id}"] [data-event-item]`)).toHaveCount(0);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
