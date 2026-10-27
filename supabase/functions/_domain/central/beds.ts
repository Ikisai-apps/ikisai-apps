/**
 * Ikisai Central · camas en el plano con un solo modelo (decisión de VG del 27-10): la posición de cada cama dentro de su
 * habitación vive solo en Booking (`booking.spaces.layout` y `booking.beds.cell`, publicadas en
 * `booking.bed_layout_projection`, #1017). Central no guarda forma de camas: la deriva en cada lectura de la forma de la
 * habitación. Cuando el kit publique `bedShape`, esta derivación se sustituye por la suya.
 */

export const BED_LAYOUT_PROJECTION = 'booking.bed_layout_projection';
/** Booking › Espacios y camas: donde se mueven las camas. */
export const BOOKING_BEDS_URL = 'https://booking.ikisai.com/#/espacios';

/** Una fila de la proyección de Booking: la cama ocupa dos cuadrantes desde (x, y); rot 0 a lo ancho, rot 90 a lo largo. */
export interface BedLayout {
  resource_bed_id: string | null;
  resource_space_id: string | null;
  cols: number;
  rows: number;
  x: number;
  y: number;
  rot: number;
  label?: string | null;
}

type Shape = { points: number[][] };

/** La forma de una cama dentro de la caja de la forma de su habitación, repartida en `cols` × `rows` cuadrantes. */
export function bedShape(room: Shape, layout: { cols: number; rows: number }, cell: { x: number; y: number; rot: number }): { points: Array<[number, number]> } {
  const xs = room.points.map((p) => p[0]!); const ys = room.points.map((p) => p[1]!);
  const x0 = Math.min(...xs); const y0 = Math.min(...ys);
  const cw = (Math.max(...xs) - x0) / Math.max(layout.cols, 1);
  const ch = (Math.max(...ys) - y0) / Math.max(layout.rows, 1);
  const [w, h] = cell.rot === 90 ? [1, 2] : [2, 1];
  const left = x0 + Math.min(cell.x, Math.max(layout.cols - w, 0)) * cw;
  const top = y0 + Math.min(cell.y, Math.max(layout.rows - h, 0)) * ch;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const [l, t, r, b] = [left, top, left + w * cw, top + h * ch].map(round) as [number, number, number, number];
  return { points: [[l, t], [r, t], [r, b], [l, b]] };
}

interface PlacedRow { id: string; kind: string; parentId?: string | null; planId?: string | null; planShape?: Shape | null }

/**
 * Las filas de Recursos con las camas en su sitio: cada cama toma la forma que le da su disposición en Booking dentro de
 * la forma de su habitación, y el dibujo de la habitación. Sin disposición, o con la habitación sin colocar, la cama no
 * sale en el plano (la forma que hubiera guardada en Recursos ya no cuenta). El resto, igual.
 */
export function deriveBeds<T extends PlacedRow>(rows: readonly T[], layouts: readonly BedLayout[]): T[] {
  const byBed = new Map(layouts.filter((l) => l.resource_bed_id).map((l) => [l.resource_bed_id!, l]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((s) => {
    if (s.kind !== 'cama') return s;
    const layout = byBed.get(s.id);
    const room = layout ? byId.get(layout.resource_space_id ?? s.parentId ?? '') ?? (s.parentId ? byId.get(s.parentId) : undefined) : undefined;
    if (!layout || !room?.planId || !room.planShape?.points?.length) return { ...s, planId: null, planShape: null } as T;
    return { ...s, planId: room.planId, planShape: bedShape(room.planShape, layout, layout) } as T;
  });
}
