import { expect, test, type Page } from 'playwright/test';

/**
 * Revisión móvil del 27-10: la cáscara se aprieta sola cuando no cabe.
 * - Título: sin «Ikisai» a la vista si el nombre no cabe junto a las herramientas (Guests y Organizers se cortaban).
 * - Barra de abajo: nombres cortos (`short`) si los enteros no caben (las seis secciones de Flow).
 * Lo escondido sigue para el lector de pantalla.
 */
async function mount(page: Page, opts: { tools: number; items: number; width: number }): Promise<void> {
  await page.setViewportSize({ width: opts.width, height: 800 });
  await page.goto('/');
  await page.evaluate((opts) => {
    const K = (window as any).ikisaiKit;
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const names = [['Inicio', 'Inicio'], ['Pedido y cobro', 'Cobro'], ['Preparación', 'Cocina'], ['Ingredientes', 'Ingred.'], ['Servicio y entrega', 'Entrega'], ['Logística', 'Logíst.']];
    const nav = names.slice(0, opts.items).map(([label, short], i) => ({ hash: `#/s${i}`, label, short, icon: 'home' }));
    const tools = Array.from({ length: opts.tools }, (_, i) => K.el('button', { type: 'button', class: 'iconbtn', 'aria-label': `Herramienta ${i}` }, 'ES·EN'));
    K.createAppShell(root, { appName: 'Organizers', subtitle: 'Marta', nav, tools, backNavigation: false });
  }, opts);
  await page.waitForTimeout(300);
}
const visibleWidth = (page: Page, sel: string) => page.locator(sel).first().evaluate((n) => n.getBoundingClientRect().width);

test.describe('ui-kit v0.69.4 · cáscara apretada en el móvil', () => {
  test('@smoke a 390 px con muchas herramientas: el título sin «Ikisai» a la vista, entero para el lector', async ({ page }) => {
    await mount(page, { tools: 4, items: 4, width: 390 });
    await expect(page.locator('.topbar')).toHaveClass(/brand-tight/);
    expect(await visibleWidth(page, '.brand-ikisai')).toBeLessThanOrEqual(1);
    await expect(page.locator('.brand h1')).toHaveText(/^Ikisai Organizers/);
    // Con sitio, el título entero a la vista.
    await mount(page, { tools: 0, items: 4, width: 1280 });
    await expect(page.locator('.topbar')).not.toHaveClass(/brand-tight/);
    expect(await visibleWidth(page, '.brand-ikisai')).toBeGreaterThan(10);
  });

  test('seis secciones a 390 px: nombres cortos a la vista y el nombre entero para el lector', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'la barra de abajo es del móvil');
    await mount(page, { tools: 0, items: 6, width: 390 });
    const nav = page.locator('nav.nav');
    await expect(nav).toHaveClass(/navtight/);
    await expect(nav.locator('.navbtn >> nth=1').locator('.navshort')).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Pedido y cobro' })).toBeVisible();
    // Ningún nombre a la vista queda cortado.
    const cut = await nav.locator('.navshort').evaluateAll((ns) => ns.filter((n) => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1).length);
    expect(cut).toBe(0);
    // Con cuatro secciones caben enteros: sin nombres cortos.
    await mount(page, { tools: 0, items: 4, width: 390 });
    await expect(page.locator('nav.nav')).not.toHaveClass(/navtight/);
    await expect(page.locator('nav.nav .navshort').first()).toBeHidden();
  });
});
