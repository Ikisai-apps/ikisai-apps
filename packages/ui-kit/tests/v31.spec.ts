import { expect, test, type Page } from 'playwright/test';
import { feedbackRoundTrip } from '../testing/feedback-smoke.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDKgCcAEAANKBQH6PbUeAAAAAElFTkSuQmCC', 'base64');

async function fresh(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.goto('/#feedback');
  await page.evaluate(async (more) => {
    const w = window as any;
    w.ikisaiFeedback.fbSave({ reports: [], posts: 0, offline: false, fail: null, ...more });
    await w.ikisaiFeedback.feedback.clear('demo-user');
    w.ikisaiFeedback.feedback.mode.set(false);
  }, extra);
  await page.reload();
  await page.locator('#fbOpen').waitFor();
}

for (const size of [{ name: 'escritorio 1280×800', width: 1280, height: 800 }, { name: 'móvil 390×844', width: 390, height: 844 }]) {
  test(`recorrido común @smoke (${size.name}): enviar reporte → hoja cerrada → aviso visible`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await fresh(page);
    const { code } = await feedbackRoundTrip(page, { launcher: '#demoLauncher', target: '#fbAction' });
    expect(code).toMatch(/^FB_2026_\d+$/);
  });
}

test('un reporte atascado en la bandeja no deja abierto el composer del siguiente', async ({ page }) => {
  test.setTimeout(60_000);
  await fresh(page);
  // Primer reporte con imagen cuya subida no termina: queda en la bandeja.
  await page.evaluate(() => { const w = window as any; const s = w.ikisaiFeedback.fbState(); s.hangUploads = true; w.ikisaiFeedback.fbSave(s); });
  await page.locator('#fbOpen').click();
  await page.locator('.fb-composer .fb-file').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG });
  await page.locator('.fb-composer .fb-message').fill('Con imagen atascada');
  await page.locator('.fb-composer .fb-send').focus();
  await page.keyboard.press('Enter');
  // Pasado el tiempo máximo, queda pendiente y el composer se cierra.
  await expect(page.locator('.fb-composer')).toHaveCount(0, { timeout: 25_000 });
  // El siguiente, sin imagen, se envía y se cierra enseguida aunque el primero siga atascado.
  await page.locator('#fbOpen').click();
  await page.locator('.fb-composer .fb-message').fill('Sin imagen');
  await page.locator('.fb-composer .fb-send').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.fb-composer')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('.toast.show')).toContainText('Enviado · FB_');
});
