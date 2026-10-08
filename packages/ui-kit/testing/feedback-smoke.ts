/**
 * Prueba común de humo del feedback para **todas las apps** (petición de Core, 8-10-2026): «enviar reporte → hoja
 * cerrada → aviso visible», por la interfaz, como lo haría una persona.
 *
 *   import { feedbackRoundTrip } from '../../packages/ui-kit/testing/feedback-smoke.ts';
 *   test('feedback: enviar, se cierra y se ve el aviso @smoke', async ({ page }) => {
 *     await login(page);
 *     await feedbackRoundTrip(page, { target: '#issuedList' });
 *   });
 *
 * Recorrido:
 * 1. Abre el lanzador (la marca, `#appLauncher`) y enciende «Señalar para comentar» si no lo está.
 * 2. Mantiene pulsado el elemento instrumentado (`target`, o el primero visible con `data-feedback-id` en `main`).
 * 3. Escribe y envía.
 * 4. Comprueba que el composer se cierra solo y que el aviso «Enviado · FB_…» se ve: dentro de la pantalla y del tamaño
 *    de un aviso (ni columna estirada ni fuera de la vista).
 * 5. Apaga el modo otra vez.
 * El servidor de la app (real o simulado) tiene que aceptar `POST /feedback`.
 */
import { expect, type Locator, type Page } from 'playwright/test';

export interface FeedbackRoundTripOptions {
  /** Elemento instrumentado sobre el que comentar; por defecto el primero visible con `data-feedback-id` en `main`. */
  target?: string;
  /** Botón de la marca que abre el lanzador; por defecto `#appLauncher`. */
  launcher?: string;
  /** Texto del comentario. */
  text?: string;
  /** Tiempo máximo para que se cierre el composer y salga el aviso (ms); por defecto 8000. */
  timeout?: number;
  /** Pulsa «Enviar» dos veces seguidas (como el usuario que no ve el aviso); por defecto sí. La app comprueba en su servidor que llega uno. */
  doubleTap?: boolean;
  /** Simula el teclado abierto: alto visible en px (p. ej. 686 en un móvil de 1008). El aviso tiene que verse dentro de lo visible. */
  keyboard?: number;
}

/** Simula el teclado virtual: la vista visual se queda con `visible` px de alto (o se restaura con `null`). */
export async function simulateKeyboard(page: Page, visible: number | null): Promise<void> {
  await page.evaluate((h) => {
    const vv = window.visualViewport;
    if (!vv) return;
    if (h === null) { delete (vv as unknown as Record<string, unknown>).height; delete (vv as unknown as Record<string, unknown>).offsetTop; }
    else {
      Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
      Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    }
    vv.dispatchEvent(new Event('resize'));
  }, visible);
}

async function setMode(page: Page, launcher: string, on: boolean): Promise<void> {
  await page.locator(launcher).first().click();
  const toggle = page.locator('.launcher-signal input');
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await page.locator('.launcher-signal').click();
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
  await expect(page.locator('.sheetback.show')).toHaveCount(0);
}

async function longPress(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await target.hover({ position: { x: Math.min(box.width / 2, 20), y: Math.min(box.height / 2, 20) } });
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
}

export async function feedbackRoundTrip(page: Page, options: FeedbackRoundTripOptions = {}): Promise<{ code: string }> {
  const launcher = options.launcher ?? '#appLauncher';
  const timeout = options.timeout ?? 8000;
  await setMode(page, launcher, true);

  const target = options.target ? page.locator(options.target).first() : page.locator('main [data-feedback-id]:visible').first();
  await longPress(page, target);
  const composer = page.locator('.fb-composer');
  await expect(composer).toBeVisible();
  await composer.locator('.fb-message').fill(options.text ?? 'Prueba de humo del feedback');
  if (options.keyboard) await simulateKeyboard(page, options.keyboard);
  await composer.locator('.fb-send').focus();
  await page.keyboard.press('Enter');
  if (options.doubleTap !== false) await page.keyboard.press('Enter').catch(() => undefined);

  // La hoja (composer) se cierra sola tras el envío correcto…
  await expect(composer).toHaveCount(0, { timeout });
  // …y el aviso se ve: dentro de la pantalla y del tamaño de un aviso.
  const toast = page.locator('.toast.show').filter({ hasText: /Enviado · FB_/ });
  await expect(toast).toBeVisible({ timeout });
  const fit = await toast.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    return { h: r.height, w: r.width, inside: r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth };
  });
  expect(fit.inside, 'el aviso tiene que verse dentro de la pantalla').toBe(true);
  expect(fit.h, 'el aviso no puede estirarse en columna').toBeLessThan(90);
  const code = /FB_\d{4}_\d+/.exec((await toast.textContent()) ?? '')?.[0] ?? '';
  if (options.keyboard) await simulateKeyboard(page, null);

  await setMode(page, launcher, false);
  return { code };
}

export interface PortalHelpRoundTripOptions {
  /** Abre «Ayuda y sugerencias». Por defecto: la marca (`#appLauncher`) y la entrada del lanzador (`.launcher-center`). */
  open?: (page: Page) => Promise<void>;
  /** Respuestas a elegir en orden (texto de cada opción), hasta llegar al paso del comentario. */
  choices: string[];
  text?: string;
  /** Pulsa «Enviar» dos veces seguidas; por defecto sí. */
  doubleTap?: boolean;
  /** Simula el teclado abierto (alto visible en px). */
  keyboard?: number;
  timeout?: number;
}

/**
 * Prueba común de los portales (Organizers, Guests): «Ayuda y sugerencias» → formulario progresivo → enviar con doble
 * toque → la hoja se cierra → el aviso se ve dentro de lo visible. La app comprueba en su servidor que llega uno.
 */
export async function portalHelpRoundTrip(page: Page, options: PortalHelpRoundTripOptions): Promise<void> {
  const timeout = options.timeout ?? 8000;
  if (options.open) await options.open(page);
  else {
    await page.locator('#appLauncher').first().click();
    await page.locator('.launcher-center').click();
  }
  const form = page.locator('.sheetback.show .fb-progressive');
  await expect(form).toBeVisible();
  for (const choice of options.choices) await form.locator('.fb-choice', { hasText: choice }).last().click();
  const message = form.locator('textarea.fb-message');
  await expect(message).toBeVisible();
  await message.fill(options.text ?? 'Prueba de humo de «Ayuda y sugerencias»');
  if (options.keyboard) await simulateKeyboard(page, options.keyboard);
  await form.locator('.fb-send').focus();
  await page.keyboard.press('Enter');
  if (options.doubleTap !== false) await page.keyboard.press('Enter').catch(() => undefined);

  await expect(page.locator('.sheetback.show .fb-progressive')).toHaveCount(0, { timeout });
  const toast = page.locator('.toast.show').filter({ hasText: /Enviado|Sent|Pendiente|Pending/ });
  await expect(toast).toBeVisible({ timeout });
  const fit = await toast.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    return { h: r.height, inside: r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth };
  });
  expect(fit.inside, 'el aviso tiene que verse dentro de lo visible').toBe(true);
  expect(fit.h, 'el aviso no puede estirarse en columna').toBeLessThan(90);
  if (options.keyboard) await simulateKeyboard(page, null);
}
