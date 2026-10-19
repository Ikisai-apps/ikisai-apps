import { expect, test } from 'playwright/test';
import { timelineSpan, timelineWindow } from '../src/pieces/timeline.ts';

/** Tanda 27, lote B3 (MUELA-075): extracto, tu año en una línea de tiempo y agenda por horas. */
test.describe('ui-kit v0.45 · piezas B3', () => {
  test('@smoke ventana del año y posición de cada tramo, recortado por los lados', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const win = timelineWindow('2026-10-19');
    expect(win).toEqual({ start: '2026-10-01', end: '2027-10-01' });
    const days = 365;
    const s = timelineSpan('2026-10-01', '2026-10-31', win)!;
    expect(s.left).toBe(0);
    expect(s.width).toBeCloseTo((31 / days) * 100, 5);
    expect(s.cutStart || s.cutEnd).toBe(false);
    const before = timelineSpan('2026-09-25', '2026-10-05', win)!;
    expect(before).toMatchObject({ left: 0, cutStart: true, cutEnd: false });
    expect(before.width).toBeCloseTo((5 / days) * 100, 5);
    expect(timelineSpan('2027-09-20', '2027-10-30', win)).toMatchObject({ cutEnd: true });
    expect(timelineSpan('2026-01-01', '2026-02-01', win)).toBeNull();
  });

  test('@smoke extracto: lo que queda en grande, lo próximo y los movimientos por meses', async ({ page }) => {
    await page.goto('/#piecesb3');
    const st = page.locator('#statementHost .mb-statement');
    await expect(st).toHaveAttribute('aria-label', 'Te queda por pagar');
    await expect(st.locator('.mb-total .mb-amount')).toHaveText(/1680,00\s€/);
    await expect(st.locator('.mb-total')).toContainText('de 2.400,00 € contratados');
    await expect(st.getByRole('region', { name: 'Próximamente' }).locator('.mb-move')).toHaveClass(/mb-due/);
    await expect(st.locator('.mb-monthh')).toHaveText(['Octubre de 2026', 'Septiembre de 2026']);
    const paid = st.locator('.mb-move[data-move="p1"]');
    await expect(paid).toHaveClass(/mb-in/);
    await expect(paid).toContainText(/\+720,00\s€/);
    await expect(paid).toContainText('Pagado');
    await st.getByRole('button', { name: /Factura F1-2026-031/ }).click();
    await expect(page.locator('#stmtOpened')).toHaveText('f1');
    expect((await paid.locator('.mb-open').boundingBox())!.height).toBeGreaterThanOrEqual(46);
  });

  test('@smoke tu año: región que se desliza, retiros, pistas, hoy, choques con nombre y el resumen en texto', async ({ page }, info) => {
    await page.goto('/#piecesb3');
    const year = page.locator('#yearHost .year-box');
    await expect(year.getByRole('region')).toHaveAttribute('aria-label', /^Tu año, de octubre de 2026 a septiembre de 2027\. Se desliza en horizontal\.$/);
    await expect(year.locator('.year-month')).toHaveCount(12);
    await expect(year.locator('.year-person')).toHaveCount(2);
    const clash = year.getByRole('button', { name: 'Ana López · 3–20 nov · Hab 3 · choca con Luis Pérez' });
    await expect(clash).toHaveClass(/year-clash/);
    await expect(clash.locator('.year-bang')).toHaveText('!');
    const box = (await clash.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(46);
    expect(box.width).toBeGreaterThanOrEqual(46);
    await clash.click();
    await expect(page.locator('#yearOpened')).toHaveText('s2');
    await expect(year.getByRole('img', { name: /ya pasó/ })).toHaveClass(/year-past/);
    await expect(year.getByRole('img', { name: /ya pasó/ })).toHaveClass(/year-cut-start/);
    await expect(year.locator('.year-person .year-today')).toHaveCount(2);
    await year.getByRole('button', { name: /Retiro: Yoga de otoño/ }).click();
    await expect(page.locator('#yearOpened')).toHaveText('r1');
    await expect(year.locator('.year-summary li')).toHaveText(['Octubre de 2026: 5 noches ocupadas', 'Noviembre de 2026: 24 noches ocupadas', 'Diciembre de 2026: 2 noches ocupadas']);
    const scroll = year.locator('.year-scroll');
    const wide = await scroll.evaluate((n) => n.scrollWidth > n.clientWidth + 1);
    expect(wide).toBe(info.project.name === 'movil');
  });

  test('@smoke agenda por horas: lo hecho plegado, la raya de ahora, lo de ahora y lo siguiente marcados', async ({ page }) => {
    await page.goto('/#piecesb3');
    const h = page.locator('#hoursHost');
    const earlier = h.locator('.hour-earlier');
    await expect(earlier.locator('summary')).toHaveText('2 actividades antes');
    await expect(earlier.locator('.hour-item').first()).toBeHidden();
    await earlier.locator('summary').click();
    await expect(earlier.locator('.hour-item')).toHaveCount(2);
    await expect(h.locator('.hour-nowline')).toHaveAttribute('aria-label', 'Ahora · 12:20');
    const now = h.locator('.hour-now');
    await expect(now).toContainText('Paseo al río');
    await expect(now).toContainText('Puerta norte · hasta las 13:30');
    await expect(now.locator('.hour-chip')).toHaveText('Ahora');
    await expect(h.locator('.hour-next .hour-chip')).toHaveText('Después');
    await expect(h.locator('.hour-kind-meal')).toHaveCount(2);
    const order = await h.locator(':scope > .hour-box > .hour-list > li').evaluateAll((n) => n.map((x) => x.className.split(' ')[0]));
    expect(order[0]).toBe('hour-nowline');
  });

  test('ni la sección ni la página se salen de lado en el móvil', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'solo en móvil');
    await page.goto('/#piecesb3');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});
