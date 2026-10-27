import { expect, test } from 'playwright/test';

/** K4 (KIT_PETICIONES, abierta por Core el 27-10): las filas horizontales avisan de que hay más, y solo cuando desbordan. */
test.describe('ui-kit v0.69.7 · K4: pista de desplazamiento', () => {
  test('@smoke la fila marca el borde con más contenido, cambia al desplazar y no marca nada si cabe', async ({ page }) => {
    await page.goto('/');
    const marks = () => page.evaluate(() => { const r = document.getElementById('k4row')!; return [r.hasAttribute('data-more-start'), r.hasAttribute('data-more-end')]; });
    await page.evaluate(() => {
      const K = (window as any).ikisaiKit;
      const row = K.el('div', { class: 'scrollrow', id: 'k4row', style: 'width:220px' },
        ...Array.from({ length: 10 }, (_, i) => K.el('button', { type: 'button', class: 'chip' }, `Filtro ${i + 1}`)));
      document.body.prepend(row);
      (window as any).stopK4 = K.watchScrollHint(row);
    });
    await expect.poll(marks).toEqual([false, true]);
    // El borde del final se difumina (máscara), el del principio no.
    expect(await page.locator('#k4row').evaluate((n) => getComputedStyle(n).maskImage || (getComputedStyle(n) as any).webkitMaskImage)).toContain('linear-gradient');
    await page.locator('#k4row').evaluate((n) => { n.scrollLeft = 60; });
    await expect.poll(marks).toEqual([true, true]);
    await page.locator('#k4row').evaluate((n) => { n.scrollLeft = n.scrollWidth; });
    await expect.poll(marks).toEqual([true, false]);
    // Si deja de desbordar (quitando chips), no queda ninguna marca.
    await page.locator('#k4row').evaluate((n) => { while (n.children.length > 1) n.lastElementChild!.remove(); n.scrollLeft = 0; });
    await expect.poll(marks).toEqual([false, false]);
    await page.evaluate(() => (window as any).stopK4());
  });

  test('installScrollHints vigila también las filas que aparecen después (como hace la cáscara)', async ({ page }) => {
    await page.goto('/');
    const has = await page.evaluate(async () => {
      const K = (window as any).ikisaiKit;
      const host = K.el('div', { id: 'k4host' });
      document.body.prepend(host);
      const stop = K.installScrollHints(host);
      host.append(K.el('div', { class: 'scrollrow', id: 'k4late', style: 'width:150px' }, ...Array.from({ length: 8 }, (_, i) => K.el('span', { class: 'chip' }, `Chip ${i}`))));
      await new Promise((r) => setTimeout(r, 200));
      const end = document.getElementById('k4late')!.hasAttribute('data-more-end');
      stop();
      return [end, document.getElementById('k4late')!.hasAttribute('data-more-end')];
    });
    expect(has).toEqual([true, false]);
  });
});
