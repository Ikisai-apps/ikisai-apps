/**
 * Aceptación de Invoices (docs/invoices/API.md §11, recorrido 31A del handoff) y escenarios offline O1–O6
 * contra la app compilada y la API falsa en memoria (misma superficie que invoices-api: subidas, import_v1, destinos).
 *
 *   npx playwright test tests/invoices/acceptance.spec.ts
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvoicesApp } from './e2e-build.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';
import { freePort } from './free-port.ts';
import { invoiceTextPdf, textPdf } from './pdf-fixture.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/invoices/vite.config.ts');
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(here, '../core/fixtures/invoice-import-v1.example.json'), 'utf8'));
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const READER = { email: 'gestoria@example.invalid', password: 'lectura-123', displayName: 'Gestoría', role: 'reader' as const };
const PROJECT = '11111111-1111-4111-8111-111111111111';
const INGREDIENT = '22222222-2222-4222-8222-222222222222';
const PDF = Buffer.from('%PDF-1.4\n% factura sintética de prueba\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

// Las tres pruebas comparten el servidor simulado del worker: A1 crea la factura y las asignaciones que O7–O9 comprueban.
// En serie, un reintento de la CI (`--retries=2`) repite todo el archivo en un worker limpio, en vez de repetir solo
// O7–O9 contra un servidor recién arrancado y sin datos (que es lo que dejaba `#purchases .row` en 0).
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER, READER],
    targets: [
      { app: 'tasks', kind: 'project', id: PROJECT, label: 'Huerto', path: ['Cocina'], revision: 5 },
      { app: 'food', kind: 'ingredient', id: INGREDIENT, label: 'Tomate pera', path: ['Ingredientes'], revision: 2 },
    ],
  });
  process.env.VITE_API_PROXY = api.url;
  await buildInvoicesApp();
  server = await preview({
    configFile, logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

async function login(page: Page, user: { email: string; password: string; displayName: string } = USER): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(user.email);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${user.displayName}` })).toBeVisible();
}

/** Espera a «Todo sincronizado». Si el cliente quedó en error por un fallo pasajero de red (ocurre en CI), reintenta con «Sincronizar ahora». */
async function synced(page: Page): Promise<void> {
  await expect.poll(async () => {
    const text = (await page.locator('#syncStatus').textContent().catch(() => '')) ?? '';
    if (/Error/.test(text)) await page.getByRole('button', { name: 'Sincronizar ahora' }).click({ timeout: 2_000 }).catch(() => undefined);
    return text;
  }, { timeout: 40_000, intervals: [500, 1000, 2000] }).toContain('Todo sincronizado');
}

/** Enlace de la navegación principal (en Inicio hay tarjetas con los mismos nombres). */
/** Fila del servidor simulado que llega por la sincronización: espera a que exista (la CI es más lenta que el local). */
async function eventually<T>(read: () => T | undefined, timeout = 20_000): Promise<T> {
  await expect.poll(() => read() !== undefined, { timeout }).toBe(true);
  return read()!;
}

function nav(page: Page, name: string) {
  return page.locator('.nav').getByRole('link', { name: new RegExp(name) });
}

/**
 * Gestoría abre el trimestre en el que se trabaja (en el primer mes de un trimestre, el anterior): las pruebas eligen
 * el de la fecha que necesitan para no depender del reloj.
 */
async function gestoriaPeriod(page: Page, isoDate = new Date().toISOString().slice(0, 10)): Promise<void> {
  await page.getByLabel('Año', { exact: true }).fill(isoDate.slice(0, 4));
  await page.getByLabel('Año', { exact: true }).dispatchEvent('change');
  await page.getByLabel('Trimestre', { exact: true }).selectOption(String(Math.floor((Number(isoDate.slice(5, 7)) - 1) / 3) + 1));
}

/** Vuelve la red: el cliente sincroniza solo al detectar el evento; si el botón está libre se pulsa también (más rápido en Playwright). */
async function reconnect(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine);
  const button = page.getByRole('button', { name: 'Sincronizar ahora' });
  if (await button.isEnabled().catch(() => false)) await button.click().catch(() => undefined);
}

function ficha(page: Page) {
  return page.locator('.sheet[role="dialog"]');
}

async function closeSheet(page: Page): Promise<void> {
  await ficha(page).locator('.sheet-foot').getByRole('button', { name: /Cerrar|Volver/ }).first().click();
  await expect(ficha(page)).toBeHidden();
}

