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
