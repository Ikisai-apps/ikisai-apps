import { expect, test, type Page } from 'playwright/test';

/** Tanda 34 (MUELA-024): `createSpaceMap`, el dibujo de fondo con la capa de estancias y su lista equivalente. */
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;

test.describe('ui-kit v0.52 · mapa de zonas', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.demo-head{position:static!important}'; document.head.append(s); }); });
    await page.goto('/#spacemap');
  });

  test('@smoke plano con tres estancias: dibujo como imagen, cada estancia es un botón con su estado en palabras y tocar resalta el contorno', async ({ page }) => {
    const map = page.locator('#spaceMapHost');
    const plan = map.getByRole('group', { name: 'Plano de Albergue · Planta baja' });
    await expect(plan).toBeVisible();
    // El dibujo va como <image> (no se mete en la página) y el viewBox es el de la imagen.
    await expect(plan.locator('image.map-bg')).toHaveAttribute('href', /^data:image\/svg\+xml/);
    await expect(plan).toHaveAttribute('viewBox', '0 0 1000 600');
    await expect(plan.locator('.map-room[role="button"]')).toHaveCount(3);
    await expect(plan.getByRole('button', { name: 'Hab 1 · Completa' })).toBeVisible();
    await expect(plan.getByRole('button', { name: 'Hab 3 · 1 libre' })).toBeVisible();
    await expect(plan.getByRole('button', { name: 'Baños · Tareas abiertas: 1' })).toBeVisible();
    // Camas: número, color y estado; la ocupada con rayado.
    await expect(plan.getByRole('button', { name: 'Cama 1, Hab 1 · Ocupada' })).toHaveClass(/map-st-occupied/);
    await expect(plan.locator('.map-hatch')).toHaveCount(1);
    await expect(plan.locator('.map-bed-txt')).toHaveText(['1', '1', '2']);
    await expect(map.locator('.map-legend li')).toHaveText(['Libre', 'Ocupada', 'No se puede elegir']);
    // Tocar: contorno exacto encima y la app abre lo suyo.
    await plan.getByRole('button', { name: 'Hab 3 · 1 libre' }).click();
    await expect(page.locator('#spaceMapPicked')).toHaveText('hab-3 · map');
    await expect(plan.locator('.map-ring')).toHaveCount(1);
    expect(await plan.locator('.map-ring').getAttribute('points')).toBe(await plan.locator('[data-space-id="hab-3"].map-shape').getAttribute('points'));
    await expect(plan.locator('[data-space-id="hab-3"].map-shape')).toHaveAttribute('aria-pressed', 'true');
    // Con el teclado: Intro sobre la cama libre la elige (verde intenso) y la habitación deja de tener libres.
    const bed = plan.getByRole('button', { name: 'Cama 1, Hab 3 · Libre' });
    await bed.focus();
    await page.keyboard.press('Enter');
    await expect(plan.getByRole('button', { name: 'Cama 1, Hab 3 · Elegida' })).toHaveClass(/map-st-picked/);
    await expect(plan.getByRole('button', { name: /^Hab 3$/ })).toBeVisible();
    // Número blanco sobre el verde intenso: al menos 4,5:1.
    const ratio = await plan.evaluate((svgNode) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = (c: number[]) => [c[0]!, c[1]!, c[2]!].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const fill = rgb(getComputedStyle(svgNode.querySelector('.map-bed.map-st-picked')!).fill);
      const ink = rgb(getComputedStyle(svgNode.querySelector('.map-bed-txt.map-st-picked')!).fill);
      const [a, b] = [lum(fill), lum(ink)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    // Otro dibujo: el conmutador de dibujos, de 46 px.
    const other = map.locator('.map-plans button', { hasText: 'Edificio de salas' });
    expect((await other.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await other.click();
    await expect(map.getByRole('group', { name: 'Plano de Edificio de salas' }).getByRole('button', { name: 'Sala Roble' })).toBeVisible();
  });

  test('@smoke lista equivalente: conmutador Plano/Lista en el móvil y lado a lado en el ordenador, con la ruta y el mismo estado', async ({ page }) => {
    const map = page.locator('#spaceMapHost');
    const list = map.locator('.map-list');
    if (wide(page)) {
      await expect(map.locator('.map-view')).toBeHidden();
      await expect(list).toBeVisible();
      await expect(map.locator('.map-svg')).toBeVisible();
    } else {
      await expect(list).toBeHidden();
      const toList = map.locator('.map-view button', { hasText: 'Lista' });
      expect((await toList.boundingBox())!.height).toBeGreaterThanOrEqual(46);
      await toList.click();
      await expect(list).toBeVisible();
      await expect(map.locator('.map-svg')).toBeHidden();
      await expect(toList).toHaveAttribute('aria-pressed', 'true');
    }
    // Lo mismo que el plano: las tres estancias del Albergue y sus camas, con la ruta; sin alturas ni edificios sueltos.
    await expect(list.locator('.map-group-title')).toHaveText(['Altura 3 › Albergue']);
    await expect(list.locator('.map-row-name')).toHaveText(['Hab 1', 'Cama 1', 'Hab 3', 'Cama 1', 'Cama 2', 'Baños']);
    await expect(list.getByRole('button', { name: 'Cama 2, Hab 3 · No se puede elegir · Altura 3 › Albergue › Hab 3' })).toBeVisible();
    const row = list.getByRole('button', { name: /^Baños · Tareas abiertas: 1/ });
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await row.click();
    await expect(page.locator('#spaceMapPicked')).toHaveText('banos-alb · list');
    await expect(list.locator('[data-space-id="banos-alb"]')).toHaveAttribute('aria-current', 'true');
    await expect(list.locator('[data-space-id="banos-alb"]')).toBeFocused();
    // Al volver al plano, la estancia sigue resaltada.
    if (!wide(page)) await map.locator('.map-view button', { hasText: 'Plano' }).click();
    await expect(map.locator('.map-ring')).toHaveCount(1);
  });

  test('@smoke sin formas: solo la lista, con su motivo y sin conmutador', async ({ page }) => {
    const bare = page.locator('#spaceMapBare');
    await expect(bare.locator('.map-svg')).toHaveCount(0);
    await expect(bare.locator('.map-view')).toHaveCount(0);
    await expect(bare.locator('.map-why')).toHaveText('Sin plano todavía: la misma información en lista, con la ruta de cada espacio.');
    await expect(bare.locator('.map-row-name')).toHaveText(['Sala Roble', 'Sala Olivo', 'Sala multiusos']);
  });

  test('@smoke sin red: la última copia, con aviso; tocar sigue abriendo y la app sabe que no hay red', async ({ page, context }) => {
    const map = page.locator('#spaceMapHost');
    await expect(map.locator('.map-svg image')).toHaveAttribute('href', /^data:/);
    await context.setOffline(true);
    await expect(map.locator('.map-offline')).toHaveText('Sin red: ves la última copia guardada.');
    await expect(map.locator('.map-svg')).toBeVisible();
    await map.getByRole('button', { name: 'Cama 1, Hab 3 · Libre', exact: true }).click();
    await expect(page.locator('#spaceMapPicked')).toHaveText('hab-3-c1 (sin red) · map');
    // La demo no elige sin red.
    await expect(map.getByRole('button', { name: 'Cama 1, Hab 3 · Libre', exact: true })).toBeVisible();
    await context.setOffline(false);
    await expect(map.locator('.map-offline')).toBeHidden();
  });

  test('sin desplazamiento lateral y sin transiciones con movimiento reducido', async ({ page }) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const t = await page.locator('#spaceMapHost .map-shape').first().evaluate((n) => getComputedStyle(n).transitionDuration);
    expect(t).toBe('0s');
  });
  test('@smoke `floorPlanFromRow`: un dibujo subido sin red (`{ $blob }`) cuenta como sin archivo hasta que se sube', async ({ page }) => {
    const out = await page.evaluate(() => {
      const k = (window as any).ikisaiKit;
      const row = { id: 'p1', building_id: 'albergue', floor: 'Planta baja', position: 1, width: 1000, height: 600, revision: 1 };
      return [k.floorPlanFromRow({ ...row, file_id: { $blob: 'abc123' } }).fileId, k.floorPlanFromRow({ ...row, file_id: 'f-9' }).fileId, k.floorPlanFromRow({ ...row, file_id: null }).fileId];
    });
    expect(out).toEqual([null, 'f-9', null]);
  });
});
