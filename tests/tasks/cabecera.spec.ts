/**
 * Tasks · cabecera del kit (aceptación del usuario, 8-10-2026): en móvil táctil (390 × 844) con la app construida, la marca
 * es el botón del kit con el icono de Tasks y el nombre «Ikisai Tasks», se ve, y al tocarla se ve la hoja «Apps de Ikisai»
 * con «Sugerencias y QA», «Señalar para comentar» y «Revisor de QA». Con «Señalar para comentar» encendido, la marca
 * lleva el punto amarillo. Las capturas quedan en `test-results/cabecera-*.png` (o en CABECERA_CAPTURAS si se indica).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import path from 'node:path';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { feedbackRoundTrip } from '../../packages/ui-kit/testing/feedback-smoke.ts';

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const shots = process.env.CABECERA_CAPTURAS ?? 'test-results';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  // El «Revisor de QA» es del dueño del ecosistema (owner de Central): como el usuario real.
  await server.app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner') on conflict do nothing`, [server.app.users.owner]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('cabecera del kit en móvil: marca de Tasks visible y la hoja «Apps de Ikisai» con sus tres interruptores @smoke', async () => {
  await settled(page);
  const mark = page.locator('#appLauncher');
  await expect(mark).toBeVisible();
  await expect(mark).toBeInViewport();
  // El icono de Tasks del kit (la lista con marcas), no el genérico de Ikisai ni el glifo antiguo.
  expect(await mark.innerHTML()).toContain('M9 6h12M9 12h12M9 18h12');
  expect(await mark.textContent()).not.toContain('•||•');
  await expect(page.locator('#shellTop .brandrow')).toContainText('Ikisai Tasks');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, 'cabecera-tasks-movil.png'), clip: { x: 0, y: 0, width: 390, height: 170 } });

  await mark.tap();
  const sheet = page.getByRole('dialog', { name: 'Apps de Ikisai' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toBeInViewport();
  await expect(sheet.getByText('Sugerencias y QA')).toBeVisible();
  const signal = sheet.getByRole('switch', { name: /Señalar para comentar/ });
  await expect(signal).toBeVisible();
  await expect(sheet.getByRole('switch', { name: /Revisor de QA/ })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, 'cabecera-tasks-lanzador.png') });

  // «Señalar para comentar» encendido: la marca lleva el punto amarillo (regla del kit sobre html.fb-mode).
  await signal.setChecked(true);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.locator('html.fb-mode')).toHaveCount(1);
  const dot = await mark.evaluate((node) => getComputedStyle(node, '::after').content);
  expect(dot).not.toBe('none');
  await page.screenshot({ path: path.join(shots, 'cabecera-tasks-senalar.png'), clip: { x: 0, y: 0, width: 390, height: 170 } });
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('feedback común del kit (móvil con el teclado abierto): enviar con doble toque, se cierra, aviso visible y un solo reporte @smoke', async () => {
  await settled(page);
  const text = 'Prueba de humo del feedback · móvil con el teclado abierto';
  const count = async () => Number((await server.app.t.db.query<{ n: number }>(`select count(*) n from core.feedback_reports where origin_app = 'tasks' and message = $1`, [text])).rows[0]!.n);
  const { code } = await feedbackRoundTrip(page, { target: '[data-feedback-id="tasks.cabecera.areas.general"]', text, keyboard: 686 });
  expect(code).toMatch(/^FB_/);
  await expect.poll(count).toBe(1);
  await page.waitForTimeout(500);
  expect(await count(), 'el doble toque no envía dos reportes').toBe(1);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
