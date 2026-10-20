/**
 * Central · Cumplimiento (V1.1): obligación con vencimiento, aviso en Inicio, tarea pedida a Tasks (simulado),
 * «Marcar cumplido» con el siguiente vencimiento, documento clave con PDF y lo que ve un lector.
 * Contra la central-api real sobre PGlite (server.ts); Tasks es un transporte simulado.
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
const madrid = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));
const nextYear = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;

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

test('cumplimiento · obligación, aviso, tarea en Tasks, cumplido, documento y lector', async ({ page, browser }) => {
  const due = madrid(20);
  await login(page, 'owner@example.invalid', 'Owner');
  await page.getByRole('link', { name: 'Cumplimiento', exact: true }).click();
  await expect(page.getByText('Nada vencido ni por vencer')).toBeVisible();

  // Nueva obligación anual que vence en 20 días (aviso con 30): entra en «Vence pronto».
  await page.locator('#ctab-requisitos').click();
  await page.locator('#newRequirement').click();
  await page.locator('#q-name').fill('Póliza de responsabilidad civil');
  await page.locator('#q-type').selectOption('seguro');
  await page.locator('#q-expires').fill(due);
  await page.locator('#q-frequency').selectOption('anual');
  await page.locator('#q-risk').selectOption('alto');
  await page.locator('#saveRequirement').click();
  // Ficha (MUELA-069): portada con el plazo, recorrido y foco; los datos plegados con «Editar».
  await expect(page.getByRole('heading', { name: 'Póliza de responsabilidad civil' })).toBeAttached();
  const cover = page.locator('#requirementView .ctl-cover');
  await expect(cover).toContainText('Vence pronto');
  await expect(cover).toContainText(/LEG_\d{4}_\d{3}/);
  await expect(cover.locator('.cover-pill')).toContainText(/^Vence el .+ \(quedan (19|20) días\)$/);
  await expect(page.locator('#requirementView .stage-list, #requirementView ol').first()).toContainText('Pendiente');
  await expect(page.locator('#requirementView .focus-card')).toContainText('Marcar cumplido');
  await expect(page.locator('#editRequirement')).toBeAttached();

  // Tarea pedida a Tasks: sin área ni proyecto, con su tipo y el enlace a la ficha.
  await page.locator('#askTask').click();
  await expect(page.locator('#at-due')).toHaveValue(due);
  await page.locator('#askTaskSubmit').click();
  await expect(page.getByText('Tarea pedida: en Tasks queda «Por clasificar».')).toBeVisible();
  await expect(page.locator('#taskList')).toContainText('Póliza de responsabilidad civil');
  await expect(page.locator('#taskList')).toContainText('En Tasks, por clasificar');
  const sent = api.tasksCalls.find((c) => c.path === 'requests/task')!.body;
  expect(sent).toMatchObject({ source: 'central', kind: 'central.compliance_due', priority: 'high', due });
  expect(sent.external_url).toMatch(/^https:\/\/central\.ikisai\.com\/#\/cumplimiento\/[0-9a-f-]{36}$/);
  expect('tab_id' in sent || 'project_id' in sent).toBe(false);

  // Vencimientos: una cosa cada vez para quien edita; «Ver todo» abre la lista de siempre; también por semanas.
  await page.getByRole('link', { name: 'Cumplimiento', exact: true }).click();
  await expect(page.locator('.queue-card')).toContainText('Póliza de responsabilidad civil');
  await expect(page.locator('.queue-card').getByRole('button', { name: 'Marcar cumplido y siguiente' })).toBeVisible();
  await page.locator('.queue-all').click();
  await expect(page.locator('#dueList')).toContainText('Póliza de responsabilidad civil');
  await page.locator('[data-view="semanas"]').click();
  await expect(page.locator('#compliance-vencimientos .worst-group')).toContainText('Póliza de responsabilidad civil');
  await page.getByRole('link', { name: 'Inicio', exact: true }).click();
  await expect(page.locator('#homeDocs')).toContainText('Póliza de responsabilidad civil');
  // Inicio (089): la obligación lleva «Resolver y siguiente»; «Ver» la abre y el resumen dice cuánto urge.
  await expect(page.locator('#homeDocs .queue-card').getByRole('button', { name: 'Resolver y siguiente' })).toBeVisible();
  await expect(page.locator('#homeAttentionSummary')).not.toBeEmpty();

  // Documento clave con PDF, enlazado a la obligación (la ficha, desde la tarjeta de Inicio).
  await page.locator('#homeDocs').getByRole('button', { name: 'Ver', exact: true }).click();
  await page.locator('#addDocument').click();
  await page.locator('#d-name').fill('Póliza 2026');
  await page.locator('#d-expires').fill(due);
  await page.locator('#d-file').setInputFiles({ name: 'poliza.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 póliza de prueba') });
  await page.locator('#saveDocument').click();
  await expect(page.locator('#blockDocuments')).toContainText('Póliza 2026');
  await expect.poll(async () => (await api.app.t.db.query(`select (file_id is not null) as ok, code from central.key_documents`)).rows[0]).toMatchObject({ ok: true });

  // Marcar cumplido: propone el mismo día del año siguiente.
  await page.locator('#markDone').click();
  const proposed = nextYear(madrid(0));
  await expect(page.locator('#md-expires')).toHaveValue(proposed);
  await page.locator('#confirmDone').click();
  await expect(page.getByText('Obligación marcada como cumplida.')).toBeVisible();
  await expect(page.locator('#requirementView .ctl-cover')).toContainText('Cumplido');
  await expect(page.locator('#requirementView ol').first()).toContainText('Cumplida');
  await expect.poll(async () => (await api.app.t.db.query<{ e: string }>(`select expires_on::text as e from central.requirements`)).rows[0]!.e).toBe(proposed);

  // Un lector lo ve, sin poder editar ni pedir tareas.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader@example.invalid', 'Reader');
  await reader.getByRole('link', { name: 'Cumplimiento', exact: true }).click();
  // Vencimientos (069, MUELA-086): también «Una cosa cada vez», con «Abrir y siguiente» y «Ver todo», sin acciones que escriben.
  await expect(reader.locator('.queue-card')).toContainText('Póliza 2026');
  await expect(reader.locator('.queue-card').getByRole('button', { name: 'Abrir y siguiente' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Marcar cumplido y siguiente' })).toHaveCount(0);
  await reader.locator('.queue-all').click();
  await expect(reader.locator('#dueList')).toContainText('Póliza 2026');
  await reader.locator('#ctab-requisitos').click();
  // Al día: su grupo («Seguro») está plegado; se abre y se toca la fila.
  const group = reader.locator('.worst-group[data-group="seguro"]');
  await expect(group).toContainText('al día');
  await group.locator('summary').click();
  await group.locator('li.row', { hasText: 'Póliza de responsabilidad civil' }).click();
  await expect(reader.locator('#blockDocuments')).toContainText('Póliza 2026');
  await expect(reader.locator('#editRequirement')).toHaveCount(0);
  await expect(reader.locator('#askTask')).toHaveCount(0);
  await other.close();
});
