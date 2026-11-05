/**
 * Plano para elegir cama (encargo de VG del 27-10-2026, «Montaje»): se baja poco a poco de la finca al edificio y del
 * edificio al dormitorio (`createSpaceMap({ drill })` del kit 0.63), sin decoración. Las estancias y camas son las de
 * Booking con la forma de su pareja en Recursos (`resource_id`); los edificios, plantas y la finca que están por encima
 * salen de Recursos para que la miga tenga dónde subir. Lo usan «Espacios y camas» y la hoja «Asignar alojamiento».
 */
import { createSyncClient, type SyncClient, type SyncedRow } from '@ikisai/sync-client';
import { bedShape, createSpaceMap, createSyncSpaceSource, type FloorPlan, type SpaceMap, type SpaceMapLayer, type SpaceRow, type SpaceSource } from '@ikisai/ui-kit';

type Row = SyncedRow & Record<string, any>;

const MAP_KIND: Record<string, string> = { habitacion: 'habitacion', sala: 'sala', zona_exterior: 'exterior', otro: 'otro' };
export const FLOOR_PLANS = 'resources.floor_plans';

/**
 * Filas del plano: las de Booking con la forma de Recursos y, por encima, los antepasados de Recursos que no son de
 * Booking (finca, edificio, planta). Sin filas de Recursos, las de Booking sueltas, como antes.
 */
export function bookingMapRows(resourceRows: readonly SpaceRow[], spaces: readonly Row[], beds: readonly Row[]): SpaceRow[] {
  const byRid = new Map(resourceRows.map((r) => [r.id, r]));
  const linked = new Map<string, string>();
  for (const s of spaces) if (typeof s.resource_id === 'string') linked.set(s.resource_id, s.id);
  for (const b of beds) if (typeof b.resource_id === 'string') linked.set(b.resource_id, b.id);
  const shape = (rid: unknown) => (typeof rid === 'string' ? byRid.get(rid) : undefined);
  const up = (rid: unknown): string | null => {
    const parent = shape(rid)?.parentId ?? null;
    return parent ? linked.get(parent) ?? parent : null;
  };
  const above = new Map<string, SpaceRow>();
  for (const rid of linked.keys()) {
    let parent = byRid.get(rid)?.parentId ?? null;
    while (parent && !linked.has(parent) && !above.has(parent)) {
      const row = byRid.get(parent);
      if (!row) break;
      above.set(row.id, { ...row, parentId: row.parentId ? linked.get(row.parentId) ?? row.parentId : null });
      parent = row.parentId;
    }
  }
  return [
    ...above.values(),
    ...spaces.map((s): SpaceRow => ({
      id: s.id, parentId: up(s.resource_id), kind: MAP_KIND[s.kind] ?? 'otro', name: String(s.name), publicName: s.public_name ?? null, code: s.code ?? null,
      position: Number(s.position) || 0, active: s.active !== false, notes: null, attributes: {}, planId: shape(s.resource_id)?.planId ?? null, planShape: shape(s.resource_id)?.planShape ?? null,
    })),
    // la cama se dibuja dentro de su habitación con su sitio de «Monta el dormitorio» (un solo modelo, kit `bedShape`): así,
    // al tocar la habitación se amplía y se puede tocar la cama (VG, 28-10)
    ...beds.map((b): SpaceRow => {
      const room = spaces.find((s) => s.id === b.space_id);
      const roomShape = room ? shape(room.resource_id) : undefined;
      const layout = room?.layout as { cols?: number; rows?: number } | null | undefined;
      const cell = b.cell as { x?: number; y?: number; rot?: number } | null | undefined;
      const derived = roomShape?.planShape && layout?.cols && layout?.rows && cell && Number.isInteger(cell.x) && Number.isInteger(cell.y)
        ? bedShape(roomShape.planShape, { cols: layout.cols, rows: layout.rows }, { x: cell.x!, y: cell.y!, rot: cell.rot === 90 ? 90 : 0 }) : null;
      return {
        id: b.id, parentId: b.space_id, kind: 'cama', name: String(b.label), publicName: null, code: null,
        position: Number(b.position) || 0, active: b.active !== false, notes: null, attributes: {},
        planId: derived ? roomShape!.planId ?? null : shape(b.resource_id)?.planId ?? null, planShape: derived ?? shape(b.resource_id)?.planShape ?? null,
        ...(derived ? { shapeLocked: true } : {}),
      };
    }),
  ];
}

