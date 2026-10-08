import { expect, test } from 'playwright/test';

/** U5 de Guests: barra inferior con «Más» (como mucho cinco entradas) y lista de días deslizable. */
test.describe('ui-kit v0.21 · navegación de portal y días', () => {
  test('barra con «Más» @smoke: cinco entradas; «Más» abre el resto, navega y queda activo', async ({ page }, info) => {
    await page.goto('/#portal');
    const nav = page.locator('#guestsShellHost nav.nav');
    await nav.scrollIntoViewIfNeeded();
    const mobile = info.project.name === 'movil';
    if (mobile) {
      // En móvil: Inicio, Programa, Menú, Alojamiento y «Más»; el resto no está en la barra.
      await expect(nav.locator('.navbtn:visible')).toHaveCount(5);
      const more = nav.locator('.navmore');
      await expect(more).toContainText('Más');
      await expect(more.locator('.badge')).toHaveText('1');
      await more.click();
      const items = page.locator('.navmore-list .navmore-item');
      await expect(items).toHaveText(['Información', 'Materiales', 'Mis datos', 'Firma1'].map((t) => new RegExp(`^${t}`)));
      await items.filter({ hasText: 'Firma' }).click();
      await expect(page.locator('.navmore-list')).toHaveCount(0);
      await expect(page.locator('#guestsRoute')).toHaveText('#/firma');
      await expect(more).toHaveAttribute('aria-current', 'page');
    } else {
      // En escritorio, lateral: todas las secciones, «Más» oculto y el resto en su propio grupo.
      await expect(nav.locator('.navmore')).toBeHidden();
      await expect(nav.locator('.navextra-group .navbtn')).toHaveCount(4);
      await nav.locator('.navextra-group .navbtn', { hasText: 'Materiales' }).click();
      await expect(page.locator('#guestsRoute')).toHaveText('#/materiales');
      await expect(nav.locator('.navextra-group [aria-current="page"]')).toContainText('Materiales');
    }
  });

  test('las apps internas no cambian: sin more ni maxNav no hay «Más»', async ({ page }) => {
    await page.goto('/#shell');
    await expect(page.locator('#shell .navmore')).toHaveCount(0);
  });

  test('lista de días @smoke: hoy elegido y marcado, flechas, contador y centrado', async ({ page }) => {
    await page.goto('/#portal');
    const tabs = page.locator('#dayTabs');
    await tabs.scrollIntoViewIfNeeded();
    await expect(tabs).toHaveAttribute('role', 'tablist');
    const today = tabs.locator('[data-day="2026-10-09"]');
    await expect(today).toHaveAttribute('aria-selected', 'true');
    await expect(today.locator('.daytab-wd')).toHaveText('Hoy');
    await expect(today).toHaveAttribute('aria-label', /viernes, 9 de octubre · Hoy/);
    await expect(tabs.locator('[data-day="2026-10-10"] .daytab-count')).toHaveText('4');
    await today.focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.locator('[data-day="2026-10-10"]')).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.locator('[data-day="2026-10-10"]')).toBeFocused();
    await expect(page.locator('#dayOut')).toHaveText('2026-10-10');
    await page.keyboard.press('End');
    await expect(page.locator('#dayOut')).toHaveText('2026-10-12');
    // La elegida queda a la vista dentro de la tira.
    const visible = await page.evaluate(() => {
      const strip = document.querySelector('#dayTabs')!.getBoundingClientRect();
      const tab = document.querySelector('#dayTabs [data-day="2026-10-12"]')!.getBoundingClientRect();
      return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
    });
    expect(visible).toBe(true);
  });
});
