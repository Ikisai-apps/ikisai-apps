import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.3', () => {
  test('compressImage devuelve WebP de 1600 px y miniatura de 480 px más ligeras que el original', async ({ page }) => {
    await page.goto('/#images');
    await page.locator('#sampleImage').click();
    const info = page.locator('#imageInfo');
    await expect(info).toHaveAttribute('data-mime', /image\/(webp|jpeg)/, { timeout: 20_000 });
    const d = await info.evaluate((node) => ({ ...(node as HTMLElement).dataset }));
    expect(d.width).toBe('1600');
    expect(d.height).toBe('1200');
    expect(d.thumbWidth).toBe('480');
    expect(d.thumbHeight).toBe('360');
    expect(d.mime).toBe('image/webp');
    expect(Number(d.fullSize)).toBeLessThan(Number(d.originalSize) / 4);
    expect(Number(d.thumbSize)).toBeLessThan(Number(d.fullSize));
    await expect(page.locator('#imagePreview img')).toHaveCount(2);
    // La función respeta la orientación y no amplía imágenes pequeñas.
    const small = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 300; c.height = 500;
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
      const kit = (window as unknown as { ikisaiKit: { compressImage: (b: Blob, o: { maxSide: number; thumbSide: number }) => Promise<{ width: number; height: number; thumbWidth: number; thumbHeight: number; filename: string }> } }).ikisaiKit;
      const out = await kit.compressImage(blob, { maxSide: 1600, thumbSide: 480 });
      return [out.width, out.height, out.thumbWidth, out.thumbHeight, out.filename];
    });
    expect(small).toEqual([300, 500, 288, 480, 'foto.webp']);
  });

  test('el calendario navega por mes y semana con botones y teclado', async ({ page }, testInfo) => {
    await page.goto('/#calendar');
    const cal = page.locator('#calendarHost .calendar');
    await expect(cal).toHaveAttribute('data-view', 'month');
    await expect(cal.locator('.cal-day.today')).toHaveCount(1);
    await expect(cal.locator('.cal-day.today .cal-event')).toHaveCount(3);
    const todayEvents = cal.locator('.cal-day.today .cal-event');
    await expect(todayEvents.first()).toHaveAttribute('data-event-id', 'r1');
    await cal.locator('.cal-day.today .cal-num').click();
    await expect(page.locator('.toast.show')).toContainText('3 evento(s)');
    await cal.locator('.cal-day.today .cal-event').first().click();
    await expect(page.locator('.toast.show')).toContainText('Abrir Familia Ortega');
    const title = await cal.locator('.cal-title').innerText();
    await cal.getByRole('button', { name: 'Siguiente' }).click();
    await expect(cal.locator('.cal-title')).not.toHaveText(title);
    await cal.getByRole('button', { name: 'Hoy' }).click();
    await expect(cal.locator('.cal-title')).toHaveText(title);
    // Teclado: la flecha derecha mueve el foco al día siguiente.
    await cal.locator('.cal-day.today').focus();
    await page.keyboard.press('ArrowRight');
    const focusedDay = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.day);
    const tomorrow = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; });
    expect(focusedDay).toBe(tomorrow);
    await page.keyboard.press('PageDown');
    await expect(cal.locator('.cal-title')).not.toHaveText(title);
    await cal.getByRole('button', { name: 'Semana' }).click();
    await expect(cal).toHaveAttribute('data-view', 'week');
    await cal.getByRole('button', { name: 'Hoy' }).click();
    await expect(cal.locator('.cal-day')).toHaveCount(7);
    if (testInfo.project.name === 'escritorio') {
      await expect(cal.locator('.cal-event', { hasText: 'Familia Ortega' }).first()).toBeVisible();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > (visualViewport?.width ?? innerWidth) + 1);
    expect(overflow).toBe(false);
  });

  test('el campo de cantidad entiende la coma, valida y suma con los botones', async ({ page }) => {
    await page.goto('/#quantity');
    const amount = page.locator('#qty-amount');
    await expect(amount).toHaveValue('250');
    await amount.fill('1.250,5');
    await amount.blur();
    await expect(amount).toHaveValue('1250,5');
    await expect(page.locator('#qtyOut')).toContainText('{"value":1250.5,"unit":"g"}');
    await page.locator('#qty-amount-unit').selectOption('kg');
    await expect(page.locator('#qtyOut')).toContainText('"unit":"kg"');
    await amount.fill('abc');
    await amount.blur();
    await expect(page.locator('#qty-amount-error')).toContainText('Escribe un número');
    await amount.fill('12,345');
    await amount.blur();
    await expect(page.locator('#qty-amount-error')).toContainText('1 decimales');
    await amount.fill('100');
    await page.getByRole('button', { name: 'Sumar' }).first().click();
    await expect(amount).toHaveValue('150');
    await amount.focus();
    await page.keyboard.press('ArrowDown');
    await expect(amount).toHaveValue('100');
    const total = page.locator('#qty-total');
    await total.fill('');
    await total.blur();
    await expect(page.locator('#qty-total-error')).toContainText('Indica una cantidad');
    await expect(page.locator('#qty-guests')).toHaveValue('12');
  });
});
