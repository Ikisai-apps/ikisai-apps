/**
 * Ingresos y gastos de apps (0244, API.md §17): desde Inicio a la lista, las notas de un apunte en su ficha, la ficha
 * con el desglose y la vista «Evento» con el resultado sin IVA (apps + emitidas − recibidas). API falsa en memoria.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvoicesApp } from './e2e-build.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';
import { freePort } from './free-port.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/invoices/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const EVENT = '3b0c6f2e-8a51-4c1d-9d0e-6f5a2b7c8d91';

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  const base = { source_app: 'flow', kind: 'income', tax_rate: 10, pending_refunds_cents: 0, notes: null, received_at: '2026-10-31T23:00:00Z' };
  api.seed('invoices.app_entries', [
    { ...base, id: 'a0000000-0000-4000-8000-000000000031', source_ref: 'flow:project:p1:2026-10-31', entry_date: '2026-10-31', description: 'Barra · Evento de octubre · 31-10',
      amount_cents: 123250, net_cents: 112045, tax_cents: 11205, methods: { cash: 79800, bizum: 43450 }, event_id: EVENT,
      detail: [{ code: 'A', name: 'Montadito clásico A', quantity: 100, amount_cents: 70000 }, { code: 'α', name: 'Caña', quantity: 205, amount_cents: 53250 }] },
    { ...base, id: 'a0000000-0000-4000-8000-000000000030', source_ref: 'flow:project:p1:2026-10-30', entry_date: '2026-10-30', description: 'Barra · Evento de octubre · 30-10',
      amount_cents: 22000, net_cents: 20000, tax_cents: 2000, methods: { cash: 22000 }, event_id: null, detail: [] },
  ]);
  process.env.VITE_API_PROXY = api.url;
  await buildInvoicesApp();
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
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

test('ingresos de apps: lista, notas, ficha y resultado del evento', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  await test.step('desde Inicio, la herramienta lleva a la lista con sus cifras', async () => {
    await expect(page.locator('#statAppEntries')).toContainText('1.452,50');
    await page.locator('#toolAppEntries').click();
    await expect(page.getByRole('heading', { name: 'Ingresos y gastos de apps', level: 2 })).toBeVisible();
    await expect(page.locator('#appEntriesStats')).toContainText('ingresos');
    await expect(page.locator('#appEntriesList')).toContainText('Barra · Evento de octubre · 31-10');
    await expect(page.locator('#appEntriesEvents')).toContainText('Resultado');
  });

  await test.step('las notas se guardan desde la ficha', async () => {
    await page.locator('#appEntriesList li.row', { hasText: '30-10' }).getByText('Barra · Evento de octubre · 30-10').click();
    await page.locator('#appEntryNotes').fill('Caja cuadrada');
    await page.locator('#appEntrySave').click();
    await expect(page.locator('#appEntrySheet')).toBeHidden();
    await expect.poll(() => api.rows('invoices.app_entries').find((r) => r.id === 'a0000000-0000-4000-8000-000000000030')?.notes).toBe('Caja cuadrada');
  });

  await test.step('la ficha enseña el desglose y los medios', async () => {
    await page.locator('#appEntriesList li.row', { hasText: '31-10' }).getByText('Barra · Evento de octubre · 31-10').click();
    await expect(page.locator('#appEntrySheet')).toContainText('Efectivo 798,00');
    await page.locator('#appEntrySheet details summary').click();
    await expect(page.locator('#appEntryDetail')).toContainText('Montadito clásico A × 100');
    await page.locator('#appEntrySheet').getByRole('link').click();
  });

  await test.step('el evento: ingresos de apps menos gastos, sin IVA', async () => {
    await expect(page.locator('#eventStats')).toContainText('1.120,45');
    await expect(page.locator('#eventMoves')).toContainText('Barra · Evento de octubre · 31-10 · Flow');
    await page.getByRole('link', { name: '‹ Ingresos y gastos de apps' }).click();
    await expect(page.getByRole('heading', { name: 'Ingresos y gastos de apps', level: 2 })).toBeVisible();
  });
});
