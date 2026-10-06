/**
 * Aceptación de Invoices (docs/invoices/API.md §11, recorrido 31A del handoff) y escenarios offline O1–O6
 * contra la app compilada y la API falsa en memoria (misma superficie que invoices-api: subidas, import_v1, destinos).
 *
 *   npx playwright test tests/invoices/acceptance.spec.ts
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, type FakeApi } from './fake-api.ts';
import { freePort } from './free-port.ts';

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
  await build({ configFile, logLevel: 'silent' });
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
function nav(page: Page, name: string) {
  return page.locator('.nav').getByRole('link', { name: new RegExp(name) });
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
    const positions = api.rows('invoices.invoice_lines').filter((l) => l.invoice_id === invoiceId && !l.deleted_at).sort((a, b) => Number(a.position) - Number(b.position)).map((l) => `${l.position}:${l.description}`);
    expect(positions).toEqual(['0:Arroz', '1:Tomate pera']);
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
    const row = api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0001')!;
    expect(row).toMatchObject({ series_code: 'A', invoice_type: 'F1', origin: 'manual', status: 'registrada', total: 170.5, base_total: 150, quota_total: 20.5, review_reason: null });
    expect(api.rows('invoices.issued_series').map((s) => s.code)).toEqual(['A']);
    expect(api.rows('invoices.issued_tax_lines').filter((t) => t.issued_invoice_id === row.id).map((t) => `${t.rate}:${t.taxable_base}:${t.quota}`).sort()).toEqual(['10:100:10', '21:50:10.5']);
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
      expect(api.rows('invoices.issued_allocations')).toEqual([expect.objectContaining({ target_app: 'booking', target_kind: 'reservation', target_id: reservation.id, allocated_amount: 150 })]);
    } finally {
      api.targets.splice(api.targets.findIndex((t) => t.id === reservation.id), 1);
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await nav(page, 'Gestoría').click();
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
    expect(api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0001')).toMatchObject({ status: 'anulada', payment_status: 'cobrada' });
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
    const fromPdf = api.rows('invoices.issued_invoices').find((i) => i.number === 'C-2026-0001')!;
    expect(fromPdf).toMatchObject({ origin: 'importada', external_tool: 'chatgpt_pdf', income_category: 'consultoria', total: 242 });
    expect(api.rows('invoices.issued_invoice_files').filter((f) => f.issued_invoice_id === fromPdf.id).map((f) => f.original_filename)).toEqual(['emitida.pdf']);
    expect(api.rows('invoices.issued_series').map((x) => x.code).sort()).toEqual(['A', 'C']);
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
    expect(api.rows('invoices.issued_invoices').find((i) => i.number === '2026-0010')).toMatchObject({ series_code: 'A', origin: 'importada', external_tool: 'google_sheet', income_category: 'restauracion', base_total: 1000, quota_total: 100, total: 1100, payment_status: 'cobrada' });
  });

  await context.close();
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
    // Lo que haría el sistema al elegir Ikisai Invoices en «Compartir»: un POST multipart a /share-target.
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
