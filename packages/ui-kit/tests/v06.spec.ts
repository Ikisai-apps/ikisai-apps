import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.5', () => {
  test('la página imprimible se estructura por días, servicios y platos, y se imprime limpia en A4', async ({ page }) => {
    await page.goto('/#print');
    const pp = page.locator('#printHost .print-page');
    await expect(pp).toHaveAttribute('data-draft', 'true');
    await expect(pp.locator('.pp-draft')).toHaveText('BORRADOR');
    await expect(pp.locator('.pp-title h1')).toHaveText('Retiro de yoga · otoño');
    // La marca de borrador va superpuesta: la cabecera empieza en el margen de la hoja, no 6 cm más abajo.
    const [pageBox, headBox] = await Promise.all([pp.boundingBox(), pp.locator('.pp-head').boundingBox()]);
    expect(headBox!.y - pageBox!.y).toBeLessThan(80);
    await expect(pp.locator('.pp-section')).toHaveCount(2);
    await expect(pp.locator('.pp-group')).toHaveCount(4);
    await expect(pp.locator('.pp-item')).toHaveCount(8);
    await expect(pp.locator('.pp-item.with-image img')).toHaveCount(6);
    await expect(pp.locator('.pp-empty')).toContainText('Pendiente de confirmar');
    await expect(pp.locator('.pp-item', { hasText: 'Curry de verduras' }).locator('.chip.alert')).toHaveText('Apio');
    await page.locator('#togglePrintDraft').click();
    await expect(page.locator('#printHost .print-page')).toHaveAttribute('data-draft', 'false');
    await expect(page.locator('#printHost .pp-draft')).toHaveCount(0);
    // Imprimir: espera a las imágenes y llama a window.print.
    await page.evaluate(() => { (window as unknown as { __printed: number }).__printed = 0; window.print = () => { (window as unknown as { __printed: number }).__printed += 1; }; });
    await page.locator('#printPage').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
    await expect(page.locator('#printPage')).toBeEnabled();
    // Medio de impresión: sin barra de acciones, saltos por sección y tarjetas que no se parten.
    await page.emulateMedia({ media: 'print' });
    const printed = await page.evaluate(() => {
      const first = document.querySelector('#printHost .pp-item') as HTMLElement;
      const second = document.querySelectorAll('#printHost .pp-section')[1] as HTMLElement;
      const bar = document.querySelector('#printHost .print-actions') as HTMLElement;
      const head = document.querySelector('.demo-head') as HTMLElement;
      return { actions: getComputedStyle(bar).display, breakInside: getComputedStyle(first).breakInside, breakBefore: getComputedStyle(second).breakBefore, shadow: getComputedStyle(document.querySelector('#printHost .print-page')!).boxShadow, headVisible: getComputedStyle(head).display };
    });
    expect(printed.actions).toBe('none');
    expect(printed.breakInside).toBe('avoid');
    expect(printed.breakBefore).toBe('page');
    expect(printed.shadow).toBe('none');
    await page.emulateMedia({ media: 'screen' });
  });
});
