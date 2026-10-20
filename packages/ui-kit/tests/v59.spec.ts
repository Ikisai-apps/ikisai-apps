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
  test('@smoke `bedNumbers: false`: camas solo por color, con el nombre accesible y el estado en palabras', async ({ page }) => {
    await page.evaluate(() => {
      const k = (window as any).ikisaiKit;
      const sq = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const map = k.createSpaceMap({
        source: k.createMemorySpaceSource(k.demoSpaces()), focus: 'hab-3', bedNumbers: false, mode: 'both', label: 'Sin números',
        plans: [{ id: 'p', buildingId: 'albergue', floor: null, position: 1, fileId: null, width: 1000, height: 600 }],
        shapes: { 'hab-3': { planId: 'p', shape: { points: sq(0.36, 0.067, 0.68, 0.567) } }, 'hab-3-c1': { planId: 'p', shape: { points: sq(0.4, 0.12, 0.48, 0.3) } }, 'hab-3-c2': { planId: 'p', shape: { points: sq(0.52, 0.12, 0.6, 0.3) } } },
        layer: (s: { kind: string; id: string }) => (s.kind === 'cama' ? { state: s.id === 'hab-3-c1' ? 'free' : 'occupied' } : null),
      });
      map.element.id = 'noNumbers';
      document.querySelector('#spacemap')!.prepend(map.element);
    });
    const host = page.locator('#noNumbers');
    await expect(host.locator('.map-bed')).toHaveCount(2);
    await expect(host.locator('.map-bed-txt')).toHaveCount(0);
    await expect(host.getByRole('button', { name: 'Cama 1, Hab 3 · Libre', exact: true })).toHaveClass(/map-st-free/);
    await expect(host.locator('.map-hatch')).toHaveCount(1);
    await expect(host.locator('.map-legend li')).toHaveText(['Libre', 'Ocupada']);
    await expect(host.locator('.map-list .map-seat')).toHaveText(['', '']);
    await expect(host.locator('.map-list .map-row-state')).toContainText(['Libre', 'Ocupada']);
  });
});
