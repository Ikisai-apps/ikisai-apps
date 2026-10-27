/**
 * Central · finca y decoración sobre el plano (encargo de VG del 27-10; MUELA/equipo/feedback/recursos/DECORACION_Y_FINCA.md).
 * Reglas puras de la pantalla «Colocar» (sin DOM, para probarlas en Node):
 * - lo que el SVG de la finca dice de sí mismo: escala (`data-meters-per-unit` en la raíz), origen de la retícula
 *   (`data-origin-x`, `data-origin-y`) y las cinco alturas (rectángulos con `data-band="Altura 1"`…), en 0..1;
 * - qué icono se puede subir (SVG, PNG o GIF de hasta 1 MB, tamaño 1 o 4 celdas);
 * - cada cambio de la capa de decoración de la pieza del kit (`onDecorChange`) como operación de Recursos, con la inversa
 *   para «Deshacer».
 * Tablas: las modela Guests en Recursos (migración 0814: `floor_plans.kind/grid/bands`, `resources.decor_icons`,
 * `resources.decor_items`); aquí, sus mismos nombres.
 */
import type { RowOperation, TableName } from '@ikisai/sync-client';

export const DECOR_ICONS = 'resources.decor_icons' as TableName;
export const DECOR_ITEMS = 'resources.decor_items' as TableName;
/** Escalas de celda, en metros: 5 m para exteriores; 1 m y 0,5 m para dentro. */
export const DECOR_SCALES = [5, 1, 0.5] as const;
export type DecorScale = typeof DECOR_SCALES[number];
/** Cuánto ocupa un objeto: 1 celda o 4 (2×2). */
export const DECOR_SIZES = [1, 4] as const;
export const ICON_MIME = ['image/svg+xml', 'image/png', 'image/gif'] as const;
export const ICON_MAX_BYTES = 1024 * 1024;

export interface EstateBand { name: string; y0: number; y1: number }
/** Lo que se guarda en `floor_plans.grid` (Recursos 0814): sin `metersPerUnit`, ese dibujo no se puede decorar. */
export interface PlanGrid { metersPerUnit: number; originX: number; originY: number }
export interface EstateMeta { metersPerUnit: number | null; originX: number; originY: number; bands: EstateBand[] }

