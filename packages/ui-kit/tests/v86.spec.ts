import { expect, test } from 'playwright/test';

/** `.segmented` con enlaces (pestañas que son rutas, como en Guests): la misma piel, altura y marca de activa que con botones. */
test('.segmented: los enlaces miden lo mismo que los botones y la activa se marca con .on o aria-current', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const nav = document.createElement('nav');
    nav.className = 'segmented';
    nav.id = 'segLinks';
    nav.innerHTML = '<a href="#a" class="on">El evento</a><a href="#b">Alójate aquí</a><a href="#c" aria-current="page">Otra</a><button type="button">Botón</button>';
    document.body.prepend(nav);
  });
  const [a, b, c, button] = ['a:nth-child(1)', 'a:nth-child(2)', 'a:nth-child(3)', 'button'].map((s) => page.locator(`#segLinks ${s}`));
  const h = (await button!.boundingBox())!.height;
  expect(h).toBeGreaterThanOrEqual(44);
  expect(Math.abs((await a!.boundingBox())!.height - h)).toBeLessThan(1);
  const style = (l: typeof a) => l!.evaluate((n) => { const s = getComputedStyle(n); return [s.textDecorationLine, s.boxShadow !== 'none', s.backgroundColor]; });
  const [deco, shadowOn] = await style(a);
  expect(deco).toBe('none');
  expect(shadowOn).toBe(true);
  expect((await style(c))[1]).toBe(true);
  expect((await style(b))[1]).toBe(false);
});