test('A1–A21: documento, importación, cuadre, validación, asignación, Compras, Gestoría, anulación', async ({ page }) => {
  test.setTimeout(240_000);

  await test.step('A1 · login e instalación (shell con las cuatro entradas)', async () => {
    await login(page);
    for (const name of ['Facturas', 'Compras', 'Gestoría']) await expect(nav(page, name)).toBeVisible();
    await synced(page);
  });

  await test.step('proveedor con NIF, alias e inversión', async () => {
    await page.getByRole('link', { name: /Proveedores/ }).click();
    await page.getByRole('button', { name: 'Nuevo proveedor' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nuevo proveedor' });
    await sheet.getByLabel('Nombre', { exact: true }).fill('Proveedor Ejemplo S.L.');
    await sheet.getByLabel('NIF').fill('B00000000');
    await sheet.getByLabel('Categoría por defecto').selectOption('compras');
    await sheet.getByLabel('Alias').fill('PROVEEDOR EJEMPLO, Ejemplo SL');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(sheet).toBeHidden();
    await synced(page);
    expect(api.rows('invoices.suppliers')[0]).toMatchObject({ name: 'Proveedor Ejemplo S.L.', aliases: ['PROVEEDOR EJEMPLO', 'Ejemplo SL'], default_is_investment: false, slug: 'proveedor_ejemplo_s_l' });
  });

  await test.step('A2–A4 · subir un PDF sintético con fecha, proveedor y objeto → nombre canónico y documento privado', async () => {
    await nav(page, 'Facturas').click();
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await sheet.locator('#newSupplier').selectOption({ label: 'Proveedor Ejemplo S.L.' });
    await sheet.getByLabel('Fecha').fill('2026-10-05');
    await sheet.getByLabel('Objeto').fill('alimentos retiro ejemplo');
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'scan factura.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(sheet.locator('#namePreview')).toHaveText('2026_10_05_(proveedor_ejemplo_s_l)_alimentos_retiro_ejemplo.pdf');
    await page.locator('#saveInvoice').click();
    await expect(sheet).toBeHidden();
    const f = ficha(page);
    await expect(f).toBeVisible();
    await expect(f).toContainText('Pendiente de datos');
    await expect(f).toContainText('2026_10_05_(proveedor_ejemplo_s_l)_alimentos_retiro_ejemplo.pdf', { timeout: 20_000 });
    await synced(page);
    const uploads = api.uploads();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ status: 'verified', mime: 'application/pdf', size: PDF.length });
    expect(api.rows('invoices.invoice_files')[0]).toMatchObject({ normalized_filename: '2026_10_05_(proveedor_ejemplo_s_l)_alimentos_retiro_ejemplo.pdf', original_filename: 'scan factura.pdf', kind: 'original' });
    // El documento se lee con URL firmada (GET files/:id con sesión), nunca pública. En headless la pestaña nueva puede
    // convertirse en descarga, así que se comprueba la petición y se cierra lo que se haya abierto.
    const before = api.requests.length;
    await f.getByRole('button', { name: 'Ver' }).click();
    await expect.poll(() => api.requests.slice(before).some((r) => /^\/api\/v1\/files\//.test(r.path)), { timeout: 15_000 }).toBeTruthy();
    for (const extra of page.context().pages()) if (extra !== page) await extra.close().catch(() => undefined);
  });

  await test.step('extracción automática: coste visible; sin JSON utilizable abre la importación manual con los motivos', async () => {
    const invoiceId = api.rows('invoices.invoices')[0]!.id;
    api.setExtractor(() => ({ document: EXAMPLE, warnings: ['El IVA de la línea 1 se ha deducido del total'], usage: { model: 'claude-opus-5-5', inputTokens: 1200, outputTokens: 640, cacheReadInputTokens: 34, cacheCreationInputTokens: 0, latencyMs: 8400 } }));
    await ficha(page).locator('#extractInvoice').click();
    let sheet = ficha(page);
    await expect(sheet.locator('#extractionNote')).toContainText('Extraído automáticamente del documento');
    await expect(sheet.locator('#extractionNote')).toContainText('El IVA de la línea 1');
    await expect(sheet.locator('#extractionUsage')).toHaveText(/claude-opus-5-5 · 1\.?234 tokens de entrada · 640 de salida · 8,4 s/);
    await expect(sheet.locator('#importPreview')).toContainText('Dentro de la tolerancia');
    await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click();
    await expect(ficha(page)).toBeHidden();
    // Sin JSON utilizable (respuesta cortada): misma hoja vacía, con el motivo, los avisos y el coste.
    api.setExtractor(() => ({ fault: { status: 422, code: 'EXTRACTION_INVALID', message: 'La respuesta del modelo se cortó antes de terminar el JSON.', details: { errors: ['TRUNCATED'], warnings: ['página 2 borrosa'], usage: { model: 'claude-opus-5-5', inputTokens: 1200, outputTokens: 640, cacheReadInputTokens: 34, cacheCreationInputTokens: 0, latencyMs: 8400 } } } }));
    await page.evaluate((id) => { location.hash = `#/facturas/${id}`; }, invoiceId);
    await ficha(page).locator('#extractInvoice').click();
    sheet = ficha(page);
    await expect(sheet.locator('#extractionNote')).toContainText('no ha dado un JSON utilizable');
    await expect(sheet.locator('#extractionNote')).toContainText('la respuesta se cortó antes de terminar el JSON');
    await expect(sheet.locator('#extractionNote')).toContainText('página 2 borrosa');
    await expect(sheet.locator('#extractionUsage')).toBeVisible();
    await expect(sheet.getByLabel('JSON', { exact: true })).toHaveValue('');
    await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click();
    await expect(ficha(page)).toBeHidden();
    api.setExtractor(null);
    expect(api.rows('invoices.invoices')[0]).toMatchObject({ status: 'pendiente_datos' });
    // Volver a la ficha por su enlace (el resto del recorrido importa a mano).
    await page.evaluate((id) => { location.hash = `#/facturas/${id}`; }, invoiceId);
    await expect(ficha(page).locator('#importInto')).toBeVisible();
  });

  await test.step('A5–A6 · importar el ejemplo del handoff sobre la factura: proveedor por NIF, líneas, impuestos, cuadre exacto', async () => {
    const f = ficha(page);
    await f.locator('#importInto').click();
    const sheet = ficha(page);
    await expect(sheet).toContainText('Importar JSON');
    await sheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(EXAMPLE));
    await expect(sheet.locator('#importPreview')).toContainText('coincide por NIF');
    await expect(sheet.locator('#importPreview')).toContainText('Dentro de la tolerancia');
    await expect(sheet.locator('#importObject')).toHaveValue('alimentos retiro ejemplo');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('Importada, pendiente de revisar', { timeout: 20_000 });
    await expect(ficha(page).locator('#invoiceLines')).toContainText('Tomate');
    await expect(ficha(page).locator('.inv-totals')).toContainText('44,00 €');
    await expect(ficha(page)).toContainText('✓ Importes comprobados');
    await synced(page);
    const inv = api.rows('invoices.invoices')[0]!;
    expect(inv).toMatchObject({ source: 'import_v1', status: 'pendiente_revision', review_reason: 'IMPORTADA', calculated_total: 44, totals_delta: 0, expense_category: 'compras' });
    expect(api.rows('invoices.invoice_lines')).toHaveLength(1);
    expect(api.rows('invoices.tax_lines')).toHaveLength(1);
    expect(api.rows('invoices.suppliers')).toHaveLength(1);
  });

  await test.step('A8 · validar explícitamente; editar un artículo la devuelve a revisión; revalidar', async () => {
    const f = ficha(page);
    await f.locator('#validateInvoice').click();
    await expect(f).toContainText('Validada', { timeout: 20_000 });
    await expect(f.locator('#validateInvoice')).toHaveCount(0);
    await f.getByRole('button', { name: 'Editar Tomate' }).click();
    await f.getByLabel('Descripción').fill('Tomate pera');
    await f.locator('#saveLine').click();
    await expect(f).toContainText('Editada tras validar', { timeout: 20_000 });
    await f.locator('#validateInvoice').click();
    await expect(f).toContainText('Validada', { timeout: 20_000 });
    await synced(page);
  });

  await test.step('orden manual de los artículos (decisión del usuario): segundo artículo, bajar el primero, position guardada; quitarlo y revalidar', async () => {
    const f = ficha(page);
    await f.locator('#addLine').click();
    await f.getByLabel('Descripción').fill('Arroz');
    await f.getByLabel('Base (sin IVA)').fill('10');
    await f.locator('#lineVat').selectOption('21');
    await f.locator('#saveLine').click();
    await expect(f.locator('#invoiceLines .line-desc')).toHaveText(['Tomate pera', 'Arroz'], { timeout: 20_000 });
    await f.getByRole('button', { name: 'Bajar Tomate pera' }).click();
    await expect(f.locator('#invoiceLines .line-desc')).toHaveText(['Arroz', 'Tomate pera'], { timeout: 20_000 });
    await synced(page);
    const invoiceId = api.rows('invoices.invoices').find((i) => i.supplier_id)!.id;
    // El orden se ve al momento en el dispositivo; en el servidor llega con el siguiente envío: se espera a que esté.
    const positions = () => api.rows('invoices.invoice_lines').filter((l) => l.invoice_id === invoiceId && !l.deleted_at).sort((a, b) => Number(a.position) - Number(b.position)).map((l) => `${l.position}:${l.description}`);
    await expect.poll(positions, { timeout: 20_000 }).toEqual(['0:Arroz', '1:Tomate pera']);
    // Quitamos el artículo añadido para que el resto del recorrido (asignaciones, cuadre) siga igual, y revalidamos.
    await f.getByRole('button', { name: 'Editar Arroz' }).click();
    await f.getByRole('button', { name: 'Quitar' }).click();
    await expect(f.locator('#invoiceLines .line-desc')).toHaveText(['Tomate pera'], { timeout: 20_000 });
    await f.locator('#validateInvoice').click();
    await expect(f).toContainText('Validada', { timeout: 20_000 });
    await synced(page);
  });

  await test.step('A9 · asignar la línea a un proyecto de Tareas (Área › Proyecto) con el token del usuario', async () => {
    const f = ficha(page);
    await f.getByRole('button', { name: 'Asignar a…' }).click();
    const sheet = ficha(page);
    await expect(sheet).toContainText('Asignar «Tomate pera»');
    await sheet.getByRole('button', { name: 'Tareas' }).click();
    await sheet.locator('#targetSearch').fill('huer');
    await sheet.getByRole('button', { name: 'Elegir Huerto' }).click();
    await expect(sheet.locator('#chosenTarget')).toContainText('Cocina › Huerto');
    await sheet.locator('#allocAmount').fill('30');
    await sheet.locator('#saveAllocation').click();
    await expect(ficha(page)).toContainText('Cocina › Huerto · 30,00 €', { timeout: 20_000 });
    await expect(ficha(page)).toContainText('Sin asignar 10,00 €');
    await synced(page);
    expect(api.rows('invoices.allocations')[0]).toMatchObject({ target_app: 'tasks', target_kind: 'project', target_id: PROJECT, target_label: 'Cocina › Huerto', target_revision: 5, allocated_amount: 30 });
  });

  await test.step('A10–A12 · el resto a Cocina (ingrediente); no se puede sobreasignar; Reservas deshabilitado', async () => {
    const f = ficha(page);
    await f.getByRole('button', { name: 'Asignar a…' }).click();
    const sheet = ficha(page);
    await sheet.getByRole('button', { name: 'Reservas' }).click();
    await expect(sheet).toContainText('fase 2');
    await sheet.getByRole('button', { name: 'Cocina' }).click();
    await sheet.getByRole('button', { name: 'Elegir Tomate pera' }).click();
    await sheet.locator('#allocAmount').fill('25');
    await sheet.locator('#saveAllocation').click();
    await expect(sheet.locator('.formerror')).toContainText('Solo quedan 10,00 €');
    await sheet.locator('#allocAmount').fill('10');
    await sheet.locator('#allocQuantity').fill('20');
    await sheet.locator('#saveAllocation').click();
    await expect(ficha(page)).toContainText('Ingredientes › Tomate pera · 10,00 €', { timeout: 20_000 });
    await expect(ficha(page)).not.toContainText('Sin asignar 10,00 €');
    await expect(ficha(page).getByRole('button', { name: 'Asignar a…' })).toHaveCount(0);
    await synced(page);
    await closeSheet(page);
  });

  await test.step('enlaces desde otras apps: factura por código y compras de un destino (API.md §9.6)', async () => {
    const code = api.rows('invoices.invoices')[0]!.code as string;
    expect(code).toMatch(/^FVR_2026_\d{3}$/);
    await page.evaluate((c) => { location.hash = `#/facturas/${c}`; }, code);
    await expect(ficha(page)).toContainText(code);
    await expect(ficha(page)).toContainText('Ingredientes › Tomate pera');
    await closeSheet(page);
    await page.evaluate((id) => { location.hash = `#/compras?destino=food:ingredient:${id}`; }, INGREDIENT);
    await expect(page.locator('#purchases .row')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('#purchases')).toContainText('Tomate pera');
    await expect(page.locator('#onlyValidated')).not.toBeChecked();
    await expect(page).toHaveURL(/#\/compras$/);
    await nav(page, 'Facturas').click();
    await page.locator('#invoiceList .row').first().click();
    await expect(ficha(page)).toContainText(code);
    await closeSheet(page);
  });

  await test.step('A7 · segunda importación con total documental que no cuadra → REVISAR IMPORTES; validar es rechazado; corregir', async () => {
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await page.locator('#importNew').click();
    const sheet = ficha(page);
    const doc = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-124' }, document_totals: { ...EXAMPLE.document_totals, total: 44.5 } };
    await sheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(doc));
    await expect(sheet.locator('#importPreview')).toContainText('REVISAR IMPORTES');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('REVISAR IMPORTES', { timeout: 20_000 });
    await expect(ficha(page)).toContainText('diferencia 0,50 €');
    await synced(page);
    // Validar con descuadre: el servidor lo rechaza y el lote queda en Rechazados, nunca validada en silencio.
    await ficha(page).locator('#validateInvoice').click();
    await expect(page.locator('#syncStatus')).toContainText(/rechazad/i, { timeout: 20_000 });
    expect(api.rows('invoices.invoices').find((i) => i.invoice_number === 'F-2026-124')!.status).toBe('pendiente_revision');
    await ficha(page).locator('details.inv-block', { hasText: 'Fiscal y pago' }).locator('summary').click();
    await ficha(page).locator('#invSourceTotal').fill('44');
    await ficha(page).locator('#invSourceTotal').press('Tab');
    await expect(ficha(page)).toContainText('Importes corregidos', { timeout: 20_000 });
    await closeSheet(page);
    await nav(page, 'Inicio').click();
    await page.getByRole('button', { name: 'Ver conflictos' }).click();
    await expect(page.locator('#rejectedList')).toContainText(/importes|cuadran/i);
    await page.locator('#rejectedList').getByRole('button', { name: /Descartar/ }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Descartar' }).click();
    await expect(page.locator('#syncStatus')).not.toContainText(/rechazad/i, { timeout: 20_000 });
  });

  await test.step('A13 · Compras: por destino y artículos, solo validadas por defecto', async () => {
    await nav(page, 'Compras').click();
    await page.getByRole('tab', { name: 'Destino' }).click();
    await expect(page.locator('#purchases')).toContainText('Cocina › Huerto');
    await expect(page.locator('#purchases')).toContainText('Ingredientes › Tomate pera');
    await expect(page.locator('#purchaseTotals')).toContainText('Base 40,00 €');
    await expect(page.locator('#purchaseTotals')).toContainText('sin asignar 0,00 €');
    await page.getByRole('tab', { name: 'Artículos' }).click();
    await expect(page.locator('#purchases .row')).toHaveCount(1);
    await page.locator('#onlyValidated').uncheck();
    await expect(page.locator('#purchases .row')).toHaveCount(2);
  });

  await test.step('A13b · Gestoría: resumen fiscal del trimestre y alertas', async () => {
    await nav(page, 'Gestoría').click();
    await gestoriaPeriod(page, '2026-10-05');
    await expect(page.locator('#fiscalSummary')).toContainText('Base40,00 €');
    await expect(page.locator('#fiscalSummary')).toContainText('IVA soportado4,00 €');
    await expect(page.locator('#fiscalSummary')).toContainText('10 %40,00 € → 4,00 €');
    await expect(page.locator('#fiscalAlerts')).toContainText('1 factura pendiente de revisión');
    await expect(page.locator('#fiscalAlerts')).toContainText('deducibilidad sin revisar');
    await expect(page.locator('#prepareExport')).toBeVisible();
  });

  await test.step('A18 · anular con motivo retira las asignaciones y saca la factura de Compras', async () => {
    await nav(page, 'Facturas').click();
    await page.locator('#invoiceList .row', { hasText: 'Importes corregidos' }).click();
    await ficha(page).locator('#annulInvoice').click();
    const dialog = page.getByRole('alertdialog');
    await dialog.locator('#annulReason').fill('duplicada');
    await dialog.getByRole('button', { name: 'Anular' }).click();
    await expect(ficha(page)).toContainText('Anulada', { timeout: 20_000 });
    await expect(ficha(page).locator('#annulInvoice')).toHaveCount(0);
    await closeSheet(page);
    await page.locator('#invoiceFilter').selectOption('anulada');
    await expect(page.locator('#invoiceList .row')).toHaveCount(1);
    await synced(page);
    expect(api.rows('invoices.invoices').filter((i) => i.status === 'anulada')).toHaveLength(1);
  });
});

test('O1–O6: sin red se trabaja; al volver la red se sube, se sincroniza y los rechazos se ven', async ({ browser }) => {
  test.setTimeout(240_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page);
  await synced(page);

  await test.step('O1 · corte de red: subir documento e importar JSON quedan en cola; al reconectar se suben y aparece el código', async () => {
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
    await nav(page, 'Facturas').click();
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await page.locator('#importNew').click();
    const sheet = ficha(page);
    const doc = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-OFF-1', supplier_tax_id: 'B99999999', supplier_name: 'Sin Red SL' } };
    await sheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(doc));
    await expect(sheet.locator('#importPreview')).toContainText('Crear proveedor «Sin Red SL»');
    await sheet.getByLabel('PDF o fotos del documento').setInputFiles({ name: 'offline.pdf', mimeType: 'application/pdf', buffer: PDF });
    await sheet.locator('#confirmImport').click();
    const f = ficha(page);
    await expect(f).toContainText('Importada, pendiente de revisar');
    await expect(f).toContainText('Pendiente de sincronizar');
    await expect(page.locator('#syncStatus')).toContainText(/pendiente/);
    expect(api.rows('invoices.invoices').some((i) => i.invoice_number === 'F-OFF-1')).toBeFalsy();
    await closeSheet(page);
  });

  await test.step('O2 · recarga sin red: la factura y la cola siguen en el dispositivo', async () => {
    await page.reload().catch(() => undefined);
    await expect(page.locator('#invoiceList .row', { hasText: 'Sin Red SL' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#invoiceList .row', { hasText: 'Sin Red SL' })).toHaveAttribute('data-pending', 'true');
    await expect(page.locator('#syncStatus')).toContainText(/pendiente/);
  });

  await test.step('O1b · reconexión: subida, verificación, import_v1 y código FVR', async () => {
    await reconnect(context, page);
    await synced(page);
    const inv = api.rows('invoices.invoices').find((i) => i.invoice_number === 'F-OFF-1')!;
    expect(inv).toMatchObject({ status: 'pendiente_revision', source: 'import_v1' });
    expect(api.uploads().some((u) => u.status === 'verified' && u.filename === 'offline.pdf')).toBeTruthy();
    expect(api.rows('invoices.invoice_files').some((f) => f.invoice_id === inv.id)).toBeTruthy();
    await expect(page.locator('#invoiceList .row', { hasText: 'Sin Red SL' })).toContainText(/FVR_2026_\d{3}/);
    await expect(page.locator('#invoiceList .row', { hasText: 'Sin Red SL' })).toHaveAttribute('data-pending', 'false');
  });

  await test.step('O3 · campos distintos en dos sitios se fusionan solos (notas en el servidor, pago en el móvil)', async () => {
    const inv = api.rows('invoices.invoices').find((i) => i.invoice_number === 'F-OFF-1')!;
    await context.setOffline(true);
    await page.locator('#invoiceList .row', { hasText: 'Sin Red SL' }).click();
    await ficha(page).locator('#togglePaid').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Marcar pagada' }).click();
    await expect(ficha(page)).toContainText('Pagada');
    api.serverUpdate('invoices.invoices', inv.id, { notes: 'anotado desde el PC' });
    await reconnect(context, page);
    await synced(page);
    const after = api.rows('invoices.invoices').find((i) => i.id === inv.id)!;
    expect(after).toMatchObject({ payment_status: 'pagada', notes: 'anotado desde el PC' });
    await closeSheet(page);
  });

  await test.step('O4 · el mismo campo en dos sitios exige decisión humana', async () => {
    const inv = api.rows('invoices.invoices').find((i) => i.invoice_number === 'F-OFF-1')!;
    await context.setOffline(true);
    await page.locator('#invoiceList .row', { hasText: 'Sin Red SL' }).click();
    await ficha(page).locator('details.inv-block', { hasText: 'Fiscal y pago' }).locator('summary').click();
    await ficha(page).locator('#invNotes').fill('nota desde el móvil');
    await ficha(page).locator('#invNotes').press('Tab'); // un solo evento change → un solo comando
    await closeSheet(page);
    api.serverUpdate('invoices.invoices', inv.id, { notes: 'nota desde el PC' });
    await reconnect(context, page);
    await expect(page.locator('#syncStatus')).toContainText(/conflicto/i, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Resolver' }).click();
    await expect(page.locator('#conflictList')).toContainText('nota desde el PC');
    await expect(page.locator('#conflictList')).toContainText('nota desde el móvil');
    expect(api.rows('invoices.invoices').find((i) => i.id === inv.id)!.notes).toBe('nota desde el PC');
  });

  await test.step('O5 · asignación sin red a un destino reciente que ya no existe → rechazado con opción de descartar', async () => {
    // Cachear el destino con red
    await nav(page, 'Facturas').click();
    await page.locator('#invoiceList .row', { hasText: 'Sin Red SL' }).click();
    await ficha(page).getByRole('button', { name: 'Asignar a…' }).click();
    await ficha(page).getByRole('button', { name: 'Tareas' }).click();
    await ficha(page).getByRole('button', { name: 'Elegir Huerto' }).click();
    await ficha(page).locator('#allocAmount').fill('5');
    await ficha(page).locator('#saveAllocation').click();
    await expect(ficha(page)).toContainText('Cocina › Huerto · 5,00 €', { timeout: 20_000 });
    await synced(page);
    // El proyecto desaparece en Tareas; sin red, se asigna desde «Usados recientemente»
    api.targets.splice(0, api.targets.length, ...api.targets.filter((t) => t.id !== PROJECT));
    await context.setOffline(true);
    await ficha(page).getByRole('button', { name: 'Asignar a…' }).click();
    await ficha(page).getByRole('button', { name: 'Tareas' }).click();
    await expect(ficha(page)).toContainText('Usados recientemente');
    await ficha(page).getByRole('button', { name: 'Elegir Huerto' }).click();
    await ficha(page).locator('#allocAmount').fill('5');
    await ficha(page).locator('#saveAllocation').click();
    await expect(ficha(page).locator('[data-allocation]')).toHaveCount(2); // la segunda, optimista, a la espera del servidor
    await closeSheet(page);
    await reconnect(context, page);
    await expect(page.locator('#syncStatus')).toContainText(/rechazad/i, { timeout: 30_000 });
    await nav(page, 'Inicio').click();
    await page.getByRole('button', { name: 'Ver conflictos' }).click();
    await expect(page.locator('#rejectedList')).toContainText('ya no existe en Tareas');
  });

  await test.step('O6 · una subida que no verifica no envía el lote y se ve como rechazada', async () => {
    api.failNextVerify();
    await nav(page, 'Facturas').click();
    await page.locator('#invoiceList .row', { hasText: 'Sin Red SL' }).click();
    await ficha(page).locator('#addFiles').setInputFiles({ name: 'pagina2.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF, Buffer.from('2')]) });
    await expect(page.locator('#syncStatus')).toContainText(/rechazad|pendiente|error/i, { timeout: 20_000 });
    expect(api.rows('invoices.invoice_files').some((f) => f.original_filename === 'pagina2.pdf')).toBeFalsy();
  });

  await context.close();
});

test('O7–O9: Compras y resumen coinciden sin red; reader solo lee; cerrar sesión borra el espejo', async ({ browser }) => {
  test.setTimeout(240_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await test.step('O7 · los totales de Compras y el resumen fiscal se calculan en local y no cambian al cortar la red', async () => {
    await login(page);
    await synced(page);
    await nav(page, 'Compras').click();
    await page.locator('#onlyValidated').uncheck();
    // Esperar a que el espejo tenga también las asignaciones (el snapshot va por tablas) antes de cortar la red.
    await page.getByRole('tab', { name: 'Artículos' }).click();
    await page.locator('#purchaseTarget').selectOption('food:ingredient');
    await expect(page.locator('#purchases .row')).toHaveCount(1, { timeout: 20_000 });
    await page.locator('#purchaseTarget').selectOption('');
    await page.getByRole('tab', { name: 'Categoría' }).click();
    const totalsOnline = await page.locator('#purchaseTotals').innerText();
    expect(totalsOnline).toContain('Base');
    await nav(page, 'Gestoría').click();
    await gestoriaPeriod(page, '2026-10-05');
    await expect(page.locator('#fiscalSummary')).toContainText('Facturas validadas');
    const summaryOnline = await page.locator('#fiscalSummary').innerText();
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
    await page.reload().catch(() => undefined);
    await nav(page, 'Compras').click();
    await page.locator('#onlyValidated').uncheck();
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
    await expect.poll(async () => norm(await page.locator('#purchaseTotals').innerText())).toBe(norm(totalsOnline));
    await nav(page, 'Gestoría').click();
    await gestoriaPeriod(page, '2026-10-05');
    await expect.poll(async () => norm(await page.locator('#fiscalSummary').innerText())).toBe(norm(summaryOnline));
    // Filtros del handoff: por destino (ingrediente) y «solo sin asignar»
    await nav(page, 'Compras').click();
    await page.locator('#onlyValidated').uncheck();
    await page.getByRole('tab', { name: 'Artículos' }).click();
    await page.locator('#purchaseTarget').selectOption('food:ingredient');
    await expect(page.locator('#purchases .row')).toHaveCount(1);
    await page.locator('#purchaseTarget').selectOption('booking:event');
    await expect(page.locator('#purchases')).toContainText('Sin artículos');
    await page.locator('#purchaseTarget').selectOption('');
    await page.locator('#onlyUnassigned').check();
    await expect(page.locator('#purchases .row').first()).toContainText('Sin asignar');
    await context.setOffline(false);
  });

  await test.step('O9 · cerrar sesión borra el espejo local (clearOnLogout)', async () => {
    // Al volver la red, el cliente está sincronizando: cerrar sesión con una lectura en vuelo deja que esa lectura escriba
    // el espejo y el `userId` del propietario después del borrado, y la siguiente persona (O8, reader) arranca con
    // USER_CHANGED y stores borrados → «Error de sincronización» permanente. Esperamos a que termine antes de salir.
    await nav(page, 'Inicio').click();
    await synced(page);
    await page.locator('#logoutHome').click();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    const counts = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('ikisai-invoices-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const out: Record<string, number> = {};
      for (const name of Array.from(db.objectStoreNames)) {
        out[name] = await new Promise<number>((resolve) => { const req = db.transaction(name).objectStore(name).count(); req.onsuccess = () => resolve(req.result); });
      }
      db.close();
      return out;
    });
    expect(counts['invoices.invoices'] ?? 0).toBe(0);
    expect(counts['invoices.suppliers'] ?? 0).toBe(0);
    expect(counts['outbox'] ?? 0).toBe(0);
  });

  await test.step('O8 · la gestoría (reader) ve Facturas, Compras y Gestoría sin botones de escritura, también sin red', async () => {
    await login(page, READER);
    await synced(page);
    await expect(page.locator('#homeNewInvoice')).toBeHidden();
    await nav(page, 'Facturas').click();
    await expect(page.locator('#invoiceList .row').first()).toBeVisible();
    await expect(page.locator('#newInvoice')).toBeHidden();
    await page.locator('#invoiceList .row').first().click();
    await expect(ficha(page)).toBeVisible();
    for (const id of ['#validateInvoice', '#annulInvoice', '#togglePaid', '#addLine', '#importInto']) await expect(ficha(page).locator(id)).toHaveCount(0);
    await expect(ficha(page).getByRole('button', { name: 'Asignar a…' })).toHaveCount(0);
    await closeSheet(page);
    await nav(page, 'Gestoría').click();
    await gestoriaPeriod(page, '2026-10-05');
    await expect(page.locator('#prepareExport')).toBeHidden();
    await expect(page.locator('#fiscalSummary')).toContainText('Base');
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
    await nav(page, 'Compras').click();
    await page.locator('#onlyValidated').uncheck();
    await expect(page.locator('#purchaseTotals')).toContainText('Base');
    await nav(page, 'Inicio').click();
    await page.getByRole('link', { name: /Proveedores/ }).click();
    await expect(page.locator('#newSupplier')).toBeHidden();
    await context.setOffline(false);
  });

  await context.close();
});

test('Aceptación V1 (Android): proveedor nuevo desde la hoja y «Extraer con ChatGPT» junto al documento', async ({ browser }) => {
  test.setTimeout(180_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page);
  await synced(page);

  await test.step('incidencia 1 · «+ Nuevo proveedor…» en Nueva factura: se crea con la factura, sin ir a Proveedores', async () => {
    await nav(page, 'Facturas').click();
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await expect(sheet).toContainText('Si no está en la lista, elige «+ Nuevo proveedor…»');
    await sheet.locator('#newSupplier').selectOption({ label: '+ Nuevo proveedor…' });
    await expect(sheet.locator('#newSupplierFields')).toBeVisible();
    await sheet.locator('#saveInvoice').click();
    await expect(sheet.locator('.formerror')).toContainText('nombre del proveedor nuevo');
    await sheet.locator('#newSupplierName').fill('Frutas Nuevas SL');
    await sheet.locator('#newSupplierTaxId').fill('B11111111');
    await sheet.getByLabel('Fecha').fill('2026-10-06');
    await sheet.getByLabel('Objeto').fill('fruta');
    await expect(sheet.locator('#namePreview')).toHaveText('2026_10_06_(frutas_nuevas_sl)_fruta.pdf');
    // Incidencia 2 · en cuanto hay documento aparece el camino manual con ChatGPT
    await expect(sheet.locator('#chatgptNew')).toBeHidden();
    // Con una foto, la vista previa lleva la extensión con la que se guardará (WebP), no .pdf
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'foto factura.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    await expect(sheet.locator('#namePreview')).toHaveText('2026_10_06_(frutas_nuevas_sl)_fruta.webp');
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'foto factura.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(sheet.locator('#namePreview')).toHaveText('2026_10_06_(frutas_nuevas_sl)_fruta.pdf');
    await expect(sheet.locator('#chatgptNew')).toBeVisible();
    await expect(sheet.locator('#chatgptNew')).toContainText('adjunta esta misma foto o PDF');
    await sheet.locator('#saveInvoice').click();
    await expect(ficha(page)).toContainText('Frutas Nuevas SL', { timeout: 20_000 });
    await synced(page);
    expect(api.rows('invoices.suppliers').find((s) => s.name === 'Frutas Nuevas SL')).toMatchObject({ tax_id: 'B11111111' });
  });

  await test.step('incidencia 2 · en la ficha pendiente de datos: copiar prompt y pegar JSON en esa misma factura', async () => {
    const f = ficha(page);
    const steps = f.locator('#chatgptInvoice');
    await expect(steps).toBeVisible();
    await steps.locator('[data-step="copy"]').click();
    // Con o sin permiso de portapapeles: o se copia (aviso) o se muestra el texto seleccionado para copiarlo a mano.
    await expect.poll(async () => (await steps.locator('.prompt-text').isVisible()) || (await page.locator('.toast, [role="status"]').filter({ hasText: 'Prompt copiado' }).count()) > 0).toBeTruthy();
    await steps.locator('[data-step="paste"]').click();
    const sheet = ficha(page);
    await expect(sheet).toContainText('Importar JSON en');
    const doc = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_date: '2026-10-06', supplier_name: 'Frutas Nuevas SL', supplier_tax_id: 'B11111111', invoice_number: 'V1-1', object: 'fruta' } };
    await sheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(doc));
    await expect(sheet.locator('#importPreview')).toContainText('coincide por NIF');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('Importada, pendiente de revisar', { timeout: 20_000 });
    await expect(ficha(page).locator('#chatgptInvoice')).toHaveCount(0);
    await synced(page);
    await closeSheet(page);
  });

  await test.step('incidencia 2 · en Nueva factura: «Pegar JSON» importa con los documentos ya subidos', async () => {
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: PDF });
    await sheet.locator('#chatgptNew [data-step="paste"]').click();
    const importSheet = ficha(page);
    await expect(importSheet).toContainText('Importar JSON de ChatGPT');
    const doc = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_date: '2026-10-06', supplier_name: 'Frutas Nuevas SL', supplier_tax_id: 'B11111111', invoice_number: 'V1-2', object: 'fruta segunda' } };
    await importSheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(doc));
    await expect(importSheet.locator('#importPreview')).toContainText('El documento que subiste se adjunta a la factura');
    await importSheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('Importada, pendiente de revisar', { timeout: 20_000 });
    await synced(page);
    const created = api.rows('invoices.invoices').find((i) => i.invoice_number === 'V1-2')!;
    expect(api.rows('invoices.invoice_files').filter((f) => f.invoice_id === created.id).map((f) => f.original_filename)).toEqual(['ticket.pdf']);
  });

  await context.close();
});

