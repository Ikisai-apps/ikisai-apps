/**
 * Ikisai Tasks · compras no alimentarias, interfaz (docs/tasks/API.md §18.9 paso 3): responsable de compras en el
 * editor de área, suministro bajo mínimo con aviso en Inicio y «Queda poco: pedir», aprobación solo del responsable,
 * plan por proveedor con hoja de ruta reordenable y casillas, y recepción que suma al almacén.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { EDITOR, VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const navigateView: any, manageTab: any, Sync: any;

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
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
