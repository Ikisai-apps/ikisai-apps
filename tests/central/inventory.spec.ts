/**
 * Central · Inventario (kit 0.37): el catálogo del kit sin ámbito y la ficha en página propia, sobre el segundo cliente de
 * Recursos (`/api/v1/resources`, la Edge real sobre PGlite). Filtros, búsqueda, enlace con filtro, alta rápida, ficha con
 * movimientos (origen «Finance» y quién, por su ficha de Personas), guardar datos, lector solo mirando y lectura sin red.
 * Bloque 2 (MUELA-076): baldosas por defecto y «Lista» a un toque (las pruebas de antes van sobre la lista), «Trasladar»
 * y «Contar» de un solo artículo, chips de sitio y la portada con foco de la ficha. Datos ficticios.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildCentralApp } from './e2e-build.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;
let seq = 0;
const uuid = () => crypto.randomUUID();
const ids = { albergue: uuid(), despensa: uuid(), harina: uuid(), aceite: uuid(), factura: uuid() };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const db = api.app.t.db;
  // La barra del evento (0811, Recursos) siembra artículos propios: fuera de este escenario, que cuenta solo los suyos.
  await db.query(`update resources.items set deleted_at = now() where 'food:carta:barra-octubre-2026' = any(source_refs) and deleted_at is null`);
  const a3 = (await db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3'`)).rows[0]!.id;
  const owner = api.app.users.owner;
  const resources = (operations: unknown[]) => api.app.call('/api/v1/resources/commands', { body: { requestId: `inv-${++seq}`, operations } });
  const first = await resources([
    { op: 'insert', table: 'resources.spaces', id: ids.albergue, fields: { parent_id: a3, kind: 'edificio', name: 'Albergue' } },
    { op: 'insert', table: 'resources.spaces', id: ids.despensa, fields: { parent_id: ids.albergue, kind: 'almacen', name: 'Despensa' } },
    { op: 'insert', table: 'resources.items', id: ids.harina, fields: { name: 'Harina', kind: 'ingrediente', base_unit: 'g', min_quantity: 5000, default_space_id: ids.despensa } },
    { op: 'insert', table: 'resources.items', id: ids.aceite, fields: { name: 'Aceite de girasol', kind: 'ingrediente', base_unit: 'ml', default_space_id: ids.despensa } },
  ]);
  expect(first.status, JSON.stringify(first.data)).toBe(200);
  const second = await resources([
    { op: 'insert', table: 'resources.movements', id: ids.factura, fields: { item_id: ids.aceite, space_id: ids.despensa, quantity: 5000, kind: 'entrada_factura', unit_cost: 0.004, source_app: 'invoices', source_ref: 'line:ficticia' } },
    { op: 'insert', table: 'resources.movements', id: uuid(), fields: { item_id: ids.aceite, space_id: ids.despensa, quantity: -1500, kind: 'salida_manual', reason: 'uso' } },
  ]);
  expect(second.status, JSON.stringify(second.data)).toBe(200);
  // El origen lo pone el servidor (Recursos #1175): desde un lote del navegador quedaría vacío. Aquí, el que pondría Finance.
  await db.query(`update resources.movements set source_app = 'invoices', source_ref = 'line:ficticia' where id = $1`, [ids.factura]);
  // La cuenta del owner, enlazada a su ficha: los movimientos dicen quién por su nombre en Personas.
  const person = await api.app.call('/api/v1/commands', { body: { requestId: 'inv-person', operations: [
    { op: 'insert', table: 'central.people', id: uuid(), fields: { display_name: 'Olga Ficticia', relation: 'equipo', user_id: owner } },
  ] } });
  expect(person.status, JSON.stringify(person.data)).toBe(200);
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp();
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

async function login(page: Page, who = 'owner'): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(`${who}@example.invalid`);
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Hola, / })).toBeVisible();
}
const rows = (page: Page) => page.locator('.stk-row');
const row = (page: Page, id: string) => page.locator(`.stk-row[data-item-id="${id}"]`);
const tile = (page: Page, id: string) => page.locator(`.stk-tilecell[data-item-id="${id}"]`);
/** Las pruebas de antes miran la lista: la vista elegida en el dispositivo es «Lista». */
const useList = (page: Page) => page.addInitScript(() => { try { localStorage.setItem('ikisai-central-inventario-vista', 'lista'); } catch { /* */ } });

