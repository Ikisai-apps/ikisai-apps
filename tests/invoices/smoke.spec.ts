/**
 * Humo de Ikisai Invoices (fase 0): login real → bootstrap → espejo local → editar proveedores sin red → sincronizar.
 *
 * Cómo correrlo:   npx playwright test tests/invoices            (desde la raíz del repo)
 * Compila la app con la API de Vite, la sirve con `vite preview` y reenvía /api a una API falsa en memoria (fake-api.ts).
 * Si Playwright no encuentra su Chromium, playwright.config.ts usa el de %LOCALAPPDATA%\ms-playwright\chromium-1217.
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, type FakeApi } from './fake-api.ts';
import { freePort } from './free-port.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/invoices/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const TABLE = 'invoices.suppliers';

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
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

async function login(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await expect(page.getByRole('heading', { name: 'Ikisai Invoices' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

test('login → bootstrap → proveedores offline → sincronizar', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('login real contra la API y bootstrap', async () => {
    await login(page);
    await expect(page.locator('#syncStatus')).toContainText('En línea');
    expect(api.requests.some((r) => r.path.startsWith('/api/v1/bootstrap'))).toBeTruthy();
    expect(api.requests.some((r) => r.path.startsWith('/api/v1/snapshot'))).toBeTruthy();
  });

  await test.step('lista vacía de proveedores', async () => {
    await page.getByRole('link', { name: /Proveedores/ }).click();
    await expect(page.getByRole('heading', { name: 'Proveedores', level: 2 })).toBeVisible();
    await expect(page.getByText('Todavía no hay proveedores')).toBeVisible();
  });

  await test.step('crear proveedor y verlo confirmado por el servidor', async () => {
    await page.getByRole('button', { name: 'Nuevo proveedor' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nuevo proveedor' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Nombre', { exact: true }).fill('Frutas Pepe');
    await dialog.getByLabel('NIF').fill('b12345678');
    await dialog.getByLabel('Categoría por defecto').selectOption('compras');
    await dialog.getByLabel('Notas').fill('Reparte los martes');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();

    const row = page.locator('#supplierList .row', { hasText: 'Frutas Pepe' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('NIF B12345678');
    await expect(row).toContainText('Compras');
    await expect(row).toHaveAttribute('data-pending', 'false');
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');

    const rows = api.rows(TABLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Frutas Pepe', tax_id: 'B12345678', default_category: 'compras', revision: 1 });
  });

  await test.step('recargar y seguir viéndolo desde el espejo local', async () => {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Proveedores', level: 2 })).toBeVisible();
    await expect(page.locator('#supplierList .row', { hasText: 'Frutas Pepe' })).toBeVisible();
  });

  await test.step('sin red: editar y ver «pendiente»', async () => {
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');

    await page.getByRole('button', { name: 'Editar Frutas Pepe' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editar proveedor' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Revisión 1');
    // «Guardar» solo aparece cuando hay cambios.
    await expect(page.locator('#saveSupplier')).toBeHidden();
    await dialog.getByLabel('Nombre', { exact: true }).fill('Frutas Pepe e Hijos');
    await expect(page.locator('#saveSupplier')).toBeVisible();
    await page.locator('#saveSupplier').click();
    await expect(dialog).toBeHidden();

    const row = page.locator('#supplierList .row', { hasText: 'Frutas Pepe e Hijos' });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-pending', 'true');
    await expect(row).toContainText('Pendiente de sincronizar');
    await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');
    expect(api.rows(TABLE)[0]!.name).toBe('Frutas Pepe');
  });

  await test.step('volver a la red y ver sincronizado', async () => {
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine);
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();

    const row = page.locator('#supplierList .row', { hasText: 'Frutas Pepe e Hijos' });
    await expect(row).toHaveAttribute('data-pending', 'false', { timeout: 15_000 });
    await expect(row).not.toContainText('Pendiente de sincronizar');
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');

    const rows = api.rows(TABLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Frutas Pepe e Hijos', revision: 2 });
  });

  await test.step('factura a mano: crear, añadir artículo, ver estado y validar (sin documento → incompleta)', async () => {
    await page.getByRole('link', { name: /Facturas/ }).click();
    await expect(page.getByRole('heading', { name: 'Facturas', level: 2 })).toBeVisible();
    await expect(page.getByText('Todavía no hay facturas')).toBeVisible();
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Proveedor').selectOption({ label: 'Frutas Pepe e Hijos' });
    await sheet.getByLabel('Fecha').fill('2026-10-05');
    await sheet.getByLabel('Objeto').fill('Alimentos retiro yoga');
    await sheet.getByLabel('Total del documento').fill('44');
    await expect(sheet.locator('#namePreview')).toHaveText('2026_10_05_(frutas_pepe)_alimentos_retiro_yoga.pdf');
    await page.locator('#saveInvoice').click();
    await expect(sheet).toBeHidden();

    const ficha = page.getByRole('dialog', { name: /Frutas Pepe e Hijos · Alimentos retiro yoga/ });
    await expect(ficha).toBeVisible();
    await expect(ficha).toContainText('Pendiente de datos');
    await ficha.locator('#addLine').click();
    await ficha.getByLabel('Descripción').fill('Tomate');
    await ficha.getByLabel('Cantidad').fill('20');
    await ficha.getByLabel('Unidad').fill('kg');
    await ficha.getByLabel('Precio unitario').fill('2');
    // La base se rellena sola a partir de cantidad × precio.
    await expect(ficha.locator('#lineNet')).toHaveValue('40');
    await ficha.locator('#lineVat').selectOption('10');
    await ficha.locator('#saveLine').click();
    await expect(ficha.locator('#invoiceLines')).toContainText('Tomate');
    await expect(ficha).toContainText('Pendiente de revisar');
    await expect(ficha).toContainText('✓ Importes comprobados');
    await expect(ficha.locator('.inv-totals')).toContainText('44,00 €');

    // Sin documento original la validación es rechazada por el servidor y el lote queda como rechazado.
    await ficha.locator('#validateInvoice').click();
    await expect(page.locator('#syncStatus')).toContainText(/rechazad|Todo sincronizado|pendiente/i);
    const invoices = api.rows('invoices.invoices');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ object: 'Alimentos retiro yoga', status: 'pendiente_revision', calculated_total: 44 });
    expect(api.rows('invoices.invoice_lines')).toHaveLength(1);
    await ficha.locator('.sheet-foot').getByRole('button', { name: 'Cerrar' }).click();
    await expect(ficha).toBeHidden();
    await expect(page.locator('#invoiceList .row', { hasText: 'Alimentos retiro yoga' })).toBeVisible();
  });

  await test.step('Compras y Gestoría se calculan en local', async () => {
    await page.getByRole('link', { name: /Compras/ }).click();
    await expect(page.getByRole('heading', { name: 'Compras', level: 2 })).toBeVisible();
    await page.locator('#onlyValidated').uncheck();
    await page.getByRole('tab', { name: 'Artículos' }).click();
    await expect(page.locator('#purchases')).toContainText('Tomate');
    await expect(page.locator('#purchaseTotals')).toContainText('Base 40,00 €');
    await page.getByRole('link', { name: /Gestoría/ }).click();
    await expect(page.getByRole('heading', { name: 'Gestoría', level: 2 })).toBeVisible();
    await expect(page.locator('#fiscalAlerts')).toContainText('pendiente de revisión');
    await page.getByRole('link', { name: /Inicio/ }).click();
    await expect(page.locator('#statPendingReview')).toHaveText('1');
  });

  await test.step('papelera: borrar y restaurar', async () => {
    await page.getByRole('link', { name: /Proveedores/ }).click();
    await expect(page.getByRole('heading', { name: 'Proveedores', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Editar Frutas Pepe e Hijos' }).click();
    await page.getByRole('button', { name: 'Enviar a papelera' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Enviar a papelera' }).click();
    await expect(page.locator('#supplierList .row', { hasText: 'Frutas Pepe e Hijos' })).toHaveCount(0);
    const trash = page.locator('#trash');
    await trash.locator('summary').click();
    await expect(trash.locator('.row', { hasText: 'Frutas Pepe e Hijos' })).toBeVisible();
    await trash.getByRole('button', { name: 'Restaurar Frutas Pepe e Hijos' }).click();
    const restored = page.locator('#supplierList .row', { hasText: 'Frutas Pepe e Hijos' });
    await expect(restored).toBeVisible();
    await expect(restored).toHaveAttribute('data-pending', 'false', { timeout: 15_000 });
    expect(api.rows(TABLE)[0]).toMatchObject({ deleted_at: null, revision: 4 });
  });
});

test('PWA: manifest, service worker y shell en caché', async ({ page }) => {
  await login(page);
  const manifest = await page.request.get(`${baseURL}/manifest.webmanifest`);
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.json()).toMatchObject({ name: 'Ikisai Invoices', short_name: 'Invoices', display: 'standalone' });
  const sw = await page.request.get(`${baseURL}/sw.js`);
  expect(sw.ok()).toBeTruthy();
  expect(await sw.text()).toContain('ikisai-invoices-shell-');
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.active);
  }, null, { timeout: 15_000 });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys.find((k) => k.startsWith('ikisai-invoices-shell-')) ?? '');
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  expect(cached).toEqual(expect.arrayContaining(['/', '/manifest.webmanifest', '/fonts/inter.woff2']));
  expect(cached.some((p) => p.startsWith('/api/'))).toBeFalsy();
});