/**
 * Los dibujos de Recursos cuelgan de su edificio de Recursos; en el plano de Booking el edificio enlazado es su fila de
 * Booking (`resource_id`), así que el dibujo se cuelga de esa fila. Sin esto, al tocar el Albergue no se bajaba a sus
 * habitaciones (VG, 28-10).
 */
export function bookingPlans(plans: readonly FloorPlan[], spaces: readonly Row[]): FloorPlan[] {
  const linked = new Map<string, string>();
  for (const s of spaces) if (typeof s.resource_id === 'string') linked.set(s.resource_id, s.id);
  return plans.map((p) => ({ ...p, buildingId: linked.get(p.buildingId) ?? p.buildingId }));
}

/** El dibujo de la finca (`kind = 'estate'`), por donde se empieza a bajar. */
export function estatePlanId(planRows: readonly SyncedRow[]): string | null {
  return (planRows as Row[]).find((r) => !r.deleted_at && r.kind === 'estate')?.id ?? null;
}

/** Fuente de solo lectura para el kit: las filas ya calculadas. */
export function staticSource(rows: () => SpaceRow[], listeners: Set<(rows: SpaceRow[]) => void>): SpaceSource {
  const no = (what: string) => async () => { throw new Error(`Los espacios se ${what} desde «Espacios y camas».`); };
  return {
    list: () => rows(),
    subscribe: (listener: (rows: SpaceRow[]) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    create: no('crean'), createMany: no('crean'), update: no('editan'), archive: no('quitan'), restore: no('recuperan'),
  } as unknown as SpaceSource;
}

export interface BedPlanOptions {
  client: SyncClient;
  spaces: Row[];
  beds: Row[];
  /** Estado de cada cama (libre, ocupada…); lo demás sin capa. */
  layer?: (space: SpaceRow) => SpaceMapLayer | null | undefined;
  /** Camas que no se pintan (p. ej. supletorias no disponibles). */
  hideBed?: (bed: Row) => boolean;
  /** Se ha tocado una cama de Booking. */
  onPickBed: (bed: Row) => void;
  label: string;
  feedbackId: string;
}

/** Plano de elegir cama para una hoja: abre Recursos, empieza en la finca y avisa al tocar una cama. */
export function createBedPlan(o: BedPlanOptions): { element: HTMLElement; destroy(): void } {
  const host = document.createElement('div');
  host.className = 'bk-bed-plan';
  const resources = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: o.client, clearOnLogout: true });
  const rs = createSyncSpaceSource(resources);
  const listeners = new Set<(rows: SpaceRow[]) => void>();
  let rows: SpaceRow[] = [];
  let map: SpaceMap | null = null;
  let destroyed = false;
  async function paint(): Promise<void> {
    let plans: FloorPlan[] = [];
    let estate: string | null = null;
    try {
      rows = bookingMapRows(await rs.list(), o.spaces, o.hideBed ? o.beds.filter((b) => !o.hideBed!(b)) : o.beds);
      plans = bookingPlans(await rs.plans.list(), o.spaces);
      estate = estatePlanId(await resources.list(FLOOR_PLANS));
    } catch { rows = bookingMapRows([], o.spaces, o.beds); }
    if (destroyed) return;
    if (!rows.some((r) => r.planShape)) { map?.destroy(); map = null; host.replaceChildren(); return; }
    if (!map) {
      map = createSpaceMap({
        source: staticSource(() => rows, listeners), plans, mode: 'plan', drill: true, showDecor: false, ...(estate ? { plan: estate } : {}),
        label: o.label, feedbackId: o.feedbackId, planUrl: (fileId) => resources.fileUrl(fileId),
        ...(o.layer ? { layer: (sp: SpaceRow) => {
          if (sp.kind === 'cama') return o.layer!(sp);
          const inside = rows.filter((r) => r.kind === 'cama' && r.parentId === sp.id);
          if (!inside.length) return null;
          const free = inside.filter((r) => { const st = o.layer!(r)?.state; return st === 'free' || st === 'picked'; }).length;
          // solo el número, con la letra pequeña del estado (`short` lo pinta enorme)
          return { label: String(free) };
        } } : {}),
        onPick: (s) => { const bed = s.kind === 'cama' ? o.beds.find((b) => b.id === s.id) : null; if (bed) o.onPickBed(bed); },
      });
      host.replaceChildren(map.element);
    }
    listeners.forEach((l) => l(rows));
    await map.refresh();
    map.repaint();
  }
  const off = rs.subscribe(() => void paint());
  void resources.start().then(() => paint(), () => paint());
  return {
    element: host,
    destroy(): void { destroyed = true; off(); map?.destroy(); rs.destroy(); resources.stop(); listeners.clear(); },
  };
}