test('inventario · catálogo sin ámbito, filtros, enlace con filtro, alta rápida y ficha con movimientos', async ({ page }) => {
  await useList(page);
  await login(page);
  // Barra de cuatro entradas para todos; Accesos, desde Inicio (decisión del usuario, 18-10-2026).
  await expect(page.locator('a.navbtn')).toHaveText(['Inicio', 'Cumplimiento', 'Personas', 'Inventario']);
  await page.locator('#homeAccounts').click();
  await expect(page).toHaveURL(/#\/accesos$/);
  await expect(page.locator('a.navbtn[data-hash="#/"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('a.navbtn[data-hash="#/"]').click();
  // La tarjeta de Recursos (0807) lleva a Inventario con el filtro puesto.
  await page.locator('.kpicard[data-kpi="resources.items_below_min"] .kpilabel').click();
  await expect(page).toHaveURL(/#\/inventario\?bajo-minimo$/);
  await expect(rows(page)).toHaveCount(1);
  await page.locator('a.navbtn[data-hash="#/inventario"]').click();
  await expect(page.getByRole('heading', { name: 'Inventario' })).toBeVisible();
  await page.locator('.stk-chips').getByRole('button', { name: 'Bajo mínimo (1)' }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, ids.harina)).toContainText('Bajo mínimo');
  await expect(page.locator('.stk-group').first()).toHaveText('Despensa · 2');

  // Filtro y búsqueda del kit.
  await page.locator('.stk-chips').getByRole('button', { name: 'Bajo mínimo (1)' }).click();
  await expect(rows(page)).toHaveCount(1);
  await page.locator('.stk-chips').getByRole('button', { name: 'Bajo mínimo (1)' }).click();
  await page.getByRole('searchbox').fill('aceite');
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole('searchbox').fill('');

  // Desde un enlace (p. ej. el panel), con el filtro puesto.
  await page.goto(`${baseURL}/#/inventario?bajo-minimo`);
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, ids.harina)).toBeVisible();
  await page.locator('.stk-chips').getByRole('button', { name: 'Bajo mínimo (1)' }).click();
  await expect(rows(page)).toHaveCount(2);

  // «+ Artículo»: alta rápida y se abre su ficha, en página propia.
  await page.getByRole('button', { name: 'Artículo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo artículo' });
  await dialog.getByRole('combobox').fill('Sal gorda');
  await dialog.getByRole('option', { name: /Crear «Sal gorda»/ }).click();
  await dialog.getByRole('button', { name: 'Crear y usar' }).click();
  await expect(page).toHaveURL(/#\/inventario\/[0-9a-f-]{36}$/);
  await expect(page.locator('.stk-sheet-title')).toHaveText('Sal gorda');
  await expect.poll(async () => (await api.app.t.db.query(`select 1 from resources.items where name = 'Sal gorda'`)).rows.length).toBe(1);

  // Ficha del aceite: movimientos con su origen («Finance», no «Invoices») y quién, por su ficha.
  await page.getByRole('link', { name: '← Inventario' }).click();
  await row(page, ids.aceite).locator('.stk-open').click();
  await expect(page).toHaveURL(new RegExp(`#/inventario/${ids.aceite}$`));
  await expect(page.locator('.stk-sheet-title')).toHaveText('Aceite de girasol');
  await page.getByRole('tab', { name: 'Movimientos' }).click();
  const moves = page.locator('.stk-movements');
  await expect(moves.locator('.stk-mov')).toHaveCount(2);
  await expect(moves).toContainText('Finance');
  await expect(moves).not.toContainText('Invoices');
  await expect(moves).toContainText('Olga Ficticia');
  // Acciones del kit 0.38 en la ficha (pestaña Stock).
  await page.getByRole('tab', { name: 'Stock' }).click();
  for (const name of ['Gastar', 'Entrada', 'Trasladar', 'Contar']) await expect(page.locator('.stk-sheet-actions').getByRole('button', { name, exact: true })).toBeVisible();

  // Datos: guardar la categoría.
  await page.getByRole('tab', { name: 'Datos' }).click();
  await page.getByLabel('Categoría', { exact: true }).fill('Aceites');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.locator('.stk-save-status')).toHaveText('Guardado.');
  await expect.poll(async () => (await api.app.t.db.query<{ c: string }>(`select category as c from resources.items where id = $1`, [ids.aceite])).rows[0]?.c).toBe('Aceites');
});

test('inventario · el lector solo mira, y sin red se lee el espejo', async ({ page, context }) => {
  await useList(page);
  await login(page, 'reader');
  await page.locator('a.navbtn[data-hash="#/inventario"]').click();
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Artículo', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Gastar' })).toHaveCount(0);
  await expect(page.locator('#inventoryCount')).toHaveCount(0);
  await row(page, ids.harina).locator('.stk-open').click();
  await page.getByRole('tab', { name: 'Datos' }).click();
  await expect(page.getByRole('button', { name: 'Guardar' })).toHaveCount(0);

  // Sin red: de Inicio a Inventario, el catálogo sale del espejo del dispositivo.
  await context.setOffline(true);
  await page.locator('a.navbtn[data-hash="#/"]').click();
  await page.locator('a.navbtn[data-hash="#/inventario"]').click();
  await expect(row(page, ids.harina)).toBeVisible();
  await expect(row(page, ids.aceite)).toBeVisible();
  await context.setOffline(false);
});

