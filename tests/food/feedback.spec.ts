/**
 * Food · «Sugerencias y QA» y uso de funcionalidades (FEEDBACK.md, USO.md; kit 0.18): aviso de medición la primera vez,
 * marcas de pantalla con la forma estable, «Señalar para comentar» desde el panel del lanzador, pulsación larga sobre un
 * control, envío con el nodo y sin datos del grupo, centro «Sugerencias y QA», y crear un menú contado con `usage.run`.
 *
 * Cómo correrlo:   npx playwright test tests/food/feedback.spec.ts
 * Solo contra la API falsa en memoria (fake-api.ts); nunca contra Supabase.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { day, freePort, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';
import { feedbackRoundTrip, simulateKeyboard } from '../../packages/ui-kit/testing/feedback-smoke.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const PATTERN = /^food(\.[a-z0-9_]+){1,4}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const GROUP = 'Retiro Feedback';

test.use({ viewport: { width: 1280, height: 800 } });

// La app calcula «hoy» con la fecha local del navegador: la misma zona que `day()` y el servidor.
test.use({ timezoneId: TIME_ZONE });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    usageConsent: false,
    events: [{
      event_id: randomUUID(), event_code: 'EVT_2026_009', reservation_code: 'RSV_2026_009', title: GROUP, event_type: 'retiro',
      start_date: day(10), end_date: day(12), arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 18, guest_count_is_final: true, minors_count: 0,
      meal_plan: 'media_pension', menu_style: 'vegetariano', reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 1,
      dietary_restrictions: [],
    }],
  });
  process.env.VITE_API_PROXY = api.url;
  await buildFoodApp();
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

/** Pulsación larga con el ratón sobre el centro del elemento (el gesto del kit son 600 ms). */
async function hold(page: Page, selector: string, ms = 900): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Sin caja para ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Abre el lanzador de la cabecera y cambia el interruptor «Señalar para comentar». */
async function setSignal(page: Page, on: boolean): Promise<void> {
  await page.locator('#appLauncher').click();
  const dialog = page.getByRole('dialog');
  const toggle = dialog.getByRole('switch', { name: /Señalar para comentar/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await toggle.setChecked(on);
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

test('feedback · aviso de uso, marcas de pantalla, señalar y comentar, «Sugerencias y QA» y usage.run @smoke', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('login y aviso de medición la primera vez', async () => {
    await page.goto(`${baseURL}/`);
    await page.getByLabel('Correo electrónico').fill(USER.email);
    await page.getByLabel('Contraseña').fill(USER.password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Mejoramos las herramientas con su uso' })).toBeVisible();
    await page.getByRole('button', { name: 'Entendido' }).click();
    await expect(page.getByRole('heading', { name: 'Mejoramos las herramientas con su uso' })).toHaveCount(0);
  });

  await test.step('cada pantalla lleva ids con la forma estable, con etiqueta y sin ids de negocio', async () => {
    const screens: Array<[string, string]> = [
      ['#/', 'food.inicio'], ['#/eventos', 'food.eventos'], ['#/menus', 'food.menus'], ['#/recetario', 'food.recetario'], ['#/maquinaria', 'food.maquinaria'],
    ];
    for (const [hash, root] of screens) {
      await page.goto(`${baseURL}/${hash}`);
      await expect(page.locator(`main[data-feedback-id="${root}"]`)).toBeVisible();
      const ids = await page.evaluate(() => Array.from(document.querySelectorAll('[data-feedback-id]')).map((n) => n.getAttribute('data-feedback-id') ?? ''));
      expect(ids.length).toBeGreaterThan(8); // cabecera, navegación y la propia pantalla
      for (const id of ids) {
        expect(id, id).toMatch(PATTERN);
        expect(id, id).not.toMatch(UUID);
      }
      const unlabeled = await page.evaluate(() => Array.from(document.querySelectorAll('[data-feedback-id]:not([data-feedback-label])')).map((n) => n.getAttribute('data-feedback-id')));
      expect(unlabeled).toEqual([]);
    }
  });

  await test.step('con el modo apagado la pulsación larga no abre nada', async () => {
    // Sobre la entrada de la pantalla en la que ya se está: al soltar, el clic normal no cambia nada.
    await page.goto(`${baseURL}/#/eventos`);
    await hold(page, '[data-feedback-id="food.navegacion.eventos"]');
    await expect(page.locator('.fb-composer')).toHaveCount(0);
    await expect(page.locator('html.fb-mode')).toHaveCount(0);
    await expect(page.locator('main[data-feedback-id="food.eventos"]')).toBeVisible();
  });

  await test.step('con el modo encendido, la pulsación larga sobre «Crear menú» abre el formulario sin crear el menú', async () => {
    await setSignal(page, true);
    await page.locator('#eventList .row', { hasText: GROUP }).click();
    await hold(page, '#createMenu');
    const composer = page.locator('.fb-composer');
    await expect(composer).toBeVisible();
    await expect(composer.locator('.fb-where strong')).toContainText('Crear menú');
    expect(api.rows('food.menus')).toHaveLength(0);
    await composer.getByRole('textbox', { name: 'Comentario' }).fill('Me gustaría elegir los servicios antes de crear el menú.');
    await composer.getByRole('button', { name: 'Enviar' }).click();
    await expect.poll(() => api.feedbackReports().length).toBe(1);
    const report = api.feedbackReports()[0]!;
    expect(report.originApp).toBe('food');
    expect(report.node?.id).toMatch(PATTERN);
    expect(report.node?.id).toContain('crear_menu');
    // El nombre del grupo viene de Booking: no viaja en el reporte.
    expect(JSON.stringify(report.context)).not.toContain(GROUP);
    expect(String((report.context as { route?: string }).route ?? '')).not.toMatch(UUID);
    await expect(composer).toHaveCount(0, { timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  await test.step('«Sugerencias y QA» desde el panel del lanzador lista el reporte', async () => {
    await page.locator('#appLauncher').click();
    await page.locator('.launcher-center').click();
    const sheet = page.getByRole('dialog', { name: 'Sugerencias y QA' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('tab', { name: 'Abiertos' }).click();
    await expect(sheet.locator('.fb-card')).toContainText(`FB_${new Date().getFullYear()}_0001`);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await setSignal(page, false);
    await expect(page.locator('html.fb-mode')).toHaveCount(0);
  });

  await test.step('crear el menú cuenta como éxito y el total llega al núcleo', async () => {
    await page.goto(`${baseURL}/#/eventos`);
    await page.locator('#eventList .row', { hasText: GROUP }).click();
    await page.locator('#createMenu').click();
    await expect(page).toHaveURL(/#\/menus\/[0-9a-f-]{36}$/);
    await context.setOffline(true);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => api.usageItems().filter((u) => u.featureId === 'food.eventos.crear_menu').reduce((n, u) => n + u.successes, 0), { timeout: 20_000 }).toBeGreaterThan(0);
  });
});

test('feedback · prueba común del kit: enviar con doble toque, se cierra, se ve el aviso y llega un solo reporte @smoke', async ({ page }) => {
  test.setTimeout(90_000);
  // El aviso de medición se abriría al cerrarse el formulario y taparía el lanzador: aquí la cuenta ya lo aceptó.
  api.setUsageConsent(true);
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();

  await test.step('en una pantalla: «Nueva receta» del Recetario', async () => {
    await page.goto(`${baseURL}/#/recetario`);
    const before = api.feedbackReports().length;
    const { code } = await feedbackRoundTrip(page, { target: '#newRecipe' });
    expect(code).toMatch(/^FB_\d{4}_\d+$/);
    await expect.poll(() => api.feedbackReports().length).toBe(before + 1);
    await page.waitForTimeout(1000);
    expect(api.feedbackReports().length, 'el doble toque no envía dos reportes').toBe(before + 1);
  });

  await test.step('con una hoja abierta y el teclado del móvil: el aviso se ve dentro de lo visible', async () => {
    // `feedbackRoundTrip` empieza pulsando el lanzador, y con una hoja abierta el fondo de la hoja lo tapa. Los mismos pasos
    // a mano: el modo se enciende antes de abrir la hoja y se apaga después de cerrarla.
    await page.goto(`${baseURL}/#/maquinaria`);
    await setSignal(page, true);
    await page.locator('#newEquipment').click();
    const dialog = page.getByRole('dialog', { name: 'Nueva máquina' });
    await expect(dialog).toBeVisible();
    const before = api.feedbackReports().length;
    await hold(page, '#equipmentForm label.field > span');
    const composer = page.locator('.fb-composer');
    await expect(composer).toBeVisible();
    await composer.locator('.fb-message').fill('Prueba con la hoja abierta y el teclado');
    await simulateKeyboard(page, 686);
    await composer.locator('.fb-send').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter').catch(() => undefined);
    await expect(composer).toHaveCount(0, { timeout: 8000 });
    const toast = page.locator('.toast.show').filter({ hasText: /Enviado · FB_/ });
    await expect(toast).toBeVisible({ timeout: 8000 });
    const fit = await toast.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const vv = window.visualViewport;
      const top = vv ? vv.offsetTop : 0;
      const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
      return { h: r.height, inside: r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth };
    });
    expect(fit.inside, 'el aviso tiene que verse dentro de lo visible con el teclado abierto').toBe(true);
    expect(fit.h, 'el aviso no puede estirarse en columna').toBeLessThan(90);
    await simulateKeyboard(page, null);
    await expect.poll(() => api.feedbackReports().length).toBe(before + 1);
    await page.waitForTimeout(1000);
    expect(api.feedbackReports().length, 'el doble toque no envía dos reportes').toBe(before + 1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await setSignal(page, false);
  });
});
