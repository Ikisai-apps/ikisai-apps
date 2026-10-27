import { expect, test, type Page } from 'playwright/test';

/** K19 + K23 (KIT_PETICIONES, abiertas por Core el 27-10): el calendario en el móvil y su contraste en oscuro. */
async function mount(page: Page, opts: { agenda?: boolean; daySheet?: boolean } = {}): Promise<void> {
  await page.goto('/');
  await page.evaluate((opts) => {
    const K = (window as any).ikisaiKit;
    const w = window as any;
    w.picked = [];
    const p = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    w.calDay = day;
    const host = K.el('div', { id: 'k23host' });
    document.body.prepend(host);
    const cal = K.createCalendar({
      label: 'Prueba', feedbackId: 'demo.k23.calendario', legend: true,
      layers: [{ id: 'retiros', label: 'Retiros', color: '#a33b3b' }, { id: 'estancias', label: 'Estancias', color: '#7b4fa0' }],
      events: () => [
        { id: 'e1', title: 'Retiro de otoño', start: day, layer: 'retiros' },
        { id: 'e2', title: 'Estancia de Ana', start: day, layer: 'estancias', badge: '2' },
      ],
      onSelectEvent: (e: { id: string }) => w.picked.push(e.id),
      ...(opts.agenda ? { agenda: true } : {}),
      ...(opts.daySheet === false ? { daySheet: false } : {}),
    });
    host.append(cal.element);
    w.cal = cal;
  }, opts);
  await page.locator('#k23host .cal-day.today').waitFor();
}

test.describe('ui-kit v0.69.8 · K19 + K23: calendario en el móvil', () => {
  test('@smoke con el dedo, el día entero abre una hoja con sus eventos de 46 px; tocar uno lo elige', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'es lo táctil');
    await mount(page);
    await expect(page.locator('#k23host .calendar')).toHaveClass(/cal-touchday/);
    expect(await page.locator('#k23host .cal-day.today .cal-event').first().evaluate((n) => getComputedStyle(n).pointerEvents)).toBe('none');
    await page.locator('#k23host .cal-day.today').click();
    const items = page.locator('.cal-sheet-event');
    await expect(items).toHaveCount(2);
    for (const box of await items.evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(46);
    await expect(items.first()).toContainText('Retiro de otoño');
    await expect(items.nth(1)).toContainText('2 Estancia de Ana');
    await expect(items.nth(1)).toContainText('Estancias');
    await expect(items.first()).toHaveAttribute('data-feedback-id', 'demo.k23.calendario.evento_dia');
    await items.nth(1).click();
    expect(await page.evaluate(() => (window as any).picked)).toEqual(['e2']);
    await expect(page.locator('.cal-sheet-event')).toHaveCount(0);
  });

  test('con panel del día (agenda) o daySheet: false, no hay hoja; con ratón, tampoco', async ({ page }, info) => {
    await mount(page, info.project.name === 'movil' ? { agenda: true } : {});
    await expect(page.locator('#k23host .calendar')).not.toHaveClass(/cal-touchday/);
    await page.locator('#k23host .cal-day.today .cal-num').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.cal-sheet-event')).toHaveCount(0);
    if (info.project.name === 'movil') {
      await mount(page, { daySheet: false });
      await expect(page.locator('#k23host .calendar')).not.toHaveClass(/cal-touchday/);
    }
  });

  test('K19: en oscuro, el texto de los eventos pasa de 4,5:1', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await mount(page);
    // En el mes a 390 px los eventos son tiras de color sin texto (6 px): el texto se ve en la semana.
    await page.evaluate(() => (window as any).cal.setView('week'));
    await page.locator('#k23host .calendar[data-view="week"]').waitFor();
    const ratios = await page.locator('#k23host .cal-event').evaluateAll((ns) => ns.filter((n) => {
      const text = n.querySelector<HTMLElement>('.cal-event-text');
      return !!text && parseFloat(getComputedStyle(text).fontSize) > 0 && text.getBoundingClientRect().height > 0;
    }).map((n) => {
      const parse = (c: string) => { const srgb = /^color\(srgb/.test(c); const m = (c.replace(/^color\(srgb/, '').match(/[\d.]+/g) ?? []).map(Number); const k = srgb ? 255 : 1; return [m[0]! * k, m[1]! * k, m[2]! * k]; };
      const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
      const s = getComputedStyle(n);
      const a = lum(parse(s.color));
      const b = lum(parse(s.backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }));
    expect(ratios.length).toBeGreaterThan(0);
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
  });
});