test('Emitidas (API.md §13): registro manual con serie nueva, número único, cobro y anulación', async ({ browser }) => {
  test.setTimeout(180_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page);
  await synced(page);
  await nav(page, 'Facturas').click();
  await page.locator('#invoiceTabs').getByRole('tab', { name: 'Emitidas' }).click();
  await expect(page.locator('#issuedList')).toContainText('Todavía no hay facturas emitidas');

  await test.step('alta manual: serie nueva, completa con destinatario, dos líneas y total del documento', async () => {
    await page.locator('#newIssued').click();
    const sheet = page.getByRole('dialog', { name: 'Nueva emitida' });
    await expect(sheet.locator('#issuedSeries')).toHaveValue('__new__');
    await expect(sheet.locator('#newIssuedIssuer')).toContainText('Faltan los datos de la entidad en Central');
    await sheet.locator('#issuedNewSeries').fill('A');
    await sheet.locator('#issuedNumber').fill('2026-0001');
    await sheet.locator('#issuedDate').fill('2026-10-06');
    await sheet.locator('#saveIssued').click();
    await expect(sheet.locator('.formerror')).toContainText('nombre y NIF del destinatario');
    await sheet.locator('#issuedRecipientName').fill('Cliente Retiro SL');
    await sheet.locator('#issuedRecipientTaxId').fill('B44444444');
    await sheet.locator('#issuedDescription').fill('Retiro de yoga, 2 noches');
    await sheet.locator('#issuedCategory').selectOption('alojamiento');
    await sheet.getByLabel('Concepto de la línea 1').fill('Alojamiento');
    await sheet.getByLabel('Base de la línea 1').fill('100');
    await sheet.locator('#addIssuedLine').click();
    await sheet.getByLabel('Concepto de la línea 2').fill('Actividad');
    await sheet.getByLabel('Base de la línea 2').fill('50');
    await sheet.getByLabel('IVA de la línea 2').selectOption('21');
    await sheet.locator('#issuedSourceTotal').fill('170,50');
    await expect(sheet.locator('#issuedPreviewTotals')).toContainText('TOTAL 170,50 €');
    await sheet.locator('#saveIssued').click();
    await expect(sheet).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('#issuedList')).toContainText('A-2026-0001 · Cliente Retiro SL', { timeout: 20_000 });
    await synced(page);
    const row = await eventually(() => api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0001'));
    expect(row).toMatchObject({ series_code: 'A', invoice_type: 'F1', origin: 'manual', status: 'registrada', total: 170.5, base_total: 150, quota_total: 20.5, review_reason: null });
    await expect.poll(() => api.rows('invoices.issued_series').map((s) => s.code), { timeout: 20_000 }).toEqual(['A']);
    await expect.poll(() => api.rows('invoices.issued_tax_lines').filter((t) => t.issued_invoice_id === row.id).map((t) => `${t.rate}:${t.taxable_base}:${t.quota}`).sort(), { timeout: 20_000 }).toEqual(['10:100:10', '21:50:10.5']);
  });

  await test.step('el mismo número en la misma serie se rechaza en el formulario', async () => {
    await page.locator('#newIssued').click();
    const sheet = page.getByRole('dialog', { name: 'Nueva emitida' });
    await expect(sheet.locator('#issuedSeries')).toHaveValue('A');
    await sheet.locator('#issuedNumber').fill('2026-0001');
    await sheet.locator('#issuedType').selectOption('F2');
    await sheet.locator('#issuedDescription').fill('Ticket');
    await sheet.getByLabel('Base de la línea 1').fill('10');
    await sheet.getByLabel('Concepto de la línea 1').fill('Café');
    await sheet.locator('#saveIssued').click();
    await expect(sheet.locator('.formerror')).toContainText('Ya está registrada la A-2026-0001');
    await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Descartar' }).click();
  });

  await test.step('asignar el ingreso a una reserva desde la ficha; Gestoría muestra el IVA repercutido', async () => {
    const reservation = { app: 'booking' as const, kind: 'reservation', id: '33333333-3333-4333-8333-333333333333', label: 'Reserva García', path: ['Reservas'], revision: 1 };
    api.targets.push(reservation);
    try {
      await page.locator('#issuedList .row').first().click();
      const sheet = page.locator('.sheet[role="dialog"]');
      await sheet.locator('#assignIssued').click();
      const assign = page.locator('.sheet[role="dialog"]');
      await expect(assign.locator('#issuedAllocAmount')).toHaveValue('150');
      await assign.getByRole('button', { name: 'Elegir Reserva García' }).click();
      await expect(assign.locator('#issuedChosenTarget')).toContainText('Reservas › Reserva García');
      await assign.locator('#issuedAllocAmount').fill('200');
      await assign.locator('#saveIssuedAllocation').click();
      await expect(assign.locator('.formerror')).toContainText('Solo quedan 150,00 €');
      await assign.locator('#issuedAllocAmount').fill('150');
      await assign.locator('#saveIssuedAllocation').click();
      await expect(page.locator('#issuedAllocations')).toContainText('Reservas › Reserva García · 150,00 €', { timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_allocations').length, { timeout: 20_000 }).toBe(1);
      await expect.poll(() => api.rows('invoices.issued_allocations'), { timeout: 20_000 }).toEqual([expect.objectContaining({ target_app: 'booking', target_kind: 'reservation', target_id: reservation.id, allocated_amount: 150 })]);
    } finally {
      api.targets.splice(api.targets.findIndex((t) => t.id === reservation.id), 1);
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await nav(page, 'Gestoría').click();
    await gestoriaPeriod(page);
    await expect(page.locator('#issuedSummary')).toContainText('IVA repercutido20,50 €');
    await expect(page.locator('#issuedSummary')).toContainText('IVA 21 %50,00 € → 10,50 €');
    await expect(page.locator('#vatBalance')).toContainText('Repercutido20,50 €');
    await nav(page, 'Facturas').click();
    await page.locator('#invoiceTabs').getByRole('tab', { name: 'Emitidas' }).click();
  });

  await test.step('ficha: cobrada y anulada con motivo; el número sigue ocupado', async () => {
    await page.locator('#issuedList .row').first().click();
    const sheet = page.locator('.sheet[role="dialog"]');
    await expect(sheet.locator('#issuedTotal')).toHaveText('170,50 €');
    await expect(sheet).toContainText('El registro Verifactu lo hace la herramienta que la expidió');
    await sheet.locator('#toggleCollected').click();
    await expect(sheet).toContainText('Cobrada el', { timeout: 20_000 });
    await sheet.locator('#annulIssued').click();
    await page.locator('#annulIssuedReason').fill('Emitida por error');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Anular' }).click();
    await expect(sheet).toContainText('Anulada: Emitida por error', { timeout: 20_000 });
    await expect(sheet.locator('#annulIssued')).toHaveCount(0);
    await synced(page);
    await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cerrar' }).click();
    await expect(page.locator('#issuedList')).toContainText('Ninguna emitida coincide', { timeout: 20_000 });
    await page.locator('#issuedFilter').selectOption('anulada');
    await expect(page.locator('#issuedList')).toContainText('A-2026-0001');
    await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0001'), { timeout: 20_000 }).toMatchObject({ status: 'anulada', payment_status: 'cobrada' });
  });

  await test.step('IVA sugerido por categoría; importar CSV del Sheet (nueva, ya registrada, con error) y emitida desde ChatGPT con su PDF', async () => {
    await page.locator('#issuedFilter').selectOption('activas');
    // IVA sugerido: consultoría → 21 % en la línea que no se ha tocado
    await page.locator('#newIssued').click();
    let sheet = page.getByRole('dialog', { name: 'Nueva emitida' });
    await sheet.locator('#issuedCategory').selectOption('consultoria');
    await expect(sheet.getByLabel('IVA de la línea 1')).toHaveValue('21');
    // «Extraer con ChatGPT» aparece con el PDF y lleva a la importación con el documento
    await expect(sheet.locator('#chatgptIssued')).toBeHidden();
    await sheet.locator('#issuedFiles').setInputFiles({ name: 'emitida.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(sheet.locator('#chatgptIssued')).toBeVisible();
    await sheet.locator('#chatgptIssued [data-step="paste"]').click();
    sheet = page.locator('.sheet[role="dialog"]');
    await expect(sheet).toContainText('Importar emitida desde ChatGPT');
    await expect(sheet).toContainText('El PDF se adjunta a la factura importada');
    await sheet.locator('#issuedCsvText').fill('serie;numero;fecha;fecha_operacion;tipo;cliente;nif;concepto;categoria;base;iva_tipo;iva_cuota;retencion;total;cobrada\nC;C-2026-0001;2026-10-09;;F1;Cliente PDF;B66666666;Consultoría web;consultoria;200,00;21;42,00;;242,00;no');
    await expect(sheet.locator('#issuedCsvSummary')).toHaveText('1 nueva · 0 con errores · 0 ya registradas');
    await sheet.locator('#confirmIssuedCsv').click();
    await expect(page.locator('#issuedList')).toContainText('C-2026-0001 · Cliente PDF', { timeout: 20_000 });
    await synced(page);
    const fromPdf = await eventually(() => api.rows('invoices.issued_invoices').find((i) => i.number === 'C-2026-0001'));
    expect(fromPdf).toMatchObject({ origin: 'importada', external_tool: 'chatgpt_pdf', income_category: 'consultoria', total: 242 });
    await expect.poll(() => api.rows('invoices.issued_invoice_files').filter((f) => f.issued_invoice_id === fromPdf.id).map((f) => f.original_filename), { timeout: 20_000 }).toEqual(['emitida.pdf']);
    await expect.poll(() => api.rows('invoices.issued_series').map((x) => x.code).sort(), { timeout: 20_000 }).toEqual(['A', 'C']);
    // CSV del Google Sheet: mapeo adivinado, serie por defecto, una ya registrada y una con error
    await page.locator('#importIssuedCsv').click();
    sheet = page.locator('.sheet[role="dialog"]');
    await expect(sheet.locator('#issuedCsvSeries')).toHaveValue('A');
    await sheet.locator('#issuedCsvText').fill([
      'Nº Factura;Fecha;Cliente;NIF;Concepto;Categoría;Base imponible;% IVA;Total;Cobrada',
      '2026-0001;06/10/2026;Cliente Retiro SL;B44444444;Repetida;alojamiento;150;10;165;',
      '2026-0010;10/10/2026;Cliente CSV;B55555555;Cena de grupo;restaurante;"1.000,00";10;1.100,00;sí',
      '2026-0011;31/02/2026;Cliente Mal;B77777777;Mal fecha;otros;10;21;12,1;',
    ].join('\n'));
    await expect(sheet.locator('#issuedCsvSummary')).toHaveText('1 nueva · 1 con errores · 1 ya registrada');
    await expect(sheet.locator('#csvMap_base')).toHaveValue('6');
    await sheet.locator('#confirmIssuedCsv').click();
    await expect(page.locator('#issuedList')).toContainText('A-2026-0010 · Cliente CSV', { timeout: 20_000 });
    await synced(page);
    await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0010'), { timeout: 20_000 }).toMatchObject({ series_code: 'A', origin: 'importada', external_tool: 'google_sheet', income_category: 'restauracion', base_total: 1000, quota_total: 100, total: 1100, payment_status: 'cobrada' });
  });

  await test.step('emisor (rondas 37 y 38): sin entidad en Central se avisa; con ella se completan las que no lo tienen, se copia al registrar y sale en la copia imprimible', async () => {
    await page.locator('#issuedList .row', { hasText: 'A-2026-0010' }).click();
    let sheet = page.locator('.sheet[role="dialog"]');
    await expect(sheet.locator('#issuerMissing')).toContainText('Faltan los datos de la entidad en Central');
    await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cerrar' }).click();
    api.setEntity({ entity_id: '44444444-4444-4444-8444-444444444444', entity_revision: 2, legal_name: 'Ikisai Retiros SL', trade_name: 'Ikisai', tax_id: 'B12345674',
      address_line: 'Calle Prueba 1', postal_code: '28001', city: 'Madrid', province: 'Madrid', country: 'ES', email: 'hola@example.invalid', phone: null, website: null, logo_file_id: null });
    try {
      // Ronda 38: completar las ya registradas sin emisor, una desde la ficha y el resto en lote desde la lista
      await expect(page.locator('#issuersMissing')).toContainText('sin emisor');
      await page.locator('#issuedList .row', { hasText: 'A-2026-0010' }).click();
      sheet = page.locator('.sheet[role="dialog"]');
      await sheet.locator('#takeIssuer').click();
      await expect(page.getByRole('alertdialog')).toContainText('Ikisai Retiros SL · NIF B12345674');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Completar' }).click();
      await expect(sheet.locator('#issuedIssuer')).toContainText('Ikisai Retiros SL', { timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0010'), { timeout: 20_000 }).toMatchObject({ issuer_tax_id: 'B12345674' });
      await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cerrar' }).click();
      await page.locator('#fillIssuers').click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Completar' }).click();
      await expect(page.locator('#issuersMissing')).toBeHidden({ timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_invoices').filter((i) => i.status !== 'anulada' && !i.issuer_tax_id), { timeout: 20_000 }).toEqual([]);
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0001'), { timeout: 20_000 }).toMatchObject({ status: 'anulada', issuer_tax_id: null });

      await page.locator('#newIssued').click();
      sheet = page.getByRole('dialog', { name: 'Nueva emitida' });
      await expect(sheet.locator('#newIssuedIssuer')).toContainText('Emisor: Ikisai Retiros SL · NIF B12345674');
      await sheet.locator('#issuedNumber').fill('2026-0020');
      await sheet.locator('#issuedType').selectOption('F2');
      await sheet.locator('#issuedDescription').fill('Ticket con emisor');
      await sheet.getByLabel('Concepto de la línea 1').fill('Café');
      await sheet.getByLabel('Base de la línea 1').fill('10');
      await sheet.locator('#saveIssued').click();
      await expect(sheet).toBeHidden({ timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0020'), { timeout: 20_000 }).toMatchObject({ issuer_tax_id: 'B12345674', issuer_name: 'Ikisai Retiros SL' });
      await page.locator('#issuedList .row', { hasText: 'A-2026-0020' }).click();
      sheet = page.locator('.sheet[role="dialog"]');
      await expect(sheet.locator('#issuedIssuer')).toContainText('Ikisai Retiros SL (Ikisai)', { timeout: 20_000 });
      await expect(sheet.locator('#issuedIssuer')).toContainText('Calle Prueba 1, 28001 Madrid, Madrid');
      await sheet.locator('#printIssued').click();
      const copy = page.locator('#issuedPrintView');
      await expect(copy).toContainText('COPIA DE REGISTRO');
      await expect(copy).toContainText('Factura A-2026-0020');
      await expect(copy.locator('#printIssuer')).toContainText('NIF B12345674');
      await expect(copy).toContainText('no es una factura');
    } finally {
      api.setEntity(null);
    }
  });

  await context.close();
});

test('Emitir desde Finance (API.md §14): serie, borrador, datos que faltan, emitir con número del servidor y factura imprimible', async ({ browser }) => {
  test.setTimeout(180_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const year = new Date().toLocaleDateString('sv-SE').slice(0, 4);
  const yy = year.slice(2);
  api.setEntity({ entity_id: '44444444-4444-4444-8444-444444444444', entity_revision: 3, legal_name: 'Ikisai Retiros SL', trade_name: 'Ikisai', tax_id: 'B12345674',
    address_line: 'Calle Prueba 1', postal_code: '28001', city: 'Madrid', province: 'Madrid', country: 'ES', email: null, phone: null, website: null, logo_file_id: null });
  try {
    await login(page);
    await synced(page);
    await nav(page, 'Facturas').click();
    await page.locator('#invoiceTabs').getByRole('tab', { name: 'Emitidas' }).click();

    await test.step('sin serie de emisión, «Nueva factura» lleva a crearla', async () => {
      await page.locator('#newIssuedInvoice').click();
      const settings = page.getByRole('dialog', { name: 'Series y VERI*FACTU' });
      await expect(settings.locator('#vfSending')).toContainText('Envío a la AEAT: apagado');
      await settings.locator('#createSeries-ordinaria').click();
      await expect(settings).toBeHidden({ timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_series').find((s) => s.code === 'F'), { timeout: 20_000 }).toMatchObject({ mode: 'emision', kind: 'ordinaria', format: '{serie}{año}-{n:4}' });
    });

    await test.step('borrador sin número; el domicilio es obligatorio para emitir a una empresa', async () => {
      await page.locator('#newIssuedInvoice').click();
      const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
      await expect(sheet.locator('#draftSeries')).toContainText(`siguiente F${year}-0001`);
      await sheet.locator('#draftRecipientName').fill('Cliente Emisión SL');
      await sheet.locator('#draftRecipientTaxId').fill('B55555555');
      await sheet.locator('#draftDescription').fill('Retiro de grupo');
      await sheet.getByLabel('Concepto de la línea 1').fill('Alojamiento');
      await sheet.getByLabel('Cantidad de la línea 1').fill('2');
      await sheet.getByLabel('Precio de la línea 1').fill('50');
      await expect(sheet.locator('#draftTotals')).toContainText('TOTAL 110,00 €');
      await sheet.locator('#saveDraft').click();
      await expect(sheet).toBeHidden({ timeout: 20_000 });
      await synced(page);
      const draft = await eventually(() => api.rows('invoices.issued_invoices').find((i) => i.description === 'Retiro de grupo'));
      expect(draft).toMatchObject({ status: 'borrador', number: null, origin: 'app', series_code: 'F' });
      await expect.poll(() => api.rows('invoices.issued_invoice_lines').filter((l) => l.issued_invoice_id === draft.id), { timeout: 20_000 }).toEqual([expect.objectContaining({ quantity: 2, unit_price: 50, net_amount: 100, vat_rate: 10 })]);
      await page.locator('#issuedList .row', { hasText: 'Borrador F' }).click();
      const ficha = page.locator('.sheet[role="dialog"]');
      await expect(ficha.locator('#draftBanner')).toContainText('Borrador sin número');
      await ficha.locator('#issueDraft').click();
      await expect(page.getByText('Para emitir falta el domicilio del destinatario')).toBeVisible();
      await ficha.locator('#editDraft').click();
      const edit = page.getByRole('dialog', { name: 'Editar borrador' });
      await edit.locator('#draftAddressLine').fill('Calle Cliente 2');
      await edit.locator('#draftPostalCode').fill('28002');
      await edit.locator('#draftCity').fill('Madrid');
      await edit.locator('#saveDraft').click();
      await expect(edit).toBeHidden({ timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.id === draft.id)!.recipient_address, { timeout: 20_000 }).toMatchObject({ line: 'Calle Cliente 2', postal_code: '28002', city: 'Madrid', country: 'ES' });
      await expect.poll(() => api.rows('invoices.issued_invoice_lines').filter((l) => l.issued_invoice_id === draft.id && !l.deleted_at), { timeout: 20_000 }).toHaveLength(1);
    });

    await test.step('emitir: número del servidor, congelada, factura imprimible con los datos obligatorios y sin QR con el envío apagado', async () => {
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#issuedList .row', { hasText: 'Borrador F' }).click();
      const ficha = page.locator('.sheet[role="dialog"]');
      await ficha.locator('#issueDraft').click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText(`F${year}-0001`);
      await expect(confirm).toContainText('no se podrá editar');
      await confirm.getByRole('button', { name: 'Emitir' }).click();
      // NIF nuevo: se ofrece guardar el cliente (ronda 46)
      const save = page.getByRole('alertdialog');
      await expect(save).toContainText('Cliente Emisión SL · B55555555', { timeout: 20_000 });
      await save.getByRole('button', { name: 'Guardar cliente' }).click();
      await expect(page.locator('#issuedList')).toContainText(`F${year}-0001 · Cliente Emisión SL`, { timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.customers'), { timeout: 20_000 }).toEqual([expect.objectContaining({ name: 'Cliente Emisión SL', tax_id: 'B55555555', kind: 'empresa',
        address: expect.objectContaining({ line: 'Calle Cliente 2', postal_code: '28002', city: 'Madrid' }) })]);
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.description === 'Retiro de grupo'), { timeout: 20_000 })
        .toMatchObject({ status: 'emitida', number: `F${year}-0001`, issuer_tax_id: 'B12345674', total: 110, vf_status: 'no_enviar' });
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.description === 'Retiro de grupo')!.vf_hash, { timeout: 20_000 }).toMatch(/^[0-9A-F]{64}$/);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#issuedList .row', { hasText: `F${year}-0001` }).click();
      const sheet = page.locator('.sheet[role="dialog"]');
      await expect(sheet.locator('#editDraft')).toHaveCount(0);
      await expect(sheet.locator('#issuedVerifactu')).toContainText('Registro de alta guardado (primero de la cadena)');
      await sheet.locator('#printInvoice').click();
      const doc = page.locator('#issuedDocumentView');
      await expect(doc).toContainText(`Factura F${year}-0001`);
      await expect(doc.locator('#docIssuer')).toContainText('NIF B12345674');
      await expect(doc.locator('#docIssuer')).toContainText('Calle Prueba 1');
      await expect(doc.locator('#docRecipient')).toContainText('NIF B55555555');
      await expect(doc.locator('#docRecipient')).toContainText('Calle Cliente 2, 28002 Madrid');
      await expect(doc.locator('#docBreakdown')).toContainText('IVA 10 %');
      await expect(doc.locator('#docTotals')).toContainText('110,00 €');
      await expect(doc).not.toContainText('VERI*FACTU');
      await expect(doc).not.toContainText('COPIA DE REGISTRO');
    });

    await test.step('rectificar (§14.3): borrador por diferencias en la serie R, emitirlo y la original queda rectificada', async () => {
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#issuedList .row', { hasText: `F${year}-0001` }).click();
      let ficha = page.locator('.sheet[role="dialog"]');
      await ficha.locator('#rectifyIssued').click();
      // Sin serie de rectificativas: lleva a crearla
      const settings = page.getByRole('dialog', { name: 'Series y VERI*FACTU' });
      // Rectificativas con el formato de la hoja (ronda 47): R_01_26, un dato de la serie
      await settings.locator('#newSeriesFormat-rectificativa').selectOption('{serie}_{n:2}_{aa}');
      await expect(settings.locator('#newSeriesNext-rectificativa')).toContainText(`Siguiente: R_01_${yy}`);
      await settings.locator('#createSeries-rectificativa').click();
      await expect(settings).toBeHidden({ timeout: 20_000 });
      await synced(page);
      await page.locator('#issuedList .row', { hasText: `F${year}-0001` }).click();
      ficha = page.locator('.sheet[role="dialog"]');
      await ficha.locator('#rectifyIssued').click();
      const dialog = page.getByRole('alertdialog');
      await dialog.locator('#rectifyReason').fill('Devolución de la estancia');
      await dialog.getByRole('button', { name: 'Crear rectificativa' }).click();
      await expect(page.locator('#issuedList')).toContainText('Borrador R', { timeout: 20_000 });
      await synced(page);
      const draft = await eventually(() => api.rows('invoices.issued_invoices').find((i) => i.series_code === 'R' && i.status === 'borrador'));
      expect(draft).toMatchObject({ invoice_type: 'R4', rectification_kind: 'I', recipient_tax_id: 'B55555555' });
      await expect.poll(() => api.rows('invoices.issued_invoice_lines').filter((l) => l.issued_invoice_id === draft.id).map((l) => l.net_amount), { timeout: 20_000 }).toEqual([-100]);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#issuedList .row', { hasText: 'Borrador R' }).click();
      ficha = page.locator('.sheet[role="dialog"]');
      await ficha.locator('#editDraft').click();
      const edit = page.getByRole('dialog', { name: 'Editar borrador' });
      await expect(edit.locator('#draftRectInfo')).toContainText(`Rectifica a F${year}-0001 · por diferencias`);
      await edit.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click();
      await page.locator('#issuedList .row', { hasText: 'Borrador R' }).click();
      ficha = page.locator('.sheet[role="dialog"]');
      await ficha.locator('#issueDraft').click();
      await expect(page.getByRole('alertdialog')).toContainText(`R_01_${yy}`);
      await page.getByRole('alertdialog').getByRole('button', { name: 'Emitir' }).click();
      await expect(page.locator('#issuedList')).toContainText(`R_01_${yy}`, { timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.full_number === `F${year}-0001`), { timeout: 20_000 }).toMatchObject({ status: 'rectificada' });
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#issuedList .row', { hasText: `R_01_${yy}` }).click();
      ficha = page.locator('.sheet[role="dialog"]');
      await ficha.locator('#printInvoice').click();
      const doc = page.locator('#issuedDocumentView');
      await expect(doc.locator('#docRectification')).toContainText(`Factura rectificativa por diferencias de F${year}-0001`);
      await expect(doc.locator('#docTotals')).toContainText('-110,00 €');
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#issuedList .row', { hasText: `F${year}-0001 · Cliente Emisión SL` }).click();
      await expect(page.locator('.sheet[role="dialog"]').locator('#issuedRectifiedBy')).toContainText(`R_01_${yy}`);
    });

    await test.step('el cliente guardado se busca y rellena NIF y domicilio', async () => {
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#newIssuedInvoice').click();
      const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
      await sheet.locator('#draftCustomerSearch').fill('cliente emi');
      await sheet.locator('#draftCustomerResults').getByRole('button', { name: 'Cliente Emisión SL · B55555555' }).click();
      await expect(sheet.locator('#draftRecipientTaxId')).toHaveValue('B55555555');
      await expect(sheet.locator('#draftAddressLine')).toHaveValue('Calle Cliente 2');
      await expect(sheet.locator('#draftCity')).toHaveValue('Madrid');
      await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Descartar' }).click();
    });

    await test.step('un borrador se borra sin dejar número', async () => {
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.locator('#newIssuedInvoice').click();
      const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
      await sheet.locator('#draftRecipientKind').selectOption('particular');
      await sheet.locator('#draftRecipientName').fill('Particular Prueba');
      await sheet.locator('#draftDescription').fill('Para borrar');
      await sheet.getByLabel('Concepto de la línea 1').fill('Cena');
      await sheet.getByLabel('Precio de la línea 1').fill('20');
      await sheet.locator('#saveDraft').click();
      await expect(sheet).toBeHidden({ timeout: 20_000 });
      await page.locator('#issuedList .row', { hasText: 'Particular Prueba' }).click();
      await page.locator('.sheet[role="dialog"]').locator('#deleteDraft').click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Borrar' }).click();
      await expect(page.locator('#issuedList')).not.toContainText('Particular Prueba', { timeout: 20_000 });
      await synced(page);
      await expect.poll(() => api.rows('invoices.issued_invoices').find((i) => i.description === 'Para borrar')!.deleted_at, { timeout: 20_000 }).not.toBeNull();
      await expect.poll(() => api.rows('invoices.issued_series').find((s) => s.code === 'F')!.counter_last, { timeout: 20_000 }).toBe(1);
    });
  } finally {
    api.setEntity(null);
    await context.close();
  }
});

test('Facturar desde una reserva (API.md §14.8): borrador relleno desde Booking, datos fiscales a mano, asignado a la reserva; volver a pulsar abre el mismo', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const RES = '55555555-5555-4555-8555-555555555555';
  const reservation = { app: 'booking' as const, kind: 'reservation', id: RES, label: 'Retiro Primavera', path: ['Reservas'], revision: 4 };
  api.targets.push(reservation);
  api.setEntity({ entity_id: '44444444-4444-4444-8444-444444444444', entity_revision: 3, legal_name: 'Ikisai Retiros SL', trade_name: 'Ikisai', tax_id: 'B12345674',
    address_line: 'Calle Prueba 1', postal_code: '28001', city: 'Madrid', province: 'Madrid', country: 'ES', email: null, phone: null, website: null, logo_file_id: null });
  api.setReservationSource(RES, {
    reservation: { id: RES, code: 'R-2026-014', label: 'Retiro Primavera', revision: 4, check_in: '2026-11-06', check_out: '2026-11-08' },
    customer: { name: 'Asociación Yoga Norte', kind: 'asociacion', tax_id: null, id_type: null, country: null, address: null },
    prices_include_vat: true, proposal: { id: '66666666-6666-4666-8666-666666666666', version: 2, total: 1221 }, final_amount: null, invoiced: null,
    lines: [
      { kind: 'tarifa', description: 'Alojamiento por persona y noche', quantity: 20, unit: 'persona_noche', unit_price: 55, discount_amount: 0, vat_rate: 10, income_category: 'alojamiento' },
      { kind: 'extra', description: 'Masaje', quantity: 2, unit: 'unidad', unit_price: 60.5, discount_amount: 0, vat_rate: 21, income_category: 'extras' },
    ],
  });
  try {
    await login(page);
    await synced(page);
    await page.goto(`${baseURL}/#/facturas?vista=emitidas&desde=booking:reservation:${RES}`);
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await expect(sheet.locator('#draftSource')).toContainText('Desde la reserva R-2026-014 · Retiro Primavera', { timeout: 20_000 });
    await expect(sheet.locator('#draftRecipientName')).toHaveValue('Asociación Yoga Norte');
    await expect(sheet.locator('#draftPricesIncludeVat')).toBeChecked();
    await expect(sheet.getByLabel('Precio de la línea 1')).toHaveValue('55');
    await expect(sheet.locator('#draftTotals')).toContainText('TOTAL 1.221,00 €');
    await expect(sheet.locator('#draftOperationDate')).toHaveValue('2026-11-08');
    await sheet.locator('#draftRecipientTaxId').fill('G12345678');
    await sheet.locator('#draftAddressLine').fill('Calle del Norte 5');
    await sheet.locator('#draftPostalCode').fill('48001');
    await sheet.locator('#draftCity').fill('Bilbao');
    // Concepto del cobro: la factura de la señal sale rotulada así en el portal del organizador
    await sheet.locator('#draftPurpose').selectOption('senal');
    await sheet.locator('#saveDraft').click();
    await expect(sheet).toBeHidden({ timeout: 20_000 });
    await synced(page);
    const draft = await eventually(() => api.rows('invoices.issued_invoices').find((i) => i.recipient_name === 'Asociación Yoga Norte'));
    expect(draft).toMatchObject({ status: 'borrador', prices_include_vat: true, recipient_kind: 'empresa', income_category: 'alojamiento', operation_date: '2026-11-08', purpose: 'senal' });
    await expect.poll(() => api.rows('invoices.issued_invoice_lines').filter((l) => l.issued_invoice_id === draft.id && !l.deleted_at)
      .sort((x, y) => Number(x.position) - Number(y.position)).map((l) => [l.net_amount, l.vat_amount]), { timeout: 20_000 }).toEqual([[1000, 100], [100, 21]]);
    await expect.poll(() => api.rows('invoices.issued_allocations').filter((al) => al.issued_invoice_id === draft.id), { timeout: 20_000 }).toEqual([
      expect.objectContaining({ target_app: 'booking', target_kind: 'reservation', target_id: RES, allocated_amount: 1100 })]);
    // Pulsar otra vez «Emitir factura» en Booking abre el borrador que ya existe, sin duplicarlo
    await page.goto(`${baseURL}/#/facturas?vista=emitidas&desde=booking:reservation:${RES}`);
    await expect(page.getByText('Esta reserva ya tiene un borrador de factura.')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.sheet[role="dialog"]').locator('#draftBanner')).toBeVisible();
    await expect(page.locator('.sheet[role="dialog"]').locator('#issuedPurpose')).toHaveText('Señal');
    await expect.poll(() => api.rows('invoices.issued_invoices').filter((i) => i.recipient_name === 'Asociación Yoga Norte'), { timeout: 20_000 }).toHaveLength(1);
  } finally {
    api.targets.splice(api.targets.findIndex((t) => t.id === RES), 1);
    api.setReservationSource(RES, null);
    api.setEntity(null);
    await context.close();
  }
});

test('IA sin API de pago (fase 1): compartir documento y contrato, volver por share_target, sobre que no coincide y escritorio sin Web Share', async ({ browser }) => {
  test.setTimeout(180_000);
  const pdfSha = createHash('sha256').update(PDF).digest('hex');
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // Web Share simulado: guarda lo que se comparte para comprobarlo.
  await context.addInitScript(() => {
    const w = window as unknown as { __shared?: unknown };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: { files?: File[] }) => Array.isArray(data.files) });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: { files?: File[]; text?: string }) => {
      const files = await Promise.all((data.files ?? []).map(async (f) => ({ name: f.name, type: f.type, text: f.type === 'text/plain' ? await f.text() : null, size: f.size })));
      w.__shared = { files, text: data.text ?? null };
    } });
  });
  const page = await context.newPage();
  await login(page);
  await synced(page);
  let code = '';

  await test.step('compartir: documento ya subido + ikisai_invoice_contract.txt con el sobre del documento', async () => {
    await nav(page, 'Facturas').click();
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await sheet.locator('#newSupplier').selectOption({ label: '+ Nuevo proveedor…' });
    await sheet.locator('#newSupplierName').fill('Proveedor IA SL');
    await sheet.getByLabel('Fecha').fill('2026-10-06');
    await sheet.getByLabel('Objeto').fill('compra ia');
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'factura ia.pdf', mimeType: 'application/pdf', buffer: PDF });
    await sheet.locator('#saveInvoice').click();
    const f = ficha(page);
    await expect(f.locator('#chatgptInvoice')).toBeVisible({ timeout: 20_000 });
    await synced(page);
    code = String(api.rows('invoices.invoices').find((i) => i.object === 'compra ia')!.code);
    await f.locator('#chatgptInvoice [data-step="share"]').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Compartir' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared?: { files: Array<{ name: string }> } }).__shared?.files.map((x) => x.name) ?? null), { timeout: 15_000 })
      .toEqual(['2026_10_06_(proveedor_ia_sl)_compra_ia.pdf', 'ikisai_invoice_contract.txt']);
    const contract = await page.evaluate(() => (window as unknown as { __shared: { files: Array<{ text: string | null }> } }).__shared.files[1]!.text);
    expect(contract).toContain(`"sha256": "${pdfSha}"`);
    expect(contract).toContain('Responde SOLO con el JSON');
  });

  await test.step('volver por share_target: el service worker recibe el texto y abre la importación de esa factura', async () => {
    await closeSheet(page);
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active), null, { timeout: 15_000 });
    if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true);
    const result = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, supplier_name: 'Proveedor IA SL', supplier_tax_id: null, invoice_number: 'IA-1', object: 'compra ia', invoice_date: '2026-10-06' },
      source: { filename: '2026_10_06_(proveedor_ia_sl)_compra_ia.pdf', sha256: pdfSha } };
    const reply = `Aquí tienes los datos:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\nAvísame si falta algo.`;
    // Lo que haría el sistema al elegir Ikisai Finance en «Compartir»: un POST multipart a /share-target.
    await page.evaluate((text) => {
      const form = document.createElement('form');
      form.method = 'POST'; form.action = '/share-target'; form.enctype = 'multipart/form-data';
      const input = document.createElement('textarea'); input.name = 'text'; input.value = text; form.append(input);
      document.body.append(form); form.submit();
    }, reply);
    const sheet = ficha(page);
    await expect(sheet).toContainText(`Importar JSON en ${code}`, { timeout: 20_000 });
    await expect(sheet.locator('#sourceMatch')).toBeVisible();
    await expect(sheet.locator('#importPreview')).toContainText('Dentro de la tolerancia');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('Importada, pendiente de revisar', { timeout: 20_000 });
    await synced(page);
    expect(api.rows('invoices.invoices').find((i) => i.code === code)).toMatchObject({ status: 'pendiente_revision', review_reason: 'IMPORTADA', invoice_number: 'IA-1' });
    await closeSheet(page);
  });

  await test.step('pegar un resultado con el sobre de otro documento: aviso, sin bloquear', async () => {
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    let sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await sheet.locator('#newSupplier').selectOption({ label: 'Proveedor IA SL' });
    await sheet.getByLabel('Objeto').fill('otra compra');
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'otra.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF, Buffer.from('% otra\n')]) });
    await sheet.locator('#saveInvoice').click();
    await expect(ficha(page).locator('#chatgptInvoice')).toBeVisible({ timeout: 20_000 });
    await ficha(page).locator('#chatgptInvoice [data-step="paste"]').click();
    sheet = ficha(page);
    const other = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'IA-2' }, source: { filename: 'factura ia.pdf', sha256: pdfSha } };
    await sheet.getByLabel('JSON', { exact: true }).fill(`Resultado: ${JSON.stringify(other)}`);
    await expect(sheet.locator('#sourceMismatch')).toContainText('no es el documento de esta factura');
    await expect(sheet.locator('#confirmImport')).toBeEnabled();
    await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Descartar' }).click();
  });
  await context.close();

  await test.step('escritorio sin Web Share: se descarga el contrato para adjuntarlo a mano', async () => {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await desktop.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
    const p = await desktop.newPage();
    await login(p);
    await synced(p);
    await nav(p, 'Facturas').click();
    await p.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = p.getByRole('dialog', { name: 'Nueva factura' });
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'escritorio.pdf', mimeType: 'application/pdf', buffer: PDF });
    await sheet.locator('#chatgptNew [data-step="share"]').click();
    const download = p.waitForEvent('download');
    await p.getByRole('alertdialog').getByRole('button', { name: 'Compartir' }).click();
    expect((await download).suggestedFilename()).toBe('ikisai_invoice_contract.txt');
    await desktop.close();
  });
});

