/**
 * Central · registro de decisiones: tres niveles plegables (nombre → descripción → explicación técnica), sustitución,
 * búsqueda y filtros; un lector lee sin editar. Contra la central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startCentralServer();
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

async function login(page: Page, email: string, name: string): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${name}` })).toBeVisible();
}

async function create(page: Page, fields: { name: string; summary: string; technical?: string; scope: string }): Promise<void> {
  await page.locator('#newDecision').click();
  await page.locator('#dc-name').fill(fields.name);
  await page.locator('#dc-summary').fill(fields.summary);
  if (fields.technical) await page.locator('#dc-technical').fill(fields.technical);
  await page.locator(`.scopes input[value="${fields.scope}"]`).check();
  await page.locator('#saveDecision').click();
  await expect(page.getByText('Decisión guardada.')).toBeVisible();
}

test('decisiones · tres niveles, sustitución, búsqueda, filtros y lector', async ({ page, browser }) => {
  await login(page, 'owner@example.invalid', 'Owner');
  await page.locator('#homeDecisions').click();
  await expect(page.getByText('Todavía no hay decisiones')).toBeVisible();

  await create(page, {
    name: 'Las facturas que emitimos se hacen con otra herramienta',
    summary: 'Finance solo apunta las facturas emitidas; no las genera.',
    technical: 'Sin Verifactu en la app: invoices.issued_invoices registra numeración por serie.',
    scope: 'invoices',
  });
  const first = page.locator('.decision', { hasText: 'Las facturas que emitimos' });
  // Nivel 1 visible; el 2 se despliega al tocar el nombre; el 3 sigue plegado dentro.
  await first.locator('summary.decisionname').click();
  await first.evaluate((d) => { (d as HTMLDetailsElement).open = false; });
  await expect(first.getByText('Finance solo apunta las facturas emitidas; no las genera.')).toBeHidden();
  await first.locator('summary.decisionname').click();
  await expect(first.getByText('Finance solo apunta las facturas emitidas; no las genera.')).toBeVisible();
  await expect(first.getByText('Sin Verifactu en la app')).toBeHidden();
  await first.getByText('Explicación técnica').click();
  await expect(first.getByText('Sin Verifactu en la app')).toBeVisible();

  // Una decisión nueva la sustituye.
  await create(page, { name: 'Finance emite facturas con su propia numeración', summary: 'Ahora las facturas se emiten desde Finance.', scope: 'invoices' });
  await first.locator('summary.decisionname').evaluate((s) => (s.parentElement as HTMLDetailsElement).open = true);
  await first.getByRole('button', { name: 'Editar' }).click();
  await page.locator('#dc-status').selectOption('sustituida');
  const newer = await page.locator('#dc-superseded option', { hasText: 'Finance emite facturas' }).getAttribute('value');
  await page.locator('#dc-superseded').selectOption(newer!);
  await page.locator('#saveDecision').click();
  await expect(first).toContainText('Sustituida');
  await expect(first).toContainText('Sustituida por');

  // Filtros y búsqueda (sin acentos).
  await page.locator('#decisionStatus').selectOption('vigente');
  await expect(page.locator('.decision')).toHaveCount(1);
  await page.locator('#decisionStatus').selectOption('');
  await page.locator('#decisionSearch').fill('verifactu');
  await expect(page.locator('.decision')).toHaveCount(1);
  await expect(page.locator('.decision')).toContainText('Las facturas que emitimos');
  await page.locator('#decisionSearch').fill('');
  await page.locator('#decisionScope').selectOption('booking');
  await expect(page.getByText('Ninguna decisión coincide')).toBeVisible();

  // Un lector lee, sin editar.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader@example.invalid', 'Reader');
  await reader.locator('#homeDecisions').click();
  await expect(reader.locator('.decision')).toHaveCount(2);
  await expect(reader.locator('#newDecision')).toHaveCount(0);
  await reader.locator('.decision summary.decisionname').first().click();
  await expect(reader.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await other.close();
});
