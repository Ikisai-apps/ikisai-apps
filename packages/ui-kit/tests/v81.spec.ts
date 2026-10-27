import { expect, test } from 'playwright/test';
import { applyBedLayouts, bedLayoutFromRow, bedShape } from '../src/spaces/bed-layout.ts';
import type { SpaceRow } from '../src/spaces/model.ts';

/** Camas con un solo modelo (decisión de VG por Core, 27-10; petición de Central): forma derivada de la disposición de Booking. */
const room = { points: [[0.2, 0.1], [0.6, 0.1], [0.6, 0.5], [0.2, 0.5]] as Array<[number, number]> };
const row = (id: string, kind: string, parentId: string | null, extra: Partial<SpaceRow> = {}): SpaceRow => ({ id, parentId, kind, name: id, publicName: null, code: null, position: 0, active: true, notes: null, attributes: {}, ...extra });

test.describe('ui-kit v0.69.9 · camas con disposición de Booking', () => {
  test('bedShape: dos cuadrantes a lo ancho (rot 0) o a lo largo (rot 90), sobre la caja de la habitación', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    // Habitación 0,4 × 0,4 en 4 columnas y 2 filas: celdas de 0,1 × 0,2.
    expect(bedShape(room, { cols: 4, rows: 2 }, { x: 1, y: 0, rot: 0 })).toEqual({ points: [[0.3, 0.1], [0.5, 0.1], [0.5, 0.3], [0.3, 0.3]] });
    expect(bedShape(room, { cols: 4, rows: 2 }, { x: 3, y: 0, rot: 90 })).toEqual({ points: [[0.5, 0.1], [0.6, 0.1], [0.6, 0.5], [0.5, 0.5]] });
    // El segundo cuadrante no cabe, celdas raras o habitación sin forma: nada.
    expect(bedShape(room, { cols: 4, rows: 2 }, { x: 3, y: 0, rot: 0 })).toBeNull();
    expect(bedShape(room, { cols: 4, rows: 2 }, { x: 0, y: 1, rot: 90 })).toBeNull();
    expect(bedShape(room, { cols: 0, rows: 2 }, { x: 0, y: 0, rot: 0 })).toBeNull();
    expect(bedShape(null, { cols: 4, rows: 2 }, { x: 0, y: 0, rot: 0 })).toBeNull();
    // Una habitación en L usa su caja.
    const l = { points: [[0, 0], [1, 0], [1, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]] as Array<[number, number]> };
    expect(bedShape(l, { cols: 2, rows: 2 }, { x: 0, y: 1, rot: 0 })).toEqual({ points: [[0, 0.5], [1, 0.5], [1, 1], [0, 1]] });
  });

  test('bedLayoutFromRow y applyBedLayouts: la cama toma la forma y el dibujo de su habitación y queda fija; sin disposición, no se pinta', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const layout = bedLayoutFromRow({ resource_bed_id: 'c1', resource_space_id: 'h1', cols: 4, rows: 2, x: 1, y: 0, rot: 0 })!;
    expect(layout).toEqual({ resourceBedId: 'c1', resourceSpaceId: 'h1', cols: 4, rows: 2, x: 1, y: 0, rot: 0 });
    expect(bedLayoutFromRow({ resource_bed_id: 'c1', resource_space_id: 'h1', cols: 4, rows: 2, x: 9, y: 0, rot: 0 })).toBeNull();
    const spaces = [
      row('h1', 'habitacion', null, { planId: 'p1', planShape: room }),
      row('c1', 'cama', 'h1', { planId: 'p9', planShape: { points: [[0, 0], [1, 0], [1, 1]] } }),
      row('c2', 'cama', 'h1', { planId: 'p1', planShape: room }),
    ];
    const out = applyBedLayouts(spaces, [layout]);
    expect(out[0]).toBe(spaces[0]);
    expect(out[1]).toMatchObject({ planId: 'p1', shapeLocked: true, planShape: { points: [[0.3, 0.1], [0.5, 0.1], [0.5, 0.3], [0.3, 0.3]] } });
    expect(out[2]).toMatchObject({ planId: null, planShape: null, shapeLocked: true });
  });

  test('en el mapa, una cama fija no se mueve con setShape (Colocar no le da asas)', async ({ page }) => {
    await page.goto('/');
    const moved = await page.evaluate(() => {
      const K = (window as any).ikisaiKit;
      const r = (id: string, kind: string, parentId: string | null, extra: object) => ({ id, parentId, kind, name: id, publicName: null, code: null, position: 0, active: true, notes: null, attributes: {}, ...extra });
      const rect = { points: [[0.2, 0.1], [0.4, 0.1], [0.4, 0.3], [0.2, 0.3]] };
      const calls: string[] = [];
      const map = K.createSpaceMap({
        source: K.createMemorySpaceSource([
          r('h1', 'habitacion', null, { planId: 'p1', planShape: { points: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] } }),
          r('c1', 'cama', 'h1', { planId: 'p1', planShape: rect, shapeLocked: true }),
          r('c2', 'cama', 'h1', { planId: 'p1', planShape: rect }),
        ]),
        plans: [{ id: 'p1', buildingId: 'h1', floor: null, position: 0, fileId: null, width: 1000, height: 700 }],
        onShape: (s: { id: string }) => calls.push(s.id),
      });
      document.body.prepend(map.element);
      return new Promise<string[]>((resolve) => setTimeout(() => {
        const next = { points: [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7], [0.5, 0.7]] };
        map.setShape('c1', 'p1', next);
        map.setShape('c2', 'p1', next);
        resolve(calls);
      }, 300));
    });
    expect(moved).toEqual(['c2']);
  });
});
