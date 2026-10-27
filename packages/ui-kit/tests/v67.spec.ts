import { expect, test, type Page } from 'playwright/test';
import { cellSize, cellToRel, decorBox, relToCell, safeIconUrl, validGrid } from '../src/spaces/decor.ts';
// @ts-expect-error: script de Node sin tipos.
import { extractFeatures } from '../scripts/feature-catalog.mjs';

/** Encargo de VG del 27-10 (DECORACION_Y_FINCA): retícula, decoración, camas con icono, alturas y cotas, y bajar de la finca a la habitación. */
const PLAN = { id: 'p-alb', width: 800, height: 600, grid: { metersPerUnit: 0.02, originX: 10, originY: 20 } };

test.describe('ui-kit v0.63 · decoración y finca en createSpaceMap', () => {
  test('retícula: celda ↔ coordenadas relativas en las tres escalas, con origen; sin escala, nada', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    expect([5, 1, 0.5].map((s) => cellSize(PLAN, s as 5 | 1 | 0.5))).toEqual([250, 50, 25]);
    expect(cellToRel(PLAN, 1, 3, 2)).toEqual({ x: (10 + 150) / 800, y: (20 + 100) / 600 });
    expect(relToCell(PLAN, 1, (10 + 150) / 800, (20 + 100) / 600)).toEqual({ cellX: 3, cellY: 2 });
    expect(relToCell(PLAN, 0.5, (10 + 160) / 800, (20 + 30) / 600)).toEqual({ cellX: 6, cellY: 1 });
    expect(decorBox(PLAN, { cellX: 1, cellY: 1, scale: 0.5, size: 4 })).toEqual({ x: 35, y: 45, side: 50 });
    expect(cellSize({ grid: null }, 1)).toBeNull();
    expect(validGrid({ metersPerUnit: 0 })).toBe(false);
    expect(safeIconUrl('javascript:alert(1)')).toBe(false);
    expect(safeIconUrl('data:text/html,<b>')).toBe(false);
    expect(safeIconUrl('data:image/gif;base64,R0lGOD')).toBe(true);
    expect(safeIconUrl('/api/v1/resources/files/x')).toBe(true);
  });

  test('catálogo: miga y decoración solo cuando la llamada usa drill o decorEdit', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const ids = (code: string) => extractFeatures(code).features.map((f: { id: string }) => f.id.split('.').pop());
    expect(ids("createSpaceMap({ source, feedbackId: 'tasks.plano' })")).toEqual(['plano', 'vista', 'dibujo', 'espacio', 'fila']);
    expect(ids("createSpaceMap({ source, drill: true, feedbackId: 'guests.camas' })")).toEqual(['camas', 'vista', 'dibujo', 'espacio', 'fila', 'miga', 'volver']);
    expect(ids("createSpaceMap({ source, decorEdit: { icons, onDecorChange }, feedbackId: 'central.colocar' })")).toHaveLength(11);
  });

  async function setup(page: Page, opts: { plan?: string; edit?: boolean; grid?: number; showDecor?: boolean }): Promise<void> {
    await page.goto('/');
    await page.evaluate((opts) => {
      const K = (window as any).ikisaiKit;
      const w = window as any;
      const rect = (x0: number, y0: number, x1: number, y1: number) => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
      const row = (id: string, parentId: string | null, kind: string, name: string, planId: string | null, shape: unknown, attributes = {}, position = 0) => ({ id, parentId, kind, name, publicName: null, code: null, position, active: true, notes: null, attributes, planId, planShape: shape });
      const icon = (fill: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="${fill}"/></svg>`);
      const rows = [
        row('finca', null, 'exterior', 'Finca', null, null),
        row('albergue', 'finca', 'edificio', 'Albergue', 'p-finca', rect(0.2, 0.3, 0.6, 0.5), {}, 1),
        row('salas', 'finca', 'edificio', 'Salas', 'p-finca', rect(0.3, 0.7, 0.7, 0.85), {}, 2),
        row('hab1', 'albergue', 'habitacion', 'Hab 1', 'p-alb', rect(0.1, 0.1, 0.5, 0.6), {}, 1),
        row('hab2', 'albergue', 'habitacion', 'Hab 2', 'p-alb', rect(0.5, 0.1, 0.9, 0.6), {}, 2),
        row('c1', 'hab1', 'cama', 'Cama 1', 'p-alb', rect(0.12, 0.15, 0.2, 0.4), { bed_kind: 'individual' }, 1),
        row('c2', 'hab1', 'cama', 'Cama 2', 'p-alb', rect(0.25, 0.15, 0.4, 0.4), { bed_kind: 'doble' }, 2),
        row('c3', 'hab1', 'cama', 'Cama 3', 'p-alb', rect(0.12, 0.45, 0.4, 0.55), { bed_kind: 'litera' }, 3),
      ];
      const plans = [
        { id: 'p-finca', buildingId: 'finca', floor: null, position: 0, fileId: null, width: 1000, height: 700, grid: { metersPerUnit: 0.25 },
          bands: [{ name: 'Altura 3 · Albergue', y0: 0.25, y1: 0.55 }, { name: 'Altura 1 · Salas', y0: 0.65, y1: 0.9 }],
          contours: [{ label: 'Altura 1', elevationM: 4, x: 0.75, y: 0.62 }, { label: 'Altura 3', elevationM: 10, x: 0.75, y: 0.22 }] },
        { id: 'p-alb', buildingId: 'albergue', floor: 'Planta baja', position: 1, fileId: null, width: 800, height: 600, grid: { metersPerUnit: 0.02 } },
      ];
      const decor = [{ id: 'd1', planId: 'p-alb', iconId: 'planta', iconUrl: icon('#4a8a3a'), cellX: 22, cellY: 3, scale: 0.5, size: 4, rotation: 0, label: 'Planta' }];
      w.changes = []; w.entered = []; w.picked = [];
      w.map = K.createSpaceMap({
        source: K.createMemorySpaceSource(rows), plans, decor, bedIcons: true, drill: true, plan: opts.plan ?? 'p-finca', feedbackId: 'central.colocar.mapa',
        ...(opts.grid ? { grid: opts.grid } : {}), ...(opts.showDecor === false ? { showDecor: false } : {}),
        onEnterBuilding: (b: any, p: any) => w.entered.push(`${b.id}>${p.id}`), onPick: (s: any) => w.picked.push(s.id),
        ...(opts.edit ? { decorEdit: { icons: [{ id: 'planta', url: icon('#4a8a3a'), label: 'Planta', size: 4 }, { id: 'mesa', url: icon('#a0703a'), label: 'Mesa', size: 1 }], onDecorChange: (c: any) => w.changes.push(`${c.type}:${c.item.cellX},${c.item.cellY},${c.item.rotation}`) } } : {}),
      });
      document.body.replaceChildren(w.map.element);
    }, opts);
    await page.locator('.map-svg').first().waitFor();
  }
  const path = (page: Page) => page.evaluate(() => (window as any).map.path().map((s: { name: string }) => s.name).join(' › '));

  test('@smoke finca → edificio → habitación: miga, «Volver», Escape y foco', async ({ page }) => {
    await setup(page, {});
    const svgLabel = await page.locator('.map-svg').getAttribute('aria-label');
    expect(svgLabel).toContain('Alturas: Altura 3 · Albergue, Altura 1 · Salas');
    expect(svgLabel).toContain('Altura 1 · 4 m (+6 m hasta la siguiente)');
    await expect(page.locator('.map-contour-diff')).toHaveText(['↑ +6 m']);
    await page.locator('.map-shape[data-space-id="albergue"]').click();
    expect(await page.evaluate(() => (window as any).entered)).toEqual(['albergue>p-alb']);
    await expect(page.locator('.map-back')).toBeFocused();
    expect(await path(page)).toBe('Finca › Albergue · Planta baja');
    await page.locator('.map-shape[data-space-id="hab1"]').focus();
    await page.keyboard.press('Enter');
    expect(await path(page)).toBe('Finca › Albergue · Planta baja › Hab 1');
    await expect(page.locator('.map-crumb-here')).toHaveText('Hab 1');
    expect(await page.locator('.map-crumb-here').getAttribute('aria-current')).toBe('location');
    // En la ampliada, una cama se elige como siempre.
    await page.locator('.map-shape[data-space-id="c1"]').click();
    expect(await page.evaluate(() => (window as any).picked)).toEqual(['c1']);
    await page.locator('.map-back').focus();
    await page.keyboard.press('Escape');
    expect(await path(page)).toBe('Finca › Albergue · Planta baja');
    await page.locator('.map-crumb').first().click();
    expect(await path(page)).toBe('Finca');
    await expect(page.locator('.map-crumbs')).toHaveCount(0);
  });

  test('camas con icono según bed_kind (la apaisada, girada) y decoración que solo se ve', async ({ page }) => {
    await setup(page, { plan: 'p-alb' });
    const icons = await page.locator('.map-bedicon').evaluateAll((ns) => ns.map((n) => `${(n as SVGElement).dataset.bedKind}${n.getAttribute('transform') ? '↻' : ''}`));
    expect(icons).toEqual(['individual', 'doble', 'litera↻']);
    expect(await page.locator('.map-decor').getAttribute('aria-hidden')).toBe('true');
    await expect(page.locator('.map-decor image')).toHaveCount(1);
    await expect(page.locator('.map-decorbar')).toBeHidden();
    expect(await page.locator('.map-decor').evaluate((g) => getComputedStyle(g).pointerEvents)).toBe('none');
    await setup(page, { plan: 'p-alb', showDecor: false, grid: 1 });
    await expect(page.locator('.map-decor')).toHaveCount(0);
    expect(await page.locator('.map-grid').getAttribute('data-scale')).toBe('1');
  });

  test('colocar decoración: poner, flechas, R, arrastrar por celdas, escala y quitar', async ({ page }, info) => {
    test.skip(info.project.name !== 'escritorio', 'el modo colocar es de ordenador');
    await setup(page, { plan: 'p-alb', edit: true });
    await expect(page.locator('.map-decorbar')).toBeVisible();
    expect(await page.locator('.map-grid').getAttribute('data-scale')).toBe('1');
    await page.locator('.map-decorbar [data-key="mesa"]').click();
    await page.locator('.map-decorbar [data-key="size-1"]').click();
    const box = (await page.locator('.map-decor-hit').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.71, box.y + box.height * 0.81);
    expect(await page.evaluate(() => (window as any).changes)).toEqual(['add:11,9,0']);
    await expect(page.locator('.map-deco.map-deco-on')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('r');
    const plant = (await page.locator('.map-deco[data-deco-id="d1"] image').boundingBox())!;
    await page.mouse.move(plant.x + plant.width / 2, plant.y + plant.height / 2);
    await page.mouse.down();
    await page.mouse.move(plant.x + plant.width / 2 + 60, plant.y + plant.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    const changes = await page.evaluate(() => (window as any).changes as string[]);
    expect(changes.slice(0, 3)).toEqual(['add:11,9,0', 'move:12,9,0', 'rotate:12,9,90']);
    expect(changes[3]).toMatch(/^move:2[4-6],[4-5],0$/);
    await page.locator('.map-decorbar [data-key="scale-0.5"]').click();
    expect(await page.locator('.map-grid').getAttribute('data-scale')).toBe('0.5');
    await page.locator('.map-deco[data-deco-id="d1"]').focus();
    await page.keyboard.press('Delete');
    expect((await page.evaluate(() => (window as any).changes as string[])).at(-1)).toMatch(/^remove:/);
    await expect(page.locator('.map-deco')).toHaveCount(1);
  });
});