/** El `grid` para guardar, o `null` si falta la escala. */
export const gridOf = (m: Pick<EstateMeta, 'metersPerUnit' | 'originX' | 'originY'>): PlanGrid | null => (m.metersPerUnit ? { metersPerUnit: m.metersPerUnit, originX: m.originX, originY: m.originY } : null);

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(tag);
  return m ? m[2]! : null;
};
const num = (v: string | null): number | null => { const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
const round4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

/** Escala, origen y alturas del SVG de la finca. Sin escala, `metersPerUnit: null` (se pide al subir). */
export function estateMeta(svg: string): EstateMeta {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const box = (attr(root, 'viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const [vy, vh] = box.length === 4 && box[3]! > 0 ? [box[1]!, box[3]!] : [0, num(attr(root, 'height')) ?? 0];
  const mpu = num(attr(root, 'data-meters-per-unit'));
  const bands: EstateBand[] = [];
  if (vh > 0) {
    for (const m of svg.matchAll(/<rect\b[^>]*\sdata-band\s*=\s*(["'])([^"']+)\1[^>]*>/gi)) {
      const y = num(attr(m[0], 'y')) ?? 0;
      const h = num(attr(m[0], 'height'));
      if (h === null || h <= 0) continue;
      bands.push({ name: m[2]!.trim(), y0: round4((y - vy) / vh), y1: round4((y + h - vy) / vh) });
    }
  }
  return {
    metersPerUnit: mpu !== null && mpu > 0 ? mpu : null,
    originX: num(attr(root, 'data-origin-x')) ?? 0,
    originY: num(attr(root, 'data-origin-y')) ?? 0,
    bands: bands.sort((p, q) => p.y0 - q.y0).slice(0, 10),
  };
}

/** Por qué no se puede subir un icono, o `null` si vale. */
export function iconProblem(file: { type: string; size: number }, name: string, size: number): string | null {
  if (!name.trim()) return 'Ponle un nombre al icono.';
  if (name.trim().length > 80) return 'El nombre, como mucho 80 letras.';
  if (!(ICON_MIME as readonly string[]).includes(file.type)) return 'El icono tiene que ser SVG, PNG o GIF.';
  if (file.size > ICON_MAX_BYTES) return 'El icono no puede pasar de 1 MB.';
  if (!(DECOR_SIZES as readonly number[]).includes(size)) return 'Elige 1 celda o 4.';
  return null;
}

/** Lo que el kit manda en `onDecorChange` (createSpaceMap, decoración; UI-kit). */
export interface DecorChange {
  type: 'add' | 'move' | 'rotate' | 'remove';
  item: { id: string; planId: string; iconId: string; cellX: number; cellY: number; scale: number; size: number; rotation: number };
}
/** Una fila de `resources.decor_items` tal como está (la que hay antes del cambio). */
export interface DecorRow { id: string; revision: number; plan_id: string; icon_id: string; cell_x: number; cell_y: number; scale: number; size: number; rotation: number; layer?: string | null }

const fieldsOf = (i: DecorChange['item']) => ({ plan_id: i.planId, icon_id: i.iconId, cell_x: Math.max(0, Math.round(i.cellX)), cell_y: Math.max(0, Math.round(i.cellY)), scale: i.scale, size: i.size, rotation: ((Math.round(i.rotation / 90) * 90) % 360 + 360) % 360, layer: 'general', op: 'add' });

/**
 * El cambio como operación de Recursos y su inversa para «Deshacer». `before` es la fila de antes (no la hay al añadir).
 * Mover y girar cambian solo lo suyo; quitar borra (la papelera de Recursos la conserva).
 */
export function decorOperations(change: DecorChange, before: DecorRow | null): { op: RowOperation; undo: (rev: number) => RowOperation } | null {
  const f = fieldsOf(change.item);
  if (change.type === 'add') {
    return { op: { op: 'insert', table: DECOR_ITEMS, id: change.item.id, fields: f }, undo: (rev) => ({ op: 'delete', table: DECOR_ITEMS, id: change.item.id, expectedRevision: rev }) };
  }
  if (!before) return null;
  if (change.type === 'remove') {
    return { op: { op: 'delete', table: DECOR_ITEMS, id: before.id, expectedRevision: before.revision }, undo: () => ({ op: 'restore', table: DECOR_ITEMS, id: before.id, expectedRevision: before.revision + 1 } as RowOperation) };
  }
  const changed = change.type === 'move' ? { cell_x: f.cell_x, cell_y: f.cell_y } : { rotation: f.rotation };
  const back = change.type === 'move' ? { cell_x: before.cell_x, cell_y: before.cell_y } : { rotation: before.rotation };
  return {
    op: { op: 'update', table: DECOR_ITEMS, id: before.id, expectedRevision: before.revision, fields: changed },
    undo: (rev) => ({ op: 'update', table: DECOR_ITEMS, id: before.id, expectedRevision: rev, fields: back }),
  };
}

/** Las filas vivas de un plano como objetos de la pieza del kit (`setDecor`). */
export function decorForPlan(rows: ReadonlyArray<DecorRow & { deleted_at?: string | null }>, planId: string, iconUrl: (iconId: string) => string | null) {
  return rows.filter((r) => !r.deleted_at && r.plan_id === planId && (r.layer ?? 'general') === 'general').map((r) => ({
    id: r.id, planId: r.plan_id, iconId: r.icon_id, iconUrl: iconUrl(r.icon_id), cellX: r.cell_x, cellY: r.cell_y, scale: r.scale, size: r.size, rotation: r.rotation,
  }));
}

/**
 * Curvas de nivel de la finca (VG, 27-10): cada banda con la cota de su altura (`elevation_m`, Recursos) y la diferencia
 * con la siguiente subiendo. La altura se reconoce por su nombre al principio de la banda («Altura 3 · Albergue»).
 */
export interface ElevationLine extends EstateBand { elevation: number | null; toNext: number | null; label: string }
const fmtM = (n: number) => `${Number.isInteger(n) ? n : n.toLocaleString('es-ES', { maximumFractionDigits: 1 })} m`;
export function elevationLines(bands: readonly EstateBand[], alturas: ReadonlyArray<{ name: string; elevation_m?: number | null }>): ElevationLine[] {
  const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const levelOf = (band: EstateBand) => alturas.find((a) => fold(band.name).startsWith(fold(a.name)))?.elevation_m ?? null;
  const withLevel = bands.map((b) => ({ ...b, elevation: levelOf(b) }));
  const sorted = withLevel.filter((b) => b.elevation !== null).sort((p, q) => p.elevation! - q.elevation!);
  return withLevel.map((b) => {
    const next = b.elevation === null ? null : sorted.find((x) => x.elevation! > b.elevation!) ?? null;
    const toNext = next ? Math.round((next.elevation! - b.elevation!) * 10) / 10 : null;
    const label = b.elevation === null ? `${b.name} · sin cota` : `${b.name} · ${fmtM(b.elevation)}${toNext !== null ? ` (+${fmtM(toNext)} hasta ${next!.name.split('·')[0]!.trim()})` : ''}`;
    return { ...b, toNext, label };
  });
}
