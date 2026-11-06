/**
 * Ikisai Central · camas en el plano con un solo modelo (decisión de VG del 27-10): la posición de cada cama dentro de su
 * habitación vive solo en Booking (`booking.spaces.layout` y `booking.beds.cell`, publicadas en
 * `booking.bed_layout_projection`, #1017). Central no guarda forma de camas: la deriva en cada lectura de la forma de la
 * habitación con `applyBedLayouts` y `bedShape` del kit (#1023), la misma derivación en todas las apps. Aquí, solo el contrato
 * de la lectura.
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

/**
 * Para qué sirve cada espacio (VG, 06-11; Recursos #1305, `resources.spaces.uses`): varios por espacio, para todas las apps.
 * Booking enseña los de alojamiento; Tasks, Food y Flow, los suyos. Solo Central los cambia. Las claves son las de Recursos;
 * las etiquetas, de Central.
 */
export const SPACE_USES = ['alojamiento', 'eventos', 'trabajo', 'almacen', 'cocina', 'comedor', 'ocio', 'servicio', 'exterior'] as const;
export type SpaceUse = typeof SPACE_USES[number];
export const SPACE_USE_LABELS: Record<SpaceUse, string> = {
  alojamiento: 'Alojamiento', eventos: 'Eventos', trabajo: 'Trabajo', almacen: 'Almacén', cocina: 'Cocina', comedor: 'Comedor', ocio: 'Ocio', servicio: 'Servicio', exterior: 'Exterior',
};

/** Los usos válidos de una fila, en el orden de la lista y sin repetir. */
export function spaceUses(value: unknown): SpaceUse[] {
  const set = new Set(Array.isArray(value) ? value : []);
  return SPACE_USES.filter((u) => set.has(u));
}

/** «Alojamiento · Ocio», o «Sin uso marcado». */
export const spaceUsesText = (value: unknown) => spaceUses(value).map((u) => SPACE_USE_LABELS[u]).join(' · ') || 'Sin uso marcado';
