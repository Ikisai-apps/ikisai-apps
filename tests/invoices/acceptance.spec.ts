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
const PROJECT = '11111111-1111-4111-8111-111111111111';
const INGREDIENT = '22222222-2222-4222-8222-222222222222';
const PDF = Buffer.from('%PDF-1.4\n% factura sintética de prueba\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
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

async function login(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

async function synced(page: Page): Promise<void> {
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado', { timeout: 20_000 });
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
    // El documento se lee con URL firmada, nunca pública
    const [popup] = await Promise.all([page.waitForEvent('popup'), f.getByRole('button', { name: 'Ver' }).click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toContain('/api/v1/_file/');
    await popup.close();
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
    await expect(ficha(page).locator('.inv-table').first()).toContainText('Tomate');
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
    await page.getByRole('tab', { name: 'Por destino' }).click();
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
    await expect(f).toContainText('código pendiente');
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
