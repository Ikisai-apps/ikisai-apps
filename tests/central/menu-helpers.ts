/**
 * Central · ayudantes de prueba del menú lateral (kit 0.47, MUELA-013). Con la columna del ordenador (`menu.column`), los
 * bloques del lanzador («Señalar para comentar», «Sugerencias y QA») están dos veces en la página: en la columna y en el
 * cajón abierto. Estos ayudantes miran solo el cajón (`#appMenu`). `feedbackRoundTrip` es el del kit
 * (`packages/ui-kit/testing/feedback-smoke.ts`) con esa única diferencia; se pidió al kit que lo haga así (PETICIONES P11).
 */
import { expect, type Locator, type Page } from 'playwright/test';
import { acceptUsageNotice, longPress, simulateKeyboard } from '../../packages/ui-kit/testing/feedback-smoke.ts';

/** Abre el cajón del menú con la marca. */
export async function openMenu(page: Page): Promise<Locator> {
  await page.locator('#appLauncher').click();
  const drawer = page.locator('#appMenu');
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Enciende o apaga «Señalar para comentar» desde el cajón y lo cierra. */
export async function setSignal(page: Page, on: boolean): Promise<void> {
  const drawer = await openMenu(page);
  const toggle = drawer.locator('.launcher-signal input');
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await drawer.locator('.launcher-signal').click();
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
  await expect(page.locator('#appMenu')).toHaveCount(0);
}

/** Como `feedbackRoundTrip` del kit: modo encendido, pulsación larga, enviar con doble toque, aviso visible y sin estirarse. */
export async function feedbackRoundTrip(page: Page, options: { target: string; text?: string; keyboard?: number; timeout?: number }): Promise<{ code: string }> {
  const timeout = options.timeout ?? 8000;
  await acceptUsageNotice(page);
  await setSignal(page, true);
  const target = page.locator(options.target).first();
  await longPress(page, target);
  const composer = page.locator('.fb-composer');
  await expect(composer).toBeVisible();
  await composer.locator('.fb-message').fill(options.text ?? 'Prueba de humo del feedback');
  if (options.keyboard) await simulateKeyboard(page, options.keyboard);
  await composer.locator('.fb-send').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter').catch(() => undefined);
  await expect(composer).toHaveCount(0, { timeout });
  const toast = page.locator('.toast.show').filter({ hasText: /Enviado · FB_/ });
  await expect(toast).toBeVisible({ timeout });
  const fit = await toast.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    return { h: r.height, inside: r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth };
  });
  expect(fit.inside, 'el aviso tiene que verse dentro de la pantalla').toBe(true);
  expect(fit.h, 'el aviso no puede estirarse en columna').toBeLessThan(90);
  const code = /FB_\d{4}_\d+/.exec((await toast.textContent()) ?? '')?.[0] ?? '';
  if (options.keyboard) await simulateKeyboard(page, null);
  if (!(await page.locator('.sheetback.show, .dialogback').count())) await setSignal(page, false);
  return { code };
}