test('IA sin API de pago (fase 2): «Leer PDF» con texto, procedencia por campo, duplicado blando y PDF escaneado', async ({ browser }) => {
  test.setTimeout(180_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page);
  await synced(page);
  await nav(page, 'Facturas').click();

  const newInvoice = async (object: string, pdf: Buffer, supplier?: { name: string; taxId: string }) => {
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    if (supplier) {
      await sheet.locator('#newSupplier').selectOption({ label: '+ Nuevo proveedor…' });
      await sheet.locator('#newSupplierName').fill(supplier.name);
      await sheet.locator('#newSupplierTaxId').fill(supplier.taxId);
    } else {
      await sheet.locator('#newSupplier').selectOption({ label: 'Frutas Pepe S.L.' });
    }
    await sheet.getByLabel('Fecha').fill('2026-10-06');
    await sheet.getByLabel('Objeto').fill(object);
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: `${object}.pdf`, mimeType: 'application/pdf', buffer: pdf });
    await sheet.locator('#saveInvoice').click();
    await expect(ficha(page).locator('#chatgptInvoice')).toBeVisible({ timeout: 20_000 });
    await synced(page);
  };

  await test.step('PDF con texto: se lee en el dispositivo y llega a la vista previa con la procedencia de cada dato', async () => {
    await newInvoice('fruta octubre', invoiceTextPdf(), { name: 'Frutas Pepe S.L.', taxId: 'B12345674' });
    await ficha(page).locator('#chatgptInvoice [data-step="read"]').click();
    const sheet = ficha(page);
    await expect(sheet.locator('#extractionNote')).toContainText('Leído del texto del PDF, sin IA', { timeout: 30_000 });
    await expect(sheet.locator('#provenance [data-field="document_totals.total"]')).toContainText('Total · 85 %');
    await expect(sheet.locator('#provenance [data-field="invoice.supplier_tax_id"]')).toContainText('CIF: B12345674');
    await expect(sheet.locator('#importPreview')).toContainText('coincide por NIF');
    await expect(sheet.locator('#importPreview')).toContainText('Dentro de la tolerancia');
    await expect(sheet.locator('#importObject')).toHaveValue('fruta octubre');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('Importada, pendiente de revisar', { timeout: 20_000 });
    await synced(page);
    const inv = api.rows('invoices.invoices').find((i) => i.object === 'fruta octubre')!;
    expect(inv).toMatchObject({ invoice_number: 'A-2026/0457', calculated_total: 159, totals_delta: 0 });
    expect(api.rows('invoices.tax_lines').filter((t) => t.invoice_id === inv.id).map((t) => `${t.tax_type}:${t.rate}:${t.amount}`).sort()).toEqual(['irpf:15:6', 'iva:10:4', 'iva:21:21']);
    await closeSheet(page);
  });

  await test.step('mismo proveedor, fecha y total con otro número: aviso de posible duplicado, sin bloquear', async () => {
    await newInvoice('fruta repetida', invoiceTextPdf('A-2026/0999'));
    await ficha(page).locator('#chatgptInvoice [data-step="read"]').click();
    const sheet = ficha(page);
    await expect(sheet.locator('#softDuplicate')).toContainText('Posible duplicado', { timeout: 30_000 });
    await expect(sheet.locator('#confirmImport')).toBeEnabled();
    await sheet.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click();
  });

  await test.step('PDF escaneado (sin texto): se dice y se remite a «Analizar con IA»', async () => {
    await newInvoice('escaneada', textPdf([]));
    await ficha(page).locator('#chatgptInvoice [data-step="read"]').click();
    await expect(page.locator('.toast, [role="status"]').filter({ hasText: 'no tiene texto' }).first()).toBeVisible({ timeout: 30_000 });
    await expect(ficha(page).locator('#chatgptInvoice')).toBeVisible();
  });
  await context.close();
});

