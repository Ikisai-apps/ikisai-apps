import { expect, test } from 'playwright/test';

/** K24 (KIT_PETICIONES, abierta por Core el 27-10): «Sincronizado» del menú común a 44 px con el dedo; con ratón, igual que antes. */
test('ui-kit v0.69.6 · K24: la línea de sincronización del menú mide 44 px con el dedo', async ({ page }, info) => {
  await page.goto('/');
  const height = await page.evaluate(() => {
    const b = document.createElement('button');
    b.className = 'appmenu-sync';
    b.textContent = 'Sincronizado';
    document.body.append(b);
    const h = b.getBoundingClientRect().height;
    b.remove();
    return h;
  });
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  expect(coarse).toBe(info.project.name === 'movil');
  if (coarse) expect(height).toBeGreaterThanOrEqual(43.5);
  else expect(height).toBeLessThan(43.5);
});
