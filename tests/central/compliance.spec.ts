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
const dmy = (d: string) => d.split('-').reverse().join('/');

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
  await expect(page.getByRole('heading', { name: 'Póliza de responsabilidad civil' })).toBeVisible();
  await expect(page.locator('#requirementView .pagehead')).toContainText('Vence pronto');
  await expect(page.locator('#requirementView .pagehead')).toContainText(/LEG_\d{4}_\d{3}/);

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

  // Vencimientos e Inicio la muestran.
  await page.getByRole('link', { name: 'Cumplimiento', exact: true }).click();
  await expect(page.locator('#dueList')).toContainText('Póliza de responsabilidad civil');
  await page.getByRole('link', { name: 'Inicio', exact: true }).click();
  await expect(page.locator('#homeDocs')).toContainText('Póliza de responsabilidad civil');

  // Documento clave con PDF, enlazado a la obligación.
  await page.locator('#homeDocs a', { hasText: 'Póliza de responsabilidad civil' }).click();
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
  await expect(page.locator('#blockRequirement')).toContainText(dmy(proposed));
  await expect(page.locator('#requirementView .pagehead')).toContainText('Cumplido');

  // Un lector lo ve, sin poder editar ni pedir tareas.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader@example.invalid', 'Reader');
  await reader.getByRole('link', { name: 'Cumplimiento', exact: true }).click();
  await reader.locator('#ctab-requisitos').click();
  await reader.locator('.personrow', { hasText: 'Póliza de responsabilidad civil' }).click();
  await expect(reader.locator('#blockDocuments')).toContainText('Póliza 2026');
  await expect(reader.locator('#editRequirement')).toHaveCount(0);
  await expect(reader.locator('#askTask')).toHaveCount(0);
  await other.close();
});
