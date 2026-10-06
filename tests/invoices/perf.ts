/**
 * Medida de `loadMirror` con ~500 facturas sintéticas (API.md §10): tiempo de recarga del espejo tras un cambio,
 * en móvil emulado con CPU ×4 más lenta. No es una prueba: imprime los tiempos.
 *   npx tsx tests/invoices/perf.ts [facturas=500]
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/invoices/vite.config.ts');
const COUNT = Number(process.argv[2] ?? 500);
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };

function uuid(): string { return crypto.randomUUID(); }

async function main() {
  const api = await startFakeApi({ users: [USER] });
  const supplierIds = Array.from({ length: 12 }, () => uuid());
  api.seed('invoices.suppliers', supplierIds.map((id, i) => ({ id, name: `Proveedor ${i + 1}`, tax_id: `B0000000${i}`, default_category: 'compras' })));
  const invoices: Array<Record<string, unknown>> = []; const lines: Array<Record<string, unknown>> = []; const taxes: Array<Record<string, unknown>> = []; const allocations: Array<Record<string, unknown>> = [];
  for (let i = 0; i < COUNT; i++) {
    const id = uuid(); const month = 1 + (i % 12); const day = 1 + (i % 27);
    const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const base = 10 + (i % 90); const vat = Math.round(base * 21) / 100;
    invoices.push({ id, supplier_id: supplierIds[i % supplierIds.length], invoice_date: date, object: `compra ${i}`, invoice_number: `N-${i}`, expense_category: 'compras', status: i % 5 === 0 ? 'pendiente_revision' : 'validada', deductibility: 'si', source_total: base + vat, calculated_base: base, calculated_vat: vat, calculated_total: base + vat, totals_delta: 0 });
    for (let l = 0; l < 3; l++) {
      const lineId = uuid(); const net = Math.round((base / 3) * 100) / 100;
      lines.push({ id: lineId, invoice_id: id, position: l, description: `Artículo ${i}-${l}`, quantity: 1 + l, unit: 'ud', unit_price: net, net_amount: net, vat_rate: 21, vat_amount: Math.round(net * 21) / 100 });
      if (l === 0) allocations.push({ id: uuid(), invoice_line_id: lineId, invoice_id: id, target_app: 'general', target_kind: 'operating_expense', target_label: 'Gasto de explotación', allocated_amount: net });
    }
    taxes.push({ id: uuid(), invoice_id: id, position: 0, tax_type: 'iva', rate: 21, taxable_base: base, amount: vat });
  }
  api.seed('invoices.invoices', invoices); api.seed('invoices.invoice_lines', lines); api.seed('invoices.tax_lines', taxes); api.seed('invoices.allocations', allocations);
  console.log(`sembradas ${COUNT} facturas, ${lines.length} líneas, ${taxes.length} impuestos, ${allocations.length} asignaciones`);

  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  const server = await preview({ configFile, logLevel: 'silent', preview: { port: 4800 + Math.floor(Math.random() * 100), host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } } });
  const baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? '';
  const exe = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe') : undefined;
  const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('heading', { name: `Hola, ${USER.displayName}` }).waitFor();
  await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent?.includes('Todo sincronizado'), null, { timeout: 120_000 });
  console.log(`login + bootstrap + snapshot de ${COUNT} facturas: ${Date.now() - t0} ms`);

  const measures = async (label: string) => {
    const entries = await page.evaluate(() => performance.getEntriesByName('invoices:loadMirror').map((e) => Math.round(e.duration)));
    await page.evaluate(() => performance.clearMeasures('invoices:loadMirror'));
    const sorted = [...entries].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0; const max = sorted.at(-1) ?? 0;
    console.log(`${label}: loadMirror × ${entries.length} · mediana ${p50} ms · máximo ${max} ms`);
    return { p50, max };
  };
  await measures('Inicio (con CPU ×4)');
  await page.locator('.nav').getByRole('link', { name: /Facturas/ }).click();
  await page.locator('#invoiceList .row').first().waitFor();
  await measures('Facturas');
  await page.locator('.nav').getByRole('link', { name: /Compras/ }).click();
  await page.locator('#purchaseTotals').getByText('Base').waitFor();
  await measures('Compras');
  // Un cambio (marcar pagada) y la recarga que provoca
  await page.locator('.nav').getByRole('link', { name: /Facturas/ }).click();
  await page.locator('#invoiceList .row').first().click();
  await page.locator('.sheet[role="dialog"] #togglePaid').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Marcar pagada' }).click();
  await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent?.includes('Todo sincronizado'), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const edit = await measures('Tras marcar pagada (commit + confirmación del servidor)');
  console.log(edit.p50 > 200 ? 'RESULTADO: por encima de 200 ms → recarga por tabla afectada' : 'RESULTADO: dentro del objetivo de 200 ms');
  await browser.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  await api.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
