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
  // Un hito de dos pasos (0947): el primero sin hacer bloquea; el segundo queda en espera.
  const hito = crypto.randomUUID();
  await api.app.t.db.query(`select flow.import_board($1, $2::jsonb)`, [board, JSON.stringify({
    hitos: [{ hito_id: hito, title: 'Mudanza del Avance', orden: 1 }],
    cards: [{ card_id: crypto.randomUUID(), lane_key: 'core', title: 'Exportar el tablero', status: 'pending', hito_id: hito, paso: 1 },
      { card_id: crypto.randomUUID(), lane_key: 'flow', title: 'Pantalla nueva', status: 'pending', hito_id: hito, paso: 2 }],
  })]);
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
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Flujos' })).toBeVisible();
  await page.goto(`${baseURL}/#/p/${board}/avance`);
}

test('avance · caja general, discos, filtros, hitos y tarjeta con pasos que se marca hecha (pantalla del artefacto original)', async ({ page }) => {
  await enter(page);
  await page.setViewportSize({ width: 1280, height: 900 }); // lado a lado: todos los carriles a la vista
  await expect(page.locator('.avance-orig .gprog .gt')).toHaveText('2 hechas de 6');
  await expect(page.locator('.avance-orig .hito')).toHaveCount(1);
  await expect(page.locator('.avance-orig .circ')).toHaveCount(4);
  // Urgencia: solo la urgente.
  await page.locator('.fc[data-pr="urgente"]').click();
  await expect(page.locator('.fc[data-pr="urgente"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.lanes .it')).toHaveCount(1);
  await expect(page.locator('.lanes .it')).toContainText('«Alójate aquí»');
  await page.locator('.fc[data-pr="urgente"]').click();
  // Flow solo: «Pantalla nueva» espera a un paso de Core, que no está en el filtro → plegada aparte.
  await page.locator('.circ[data-sum="Flow"]').click();
  const wait = page.locator('details.wait');
  await expect(wait.locator('summary')).toContainText('1 bloqueada');
  await expect(wait.locator('.wby')).toContainText('Core');
  // Con Core también en el filtro ya no se pliega.
  await page.locator('.circ[data-sum="Core"]').click();
  await expect(page.locator('details.wait')).toHaveCount(0);
  await page.locator('.circ[data-sum="Core"]').click();
  await page.locator('.circ[data-sum="Flow"]').click();
  // Víctor: abrir la tarjeta (pasos) y marcarla hecha con nota.
  await page.locator('.circ[data-sum="Víctor"]').click();
  const victor = page.locator('.lanes .it', { hasText: 'Probar el alojamiento' });
  await victor.click();
  await expect(victor.locator('.pasos li')).toHaveCount(2);
  await victor.locator('.acts').getByRole('button', { name: 'Hecha' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Nota (opcional)').fill('Probado en el móvil');
  await dialog.getByRole('button', { name: 'Hecha' }).click();
  await expect(page.locator('.circ[data-sum="Víctor"]')).toHaveClass(/full/, { timeout: 15_000 });
});