test('inventario · baldosas por defecto, «Lista» a un toque, Trasladar y Contar de uno, y la ficha con portada y foco (Bloque 2)', async ({ page }) => {
  const dialog = page.getByRole('dialog');
  await login(page);
  await page.locator('a.navbtn[data-hash="#/inventario"]').click();
  await expect(page.locator('#inventoryView button[aria-pressed="true"]')).toHaveText('Baldosas');
  // Cada artículo, una baldosa con su cifra y el nivel en palabras.
  await expect(tile(page, ids.harina)).toContainText('Bajo mínimo');
  await expect(tile(page, ids.aceite)).toContainText('ml');
  await expect(page.locator('.stk-row')).toHaveCount(0);
  // Chip del sitio donde hay algo (la despensa, con el aceite).
  await expect(page.locator('.stk-chips').getByRole('button', { name: 'Despensa', exact: true })).toBeVisible();
  // Gastar, Entrada, Contar y Trasladar en cada artículo, con su nombre.
  for (const name of ['Gastar', 'Entrada', 'Contar', 'Trasladar']) await expect(tile(page, ids.aceite).getByRole('button', { name: `${name}: Aceite de girasol` })).toBeVisible();
  // Contar abre el recuento solo de ese artículo (no el de todo).
  await tile(page, ids.aceite).getByRole('button', { name: 'Contar: Aceite de girasol' }).click();
  await expect(dialog.locator('.stk-count-line')).toHaveCount(1);
  await expect(dialog.locator(`.stk-count-line[data-item-id="${ids.aceite}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await tile(page, ids.aceite).getByRole('button', { name: 'Trasladar: Aceite de girasol' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');

  // «Lista» a un toque, y se recuerda.
  await page.locator('#inventoryView').getByRole('button', { name: 'Lista' }).click();
  await expect(row(page, ids.harina)).toBeVisible();
  await expect(row(page, ids.aceite).getByRole('button', { name: 'Trasladar' })).toBeVisible();
  await page.reload();
  await expect(row(page, ids.harina)).toBeVisible();
  await page.locator('#inventoryView').getByRole('button', { name: 'Baldosas' }).click();
  await expect(tile(page, ids.harina)).toBeVisible();

  // Ficha de la harina: portada con sus cifras y el foco «Reponer» con su acción.
  await tile(page, ids.harina).locator('.tile-box').click();
  await expect(page).toHaveURL(new RegExp(`#/inventario/${ids.harina}$`));
  const cover = page.locator('#inventoryOverview .cover-box');
  await expect(cover).toContainText('Bajo mínimo');
  await expect(cover).toContainText('mínimo 5000 g');
  const reponer = page.locator('.ctl-itemfocus-card[data-focus="reponer"]');
  await expect(reponer).toContainText('el mínimo es 5000 g');
  await reponer.getByRole('button', { name: 'Registrar entrada: Harina' }).click();
  await expect(dialog.getByLabel('Cuánto entra', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // Debajo, la ficha de siempre.
  await expect(page.locator('.stk-sheet-title')).toHaveText('Harina');
});

test('inventario · el lector ve las baldosas y el foco, sin acciones', async ({ page }) => {
  await login(page, 'reader');
  await page.locator('a.navbtn[data-hash="#/inventario"]').click();
  await expect(tile(page, ids.harina)).toContainText('Bajo mínimo');
  await expect(tile(page, ids.harina).getByRole('button', { name: /^(Gastar|Entrada|Contar|Trasladar):/ })).toHaveCount(0);
  await tile(page, ids.harina).locator('.tile-box').click();
  await expect(page.locator('.ctl-itemfocus-card[data-focus="reponer"]')).toBeVisible();
  await expect(page.locator('.ctl-itemfocus button')).toHaveCount(0);
});

test('inventario · Gastar, Entrada y Recuento (kit 0.38) llegan a Recursos', async ({ page }) => {
  const stock = async (item: string) => Number((await api.app.t.db.query<{ q: string }>(`select coalesce(sum(quantity), 0) as q from resources.movements where item_id = $1 and deleted_at is null`, [item])).rows[0]!.q);
  const dialog = page.getByRole('dialog');
  await useList(page);
  await login(page);
  await page.locator('a.navbtn[data-hash="#/inventario"]').click();
  const before = await stock(ids.aceite);

  // Gastar: salida con el motivo «uso» ya elegido.
  await row(page, ids.aceite).getByRole('button', { name: 'Gastar' }).click();
  await dialog.getByLabel('Cuánto sale', { exact: true }).fill('500');
  await dialog.getByRole('button', { name: 'Registrar salida' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => stock(ids.aceite)).toBe(before - 500);
  expect((await api.app.t.db.query<{ r: string }>(`select reason as r from resources.movements where item_id = $1 and kind = 'salida_manual' order by at desc limit 1`, [ids.aceite])).rows[0]?.r).toBe('uso');

  // Entrada a mano en la harina, que estaba bajo mínimo.
  await row(page, ids.harina).getByRole('button', { name: 'Entrada' }).click();
  await dialog.getByLabel('Cuánto entra', { exact: true }).fill('6000');
  await dialog.getByRole('button', { name: 'Registrar entrada' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => stock(ids.harina)).toBe(6000);
  await expect(row(page, ids.harina)).not.toContainText('Bajo mínimo');

  // Recuento de todo, a ciegas: el aceite cuenta 100 ml menos y se ajusta al cerrar.
  const counted = (await stock(ids.aceite)) - 100;
  await page.locator('#inventoryCount').click();
  const line = dialog.locator(`.stk-count-line[data-item-id="${ids.aceite}"] input`);
  await line.fill(String(counted));
  await line.press('Enter');
  await expect(dialog.locator('.stk-count-progress-text')).toHaveText('1 de 2 contados');
  // Kit 0.38: con el foco en una casilla, «Revisar y cerrar» no se activa hasta un repintado completo (aviso a UI por
  // Core en SALIDA). Como en la prueba del kit, «Ver lo calculado» repinta; se vuelve a ocultar para seguir a ciegas.
  await dialog.getByRole('button', { name: 'Ver lo calculado' }).click();
  await dialog.getByRole('button', { name: 'Ocultar lo calculado' }).click();
  await dialog.getByRole('button', { name: 'Revisar y cerrar' }).click();
  await dialog.getByRole('button', { name: 'Cerrar y ajustar' }).click();
  await expect(dialog.locator('.stk-count-done')).toContainText('Recuento cerrado');
  await expect.poll(() => stock(ids.aceite), { timeout: 15_000 }).toBe(counted);
  expect((await api.app.t.db.query(`select 1 from resources.movements where item_id = $1 and kind = 'ajuste_recuento'`, [ids.aceite])).rows.length).toBe(1);
});
