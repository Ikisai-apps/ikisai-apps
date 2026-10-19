import { expect, test, type Page } from 'playwright/test';
import { withReturnTo } from '../src/shell/return-to.ts';

const back = (page: Page) => page.evaluate(() => new Promise<void>((r) => { addEventListener('popstate', () => setTimeout(r, 80), { once: true }); history.back(); }));
const mount = (page: Page, returnTo: boolean) => page.evaluate((rt) => {
  const root = document.createElement('div');
  root.id = 'returnShell';
  document.body.prepend(root);
  (window as any).ikisaiKit.createAppShell(root, { appName: 'Food', nav: [{ hash: '#/', label: 'Inicio', icon: 'home' }], navigate: (h: string) => { location.hash = h; }, ...(rt ? { returnTo: { feedbackId: 'food.cabecera.volver' } } : {}) });
}, returnTo);

/** Tanda 28, K9 (MUELA-013): «‹ Volver a…» entre apps. */
test.describe('ui-kit v0.48 · volver a la app de la que se vino', () => {
  test('@smoke el enlace con la vuelta: desde, volver y titulo en el hash o en la búsqueda', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'función pura: una vez basta');
    expect(withReturnTo('https://food.ikisai.com/#/menus', { from: 'central', title: 'Cumplimiento', url: 'https://central.ikisai.com/#/cumplimiento' }))
      .toBe('https://food.ikisai.com/#/menus?desde=central&volver=https%3A%2F%2Fcentral.ikisai.com%2F%23%2Fcumplimiento&titulo=Cumplimiento');
    expect(withReturnTo('https://food.ikisai.com/menus?x=1', { from: 'central', url: 'https://central.ikisai.com/' }))
      .toBe('https://food.ikisai.com/menus?x=1&desde=central&volver=https%3A%2F%2Fcentral.ikisai.com%2F');
  });

  test('@smoke al llegar con `volver`: «‹ Volver a…» arriba, la URL limpia y «atrás» desde el inicio vuelve sin preguntar', async ({ page }) => {
    const volver = encodeURIComponent('/?vuelta=1#/cumplimiento');
    await page.goto(`/#/?desde=central&volver=${volver}&titulo=Cumplimiento`);
    await mount(page, true);
    const link = page.locator('#returnShell .return-link');
    await expect(link).toHaveText('Volver a Cumplimiento');
    await expect(link).toHaveAttribute('href', '/?vuelta=1#/cumplimiento');
    await expect(link).toHaveAttribute('data-feedback-id', 'food.cabecera.volver');
    expect(new URL(page.url()).hash).toBe('#/?desde=central');
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    // Primer «atrás»: al inicio de la app (se llegó a `#/?desde=…`, que no es el inicio). Segundo: a la app de origen,
    // sin «¿Cerrar la app?».
    await back(page);
    expect(new URL(page.url()).hash).toBe('#/');
    await Promise.all([page.waitForURL(/vuelta=1/), page.evaluate(() => history.back())]);
    expect(new URL(page.url()).search).toBe('?vuelta=1');
    await expect(page.locator('.dialog')).toHaveCount(0);
  });

  test('`desde` sola (Booking → Finance) no se toca; una vuelta fuera de Ikisai no cuenta', async ({ page }) => {
    await page.goto('/#/facturas?vista=emitidas&desde=booking:reservation:abc');
    await mount(page, true);
    await expect(page.locator('#returnShell .return-link')).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('#/facturas?vista=emitidas&desde=booking:reservation:abc');
    await page.goto(`/#/?desde=x&volver=${encodeURIComponent('https://example.com/')}`);
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await mount(page, true);
    await expect(page.locator('#returnShell .return-link')).toHaveCount(0);
  });

  test('sin `returnTo`, nada cambia: ni enlace ni la URL', async ({ page }) => {
    const volver = encodeURIComponent('/?vuelta=1');
    await page.goto(`/#/?desde=central&volver=${volver}&titulo=Cumplimiento`);
    await page.evaluate(() => sessionStorage.clear());
    await mount(page, false);
    await expect(page.locator('#returnShell .return-link')).toHaveCount(0);
    expect(new URL(page.url()).hash).toContain('volver=');
  });
});