test('IA sin API de pago (fase 3): la plantilla se aprende al validar, lee lo que el genérico no ve y se puede retirar', async ({ browser }) => {
  test.setTimeout(240_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page);
  await synced(page);
  await nav(page, 'Facturas').click();
  // Formato del proveedor: el número va tras «Doc. ref.», que las reglas genéricas no reconocen.
  const pepePdf = (n: string, date: string, base: string, quota: string, total: string) => textPdf([
    ['HUERTA PEPA S.L.', 40, 800], ['CIF: B87654323', 40, 786], ['Albarán y factura de mercancía', 40, 772], [`Doc. ref.: ${n}`, 40, 758], ['Emitido el', 40, 744], [date, 300, 744],
    ['Fruta y verdura variada', 40, 716], [base, 300, 716], ['Base imponible', 40, 702], [base, 300, 702], ['IVA 10%', 40, 688], [quota, 300, 688], ['Importe total', 40, 674], [total, 300, 674],
  ]);
  const newInvoice = async (object: string, pdf: Buffer, first: boolean, date = '2026-10-06') => {
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    if (first) {
      await sheet.locator('#newSupplier').selectOption({ label: '+ Nuevo proveedor…' });
      await sheet.locator('#newSupplierName').fill('Huerta Pepa S.L.');
      await sheet.locator('#newSupplierTaxId').fill('B87654323');
    } else {
      await sheet.locator('#newSupplier').selectOption({ label: 'Huerta Pepa S.L.' });
    }
    await sheet.getByLabel('Fecha').fill(date);
    await sheet.getByLabel('Objeto').fill(object);
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: `${object}.pdf`, mimeType: 'application/pdf', buffer: pdf });
    await sheet.locator('#saveInvoice').click();
    await expect(ficha(page).locator('#chatgptInvoice')).toBeVisible({ timeout: 20_000 });
    await synced(page);
  };

  await test.step('primera factura: se importa y al validar se aprende la plantilla (aprendiendo)', async () => {
    await newInvoice('fruta uno', pepePdf('X-77', '06/10/2026', '100,00', '10,00', '110,00'), true);
    await ficha(page).locator('#chatgptInvoice [data-step="paste"]').click();
    const sheet = ficha(page);
    const doc = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_date: '2026-10-06', supplier_name: 'Huerta Pepa S.L.', supplier_tax_id: 'B87654323', invoice_number: 'X-77', object: 'fruta uno' },
      lines: [{ ...EXAMPLE.lines[0], description: 'Fruta y verdura variada', quantity: null, unit: null, unit_price: null, net_amount: 100, vat_rate: 10, vat_amount: 10, gross_amount: 110 }],
      taxes: [{ tax_type: 'iva', rate: 10, taxable_base: 100, amount: 10, notes: null }], document_totals: { base: 100, vat: 10, withholding: 0, total: 110 } };
    await sheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(doc));
    await sheet.locator('#importCategory').selectOption('compras');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('Importada, pendiente de revisar', { timeout: 20_000 });
    await synced(page);
    await ficha(page).locator('#validateInvoice').click();
    await expect(ficha(page)).toContainText('Validada', { timeout: 30_000 });
    await synced(page);
    await expect.poll(() => api.rows('invoices.supplier_templates').length, { timeout: 20_000 }).toBe(1);
    const t = api.rows('invoices.supplier_templates')[0]!;
    expect(t).toMatchObject({ version: 1, status: 'aprendiendo', confirmations: 1 });
    expect((t.fields as Record<string, { anchor: { text: string } }>).invoice_number!.anchor.text).toBe('doc. ref.');
    await closeSheet(page);
  });

  await test.step('segunda factura: «Leer PDF» lee el número con la plantilla; al validar pasa a activa', async () => {
    // Fecha escrita a mano al subir (1) distinta de la del documento (7): se conserva, se avisa y se puede cambiar con un toque.
    await newInvoice('fruta dos', pepePdf('X-78', '07/10/2026', '50,00', '5,00', '55,00'), false, '2026-10-01');
    await ficha(page).locator('#chatgptInvoice [data-step="read"]').click();
    const sheet = ficha(page);
    await expect(sheet.locator('#extractionNote')).toContainText('Plantilla del proveedor v1', { timeout: 30_000 });
    await expect(sheet.locator('#provenance [data-field="invoice.invoice_number"]')).toContainText('plantilla del proveedor');
    await expect(sheet.locator('#provenance [data-field="invoice.invoice_number"]')).toContainText('X-78');
    await expect(sheet.locator('#dateDiscrepancy')).toContainText('El documento dice la fecha');
    await expect(sheet.locator('#importDate')).toHaveValue('2026-10-01');
    await sheet.locator('#useDocumentDate').click();
    await expect(sheet.locator('#importDate')).toHaveValue('2026-10-07');
    await expect(sheet.locator('#useDocumentDate')).toContainText('Usar la mía');
    await sheet.locator('#importCategory').selectOption('compras');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page)).toContainText('Importada, pendiente de revisar', { timeout: 20_000 });
    await synced(page);
    expect(api.rows('invoices.invoices').find((i) => i.object === 'fruta dos')).toMatchObject({ invoice_number: 'X-78', calculated_total: 55 });
    await ficha(page).locator('#validateInvoice').click();
    await expect(ficha(page)).toContainText('Validada', { timeout: 30_000 });
    await synced(page);
    await expect.poll(() => api.rows('invoices.supplier_templates')[0]?.status, { timeout: 20_000 }).toBe('activa');
    expect(api.rows('invoices.supplier_templates')[0]).toMatchObject({ confirmations: 2, full_hits: 1 });
    await closeSheet(page);
  });

  await test.step('ficha del proveedor: la plantilla se ve y el owner la retira', async () => {
    await nav(page, 'Inicio').click();
    await page.getByRole('link', { name: /Proveedores/ }).click();
    await page.getByRole('button', { name: 'Editar Huerta Pepa S.L.' }).click();
    const sheet = page.locator('.sheet[role="dialog"]');
    await expect(sheet.locator('#supplierTemplates')).toContainText('v1 · Activa');
    await expect(sheet.locator('#supplierTemplates')).toContainText('2 facturas confirmadas');
    await sheet.getByRole('button', { name: 'Retirar plantilla v1' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Retirar' }).click();
    await synced(page);
    await expect.poll(() => api.rows('invoices.supplier_templates')[0]?.status, { timeout: 20_000 }).toBe('retirada');
  });
  await context.close();
});

