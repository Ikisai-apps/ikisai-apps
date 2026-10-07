import { expect, test, type Page } from 'playwright/test';

/** Piloto de Booking (build 251): FB_2026_002 (pin) y FB_2026_003 (punto de la marca). */
async function fresh(page: Page, mode = true): Promise<void> {
  await page.goto('/#feedback');
  await page.evaluate(async (on) => {
    const w = window as any;
    w.ikisaiFeedback.fbSave({ reports: [], posts: 0, offline: false, fail: null });
    await w.ikisaiFeedback.feedback.clear('demo-user');
    w.ikisaiFeedback.feedback.mode.set(on);
    w.ikisaiFeedback.review.mode.set(false);
  }, mode);
  await page.reload();
  await page.locator('#fbOpen').waitFor();
}
const composer = (page: Page) => page.locator('.fb-composer');

test.describe('ui-kit v0.18.3 · piloto: pines y punto de la marca', () => {
  test('FB_2026_002: tras enviar, el elemento queda marcado con «tus sugerencias»; al tocarlo se ven y se puede añadir otra', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Este cuadro solo debería salir en la web');
    await composer(page).locator('.fb-send').focus();
    await page.keyboard.press('Enter');
    await expect(composer(page)).toHaveCount(0);
    const mine = page.locator('.fb-pin.mine[data-node="demo.reservation.guests.add"]');
    await expect(mine).toBeVisible();
    await expect(mine).toContainText('1');
    await mine.click();
    await expect(composer(page).locator('.fb-dupes')).toContainText('Ya hay 1 reporte abierto aquí');
    // Un borrador en el mismo elemento: los dos pines, uno al lado del otro.
    await composer(page).locator('.fb-new').click();
    await composer(page).locator('.fb-message').fill('Otra idea a medias');
    await page.keyboard.press('Escape');
    const draft = page.locator('.fb-pin.draft[data-node="demo.reservation.guests.add"]');
    await expect(draft).toBeVisible();
    const [a, b] = [await draft.boundingBox(), await mine.boundingBox()];
    expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(30);
  });

  test('FB_2026_002: con una copia oculta del mismo id, el pin va al elemento visible', async ({ page }) => {
    await fresh(page);
    await page.evaluate(() => {
      const ghost = document.createElement('button');
      ghost.setAttribute('data-feedback-id', 'demo.reservation.guests.add');
      ghost.style.display = 'none';
      document.querySelector('#fbScreen')!.prepend(ghost);
    });
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Borrador');
    await page.locator('.fb-catcher').click({ position: { x: 5, y: 5 } });
    const pin = page.locator('.fb-pin.draft[data-node="demo.reservation.guests.add"]');
    await expect(pin).toBeVisible();
    // Las dos posiciones en el mismo instante (el pin se repinta al desplazar).
    await expect.poll(() => page.evaluate(() => {
      const p = document.querySelector('.fb-pin.draft[data-node="demo.reservation.guests.add"]')?.getBoundingClientRect();
      const t = document.querySelector('#fbAction')!.getBoundingClientRect();
      return p ? Math.round(Math.abs(p.top - Math.max(4, t.top - 10))) : 99;
    })).toBeLessThan(3);
  });

  test('FB_2026_003: el modo se explica (aviso al activarlo, «· activo» en el lanzador y título en la marca)', async ({ page }) => {
    await fresh(page, false);
    await page.evaluate(() => {
      const mark = document.createElement('button');
      mark.id = 'appLauncher';
      mark.setAttribute('aria-label', 'Abrir otra app de Ikisai');
      document.body.prepend(mark);
    });
    await page.locator('#demoLauncher').click();
    await expect(page.locator('.launcher-signal strong')).toHaveText('Señalar para comentar');
    await page.locator('.launcher-signal').click();
    await expect(page.locator('.launcher-signal strong')).toHaveText('Señalar para comentar · activo');
    await expect(page.locator('.launcher-signal small')).toContainText('punto amarillo');
    await expect(page.locator('.toast.show')).toContainText('el punto amarillo de la marca lo recuerda');
    await expect(page.locator('#appLauncher')).toHaveAttribute('title', /Señalar para comentar: activo/);
    await expect(page.locator('#appLauncher')).toHaveAttribute('aria-label', /Abrir otra app de Ikisai\. Señalar para comentar: activo/);
    await page.locator('.launcher-signal').click();
    await expect(page.locator('#appLauncher')).not.toHaveAttribute('title', /.+/);
  });

  test('los pasos «abrió» llevan el nodo de la pantalla (fallbackNode)', async ({ page }) => {
    await fresh(page, false);
    await page.evaluate(() => { location.hash = '#cards'; });
    await page.waitForTimeout(100);
    await page.evaluate(() => { location.hash = '#feedback'; });
    await page.waitForTimeout(100);
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Con pasos');
    await composer(page).locator('.fb-send').focus();
    await page.keyboard.press('Enter');
    await expect(composer(page)).toHaveCount(0);
    const steps = (await page.evaluate(() => (window as any).ikisaiFeedback.fbState())).reports[0].context.steps as { action: string; node?: string; route: string }[];
    const opened = steps.filter((s) => s.action === 'abrió');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((s) => s.node === 'demo.feedback')).toBe(true);
  });
});
