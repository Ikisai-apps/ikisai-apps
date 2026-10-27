/**
 * Camas con un solo modelo (decisión de VG por Core, 27-10; petición de Central): la posición de cada cama vive solo en
 * Booking (`booking.bed_layout_projection`, #1017) como una celda de la habitación, y la forma en el dibujo se **deriva**
 * de la de la habitación. Así Booking, Guests, Tasks y Central pintan lo mismo.
 * - `bedShape(habitación, { cols, rows }, { x, y, rot })`: la habitación se reparte en `cols` de ancho y `rows` de fondo
 *   (sobre la caja de su forma). La cama ocupa dos cuadrantes desde `(x, y)`: con `rot` 0, `x` y `x+1` a lo ancho; con
 *   `rot` 90, `y` e `y+1` a lo largo. Función pura.
 * - `applyBedLayouts(espacios, disposiciones)`: las camas con disposición toman la forma derivada (en el dibujo de su
 *   habitación) y quedan con `shapeLocked`: no se arrastran ni tienen asas. Las camas sin disposición no se pintan.
 */
import type { SpaceRow } from './model.ts';
import type { PlanShape } from './map.ts';

export interface BedLayout {
  /** La cama (`resources.spaces`). */
  resourceBedId: string;
  /** Su habitación (`resources.spaces`). */
  resourceSpaceId: string;
  cols: number;
  rows: number;
  x: number;
  y: number;
  rot: 0 | 90;
}

/** Fila de `booking.bed_layout_projection` → disposición del kit; `null` si no es válida. */
export function bedLayoutFromRow(row: Record<string, unknown>): BedLayout | null {
  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v));
  const layout = {
    resourceBedId: String(row.resource_bed_id ?? ''), resourceSpaceId: String(row.resource_space_id ?? ''),
    cols: n(row.cols), rows: n(row.rows), x: n(row.x), y: n(row.y), rot: (n(row.rot) === 90 ? 90 : 0) as 0 | 90,
  };
  return layout.resourceBedId && layout.resourceSpaceId && validLayout(layout, layout) ? layout : null;
}

function validLayout(layout: { cols: number; rows: number }, cell: { x: number; y: number; rot?: number }): boolean {
  const int = (v: number) => Number.isInteger(v);
  if (!int(layout.cols) || !int(layout.rows) || layout.cols < 1 || layout.rows < 1) return false;
  if (!int(cell.x) || !int(cell.y) || cell.x < 0 || cell.y < 0) return false;
  // Dos cuadrantes: el segundo también tiene que caber.
  return cell.rot === 90 ? cell.x < layout.cols && cell.y + 1 < layout.rows : cell.x + 1 < layout.cols && cell.y < layout.rows;
}

/** Forma de la cama dentro de la habitación; `null` si la habitación no tiene forma o la celda no cabe. */
export function bedShape(roomShape: PlanShape | null | undefined, layout: { cols: number; rows: number }, cell: { x: number; y: number; rot: 0 | 90 }): PlanShape | null {
  const pts = roomShape?.points;
  if (!pts || pts.length < 3 || !validLayout(layout, cell)) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const cw = (Math.max(...xs) - x0) / layout.cols;
  const ch = (Math.max(...ys) - y0) / layout.rows;
  const left = x0 + cell.x * cw;
  const top = y0 + cell.y * ch;
  const right = left + (cell.rot === 90 ? cw : 2 * cw);
  const bottom = top + (cell.rot === 90 ? 2 * ch : ch);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { points: [[r(left), r(top)], [r(right), r(top)], [r(right), r(bottom)], [r(left), r(bottom)]] };
}

/** Las camas toman la forma derivada de su habitación; las que no tienen disposición se quedan sin forma (no se pintan). */
export function applyBedLayouts(spaces: SpaceRow[], layouts: BedLayout[]): SpaceRow[] {
  const byBed = new Map(layouts.map((l) => [l.resourceBedId, l]));
  const byId = new Map(spaces.map((s) => [s.id, s]));
  return spaces.map((s) => {
    if (s.kind !== 'cama') return s;
    const layout = byBed.get(s.id);
    const room = layout ? byId.get(layout.resourceSpaceId) : undefined;
    const shape = layout && room?.planId ? bedShape(room.planShape, layout, layout) : null;
    return shape ? { ...s, planId: room!.planId!, planShape: shape, shapeLocked: true } : { ...s, planId: null, planShape: null, shapeLocked: true };
  });
}
