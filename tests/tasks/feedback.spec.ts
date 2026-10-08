/**
 * Tasks · «Sugerencias y QA» (FEEDBACK.md, adopción de la fase 4) contra la tasks-api real: el lanzador con
 * «Señalar para comentar», la pulsación larga sobre un control marcado, el envío del reporte (nodo y ruta de etiquetas
 * estables, sin datos ignorados), el centro de reportes desde el menú, el uso de funciones y la pantalla marcada.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { feedbackRoundTrip } from '../../packages/ui-kit/testing/feedback-smoke.ts';

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
  server = await startE2EServer();
  ID = await seedDemo(server);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

/** Pulsación larga con el ratón sobre el centro del elemento (el gesto del kit son 600 ms). */
async function hold(selector: string, ms = 900): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Sin caja para ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
async function setSignal(on: boolean): Promise<void> {
  await page.locator('#appLauncher').click();
  const dialog = page.getByRole('dialog');
  const toggle = dialog.getByRole('switch', { name: /Señalar para comentar/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await toggle.setChecked(on);
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}
const reports = async () => (await server.app.t.db.query<Record<string, any>>(`select * from core.feedback_reports where origin_app = 'tasks' order by created_at`)).rows;

test('recorrido de feedback en Tasks: interruptor, pulsación larga, envío, «Sugerencias y QA» y uso', async () => {
  await settled(page);
  await test.step('la pantalla y la cáscara llevan sus marcas', async () => {
    await expect(page.locator('#view main[data-feedback-id]')).toHaveCount(1);
    await expect(page.locator('[data-feedback-id="tasks.cabecera.lanzador"]')).toHaveCount(1);
  });

  await test.step('el lanzador ofrece «Señalar para comentar», apagado; sin él, la pulsación larga no hace nada', async () => {
    await setSignal(false);
    await hold('[data-feedback-id="tasks.cabecera.areas.general"]');
    await expect(page.locator('.fb-composer')).toHaveCount(0);
  });

  await test.step('con el modo encendido, la pulsación larga abre el formulario con la ruta de etiquetas', async () => {
    await setSignal(true);
    await expect(page.locator('html.fb-mode')).toHaveCount(1);
    await hold('[data-feedback-id="tasks.cabecera.areas.general"]');
    const composer = page.locator('.fb-composer');
    await expect(composer).toBeVisible();
    await expect(composer.locator('.fb-where strong')).toHaveText('Cabecera › General');
    await composer.getByRole('textbox', { name: 'Comentario' }).fill('La pestaña General debería decir cuántas tareas hay.');
    await composer.getByRole('button', { name: 'Enviar' }).click();
    await expect.poll(async () => (await reports()).length).toBe(1);
    // El aviso «Enviado» del kit va dentro de #kitLayer (CSS del kit acotado), no suelto en body.
    // El aviso «Enviado» va a la capa del kit (setKitLayer) y tiene tamaño de aviso, no una columna (escritorio).
    const notice = page.locator('#kitLayer .toast[role="status"]');
    await expect(notice).toHaveCount(1);
    await expect(page.locator('body > .toast[role="status"]')).toHaveCount(0);
    const box = (await notice.boundingBox())!;
    expect(box.height).toBeLessThan(90);
    expect(box.width).toBeLessThan(640);
    const report = (await reports())[0]!;
    expect(report.node?.id ?? report.node_id).toBe('tasks.cabecera.areas.general');
    await expect(page.locator('.fb-composer')).toHaveCount(0, { timeout: 5_000 });
    await setSignal(false);
    await expect(page.locator('html.fb-mode')).toHaveCount(0);
  });

  await test.step('«Sugerencias y QA» del menú lista el reporte', async () => {
    await page.evaluate(() => (window as any).handleTopAction('feedbackCenter'));
    const sheet = page.getByRole('dialog', { name: 'Sugerencias y QA' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('tab', { name: 'Abiertos' }).click();
    await expect(sheet.locator('.fb-card')).toHaveCount(1);
    await expect(sheet.locator('.fb-card')).toContainText('La pestaña General');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('crear y completar una tarea cuenta su uso', async () => {
    await page.evaluate(() => { (window as any).record('create', []); (window as any).record('complete', []); });
    const today = await page.evaluate(() => (window as any).tasksFeedback().usage.today().map((i: any) => [i.featureId, i.successes]));
    expect(today).toEqual(expect.arrayContaining([['tasks.tarea.crear', 1], ['tasks.tarea.completar', 1]]));
  });
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('feedback común del kit (escritorio): enviar con doble toque, se cierra, aviso visible y un solo reporte @smoke', async () => {
  await settled(page);
  const text = 'Prueba de humo del feedback · escritorio';
  const count = async () => Number((await server.app.t.db.query<{ n: number }>(`select count(*) n from core.feedback_reports where origin_app = 'tasks' and message = $1`, [text])).rows[0]!.n);
  const { code } = await feedbackRoundTrip(page, { target: '[data-feedback-id="tasks.cabecera.areas.general"]', text });
  expect(code).toMatch(/^FB_/);
  await expect.poll(count).toBe(1);
  await page.waitForTimeout(500);
  expect(await count(), 'el doble toque no envía dos reportes').toBe(1);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
