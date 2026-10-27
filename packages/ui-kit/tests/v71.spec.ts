import { expect, test, type Page } from 'playwright/test';

/** Guiado, tanda 2 (decisión de VG del 27-10): createGuide, con foco y burbuja dentro de la app y avance solo con la confirmación. */
async function start(page: Page): Promise<void> {
  await page.goto('/');
  await page.addStyleTag({ content: '.demo-head{position:static!important}' });
  await page.locator('#guiado').scrollIntoViewIfNeeded();
  await page.locator('#guideStart').click();
  await expect(page.locator('.guia-bubble .guia-title')).toHaveText('Pon la hora de llegada');
}
const bubble = (page: Page) => page.locator('.guia-bubble');
const log = (page: Page) => page.locator('#guideLogOut');

test.describe('ui-kit v0.67 · Guiado completo (createGuide)', () => {
  test('@smoke señala el campo y avanza solo cuando se guarda de verdad; lo escondido se enseña; «Hecho» en los manuales', async ({ page }) => {
    await start(page);
    await expect(bubble(page).locator('.guia-meta')).toContainText('Paso 1 de 3');
    await expect(page.locator('#guideArrival')).toBeFocused();
    await expect(page.locator('.guia-ring')).toBeVisible();
    const ring = (await page.locator('.guia-ring').boundingBox())!;
    const field = (await page.locator('#guideArrival').boundingBox())!;
    expect(Math.abs(ring.x + 6 - field.x)).toBeLessThan(3);
    // Escribir no basta: hasta que se guarda, no avanza.
    await page.locator('#guideArrival').fill('18:30');
    await page.waitForTimeout(400);
    await expect(bubble(page).locator('.guia-title')).toHaveText('Pon la hora de llegada');
    await page.getByRole('button', { name: 'Guardar hora' }).click();
    await expect(bubble(page).locator('.guia-title')).toHaveText('Apunta la matrícula');
    await expect(bubble(page).locator('.guia-title')).toBeFocused();
    await expect(log(page)).toHaveText('llegada:save');
    // La matrícula está en un <details> cerrado: la app lo abre (registerReveal).
    await expect.poll(() => page.locator('#guideMore').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    await expect(bubble(page)).toHaveAttribute('data-found', 'true');
    await page.getByRole('button', { name: 'Guardar matrícula' }).click();
    await expect(bubble(page).locator('.guia-title')).toHaveText('Repasa la ficha');
    await expect(page.locator('.guia-ring')).toBeHidden();
    await bubble(page).getByRole('button', { name: 'Hecho', exact: true }).click();
    await expect(bubble(page).locator('.guia-title')).toContainText('Todo hecho');
    await expect(log(page)).toHaveText('llegada:save, matricula:event, repaso:manual');
    await expect(bubble(page).getByRole('link', { name: 'Volver a la muestra' })).toBeVisible();
  });

  test('lo hecho fuera no se repregunta; saltar lo no esencial; ocultar en una píldora y volver', async ({ page }) => {
    await start(page);
    await page.locator('#guideOutside').click();
    await expect(bubble(page).locator('.guia-title')).toHaveText('Apunta la matrícula');
    await bubble(page).getByRole('button', { name: 'Saltar' }).click();
    await expect(bubble(page).locator('.guia-title')).toHaveText('Repasa la ficha');
    await expect(log(page)).toHaveText('matricula:saltado');
    await bubble(page).getByRole('button', { name: 'Ocultar la guía' }).click();
    await expect(bubble(page)).toBeHidden();
    const pill = page.locator('.guia-pill');
    await expect(pill).toHaveText('Guía · paso 3 de 3');
    await expect(pill).toBeFocused();
    await pill.click();
    await expect(bubble(page).locator('.guia-title')).toHaveText('Repasa la ficha');
    await expect(bubble(page).locator('.guia-title')).toBeFocused();
    // «Anterior» vuelve a un paso ya hecho para cambiarlo.
    await bubble(page).getByRole('button', { name: 'Anterior' }).click();
    await expect(bubble(page).locator('.guia-title')).toHaveText('Apunta la matrícula');
  });

  test('la burbuja no tapa el ancho ni bloquea la pantalla: se sigue pudiendo tocar la app', async ({ page }) => {
    await start(page);
    const box = (await bubble(page).boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(await page.locator('.guia-ring').evaluate((n) => getComputedStyle(n).pointerEvents)).toBe('none');
    await page.locator('#guideMore summary').click();
    await expect.poll(() => page.locator('#guideMore').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
  });
});