// ---------------------------------------------------------------------------
// «Sugerencias y QA» y uso (kit 0.18, ronda 46): recorrido de feedback en PC y forma de los ids en todas las pantallas.
// ---------------------------------------------------------------------------
const FB_PATTERN = /^invoices(\.[a-z0-9_]+){1,4}$/;

/** Pulsación larga con el ratón sobre el centro del elemento (el gesto del kit son 600 ms). */
async function hold(page: Page, selector: string, ms = 900): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Sin caja para ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** El aviso «Enviado · FB_…» con los estilos del kit: fijo, abajo y del tamaño de una línea (kit 0.24, fallo en PC). */
async function expectCompactToast(page: Page): Promise<void> {
  const toast = page.locator('.toast.show').filter({ hasText: 'Enviado' });
  await expect(toast).toBeVisible();
  const box = (await toast.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(520);
  expect(box.height).toBeLessThan(80);
  expect(await toast.evaluate((n) => getComputedStyle(n).position)).toBe('fixed');
}

/** Abre el panel de la marca y cambia «Señalar para comentar». */
async function setSignal(page: Page, on: boolean): Promise<void> {
  await page.locator('#appLauncher').click();
  const dialog = page.getByRole('dialog');
  const toggle = dialog.getByRole('switch', { name: /Señalar para comentar/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await toggle.setChecked(on);
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

test('feedback en Finance: interruptor del lanzador, pulsación larga, zona excluida, envío y «Sugerencias y QA»', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await login(page);
    await synced(page);
    const target = '[data-feedback-id="invoices.inicio.trimestre.ir_gestoria"]';
    await expect(page.locator(target)).toBeVisible();

    await test.step('apagado por defecto: la pulsación larga no cambia nada y el clic sigue funcionando', async () => {
      await page.locator('#appLauncher').click();
      await expect(page.getByRole('dialog').getByRole('switch', { name: /Señalar para comentar/ })).not.toBeChecked();
      await expect(page.getByRole('dialog').locator('.launcher-center')).toContainText('Sugerencias y QA');
      await page.keyboard.press('Escape');
      await hold(page, '[data-feedback-id="invoices.inicio.trimestre"] h3');
      await expect(page.locator('.fb-composer')).toHaveCount(0);
      await expect(page.locator('html.fb-mode')).toHaveCount(0);
    });

    await test.step('encendido: sobre los importes (zona excluida) no se abre nada', async () => {
      await setSignal(page, true);
      await expect(page.locator('html.fb-mode')).toHaveCount(1);
      await hold(page, '[data-feedback-id="invoices.inicio.trimestre"] dl[data-feedback-ignore]');
      await expect(page.locator('.fb-composer')).toHaveCount(0);
    });

    await test.step('sobre «Ir a Gestoría» se abre el formulario con la ruta de etiquetas y el clic no navega', async () => {
      await hold(page, target);
      const composer = page.locator('.fb-composer');
      await expect(composer).toBeVisible();
      await expect(composer.locator('.fb-where strong')).toHaveText('Inicio › Trimestre › Ir a Gestoría');
      expect(page.url()).not.toContain('#/gestoria');
      await composer.getByRole('textbox', { name: 'Comentario' }).fill('El resumen del trimestre debería enlazar al detalle del IVA.');
      await composer.getByRole('button', { name: 'Enviar' }).click();
      await expect.poll(() => api.feedbackReports().length).toBe(1);
      const report = api.feedbackReports()[0]!;
      expect(report.originApp).toBe('invoices');
      expect(report.node?.id).toBe('invoices.inicio.trimestre.ir_gestoria');
      expect(report.node?.path).toEqual(['Inicio', 'Trimestre', 'Ir a Gestoría']);
      await expect(page.locator('.fb-composer')).toHaveCount(0, { timeout: 5_000 });
      await expectCompactToast(page);
    });

    await test.step('desde una hoja abierta (kit 0.24): hoja con los estilos del kit, reporte enviado y aviso compacto', async () => {
      await page.goto(`${baseURL}/#/facturas?vista=emitidas`);
      await page.locator('#newIssued').click();
      const sheet = page.getByRole('dialog', { name: 'Nueva emitida' });
      await expect(sheet).toBeVisible();
      const box = (await sheet.boundingBox())!;
      expect(box.width).toBeLessThan(1280);
      expect(await sheet.evaluate((n) => getComputedStyle(n.closest('.sheetback') ?? n).position)).toBe('fixed');
      // Los campos editables no se señalan (FEEDBACK.md §2.3): la etiqueta «Serie» resuelve al formulario
      await hold(page, '.sheet [data-feedback-id="invoices.emitidas.registrar.formulario"] label.field > span');
      const composer = page.locator('.fb-composer');
      await expect(composer).toBeVisible();
      await composer.getByRole('textbox', { name: 'Comentario' }).fill('La serie nueva debería proponer el formato de la hoja.');
      await composer.getByRole('button', { name: 'Enviar' }).click();
      await expect.poll(() => api.feedbackReports().length).toBe(2);
      expect(api.feedbackReports()[1]!.node?.id).toBe('invoices.emitidas.registrar.formulario');
      await expectCompactToast(page);
      await sheet.getByRole('button', { name: 'Cancelar' }).click();
      await expect(sheet).toBeHidden();
      await page.goto(`${baseURL}/#/`);
    });

    await test.step('«Sugerencias y QA» desde el panel de la marca lista el reporte', async () => {
      await page.locator('#appLauncher').click();
      await page.getByRole('dialog').locator('.launcher-center').click();
      const sheet = page.getByRole('dialog', { name: 'Sugerencias y QA' });
      await expect(sheet).toBeVisible();
      await sheet.getByRole('tab', { name: 'Abiertos' }).click();
      await expect(sheet.locator('.fb-card')).toHaveCount(2);
      await expect(sheet.locator('.fb-card').filter({ hasText: 'FB-0001' })).toContainText('Inicio › Trimestre › Ir a Gestoría');
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    });

    await test.step('apagar el modo devuelve la app a su estado normal', async () => {
      await setSignal(page, false);
      await expect(page.locator('html.fb-mode')).toHaveCount(0);
      await page.locator(target).click();
      await expect(page).toHaveURL(/#\/gestoria/);
    });
  } finally {
    await context.close();
  }
});

test('feedback en Finance en móvil: tras enviar se cierra el formulario y se ve el aviso, también con la red lenta', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const before = api.feedbackReports().length;
  try {
    await login(page);
    await synced(page);
    await setSignal(page, true);
    const send = async (selector: string, message: string) => {
      await page.locator(selector).first().scrollIntoViewIfNeeded();
      await hold(page, selector);
      const composer = page.locator('.fb-composer');
      await expect(composer).toBeVisible();
      await composer.getByRole('textbox', { name: 'Comentario' }).fill(message);
      await composer.getByRole('button', { name: 'Enviar' }).click();
      await expect(composer).toHaveCount(0, { timeout: 10_000 });
      const toast = page.locator('.toast.show').filter({ hasText: 'Enviado' });
      await expect(toast).toBeVisible();
      const box = (await toast.boundingBox())!;
      expect(box.height).toBeLessThan(80);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    };

    await test.step('en Inicio', async () => {
      await send('[data-feedback-id="invoices.inicio.trimestre.ir_gestoria"]', 'En móvil, el resumen debería caber sin desplazar.');
      await expect.poll(() => api.feedbackReports().length).toBe(before + 1);
    });

    await test.step('con la respuesta del servidor tardando 3 s: el formulario espera y luego se cierra con el aviso', async () => {
      await page.route('**/api/v1/feedback', async (route) => {
        if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 3_000));
        await route.continue();
      });
      await send('[data-feedback-id="invoices.inicio.trimestre"] h3', 'Con red lenta también debe cerrarse.');
      await expect.poll(() => api.feedbackReports().length).toBe(before + 2);
      await page.unroute('**/api/v1/feedback');
    });
    await setSignal(page, false);
  } finally {
    await context.close();
  }
});

