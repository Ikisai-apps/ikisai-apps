import { expect, test, type Page } from 'playwright/test';

/** Banco vacío, con los ejemplos del revisor y el modo como se pida. */
async function fresh(page: Page, { seed = true, reviewing = false, notReviewer = false } = {}): Promise<void> {
  await page.goto('/#feedback');
  await page.evaluate(async ({ seed, reviewing, notReviewer }) => {
    const w = window as any;
    w.ikisaiFeedback.fbSave({ reports: [], posts: 0, offline: false, fail: null, notReviewer });
    if (seed) w.ikisaiFeedback.fbSeed();
    await w.ikisaiFeedback.feedback.clear('demo-user');
    w.ikisaiFeedback.review.mode.set(reviewing);
  }, { seed, reviewing, notReviewer });
  await page.reload();
  await page.locator('#fbOpen').waitFor();
}
const server = (page: Page) => page.evaluate(() => (window as any).ikisaiFeedback.fbState());
const byCode = async (page: Page, code: string) => (await server(page)).reports.find((r: { code: string }) => r.code === code);
const card = (page: Page) => page.locator('.fb-review-card');

test.describe('ui-kit v0.16 · feedback: modo «Revisor de QA»', () => {
  test('el interruptor del lanzador solo aparece si la cuenta puede revisar', async ({ page }) => {
    await fresh(page, { notReviewer: true });
    await page.locator('#demoLauncher').click();
    await expect(page.locator('.launcher-signal')).toBeVisible();
    await expect(page.locator('.launcher-review')).toHaveCount(0);
    await fresh(page);
    await page.locator('#demoLauncher').click();
    await page.locator('.launcher-review').click();
    await expect(page.locator('.launcher-review input')).toBeChecked();
    await expect(page.locator('.fb-review')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains('fb-reviewing'))).toBe(true);
  });

  test('lista lateral con «Por revisar» y «Por comprobar» de todas las apps', async ({ page }) => {
    await fresh(page, { reviewing: true });
    const review = page.locator('.fb-review [data-block="review"]');
    await expect(review.locator('.fb-review-row')).toHaveCount(3);
    await expect(review.locator('[data-code="FB_2026_0101"]')).toContainText('Me bloquea');
    await expect(review.locator('[data-code="FB_2026_0101"] .fb-card-msg')).toHaveText('No añade al segundo huésped');
    await expect(review.locator('[data-code="FB_2026_0102"]')).toContainText('booking');
    await expect(page.locator('.fb-review [data-block="check"] .fb-review-row')).toHaveCount(1);
  });

  test('ir al sitio ilumina el elemento; «Aprobar» guarda y «Siguiente» de otra app abre su dominio con ?fb=', async ({ page }) => {
    await fresh(page, { reviewing: true });
    await page.locator('.fb-review-row[data-code="FB_2026_0101"]').click();
    await expect(page.locator('#fbAction')).toHaveClass(/fb-spot/);
    await expect(card(page).locator('.fb-detail-msg')).toContainText('No añade al segundo huésped');
    await expect(card(page).locator('.fb-rv-steps li')).toHaveCount(2);
    await expect(card(page).locator('.fb-rv-approx')).toHaveCount(0);
    await card(page).locator('.fb-rv-approve').click();
    await expect(page.locator('.toast.show')).toContainText('Aprobado');
    expect((await byCode(page, 'FB_2026_0101')).reviewStatus).toBe('approved');
    // El siguiente de la cola es de Booking: se abre su dominio con el código y el modo.
    await expect(page.locator('#fbOpened')).toHaveText('https://booking.ikisai.com/?fb=FB_2026_0102&qa=1');
    await expect(page.locator('.fb-review [data-block="review"] .fb-review-row')).toHaveCount(2);
  });

  test('si el elemento ya no existe, ancla a la sección; «Unir a…» lo junta con otro', async ({ page }) => {
    await fresh(page, { reviewing: true });
    await page.locator('.fb-review-row[data-code="FB_2026_0103"]').click();
    await expect(page.locator('[data-feedback-id="demo.reservation.guests"]')).toHaveClass(/fb-spot/);
    await expect(card(page).locator('.fb-rv-approx')).toContainText('se muestra su sección');
    await card(page).locator('.fb-rv-merge').click();
    await card(page).locator('.fb-merge-into').fill('FB_2026_0103');
    await card(page).locator('.fb-rv-merge').click();
    await expect(card(page).locator('.fb-status')).toContainText('código del otro reporte');
    await card(page).locator('.fb-merge-into').fill('fb_2026_0101');
    await card(page).locator('.fb-rv-merge').click();
    await expect(page.locator('.toast.show')).toContainText('Unido a FB_2026_0101');
    expect((await byCode(page, 'FB_2026_0103')).mergedInto).toBe('FB_2026_0101');
  });

  test('«Descartar» pide motivo; en «Por comprobar», «Funciona» verifica', async ({ page }) => {
    await fresh(page, { reviewing: true });
    await page.locator('.fb-review-row[data-code="FB_2026_0101"]').click();
    await card(page).locator('.fb-rv-dismiss').click();
    await card(page).locator('.fb-message').fill('Ya está en el plan');
    await card(page).locator('.fb-rv-dismiss').click();
    await expect(page.locator('.toast.show')).toContainText('Descartado');
    expect((await byCode(page, 'FB_2026_0101')).dismissReason).toBe('Ya está en el plan');
    await page.locator('.fb-review-row[data-code="FB_2026_0104"]').click();
    await expect(page.locator('#fbScreen')).toHaveClass(/fb-spot/);
    await expect(card(page).locator('.fb-rv-approve')).toHaveCount(0);
    await card(page).locator('.fb-rv-works').click();
    await expect(page.locator('.toast.show')).toContainText('Verificado');
    expect((await byCode(page, 'FB_2026_0104')).display).toBe('verified');
  });

  test('al arrancar con ?fb=<código>&qa=1 enciende el modo, enseña la tarjeta y limpia la URL', async ({ page }) => {
    await fresh(page);
    await page.goto('/?fb=FB_2026_0101&qa=1#feedback');
    await expect(card(page).locator('.fb-where strong')).toContainText('FB_2026_0101');
    await expect(page.locator('#fbAction')).toHaveClass(/fb-spot/);
    // El modo queda encendido (en móvil la lista se aparta mientras hay tarjeta).
    await expect(page.locator('.fb-review')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.classList.contains('fb-reviewing'))).toBe(true);
    expect(new URL(page.url()).search).toBe('');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('#fbAction')).not.toHaveClass(/fb-spot/);
    await expect(page.locator('.fb-review')).toBeVisible();
  });

  test('el contexto lleva la ruta real (routeRaw) además de la saneada', async ({ page }) => {
    await fresh(page, { seed: false });
    await page.locator('#fbOpen').click();
    await page.locator('.fb-composer .fb-message').fill('Con ruta real');
    await page.locator('.fb-composer .fb-send').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast.show')).toContainText('Enviado');
    const ctx = (await server(page)).reports[0].context;
    expect(ctx.routeRaw).toBe('/#feedback');
    expect(ctx.route).toBe('/feedback');
  });
});
