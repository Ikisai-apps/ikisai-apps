/**
 * Capturas de pantalla de Invoices a 390×844 y 1440×1000 contra la app compilada y la API falsa (no es una prueba).
 *   npx tsx tests/invoices/shots.ts [carpeta de salida]
 */
import { chromium, type Page } from 'playwright';
import { build, preview } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './fake-api.ts';
import { freePort } from './free-port.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/invoices/vite.config.ts');
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(here, '../core/fixtures/invoice-import-v1.example.json'), 'utf8'));
const out = path.resolve(process.argv[2] ?? path.join(here, '../../../capturas-invoices-2026-10-06'));
fs.mkdirSync(out, { recursive: true });
const PROJECT = '11111111-1111-4111-8111-111111111111';
const INGREDIENT = '22222222-2222-4222-8222-222222222222';
const PDF = Buffer.from('%PDF-1.4\n% factura sintética\n%%EOF\n');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };

function executable(): string | undefined {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe') : null;
  return base && fs.existsSync(base) ? base : undefined;
}

async function main() {
  const api = await startFakeApi({ users: [USER], targets: [
    { app: 'tasks', kind: 'project', id: PROJECT, label: 'Huerto', path: ['Cocina'], revision: 5 },
    { app: 'food', kind: 'ingredient', id: INGREDIENT, label: 'Tomate pera', path: ['Ingredientes'], revision: 2 },
  ] });
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  const server = await preview({ configFile, logLevel: 'silent', preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } } });
  const baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? '';
  const browser = await chromium.launch({ headless: true, executablePath: executable() });

  const synced = (page: Page) => page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent?.includes('Todo sincronizado'), null, { timeout: 20_000 });
  const shoot = async (page: Page, name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false }); console.log('✓', name); };

  // --- móvil -----------------------------------------------------------------
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' });
  const m = await mobile.newPage();
  await m.goto(`${baseURL}/`);
  await shoot(m, 'm00-login');
  await m.getByLabel('Correo electrónico').fill(USER.email);
  await m.getByLabel('Contraseña').fill(USER.password);
  await m.getByRole('button', { name: 'Entrar' }).click();
  await m.getByRole('heading', { name: `Hola, ${USER.displayName}` }).waitFor();
  await synced(m);
  await shoot(m, 'm01-inicio-vacio');

  // proveedor y facturas de muestra
  await m.getByRole('link', { name: /Proveedores/ }).click();
  await m.getByRole('button', { name: 'Nuevo proveedor' }).click();
  await m.getByLabel('Nombre', { exact: true }).fill('Proveedor Ejemplo S.L.');
  await m.getByLabel('NIF').fill('B00000000');
  await m.getByLabel('Categoría por defecto').selectOption('compras');
  await m.getByRole('button', { name: 'Guardar' }).click();
  await m.locator('.nav').getByRole('link', { name: /Facturas/ }).click();
  await m.getByRole('button', { name: 'Nueva factura' }).click();
  await shoot(m, 'm02-nueva-factura');
  await m.getByLabel('Proveedor').selectOption({ label: 'Proveedor Ejemplo S.L.' });
  await m.getByLabel('Fecha').fill('2026-10-05');
  await m.getByLabel('Objeto').fill('alimentos retiro ejemplo');
  await m.getByLabel('PDF o fotos').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: PDF });
  await m.locator('#saveInvoice').click();
  const sheet = m.locator('.sheet[role="dialog"]');
  await sheet.waitFor();
  await sheet.getByText('2026_10_05_(proveedor_ejemplo_s_l)_alimentos_retiro_ejemplo.pdf').waitFor({ timeout: 20_000 });
  await shoot(m, 'm03-ficha-pendiente-datos');
  await sheet.locator('#importInto').click();
  await m.locator('.sheet[role="dialog"]').getByLabel('JSON', { exact: true }).fill(JSON.stringify(EXAMPLE));
  await m.locator('#importPreview').getByText('Dentro de la tolerancia').waitFor();
  await shoot(m, 'm04-importar-cuadre');
  await m.locator('#confirmImport').click();
  await m.locator('.sheet[role="dialog"]').getByText('Importada, pendiente de revisar').waitFor({ timeout: 20_000 });
  await shoot(m, 'm05-ficha-importada');
  await m.locator('.sheet[role="dialog"]').locator('#validateInvoice').click();
  await m.locator('.sheet[role="dialog"]').getByText('Validada', { exact: true }).first().waitFor({ timeout: 20_000 });
  await m.locator('.sheet[role="dialog"]').getByRole('button', { name: 'Asignar a…' }).click();
  await m.locator('.sheet[role="dialog"]').getByRole('button', { name: 'Tareas' }).click();
  await m.locator('.sheet[role="dialog"]').getByRole('button', { name: 'Elegir Huerto' }).waitFor();
  await shoot(m, 'm06-asignar-tareas');
  await m.locator('.sheet[role="dialog"]').getByRole('button', { name: 'Elegir Huerto' }).click();
  await m.locator('#allocAmount').fill('30');
  await m.locator('#saveAllocation').click();
  await m.locator('.sheet[role="dialog"]').getByText('Cocina › Huerto · 30,00 €').waitFor({ timeout: 20_000 });
  await m.waitForTimeout(500);
  await m.evaluate(() => { const block = Array.from(document.querySelectorAll('.sheet details.inv-block')).find((d) => d.querySelector('summary')?.textContent?.includes('Asignación')); block?.scrollIntoView({ block: 'start' }); });
  await shoot(m, 'm07-ficha-asignacion');
  await m.locator('.sheet-foot').getByRole('button', { name: 'Cerrar' }).click();
  // segunda factura con descuadre
  await m.getByRole('button', { name: 'Nueva factura' }).click();
  await m.locator('#importNew').click();
  const doc2 = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_number: 'F-2026-124', object: 'menaje cocina' }, document_totals: { ...EXAMPLE.document_totals, total: 44.5 } };
  await m.locator('.sheet[role="dialog"]').getByLabel('JSON', { exact: true }).fill(JSON.stringify(doc2));
  await m.locator('#importPreview').getByText('REVISAR IMPORTES').waitFor();
  await shoot(m, 'm08-importar-descuadre');
  await m.locator('#confirmImport').click();
  await m.locator('.sheet[role="dialog"]').getByText('REVISAR IMPORTES').first().waitFor({ timeout: 20_000 });
  await shoot(m, 'm09-ficha-revisar-importes');
  await m.locator('.sheet-foot').getByRole('button', { name: 'Cerrar' }).click();
  await synced(m);
  await shoot(m, 'm10-facturas-lista');
  await m.locator('.nav').getByRole('link', { name: /Compras/ }).click();
  await m.locator('#purchaseTotals').getByText('Base').waitFor();
  await shoot(m, 'm11-compras-categoria');
  await m.getByRole('tab', { name: 'Destino' }).click();
  await shoot(m, 'm12-compras-destino');
  await m.getByRole('tab', { name: 'Artículos' }).click();
  await m.locator('#onlyValidated').uncheck();
  await shoot(m, 'm13-compras-articulos');
  await m.locator('.nav').getByRole('link', { name: /Gestoría/ }).click();
  await m.locator('#fiscalSummary').getByText('Facturas validadas').waitFor();
  await shoot(m, 'm14-gestoria');
  await m.locator('.nav').getByRole('link', { name: /Inicio/ }).click();
  await m.locator('#statPendingReview').getByText('1').waitFor();
  await shoot(m, 'm15-inicio-con-datos');
  await mobile.close();

  // --- escritorio ------------------------------------------------------------
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'es-ES' });
  const d = await desktop.newPage();
  await d.goto(`${baseURL}/`);
  await d.getByLabel('Correo electrónico').fill(USER.email);
  await d.getByLabel('Contraseña').fill(USER.password);
  await d.getByRole('button', { name: 'Entrar' }).click();
  await d.getByRole('heading', { name: `Hola, ${USER.displayName}` }).waitFor();
  await synced(d);
  await shoot(d, 'd01-inicio');
  await d.locator('.nav').getByRole('link', { name: /Facturas/ }).click();
  await d.locator('#invoiceList .row').first().waitFor();
  await shoot(d, 'd02-facturas');
  await d.locator('#invoiceList .row').first().click();
  await d.locator('.sheet[role="dialog"]').waitFor();
  await shoot(d, 'd03-ficha');
  await d.locator('.sheet-foot').getByRole('button', { name: 'Cerrar' }).click();
  await d.locator('.nav').getByRole('link', { name: /Compras/ }).click();
  await d.locator('#purchaseTotals').getByText('Base').waitFor();
  await shoot(d, 'd04-compras');
  await d.locator('.nav').getByRole('link', { name: /Gestoría/ }).click();
  await d.locator('#fiscalSummary').getByText('Facturas validadas').waitFor();
  await shoot(d, 'd05-gestoria');
  await desktop.close();

  await browser.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  await api.close();
  console.log('capturas en', out);
}

main().catch((error) => { console.error(error); process.exit(1); });