test('QA FB_2026_016: nueva factura sin fecha (opcional, sin rellenar con hoy); en la ficha se pone después', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page);
    await synced(page);
    await page.goto(`${baseURL}/#/facturas`);
    await page.locator('#newInvoice').click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await expect(sheet.locator('#newDate')).toHaveValue('');
    await sheet.locator('#newSupplier').selectOption({ label: 'Proveedor Ejemplo S.L.' });
    await sheet.getByLabel('Objeto').fill('papeleria sin fecha');
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(sheet.locator('#namePreview')).toHaveText('sin_fecha_(proveedor_ejemplo_s_l)_papeleria_sin_fecha.pdf');
    await page.locator('#saveInvoice').click();
    await expect(sheet).toBeHidden();
    const f = ficha(page);
    await expect(f).toContainText('Sin fecha: léela del PDF o escríbela para poder validar');
    await synced(page);
    const created = await eventually(() => api.rows('invoices.invoices').find((i) => i.object === 'papeleria sin fecha'));
    expect(created.invoice_date).toBeNull();
    // La fecha se escribe después en «Fiscal y pago»
    const date = f.locator('#invDate');
    if (!(await date.isVisible())) await f.getByText('Fiscal y pago', { exact: true }).first().click();
    await expect(date).toHaveValue('');
    await date.fill('2026-10-06');
    await date.dispatchEvent('change');
    await expect.poll(() => api.rows('invoices.invoices').find((i) => i.id === created.id)?.invoice_date, { timeout: 20_000 }).toBe('2026-10-06');
  } finally {
    await context.close();
  }
});

