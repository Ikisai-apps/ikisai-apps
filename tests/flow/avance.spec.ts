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

test('avance · caja general, discos, filtros y tarjeta con pasos que se marca hecha', async ({ page }) => {
  await enter(page);
  // 7 tarjetas, 1 en backlog: 6 en juego; hechas = la de Flow y la recurrente (cuenta como hecha).
  await expect(page.locator('.avance-total .gt')).toHaveText('2 hechas de 6');
  // Hitos: numerado, el primer paso sin hacer «bloquea» y el siguiente, en espera.
  await expect(page.locator('.avance-hito')).toHaveCount(1);
  await expect(page.locator('.avance-chain li.is-blocking')).toHaveCount(1);
  await expect(page.locator('.avance-chain li.is-waiting')).toHaveCount(1); // los carriles se montan al verse: se mira en la cadena
  await expect(page.locator('.avance-disc')).toHaveCount(4);
  // Filtro de urgencia: solo «Urgente».
  await page.locator('.avance-chip', { hasText: 'Urgente' }).click();
  await expect(page.locator('.avance-card:visible')).toHaveCount(1);
  await expect(page.locator('.avance-card:visible')).toContainText('«Alójate aquí»');
  // Se recuerda en el dispositivo.
  await page.reload();
  await expect(page.locator('.avance-chip', { hasText: 'Urgente' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.avance-chip', { hasText: 'Urgente' }).click();
  // Filtro de agentes: la bloqueada por un paso de un agente fuera del filtro va aparte, plegada, con lo que la bloquea (VG, 27-10).
  await page.locator('.avance-disc', { hasText: 'Flow' }).click();
  const blocked = page.locator('details.avance-blocked');
  await expect(blocked.locator('summary')).toHaveText('Bloqueadas (1)');
  await expect(blocked.locator('.avance-card', { hasText: 'Pantalla nueva' })).toContainText('bloqueada por: «Exportar el tablero» (Core)');
  await expect(page.locator('.avance-card:visible', { hasText: 'Pantalla nueva' })).toHaveCount(0);
  // Con Core también en el filtro, sale en su sitio con «en espera».
  await page.locator('.avance-disc', { hasText: 'Core' }).first().click();
  await expect(page.locator('details.avance-blocked')).toHaveCount(0);
  await expect(page.locator('.avance-card.is-waiting', { hasText: 'Pantalla nueva' })).toHaveCount(1);
  await page.locator('.avance-disc', { hasText: 'Core' }).first().click();
  await page.locator('.avance-disc', { hasText: 'Flow' }).click();
  // La tarjeta de Víctor despliega sus pasos y se marca hecha.
  await page.locator('.avance-disc', { hasText: 'Víctor' }).click();
  const victor = page.locator('.avance-card', { hasText: 'Probar el alojamiento' }).first();
  await victor.locator('.avance-card-title').click();
  await expect(page.locator('.avance-card', { hasText: 'Probar el alojamiento' }).first().locator('.avance-steps li')).toHaveCount(2);
  await page.locator('.avance-card', { hasText: 'Probar el alojamiento' }).first().getByRole('button', { name: 'Hecha' }).click();
  // Nota opcional al cerrar (VG).
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nota (opcional)').fill('Probado en el móvil');
  await dialog.getByRole('button', { name: 'Hecha' }).click();
  await expect(page.locator('.avance-card.is-hecho', { hasText: 'Probar el alojamiento' })).toBeVisible({ timeout: 15_000 });
});
