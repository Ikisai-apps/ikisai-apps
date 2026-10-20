import { expect, test } from 'playwright/test';

/** MUELA-056: «la elegida ampliada» en `createSpaceMap` (`focus`). */
test.describe('ui-kit v0.54 · la elegida ampliada', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.demo-head{position:static!important}'; document.head.append(s); }); });
    await page.goto('/#spacemap');
  });

  test('@smoke `focus`: el dibujo recortado a la habitación, con su contorno y sus camas (número, color, estado) tocables', async ({ page }) => {
    const zoom = page.locator('#spaceMapZoom');
    const plan = zoom.getByRole('group', { name: 'Hab 3 en el plano' });
    await expect(plan).toBeVisible();
    // Recortado: el viewBox es la caja de la habitación (con margen), no el dibujo entero; la imagen es la misma.
    const vb = (await plan.getAttribute('viewBox'))!.split(' ').map(Number);
    expect(vb[2]).toBeLessThan(1000);
    expect(vb[0]).toBeGreaterThan(300);
    await expect(plan.locator('image.map-bg')).toHaveAttribute('href', /^data:image\/svg\+xml/);
    // Solo la habitación y lo de dentro.
    await expect(plan.locator('.map-shape')).toHaveCount(3);
    await expect(plan.locator('.map-room.map-focus')).toHaveCount(1);
    await expect(plan.locator('.map-bed-txt')).toHaveText(['1', '2']);
    const bed = plan.getByRole('button', { name: 'Cama 1, Hab 3 · Libre', exact: true });
    await expect(bed).toHaveClass(/map-st-free/);
    // Ampliada, la cama se toca con el dedo.
    const box = (await bed.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(46);
    await bed.click();
    await expect(page.locator('#spaceMapPicked')).toHaveText('hab-3-c1 · ampliada');
    await expect(plan.locator('.map-ring')).toHaveCount(1);
    // La lista equivalente es la de la habitación.
    const list = zoom.locator('.map-list');
    if ((page.viewportSize()?.width ?? 0) < 900) await zoom.locator('.map-view button', { hasText: 'Lista' }).click();
    await expect(list.locator('.map-row-name')).toHaveText(['Hab 3', 'Cama 1', 'Cama 2']);
    await expect(zoom.locator('.map-plans')).toHaveCount(0);
  });

  test('@smoke sin forma, la lista de lo de dentro; `setFocus(null)` vuelve al plano entero', async ({ page }) => {
    const zoom = page.locator('#spaceMapZoom');
    await page.evaluate(() => (window as any).spaceMapZoom.setFocus('cocina'));
    await expect(zoom.locator('.map-svg')).toHaveCount(0);
    await expect(zoom.locator('.map-why')).toHaveText('Sin sitio en el plano: lo de dentro, en lista.');
    await expect(zoom.locator('.map-row-name')).toHaveText(['Cocina', 'Despensa', 'Cámara']);
    await page.evaluate(() => (window as any).spaceMapZoom.setFocus(null));
    await expect(zoom.getByRole('group', { name: 'Plano de Albergue · Planta baja' })).toBeVisible();
    await expect(zoom.getByRole('group', { name: 'Plano de Albergue · Planta baja' })).toHaveAttribute('viewBox', '0 0 1000 600');
  });
});
