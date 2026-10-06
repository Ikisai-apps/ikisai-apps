import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.6', () => {
  test('la lista se reordena con botones, teclado y arrastre, y calcula position', async ({ page }, testInfo) => {
    await page.goto('/#sortable');
    const list = page.locator('#dishList');
    const order = () => list.locator('.sortable-row .name').allInnerTexts();
    expect(await order()).toEqual(['Crema de calabaza asada', 'Curry de verduras', 'Ensalada de garbanzos', 'Bizcocho de zanahoria']);
    await expect(list.locator('.sortable-row').first().getByRole('button', { name: 'Subir Crema de calabaza asada' })).toBeDisabled();
    // Botones: bajar el primero.
    await list.getByRole('button', { name: 'Bajar Crema de calabaza asada' }).click();
    expect(await order()).toEqual(['Curry de verduras', 'Crema de calabaza asada', 'Ensalada de garbanzos', 'Bizcocho de zanahoria']);
    await expect(page.locator('.toast.show')).toContainText('de 1 a 2 (position 2560)');
    await expect(page.locator('#sortOut')).toHaveText('Curry → Crema → Ensalada → Bizcocho');
    // Teclado sobre el asa: Fin lleva al final, flecha arriba sube uno; el foco sigue al asa movida.
    const handle = list.locator('.sortable-row', { hasText: 'Curry de verduras' }).locator('.sortable-handle');
    await handle.focus();
    await page.keyboard.press('End');
    expect(await order()).toEqual(['Crema de calabaza asada', 'Ensalada de garbanzos', 'Bizcocho de zanahoria', 'Curry de verduras']);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'))).toContain('Mover Curry de verduras. Posición 4 de 4');
    await page.keyboard.press('ArrowUp');
    expect(await order()).toEqual(['Crema de calabaza asada', 'Ensalada de garbanzos', 'Curry de verduras', 'Bizcocho de zanahoria']);
    await expect(page.locator('#sortHost [aria-live]')).toContainText('Curry de verduras, posición 3 de 4');
    // Arrastre con el ratón (en el proyecto móvil el puntero es táctil y requiere pulsación mantenida; se prueba en escritorio).
    if (testInfo.project.name === 'escritorio') {
      await page.evaluate(() => document.querySelector('#dishList')!.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(150);
      const from = await list.locator('.sortable-row', { hasText: 'Bizcocho' }).locator('.sortable-handle').boundingBox();
      const target = await list.locator('.sortable-row', { hasText: 'Crema' }).boundingBox();
      await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
      await page.mouse.down();
      await page.mouse.move(from!.x + from!.width / 2, from!.y - 20, { steps: 4 });
      await page.mouse.move(target!.x + 60, target!.y + 6, { steps: 8 });
      await expect(list.locator('.sortable-row', { hasText: 'Crema' })).toHaveClass(/drop-before/);
      await page.mouse.up();
      expect(await order()).toEqual(['Bizcocho de zanahoria', 'Crema de calabaza asada', 'Ensalada de garbanzos', 'Curry de verduras']);
      await expect(page.locator('.sortable-ghost')).toHaveCount(0);
      await expect(page.locator('.toast.show')).toContainText('position 1536');
    }
  });
});