test('Rectificativa recibida (0227): el abono se reconoce al importar, se importa en negativo y la ficha dice qué rectifica', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page);
    await synced(page);
    await page.goto(`${baseURL}/#/facturas`);
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    await page.locator('#importNew').click();
    const sheet = ficha(page);
    // Abono impreso en positivo, con la referencia a la original en las notas
    const abono = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'AB-0001' }, extraction_notes: 'Factura rectificativa (abono). Rectifica a la factura nº F-2026-123.' };
    await sheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(abono));
    await expect(sheet.locator('#importKind')).toHaveValue('rectificativa');
    await expect(sheet.locator('#importRectNumber')).toHaveValue('F-2026-123');
    await sheet.locator('#confirmImport').click();
    await expect(ficha(page).locator('#rectChip')).toHaveText('Rectificativa', { timeout: 20_000 });
    await expect(ficha(page).locator('#rectifiesOriginal')).toContainText('F-2026-123');
    await synced(page);
    const row = await eventually(() => api.rows('invoices.invoices').find((i) => i.invoice_number === 'AB-0001'));
    expect(row).toMatchObject({ invoice_kind: 'rectificativa', rectifies_number: 'F-2026-123' });
    expect(Number(row.calculated_total)).toBeLessThan(0);
    // En la lista, con su etiqueta y en el filtro «Rectificativas sin enlazar» (la API simulada no enlaza)
    await closeSheet(page);
    await page.locator('#invoiceFilter').selectOption('rect_sin_enlazar');
    await expect(page.locator('#invoiceList')).toContainText('Rectificativa sin enlazar');
  } finally {
    await context.close();
  }
});

test('Subir varias (auditoría del 3T): cada archivo es una factura; los PDF con texto se leen solos, los duplicados no se suben y las fotos quedan sin leer', async ({ browser }) => {
  test.setTimeout(180_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  // PNG de 1×1 válido (la app la recomprime a WebP)
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  try {
    await login(page);
    await synced(page);
    await page.goto(`${baseURL}/#/facturas`);
    const before = api.rows('invoices.invoices').length;
    await page.locator('#batchUpload').click();
    const sheet = page.getByRole('dialog', { name: 'Subir varias facturas' });
    await expect(sheet).toBeVisible();
    const leida = invoiceTextPdf('LOTE-0001');
    await sheet.locator('#batchFiles').setInputFiles([
      { name: 'lote leida.pdf', mimeType: 'application/pdf', buffer: leida },
      { name: 'lote repetida.pdf', mimeType: 'application/pdf', buffer: leida },
      { name: 'lote escaneada.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([textPdf([]), Buffer.from('% lote escaneada ' + 'x')]) },
      { name: 'lote foto.png', mimeType: 'image/png', buffer: PNG },
    ]);
    await sheet.locator('#batchStart').click();
    await expect(sheet.locator('#batchSummary')).toContainText('1 leída, 2 sin leer, 1 duplicada', { timeout: 60_000 });
    await expect(sheet.locator('#batchList')).toContainText('Duplicada');
    await synced(page);
    await expect.poll(() => api.rows('invoices.invoices').length, { timeout: 20_000 }).toBe(before + 3);
    const read = await eventually(() => api.rows('invoices.invoices').find((i) => i.invoice_number === 'LOTE-0001'));
    expect(read.status).toBe('pendiente_revision');
    const unread = api.rows('invoices.invoices').filter((i) => i.object === 'lote escaneada' || i.object === 'lote foto');
    expect(unread.map((i) => i.status).sort()).toEqual(['pendiente_datos', 'pendiente_datos']);
  } finally {
    await context.close();
  }
});

test('Periodo de declaración (0228): una factura de un trimestre anterior pregunta si se declara en el trimestre en curso', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const old = `${new Date().getFullYear() - 2}-05-10`; // siempre de un trimestre anterior al de trabajo
  try {
    await login(page);
    await synced(page);
    await page.goto(`${baseURL}/#/facturas`);
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await sheet.locator('#newSupplier').selectOption({ label: 'Proveedor Ejemplo S.L.' });
    await sheet.locator('#newDate').fill(old);
    await sheet.getByLabel('Objeto').fill('factura atrasada');
    await page.locator('#saveInvoice').click();
    const f = ficha(page);
    await expect(f.locator('#lateBanner')).toContainText(`Es del 2T ${old.slice(0, 4)}`, { timeout: 20_000 });
    await f.locator('#declareNow').click();
    await expect(f.locator('#declaredPeriod')).toContainText('atrasada', { timeout: 20_000 });
    await expect(f.locator('#lateBanner')).toHaveCount(0);
    await synced(page);
    const row = await eventually(() => api.rows('invoices.invoices').find((i) => i.object === 'factura atrasada'));
    expect(row.declared_period).toMatch(/^\d{4}T[1-4]$/);
    expect(row.invoice_date).toBe(old);
  } finally {
    await context.close();
  }
});

test('Compartir facturas con Finance desde otra app (PDF): el service worker las recibe y la app las sube como «Subir varias»', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page);
    await synced(page);
    // El service worker tiene que controlar la página (como la PWA instalada)
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 30_000 }).toBe(true);
    const pdf = [...invoiceTextPdf('COMP-0001')];
    const status = await page.evaluate(async (bytes) => {
      const form = new FormData();
      form.append('files', new File([new Uint8Array(bytes)], 'Factura compartida.pdf', { type: 'application/pdf' }));
      const response = await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
      return response.type;
    }, pdf);
    expect(status).toBe('opaqueredirect');
    await page.goto(`${baseURL}/#/facturas?compartido=docs`);
    const sheet = page.getByRole('dialog', { name: 'Subir varias facturas' });
    await expect(sheet.locator('#batchSummary')).toContainText('1 leída', { timeout: 60_000 });
    await synced(page);
    const row = await eventually(() => api.rows('invoices.invoices').find((i) => i.invoice_number === 'COMP-0001'));
    expect(row.status).toBe('pendiente_revision');
  } finally {
    await context.close();
  }
});

test('«Rellenar a mano» (9-10-2026): proveedor nuevo por NIF, base al 21 %, cuota calculada, total y cuadre en vivo', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page);
    await synced(page);
    await page.goto(`${baseURL}/#/facturas`);
    await page.getByRole('button', { name: 'Nueva factura' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nueva factura' });
    await sheet.locator('#newSupplier').selectOption({ label: 'Proveedor Ejemplo S.L.' });
    await sheet.getByLabel('Objeto').fill('para rellenar a mano');
    await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'escaneada.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([textPdf([]), Buffer.from('% a mano')]) });
    await page.locator('#saveInvoice').click();
    const f = ficha(page);
    await expect(f.locator('#fillManually')).toBeVisible({ timeout: 20_000 });
    await expect(f.locator('#readWithAi')).toHaveClass(/primary/);
    await f.locator('#fillManually').click();
    const manual = page.getByRole('dialog', { name: 'Rellenar a mano' });
    await manual.locator('#manualTaxId').fill('A12345674');
    await expect(manual.locator('#manualSupplierNote')).toContainText('Proveedor nuevo');
    await manual.locator('#manualName').fill('Suministros A Mano SA');
    await manual.locator('#manualNumber').fill('MAN-001');
    await manual.locator('#manualDate').fill('2026-09-15');
    await manual.getByLabel('Base imponible 1').fill('100');
    await manual.locator('#manualTotal').fill('121');
    await expect(manual.locator('#manualCuadre')).toContainText('cuadra con el total');
    await manual.locator('#manualCategory').selectOption('compras');
    await manual.locator('#manualSave').click();
    await expect(manual).toBeHidden({ timeout: 20_000 });
    await synced(page);
    const row = await eventually(() => api.rows('invoices.invoices').find((i) => i.invoice_number === 'MAN-001'));
    expect(row).toMatchObject({ invoice_date: '2026-09-15', source_total: 121, expense_category: 'compras' });
    expect(api.rows('invoices.suppliers').find((s) => s.id === row.supplier_id)).toMatchObject({ name: 'Suministros A Mano SA', tax_id: 'A12345674' });
    await expect.poll(() => api.rows('invoices.tax_lines').filter((t) => t.invoice_id === row.id && !t.deleted_at).map((t) => [t.rate, t.taxable_base, t.amount]), { timeout: 20_000 }).toEqual([[21, 100, 21]]);
  } finally {
    await context.close();
  }
});

/** Caso real (FB_2026_016 y 017): Android, 484 px de ancho, hoja «Nueva factura» abierta y el teclado bajando la altura a 686. */
async function composeInNewInvoiceWithKeyboard(page: Page): Promise<void> {
  await login(page);
  await synced(page);
  await page.goto(`${baseURL}/#/facturas`);
  await setSignal(page, true);
  await page.locator('#newInvoice').click();
  await expect(page.getByRole('dialog', { name: 'Nueva factura' })).toBeVisible();
  await hold(page, '#newInvoiceForm label.field > span');
  const composer = page.locator('.fb-composer');
  await expect(composer).toBeVisible();
  await composer.getByRole('textbox', { name: 'Comentario' }).fill('El proveedor debería sugerirse por el NIF.');
  await page.setViewportSize({ width: 484, height: 686 });
}

test('feedback con la hoja «Nueva factura» y el teclado abiertos (móvil 484×1008 → 686): se cierra el formulario y se ve el aviso', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const before = api.feedbackReports().length;
  try {
    await composeInNewInvoiceWithKeyboard(page);
    await page.locator('.fb-composer').getByRole('button', { name: 'Enviar' }).click();
    await expect(page.locator('.fb-composer')).toHaveCount(0, { timeout: 10_000 });
    const toast = page.locator('.toast.show').filter({ hasText: 'Enviado' });
    await expect(toast).toBeVisible();
    const box = (await toast.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(686);
    expect(box.height).toBeLessThan(80);
    await expect.poll(() => api.feedbackReports().length).toBe(before + 1);
    expect(api.feedbackReports().at(-1)!.node?.id).toBe('invoices.facturas.nueva.formulario');
  } finally {
    await context.close();
  }
});

// Fallo del kit corregido en ui-kit 0.25.1 (FB_2026_016/017): «Enviar» queda desactivado desde el primer toque hasta que
// se cierra el formulario y el `requestId` es el mismo en cada intento, así que una segunda pulsación no crea un duplicado.
test('feedback: dos pulsaciones seguidas en «Enviar» crean un solo reporte', async ({ browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 484, height: 1008 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/feedback')) posts.push(String(JSON.parse(r.postData() ?? '{}').requestId)); });
  try {
    await composeInNewInvoiceWithKeyboard(page);
    const send = page.locator('.fb-composer').getByRole('button', { name: 'Enviar' });
    await send.click();
    await page.waitForTimeout(250);
    await send.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    expect(new Set(posts).size).toBe(1);
  } finally {
    await context.close();
  }
});

test('@smoke todas las pantallas de Finance llevan ids con la forma estable, con etiqueta y sin ids de negocio', async ({ browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await login(page);
    await synced(page);
    const screens: Array<[string, string]> = [
      ['#/', 'invoices.inicio'], ['#/facturas', 'invoices.facturas'], ['#/facturas?vista=emitidas', 'invoices.facturas'], ['#/compras', 'invoices.compras'],
      ['#/gestoria', 'invoices.gestoria'], ['#/proveedores', 'invoices.proveedores'], ['#/conflictos', 'invoices.conflictos'],
    ];
    for (const [hash, root] of screens) {
      await page.goto(`${baseURL}/${hash}`);
      await expect(page.locator(`main[data-feedback-id="${root}"]`)).toBeVisible();
      if (hash.includes('emitidas')) await expect(page.locator('[data-feedback-id="invoices.emitidas.lista"]')).toBeVisible();
      const ids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-feedback-id]')).map((n) => n.getAttribute('data-feedback-id') ?? ''));
      expect(ids.length, hash).toBeGreaterThan(8);
      for (const id of ids) {
        expect(id, `${hash} ${id}`).toMatch(FB_PATTERN);
        expect(id, id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      }
      const unlabeled = await page.evaluate(() => Array.from(document.querySelectorAll('[data-feedback-id]:not([data-feedback-label])')).map((n) => n.getAttribute('data-feedback-id')));
      expect(unlabeled, hash).toEqual([]);
    }
  } finally {
    await context.close();
  }
});
