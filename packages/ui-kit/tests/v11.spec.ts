import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.8', () => {
  test('la lista reordenable se anida: cada asa mueve solo su lista', async ({ page }) => {
    await page.goto('/#sortable');
    const outer = page.locator('#serviceList');
    const outerOrder = () => outer.locator(':scope > .sortable-row > .sortable-body .row-title .name').allInnerTexts();
    const inner = page.locator('#inner-s1');
    const innerOrder = () => inner.locator(':scope > .sortable-row .name').allInnerTexts();
    expect(await outerOrder()).toEqual(['Comida', 'Cena']);
    expect(await innerOrder()).toEqual(['Crema de calabaza asada', 'Curry de verduras']);
    // Asa interior: sube el curry dentro de la comida; los servicios no se mueven.
    await inner.locator(':scope > .sortable-row > .sortable-handle').nth(1).focus();
    await page.keyboard.press('ArrowUp');
    expect(await innerOrder()).toEqual(['Curry de verduras', 'Crema de calabaza asada']);
    expect(await outerOrder()).toEqual(['Comida', 'Cena']);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'))).toContain('Mover Curry de verduras. Posición 1 de 2');
    await expect(page.locator('#nestOut')).toHaveText('Comida: Curry, Crema | Cena: Ensalada, Bizcocho');
    // Asa exterior: la cena sube por delante de la comida y cada servicio conserva sus platos.
    await outer.locator(':scope > .sortable-row > .sortable-handle').nth(1).focus();
    await page.keyboard.press('ArrowUp');
    expect(await outerOrder()).toEqual(['Cena', 'Comida']);
    expect(await page.locator('#inner-s1').locator(':scope > .sortable-row .name').allInnerTexts()).toEqual(['Curry de verduras', 'Crema de calabaza asada']);
    expect(await page.locator('#inner-s2').locator(':scope > .sortable-row .name').allInnerTexts()).toEqual(['Ensalada de garbanzos', 'Bizcocho de zanahoria']);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'))).toContain('Mover Cena. Posición 1 de 2');
    await expect(page.locator('#nestOut')).toHaveText('Cena: Ensalada, Bizcocho | Comida: Curry, Crema');
  });

  test('select e input sueltos llevan la piel de los campos y .compact los reduce a 36 px', async ({ page }) => {
    await page.goto('/#controls');
    const select = page.locator('#looseSelect');
    const box = await select.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(46);
    const style = await select.evaluate((n) => { const s = getComputedStyle(n); return { border: s.borderTopWidth, appearance: s.appearance, radius: s.borderTopLeftRadius }; });
    expect(style.border).toBe('1px');
    expect(style.appearance).toBe('none');
    expect(style.radius).not.toBe('0px');
    await select.focus();
    expect(await select.evaluate((n) => getComputedStyle(n).boxShadow)).toContain('0px 0px 0px 3px');
    const compact = await page.locator('#looseTime').boundingBox();
    expect(compact!.height).toBeGreaterThanOrEqual(34);
    expect(compact!.height).toBeLessThanOrEqual(38);
    // Los campos del kit no cambian: el buscador del selector de etiquetas sigue en 40 px.
    await page.goto('/#labels');
    const search = await page.locator('#labelHost .lp-search').boundingBox();
    expect(Math.round(search!.height)).toBe(40);
  });
});
