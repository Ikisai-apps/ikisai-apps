/**
 * Capturas en móvil (390×844) de las dos correcciones de la aceptación V1 del usuario (tanda 12): proveedor nuevo desde la
 * hoja «Nueva factura» y «Extraer con ChatGPT» junto al documento. Contra la app compilada y la API falsa; no es una prueba.
 *   npx tsx tests/invoices/shots-v1.ts <carpeta de salida>
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
const out = path.resolve(process.argv[2] ?? path.join(here, '../../../capturas-invoices-v1'));
fs.mkdirSync(out, { recursive: true });
const PDF = Buffer.from('%PDF-1.4\n% factura sintética\n%%EOF\n');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Víctor' };

function executable(): string | undefined {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe') : null;
  return base && fs.existsSync(base) ? base : undefined;
}

async function main() {
  const api = await startFakeApi({ users: [USER] });
  api.seed('invoices.suppliers', [{ id: crypto.randomUUID(), name: 'Makro', tax_id: 'A28647451', default_category: 'compras' }]);
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  const server = await preview({ configFile, logLevel: 'silent', preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } } });
  const baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? '';
  const browser = await chromium.launch({ headless: true, executablePath: executable() });
  const synced = (page: Page) => page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent?.includes('Todo sincronizado'), null, { timeout: 20_000 });
  const shoot = async (page: Page, name: string, locator?: string) => {
    await page.waitForTimeout(400);
    if (locator) await page.locator(locator).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
    console.log('✓', name);
  };

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'es-ES' });
  const m = await context.newPage();
  await m.goto(`${baseURL}/`);
  await m.getByLabel('Correo electrónico').fill(USER.email);
  await m.getByLabel('Contraseña').fill(USER.password);
  await m.getByRole('button', { name: 'Entrar' }).click();
  await m.getByRole('heading', { name: `Hola, ${USER.displayName}` }).waitFor();
  await synced(m);

  // Flujo 1 · proveedor nuevo desde la hoja
  await m.locator('.nav').getByRole('link', { name: /Facturas/ }).click();
  await m.getByRole('button', { name: 'Nueva factura' }).click();
  const sheet = m.getByRole('dialog', { name: 'Nueva factura' });
  await shoot(m, '01-nueva-factura-pista-proveedor');
  await sheet.locator('#newSupplier').selectOption({ label: '+ Nuevo proveedor…' });
  await sheet.locator('#newSupplierName').fill('Frutas Nuevas SL');
  await sheet.locator('#newSupplierTaxId').fill('B11111111');
  await sheet.getByLabel('Objeto').fill('fruta');
  await shoot(m, '02-nuevo-proveedor-en-la-hoja', '#newSupplierFields');

  // Flujo 2 · documento subido → «Extraer con ChatGPT»
  await sheet.getByLabel('PDF o fotos').setInputFiles({ name: 'foto factura.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  await sheet.locator('#chatgptNew').waitFor();
  await shoot(m, '03-extraer-con-chatgpt-tras-subir', '#chatgptNew');
  await sheet.locator('#chatgptNew [data-step="paste"]').click();
  const importSheet = m.locator('.sheet[role="dialog"]');
  const doc = { ...EXAMPLE, invoice: { ...EXAMPLE.invoice, invoice_date: '2026-10-06', supplier_name: 'Frutas Nuevas SL', supplier_tax_id: 'B11111111', invoice_number: 'V1-1', object: 'fruta' } };
  await importSheet.getByLabel('JSON', { exact: true }).fill(JSON.stringify(doc, null, 2));
  await importSheet.locator('#importPreview').waitFor();
  await shoot(m, '04-pegar-json-con-el-documento', '#importPreview');
  await importSheet.locator('#importDocs').scrollIntoViewIfNeeded();
  await shoot(m, '05-documento-ya-adjunto', '#importDocs');
  await m.keyboard.press('Escape').catch(() => undefined);
  await m.locator('.sheet-foot').getByRole('button', { name: 'Cancelar' }).click().catch(() => undefined);
  await m.getByRole('button', { name: 'Descartar' }).click({ timeout: 3000 }).catch(() => undefined);

  // Ficha de una factura pendiente de datos con documento → el mismo bloque junto al documento
  await m.getByRole('button', { name: 'Nueva factura' }).click();
  const sheet2 = m.getByRole('dialog', { name: 'Nueva factura' });
  await sheet2.locator('#newSupplier').selectOption({ label: 'Makro' });
  await sheet2.getByLabel('Objeto').fill('compra semanal');
  await sheet2.getByLabel('PDF o fotos').setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: PDF });
  await sheet2.locator('#saveInvoice').click();
  await m.locator('.sheet[role="dialog"] #chatgptInvoice').waitFor({ timeout: 20_000 });
  await synced(m).catch(() => undefined);
  await m.waitForTimeout(4500); // que se vaya el aviso «Factura creada»
  await shoot(m, '06-ficha-pendiente-extraer-con-chatgpt', '#chatgptInvoice');

  await browser.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  await api.close();
  console.log('capturas en', out);
}

main().catch((error) => { console.error(error); process.exit(1); });
