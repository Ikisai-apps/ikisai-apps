/**
 * La planta con camas de Alojamiento (FB_2026_061; decisión de VG del 05-11, O-C2 b). Lógica pura: el mapa de zonas de
 * Recursos (`GET plans`, `resources.portal_plans`) con la forma de cada cama sacada de su disposición en Booking
 * (`booking.portal_rooms`, 1417), y la capa de quién duerme en cada una. Las mismas reglas que Guests (`withBedLayouts`).
 */
import type { FloorPlan, SpaceMapLayer, SpaceRow } from '@ikisai/ui-kit';
// Directo del módulo (solo tipos dentro), para que las pruebas de Node no carguen el kit entero con su DOM.
import { bedShape } from '../../../../packages/ui-kit/src/spaces/bed-layout.ts';

export interface PortalPlan {
  id: string; buildingId: string; floor: string | null; position: number; width: number; height: number;
  fileId: string | null; mime: string | null; sha256: string | null; url: string | null; kind?: 'building' | 'estate';
  grid?: { metersPerUnit: number; originX?: number; originY?: number } | null;
  bands?: Array<{ name: string; y0: number; y1: number }> | null;
}
export interface PortalSpace {
  id: string; parentId: string | null; kind: string; name: string; planId: string | null; planShape: { points: Array<[number, number]> } | null; position: number; bedKind?: string;
}
export interface PortalPlans { plans: PortalPlan[]; spaces: PortalSpace[] }

/** Una habitación del retiro tal como la da `booking.portal_rooms` al organizador (solo lo que usa la planta). */
export interface PlanRoom {
  space_id: string; resource_space_id?: string | null; layout?: { cols: number; rows: number } | null; name: string;
  beds: Array<{ bed_id: string; resource_bed_id?: string | null; layout?: { x: number; y: number; rot?: number } | null; label: string; kind: string; free: boolean; guest_id?: string | null; group_label?: string | null; status?: string }>;
}

/**
 * Las camas con la forma de su disposición en Booking (`bedShape` del kit sobre su habitación), nunca de Recursos. La
 * habitación se casa por `resource_space_id` o, si no lo hay, por la de la cama en Recursos. Sin disposición, la cama se
 * queda sin forma: no se pinta y queda en la lista.
 */
export function withBedLayouts(data: PortalPlans, rooms: PlanRoom[]): PortalPlans {
  const byId = new Map(data.spaces.map((s) => [s.id, s]));
  const shapes = new Map<string, Pick<PortalSpace, 'planId' | 'planShape'>>();
  for (const room of rooms) {
    if (!room.layout) continue;
    for (const bed of room.beds) {
      const space = bed.resource_bed_id ? byId.get(bed.resource_bed_id) : undefined;
      if (!space || !bed.layout) continue;
      const parent = byId.get(room.resource_space_id ?? space.parentId ?? '');
      if (!parent?.planId) continue;
      const shape = bedShape(parent.planShape, room.layout, { x: bed.layout.x, y: bed.layout.y, rot: bed.layout.rot === 90 ? 90 : 0 });
      if (shape) shapes.set(space.id, { planId: parent.planId, planShape: shape });
    }
  }
  return { ...data, spaces: data.spaces.map((s) => (s.kind === 'cama' ? { ...s, ...(shapes.get(s.id) ?? { planId: null, planShape: null }) } : s)) };
}

export function toRows(spaces: PortalSpace[]): SpaceRow[] {
  return spaces.map((s) => ({ id: s.id, parentId: s.parentId, kind: s.kind, name: s.name, publicName: null, code: null, position: s.position ?? 0,
    active: true, notes: null, attributes: s.bedKind ? { bed_kind: s.bedKind } : {}, planId: s.planId, planShape: s.planShape }));
}

export function toFloorPlans(data: PortalPlans): FloorPlan[] {
  return data.plans.map((x) => ({ id: x.id, buildingId: x.buildingId, floor: x.floor, position: x.position, fileId: x.fileId,
    width: x.width, height: x.height, grid: x.grid ?? null, bands: x.bands ?? null }));
}

export type PlanBed = PlanRoom['beds'][number];

/** Dónde está cada cosa del retiro en Recursos: espacio de Recursos → habitación y, si es una cama, la cama. */
export function planIndex(rooms: PlanRoom[]): Map<string, { room: PlanRoom; bed: PlanBed | null }> {
  const out = new Map<string, { room: PlanRoom; bed: PlanBed | null }>();
  for (const room of rooms) {
    if (room.resource_space_id) out.set(room.resource_space_id, { room, bed: null });
    for (const bed of room.beds) if (bed.resource_bed_id) out.set(bed.resource_bed_id, { room, bed });
  }
  return out;
}

/**
 * La capa de un espacio del retiro: en cada cama, quién duerme («Ana») o «Libre», «Pendiente de aprobar» o «Reservada
 * para tu grupo»; en cada habitación, cuántas quedan libres. El color nunca va solo: el estado va en palabras.
 */
export function planLayer(hit: { room: PlanRoom; bed: PlanBed | null }, nameOf: (guestId: string) => string, text: {
  free: string; requested: string; group: string; roomFree: (free: number, total: number) => string;
}): SpaceMapLayer {
  const { room, bed } = hit;
  if (!bed) {
    const real = room.beds.filter((b) => b.kind !== 'supletoria');
    const free = real.filter((b) => !b.guest_id && !b.group_label).length;
    return { tone: free ? 'ok' : 'muted', label: text.roomFree(free, real.length), short: String(free) };
  }
  if (bed.guest_id) {
    const name = nameOf(bed.guest_id);
    return bed.status === 'requested'
      ? { state: 'occupied', tone: 'warn', label: `${name} · ${text.requested}` }
      : { state: 'occupied', label: name };
  }
  if (bed.group_label) return { state: 'occupied', tone: 'muted', label: text.group };
  return { state: 'free', label: text.free };
}
