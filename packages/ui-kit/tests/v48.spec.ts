import { expect, test, type Page } from 'playwright/test';

/** Toque real por CDP (como en v39): pasa por el reconocedor de gestos de Chromium, como en Android. */
async function touchSwipe(page: Page, from: { x: number; y: number }, dx: number, dy = 0): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / 10, y: from.y + (dy * i) / 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Tanda 27, lote B1 (MUELA-075): portada y foco, portada con flechas, lo primero en grande, lo de ahora y precios. */
test.describe('ui-kit v0.43 · piezas compuestas B1', () => {
  test('@smoke portada: abre, píldora y cifras escritas, caras decorativas', async ({ page }) => {
    await page.goto('/#piecesb');
    const cover = page.locator('#coverHost .cover-box').first();
    await expect(cover).toHaveAttribute('aria-label', 'Huerta de otoño');
    await expect(cover.locator('.cover-pill')).toHaveText('Vence el 30 oct');
    await expect(cover.locator('.cover-stats')).toHaveText('5 pendientes · 1 vencida · 40 % hecho');
    await expect(cover.locator('.cover-faces')).toHaveAttribute('aria-hidden', 'true');
    await cover.getByRole('button', { name: /Huerta de otoño/ }).click();
    await expect(page.locator('#coverOpened')).toHaveText('huerta');
    await expect(page.locator('#coverHost .cover-box').nth(1).getByRole('button')).toHaveCount(0);
  });

  test('@smoke foco: una tarjeta cada vez, «Siguiente ›» rota y anuncia, «✓ Hecha» la quita', async ({ page }) => {
    await page.goto('/#piecesb');
    const focus = page.locator('#focusHost');
    await expect(focus.locator('.focus-card')).toHaveCount(1);
    await expect(focus.locator('.focus-ghost')).toHaveCount(2);
    await expect(focus.locator('.focus-count')).toHaveText('1 de 3 por hacer');
    await expect(focus.locator('.focus-card')).toHaveAttribute('data-tone', 'alert');
    const done = focus.getByRole('checkbox', { name: 'Marcar hecha: Podar los rosales' });
    expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await focus.getByRole('button', { name: 'Siguiente ›' }).click();
    await expect(focus.locator('.focus-title')).toHaveText('Comprar abono');
    await expect(focus.locator('.focus-count')).toHaveText('2 de 3 por hacer');
    await expect(focus.getByRole('button', { name: 'Siguiente ›' })).toBeFocused();
    await focus.getByRole('button', { name: 'Abrir' }).click();
    await expect(page.locator('#focusOpened')).toHaveText('t2');
    await focus.getByRole('checkbox', { name: /Comprar abono/ }).click();
    await expect(focus.locator('.focus-count')).toHaveText(/de 2 por hacer/);
    await expect(focus.locator('.focus-ghost')).toHaveCount(1);
    for (let i = 0; i < 2; i += 1) await focus.getByRole('checkbox').click();
    await expect(focus.locator('.focus-done')).toContainText('Todo hecho');
    await expect(focus.locator('.focus-done')).toContainText('Añade una tarea abajo si falta algo.');
  });

  test('@smoke portada con flechas: carrusel accesible, flechas, puntos, teclado y deslizar', async ({ page }, info) => {
    await page.goto('/#piecesb');
    const box = page.locator('#carouselHost .cover-carousel');
    await expect(box).toHaveAttribute('aria-roledescription', 'carrusel');
    await expect(box.locator('.cover-slide')).toHaveAttribute('aria-label', '2 de 3: Yoga de otoño');
    await expect(box.locator('.cover-slide')).toHaveAttribute('aria-roledescription', 'diapositiva');
    await expect(box.locator('.cover-dot[aria-current="true"]')).toHaveAttribute('aria-label', 'Yoga de otoño, Ahora · hasta el viernes');
    await box.getByRole('button', { name: 'Siguiente' }).click();
    await expect(page.locator('#carouselAt')).toHaveText('r3');
    await expect(box.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    await expect(box.locator('[aria-live="polite"]')).toHaveText('3 de 3: Retiro de invierno');
    await box.getByRole('button', { name: /Silencio de noviembre/ }).click();
    await expect(page.locator('#carouselAt')).toHaveText('r1');
    await expect(box.locator('.cover-title')).toBeFocused();
    await expect(box.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#carouselAt')).toHaveText('r2');
    // Deslizar a la izquierda pasa a la siguiente; un gesto corto o vertical, no.
    // En el móvil, la cabecera fija de la demo (muy alta) taparía la portada y el toque no llegaría.
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    await box.locator('.cover-slide').scrollIntoViewIfNeeded();
    // Medir cuando deja de moverse (el desplazamiento de la demo es suave).
    let slide = (await box.locator('.cover-slide').boundingBox())!;
    await expect.poll(async () => { const now = (await box.locator('.cover-slide').boundingBox())!; const still = now.y === slide.y; slide = now; return still; }).toBe(true);
    const y = slide.y + slide.height / 2;
    const swipe = async (x: number, dx: number, dy: number) => {
      if (info.project.name === 'movil') { await touchSwipe(page, { x, y }, dx, dy); return; }
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 5 });
      await page.mouse.up();
    };
    await swipe(slide.x + slide.width - 30, -200, 10);
    await expect(page.locator('#carouselAt')).toHaveText('r3');
    // Un gesto corto o sobre todo vertical no pasa de portada.
    await swipe(slide.x + 60, 30, 40);
    await expect(page.locator('#carouselAt')).toHaveText('r3');
    expect((await box.getByRole('button', { name: 'Anterior' }).boundingBox())!.height).toBeGreaterThanOrEqual(46);
  });

  test('@smoke lo primero en grande: tres tarjetas, cola desde el 4 y «Ver N más»', async ({ page }) => {
    await page.goto('/#piecesb');
    const lead = page.locator('#leadHost .lead-box');
    await expect(lead.locator('.lead-head')).toHaveText('Lo primero · 6 piden atención');
    await expect(lead.locator('.lead-card')).toHaveCount(3);
    await expect(lead.locator('.lead-card').first().getByRole('heading')).toHaveText('1. Pagar a la gestoría');
    await expect(lead.locator('.lead-card').first()).toHaveAttribute('data-tone', 'alert');
    await expect(lead.locator('.lead-queue')).toHaveAttribute('start', '4');
    await expect(lead.locator('.lead-line')).toHaveCount(2);
    const more = lead.getByRole('button', { name: 'Ver 1 más' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(lead.locator('.lead-line')).toHaveCount(3);
    await expect(lead.getByRole('button', { name: 'Ver menos' })).toHaveAttribute('aria-expanded', 'true');
    await lead.getByRole('button', { name: 'Abrir Revisar la caldera' }).click();
    await expect(page.locator('#leadOpened')).toHaveText('l2');
    await expect(lead.getByRole('checkbox', { name: 'Marcar hecha: Llamar al fontanero' })).toBeVisible();
  });

  test('@smoke lo de ahora: avance, lo siguiente, lo hecho escondido y lo de dentro al abrir', async ({ page }) => {
    await page.goto('/#piecesb');
    const now = page.locator('#nowHost');
    await expect(now.getByRole('region', { name: 'Ahora' })).toContainText('Quedan 54 min');
    await expect(now.getByRole('progressbar', { name: 'Avance' })).toHaveAttribute('aria-valuenow', '40');
    await expect(now.getByRole('region', { name: 'Lo siguiente' })).toContainText('13:30 · Comida');
    await expect(now.locator('.now-fold')).toHaveCount(2);
    await expect(now.locator('.now-fold').first()).toContainText('Más tarde');
    const toggle = now.getByRole('button', { name: 'Ver lo ya hecho (2)' });
    await toggle.click();
    await expect(now.locator('.now-fold')).toHaveCount(4);
    await expect(now.locator('.now-fold').first()).toContainText('Hecho');
    await expect(now.getByRole('button', { name: 'Ocultar lo ya hecho' })).toHaveAttribute('aria-expanded', 'true');
    const yoga = now.locator('.now-fold[data-id="p3"]');
    await expect(yoga.locator('.now-fold-body')).toBeEmpty();
    await yoga.locator('summary').click();
    await expect(yoga.locator('.now-fold-body')).toContainText('Sala Olivo');
    expect((await yoga.locator('summary').boundingBox())!.height).toBeGreaterThanOrEqual(46);
  });

  test('@smoke calendario de precios: precio bajo el número y el tono dicho con palabras', async ({ page }) => {
    await page.goto('/#piecesb');
    const cal = page.locator('#priceCalHost');
    const cheap = cal.locator('.cal-day[data-day="2026-11-06"]');
    await expect(cheap.locator('.cal-price')).toHaveText('80 €');
    await expect(cheap).toHaveClass(/cal-tone-low/);
    await expect(cheap).toHaveAttribute('aria-label', /80 €, el más barato/);
    const high = cal.locator('.cal-day[data-day="2026-11-27"]');
    await expect(high).toHaveClass(/cal-tone-high/);
    await expect(high).toHaveAttribute('aria-label', /95 €, temporada alta/);
    await expect(cal.locator('.cal-day[data-day="2026-11-20"]')).not.toHaveClass(/cal-tone-/);
    await high.click();
    await expect(cal.locator('.cal-agenda-price')).toHaveText('95 € · temporada alta');
  });

  test('ni la sección ni la página se salen de lado en el móvil', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'solo en móvil');
    await page.goto('/#piecesb');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});
