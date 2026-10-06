/**
 * Aceptación de Invoices (docs/invoices/API.md §11, recorrido 31A del handoff) y escenarios offline O1–O6
 * contra la app compilada y la API falsa en memoria (misma superficie que invoices-api: subidas, import_v1, destinos).
 *
 *   npx playwright test tests/invoices/acceptance.spec.ts
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, type FakeApi } from './fake-api.ts';

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
    preview: { port: 4600 + Math.floor(Math.random() * 300), strictPort: false, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
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
    await sheet.getByLabel('Proveedor').selectOption({ label: 'Proveedor Ejemplo S.L.' });
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
