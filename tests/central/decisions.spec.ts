/**
 * Central · registro de decisiones: tres niveles plegables (nombre → descripción → explicación técnica), sustitución,
 * búsqueda y filtros; un lector lee sin editar. Contra la central-api real sobre PGlite (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildCentralApp } from './e2e-build.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  // Compilar la app con Vite puede pasar de los 90 s con la máquina cargada (fallo visto con @smoke en paralelo).
  test.setTimeout(180_000);
  api = await startCentralServer();
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp(); // un solo build aunque haya varios workers
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
  await page.goto(`${baseURL}/#/decisiones`);
  await page.locator('#newDecision').click();
  await page.locator('#dc-name').fill(fields.name);
  await page.locator('#dc-summary').fill(fields.summary);
  if (fields.technical) await page.locator('#dc-technical').fill(fields.technical);
  await page.locator(`.scopes input[value="${fields.scope}"]`).check();
  await page.locator('#saveDecision').click();
  await expect(page.getByText('Decisión guardada.')).toBeVisible();
  // Al crearla se abre su ficha entera (MUELA-014 y 069).
  await expect(page.locator('#decisionTitle')).toHaveText(fields.name);
}

const row = (page: Page, text: string) => page.locator('#decisionList li.row', { hasText: text });

test('decisiones · lista y ficha, tres niveles, sustitución en los dos sentidos, filtros, votos y decisión final', async ({ page, browser }) => {
  await login(page, 'owner@example.invalid', 'Owner');
  await page.locator('#homeDecisions').click();
  await expect(page.getByText('Todavía no hay decisiones')).toBeVisible();

  await create(page, {
    name: 'Las facturas que emitimos se hacen con otra herramienta',
    summary: 'Finance solo apunta las facturas emitidas; no las genera.',
    technical: 'Sin Verifactu en la app: invoices.issued_invoices registra numeración por serie.',
    scope: 'invoices',
  });
  // Ficha: el porqué a la vista y la explicación técnica plegada dentro.
  await expect(page.getByText('Finance solo apunta las facturas emitidas; no las genera.')).toBeVisible();
  await expect(page.getByText('Sin Verifactu en la app')).toBeHidden();
  await page.getByText('Explicación técnica').click();
  await expect(page.getByText('Sin Verifactu en la app')).toBeVisible();
  const firstUrl = page.url();

  // Una decisión nueva la sustituye: «Sustituida por» y «Sustituye a», un toque en cada sentido.
  await create(page, { name: 'Finance emite facturas con su propia numeración', summary: 'Ahora las facturas se emiten desde Finance.', scope: 'invoices' });
  await page.goto(firstUrl);
  await page.locator('#editDecision').click();
  await page.locator('#dc-status').selectOption('sustituida');
  const newer = await page.locator('#dc-superseded option', { hasText: 'Finance emite facturas' }).getAttribute('value');
  await page.locator('#dc-superseded').selectOption(newer!);
  await page.locator('#saveDecision').click();
  await expect(page.locator('#decisionView .pagehead')).toContainText('Sustituida');
  await page.locator('.ctl-trail', { hasText: 'Sustituida por' }).click();
  await expect(page.locator('#decisionTitle')).toHaveText('Finance emite facturas con su propia numeración');
  await expect(page.locator('.ctl-trail', { hasText: 'Sustituye a' })).toBeVisible();

  // Lista: «Lo que vale hoy» y «Ya no valen»; etiquetas de estado y de app con recuento; búsqueda sin acentos.
  await page.locator('.backlink').click();
  await expect(page.locator('[data-group="vigentes"]')).toContainText('Finance emite facturas');
  await expect(page.locator('[data-group="ya_no"]')).toContainText('Las facturas que emitimos');
  await page.locator('[data-filter="estado:vigente"]').click();
  await expect(page.locator('#decisionList li.row')).toHaveCount(1);
  await page.locator('[data-filter="estado:todas"]').click();
  await page.locator('#decisionSearch').fill('verifactu');
  await expect(page.locator('#decisionList li.row')).toHaveCount(1);
  await expect(page.locator('#decisionList li.row')).toContainText('Las facturas que emitimos');
  await page.locator('#decisionSearch').fill('');
  await page.locator('[data-filter="estado:revocada"]').click();
  await expect(page.getByText('Ninguna decisión coincide')).toBeVisible();
  await page.locator('[data-filter="estado:todas"]').click();

  // Un lector lee, sin editar, y vota (decisión de VG; núcleo #608).
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader@example.invalid', 'Reader');
  await reader.locator('#homeDecisions').click();
  await expect(reader.locator('#decisionList li.row')).toHaveCount(2);
  await expect(reader.locator('#newDecision')).toHaveCount(0);
  await reader.locator('#decisionVote').getByRole('button', { name: /^Retirar/ }).first().click();
  await expect(reader.getByText('Votado: Retirar.')).toBeVisible();
  await expect.poll(async () => (await api.app.t.db.query<{ n: number }>(`select count(*)::int as n from central.decision_votes where vote = 'retirar' and deleted_at is null`)).rows[0]!.n).toBe(1);
  await row(reader, 'Finance emite facturas').click();
  await expect(reader.locator('#editDecision')).toHaveCount(0);
  await expect(reader.locator('#reviewKeep')).toHaveCount(0);
  await expect(reader.locator('#voteDrop')).toHaveAttribute('aria-pressed', 'true');
  await other.close();

  // El owner ve la votación en la ficha y decide: se mantiene, aunque los votos digan otra cosa.
  await page.reload();
  await row(page, 'Finance emite facturas').click();
  await expect(page.locator('#decisionTally')).toContainText('0 se mantiene · 1 retirar');
  await page.locator('#reviewKeep').click();
  await expect(page.locator('#decisionReviewed')).toContainText('Mantener');
  await expect.poll(async () => (await api.app.t.db.query<{ o: string | null }>(`select review_outcome as o from central.decisions where status = 'vigente'`)).rows[0]!.o).toBe('mantener');
});
