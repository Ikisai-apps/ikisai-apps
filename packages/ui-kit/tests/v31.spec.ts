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

test('caso de Finance (FB_2026_016/017) @smoke: hoja abierta, teclado abierto y doble toque → un solo reporte, cerrado y con aviso', async ({ page }) => {
  await page.setViewportSize({ width: 484, height: 1008 });
  await fresh(page);
  await page.evaluate(() => {
    const kit = (window as any).ikisaiKit;
    kit.openSheet({ title: 'Nueva factura', body: kit.el('div', { 'data-feedback-id': 'demo.facturas.nueva.formulario', 'data-feedback-label': 'Formulario' },
      kit.el('label', { class: 'field' }, kit.el('span', null, 'Concepto'), kit.el('input', { id: 'concepto' }))) });
  });
  await page.locator('#concepto').focus();
  await page.evaluate(() => (window as any).ikisaiFeedback.feedback.signal(document.querySelector('[data-feedback-id="demo.facturas.nueva.formulario"]')));
  const composer = page.locator('.fb-composer');
  await expect(composer).toBeVisible();
  await composer.locator('.fb-message').fill('No se guarda el concepto');
  const { simulateKeyboard } = await import('../testing/feedback-smoke.ts');
  await simulateKeyboard(page, 686);
  // Dos toques seguidos, como hizo el usuario al no ver el aviso.
  await composer.locator('.fb-send').evaluate((b) => { (b as HTMLButtonElement).click(); (b as HTMLButtonElement).click(); });
  await expect(composer).toHaveCount(0, { timeout: 3_000 });
  const toast = page.locator('.toast.show').filter({ hasText: /Enviado · FB_/ });
  await expect(toast).toBeVisible();
  const inside = await toast.evaluate((n) => { const r = n.getBoundingClientRect(); const vv = window.visualViewport!; return r.top >= vv.offsetTop && r.bottom <= vv.offsetTop + vv.height; });
  expect(inside).toBe(true);
  await page.waitForTimeout(1200);
  const st = await page.evaluate(() => (window as any).ikisaiFeedback.fbState());
  expect(st.reports).toHaveLength(1);
  expect(st.posts).toBe(1);
  // La hoja de la app sigue ahí, con su contenido.
  await expect(page.locator('#concepto')).toBeVisible();
});

test('recorrido común con teclado y doble toque (móvil): un solo reporte', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fresh(page);
  await feedbackRoundTrip(page, { launcher: '#demoLauncher', target: '#fbAction', keyboard: 560 });
  await page.waitForTimeout(800);
  expect((await page.evaluate(() => (window as any).ikisaiFeedback.fbState())).reports).toHaveLength(1);
});
