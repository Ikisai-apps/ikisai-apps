/**
 * Flow · pantalla «Avance por aplicaciones» (0937–0938): caja general, discos por agente, filtros por estado y urgencia
 * que se recuerdan, carriles por agente y tarjeta que despliega sus pasos y cambia de estado. Contra la `flow-api` real
 * sobre PGlite. Datos ficticios.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { PROCEDURES } from '../../supabase/functions/_domain/flow/mod.ts';
import { buildFlowApp } from './e2e-build.ts';
import { startFlowServer, type FlowTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/flow/vite.config.ts');

let api: FlowTestServer;
let server: PreviewServer;
let baseURL: string;
let board = '';
let seq = 0;

async function ok(operations: unknown[]): Promise<any> {
  const r = await api.app.call('/api/v1/commands', { body: { requestId: `avance-${++seq}-${crypto.randomUUID()}`, operations } });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  return r.data.results[0].result;
}
const card = (args: Record<string, unknown>) => ok([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: board, ...args } }]);

test.beforeAll(async () => {
  test.setTimeout(240_000);
  api = await startFlowServer();
  board = crypto.randomUUID();
  await ok([{ op: 'call', procedure: PROCEDURES.createFlow, args: { template_key: 'avance', project_id: board, name: 'Avance por aplicaciones' } }]);
  await card({ lane_key: 'flow', title: 'Carta pública en producción', status: 'done', tipo: 'arreglo' });
  await card({ lane_key: 'flow', title: '«Alójate aquí»', status: 'in_progress', flag: 'pr', prio: 'urgente', ref: '#943', url: 'https://example.invalid/pr/943' });
  await card({ lane_key: 'victor', title: 'Probar el alojamiento', prio: 'importante', tipo: 'prueba', steps: ['Abrir la carta', 'Tocar «Alójate aquí»'] });
  await card({ lane_key: 'core', title: 'Revisar CI', kind: 'recurring' });
  await card({ lane_key: 'food', title: 'Más adelante', flag: 'backlog' });
  await buildFlowApp();
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

async function enter(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/equipo`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Flujos' })).toBeVisible();
  await page.goto(`${baseURL}/equipo#/p/${board}/avance`);
}

test('avance · caja general, discos, filtros y tarjeta con pasos que se marca hecha', async ({ page }) => {
  await enter(page);
  // 5 tarjetas, 1 en backlog: 4 en juego; hechas = la de Flow y la recurrente (cuenta como hecha).
  await expect(page.locator('.avance-total .gt')).toHaveText('2 hechas de 4');
  await expect(page.locator('.avance-disc')).toHaveCount(4);
  // Filtro de urgencia: solo «Urgente».
  await page.locator('.avance-chip', { hasText: 'Urgente' }).click();
  await expect(page.locator('.avance-card:visible')).toHaveCount(1);
  await expect(page.locator('.avance-card:visible')).toContainText('«Alójate aquí»');
  // Se recuerda en el dispositivo.
  await page.reload();
  await expect(page.locator('.avance-chip', { hasText: 'Urgente' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.avance-chip', { hasText: 'Urgente' }).click();
  // La tarjeta de Víctor despliega sus pasos y se marca hecha.
  await page.locator('.avance-disc', { hasText: 'Víctor' }).click();
  const victor = page.locator('.avance-card', { hasText: 'Probar el alojamiento' }).first();
  await victor.click();
  await expect(victor.locator('.avance-steps li')).toHaveCount(2);
  await victor.getByRole('button', { name: 'Hecha' }).click();
  await expect(page.locator('.avance-card.is-hecho', { hasText: 'Probar el alojamiento' })).toBeVisible({ timeout: 15_000 });
});
