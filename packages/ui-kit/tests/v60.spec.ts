import { expect, test } from 'playwright/test';

/** Tanda 37 (MUELA-090, Tasks): `layout: 'all'`, `mode: 'plan'` y `short` en la capa de `createSpaceMap`. */
test.describe('ui-kit v0.55 · mapa para Tasks', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.demo-head{position:static!important}'; document.head.append(s); }); });
    await page.goto('/#spacemap');
  });

  test('@smoke todos los dibujos a la vez, solo el plano y la cifra corta en el dibujo con la frase entera para el lector', async ({ page }) => {
    const map = page.locator('#spaceMapTasks');
    const albergue = map.getByRole('group', { name: 'Plano de Albergue · Planta baja' });
    const salas = map.getByRole('group', { name: 'Plano de Edificio de salas' });
    await expect(albergue).toBeVisible();
    await expect(salas).toBeVisible();
    await expect(map.locator('.map-figcap')).toHaveText(['Albergue · Planta baja', 'Edificio de salas']);
    // Sin selector de dibujos; dos por fila en el ordenador y uno en el móvil.
    await expect(map.locator('.map-plans')).toHaveCount(0);
    const [a, b] = [(await albergue.boundingBox())!, (await salas.boundingBox())!];
    if ((page.viewportSize()?.width ?? 0) >= 900) expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    else expect(b.y).toBeGreaterThan(a.y + a.height);
    // Solo plano: ni lista ni conmutador propios.
    await expect(map.locator('.map-view')).toHaveCount(0);
    await expect(map.locator('.map-list')).toBeHidden();
    // `short` en el dibujo; `label` en el nombre accesible.
    const banos = albergue.getByRole('button', { name: 'Baños · 2 tareas abiertas, 1 vencida' });
    await expect(banos).toHaveClass(/map-tone-alert/);
    await expect(albergue.locator('.map-room-short')).toHaveText('2');
    await expect(salas.locator('.map-room-short')).toHaveText('1');
    await expect(map.locator('.map-room-state')).toHaveCount(0);
    // Las camas fuera del filtro, apagadas y sin número.
    await expect(albergue.locator('.map-bed.map-off')).toHaveCount(3);
    await expect(albergue.locator('.map-bed-txt')).toHaveCount(0);
    await salas.getByRole('button', { name: 'Sala Roble · 1 tarea abierta' }).click();
    await expect(page.locator('#spaceMapPicked')).toHaveText('sala-roble · tasks');
    await expect(salas.locator('.map-ring')).toHaveCount(1);
  });

  test('@smoke `mode: \'plan\'` sin dibujo: la pieza no se queda sin lista', async ({ page }) => {
    await page.evaluate(() => {
      const k = (window as any).ikisaiKit;
      const map = k.createSpaceMap({ source: k.createMemorySpaceSource(k.demoSpaces()), plans: [], mode: 'plan', label: 'Solo plano sin dibujo', filter: (s: { kind: string }) => s.kind === 'sala' });
      map.element.id = 'planNoDrawing';
      document.querySelector('#spacemap')!.prepend(map.element);
    });
    const host = page.locator('#planNoDrawing');
    await expect(host.locator('.map-svg')).toHaveCount(0);
    await expect(host.locator('.map-list')).toBeVisible();
    await expect(host.locator('.map-row-name')).toHaveText(['Sala Roble', 'Sala Olivo', 'Sala multiusos']);
  });
  test('@smoke `labelJoin`: el separador del nombre accesible lo elige la app («Baños: 2 tareas abiertas»)', async ({ page }) => {
    await page.evaluate(() => {
      const k = (window as any).ikisaiKit;
      const map = k.createSpaceMap({
        source: k.createMemorySpaceSource(k.demoSpaces()), mode: 'plan', labelJoin: ': ', label: 'Con dos puntos',
        plans: [{ id: 'p', buildingId: 'albergue', floor: null, position: 1, fileId: null, width: 1000, height: 600 }],
        shapes: { 'banos-alb': { planId: 'p', shape: { points: [[0.68, 0.07], [0.96, 0.07], [0.96, 0.57], [0.68, 0.57]] } } },
        layer: (s: { id: string }) => (s.id === 'banos-alb' ? { short: '2', label: '2 tareas abiertas' } : null),
      });
      map.element.id = 'joinHost';
      document.querySelector('#spacemap')!.prepend(map.element);
    });
    await expect(page.locator('#joinHost').getByRole('button', { name: 'Baños: 2 tareas abiertas', exact: true })).toBeVisible();
  });
});
