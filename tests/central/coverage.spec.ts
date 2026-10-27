/**
 * Central · Revisión › Uso y cobertura (visión V0.2 aprobada por VG, 27-10): el uso de 30 días de cada función, su estado de
 * cobertura y la decisión de una persona («Retirar», con confirmación). Datos ficticios.
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
  test.setTimeout(180_000);
  api = await startCentralServer();
  const db = api.app.t.db;
  // Dos funciones catalogadas de Tasks: una que se usa (5 usos hoy) y otra que nadie ha visto.
  await db.query(`insert into core.usage_features (feature_id, app, label, kind, catalogued, active) values
    ('tasks.lista.filtro', 'tasks', 'Filtro de la lista', 'button', true, true),
    ('tasks.lista.exportar', 'tasks', 'Exportar la lista', 'button', true, true)`);
  await db.query(`insert into core.usage_daily (day, feature_id, generation, actor, context, user_key, device_id, exposures, activations, successes)
    values (current_date, 'tasks.lista.filtro', 1, 'internal', 'production', $1, gen_random_uuid(), 7, 5, 5)`, [api.app.users.owner]);
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp();
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
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();
}
const decision = async (feature: string) => (await api.app.t.db.query<{ d: string }>(`select decision as d from central.coverage_decisions where feature_id = $1 and deleted_at is null`, [feature])).rows[0]?.d ?? null;

test('uso y cobertura · desde Revisión; estado por función, filtro y «Retirar» con confirmación', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/revision`);
  await page.locator('#openCoverage').click();
  await expect(page).toHaveURL(/#\/revision\/uso$/);
  await expect(page.getByRole('heading', { name: 'Uso y cobertura' })).toBeVisible();
  // Con el inventario del núcleo (P15, #783) leído: ni aviso de carga ni de que falte.
  await expect(page.locator('#coverageNote')).toHaveText('');
  const used = page.locator('.ctl-cov[data-feature="tasks.lista.filtro"]');
  const nobody = page.locator('.ctl-cov[data-feature="tasks.lista.exportar"]');
  await expect(used).toHaveAttribute('data-state', 'usado_fuera');
  await expect(used).toContainText('30 días: 5 usos');
  await expect(nobody).toHaveAttribute('data-state', 'nadie_llega');
  // Filtro por estado.
  await page.locator('#coverageStates [data-state="nadie_llega"]').click();
  await expect(used).toHaveCount(0);
  await expect(nobody).toBeVisible();
  // «Retirar» pregunta antes; cancelar no escribe nada.
  await nobody.getByRole('button', { name: 'Retirar' }).click();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  expect(await decision('tasks.lista.exportar')).toBeNull();
  await nobody.getByRole('button', { name: 'Retirar' }).click();
  await page.locator('#dialogConfirm').click(); // el diálogo del kit es un alertdialog
  await expect.poll(() => decision('tasks.lista.exportar')).toBe('retirar');
  await expect(nobody.getByRole('button', { name: 'Retirar' })).toHaveAttribute('aria-pressed', 'true');
  // Otra vez la misma: la quita.
  await nobody.getByRole('button', { name: 'Retirar' }).click();
  await expect.poll(() => decision('tasks.lista.exportar')).toBeNull();
});
