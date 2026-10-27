/**
 * Central · finca y decoración sobre el plano (encargo de VG del 27-10; MUELA/equipo/feedback/recursos/DECORACION_Y_FINCA.md).
 * Reglas puras de la pantalla «Colocar» (sin DOM, para probarlas en Node):
 * - lo que el SVG de la finca dice de sí mismo: escala (`data-meters-per-unit` en la raíz), origen de la retícula
 *   (`data-origin-x`, `data-origin-y`) y las cinco alturas (formas con `data-name="Altura 1"`… o `data-band`), en 0..1;
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
/** Una curva de nivel del SVG de la finca (`<path data-contour="Altura N">`): sus puntos en 0..1 y el ancla de la etiqueta. */
export interface EstateContour { name: string; points: Array<[number, number]>; anchor: [number, number] }
export interface EstateMeta { metersPerUnit: number | null; originX: number; originY: number; bands: EstateBand[]; contours: EstateContour[] }

/** El `grid` para guardar, o `null` si falta la escala. */
export const gridOf = (m: Pick<EstateMeta, 'metersPerUnit' | 'originX' | 'originY'>): PlanGrid | null => (m.metersPerUnit ? { metersPerUnit: m.metersPerUnit, originX: m.originX, originY: m.originY } : null);

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(tag);
  return m ? m[2]! : null;
};
const num = (v: string | null): number | null => { const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
const round4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

/**
 * Los puntos de un trazado SVG en unidades del dibujo: absolutos o relativos, rectas (M, L, H, V) y curvas (C, S, Q, T).
 * De cada curva se queda su punto medio y su final, no los de control, para que la línea editable siga la curva.
 */
export function pathPoints(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const tokens = d.match(/[a-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0; let cmd = ''; let x = 0; let y = 0; let sx = 0; let sy = 0;
  let cx: number | null = null; let cy: number | null = null; // último punto de control de una C o S, para reflejarlo en S
  const isNum = () => i < tokens.length && !/^[a-z]$/i.test(tokens[i]!);
  const n = () => Number(tokens[i++]);
  while (i < tokens.length && out.length < 400) {
    if (!isNum()) { cmd = tokens[i++]!; if (/z/i.test(cmd)) { x = sx; y = sy; cx = cy = null; } continue; }
    if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(); const C = cmd.toUpperCase();
    const ox = rel ? x : 0; const oy = rel ? y : 0;
    if (C === 'C' || C === 'S') {
      // Cúbica: su punto medio es (P0 + 3·P1 + 3·P2 + P3) / 8.
      const [x1, y1] = C === 'C' ? [ox + n(), oy + n()] : cx === null || cy === null ? [x, y] : [2 * x - cx, 2 * y - cy];
      const x2 = ox + n(); const y2 = oy + n(); const ex = ox + n(); const ey = oy + n();
      out.push([(x + 3 * x1 + 3 * x2 + ex) / 8, (y + 3 * y1 + 3 * y2 + ey) / 8]);
      cx = x2; cy = y2; x = ex; y = ey; out.push([x, y]);
      continue;
    }
    cx = cy = null;
    if (C === 'Q') {
      // Cuadrática: su punto medio es (P0 + 2·P1 + P2) / 4.
      const x1 = ox + n(); const y1 = oy + n(); const ex = ox + n(); const ey = oy + n();
      out.push([(x + 2 * x1 + ex) / 4, (y + 2 * y1 + ey) / 4]);
      x = ex; y = ey;
    } else if (C === 'A') { for (let j = 0; j < 5; j++) n(); x = ox + n(); y = oy + n(); }
    else if (C === 'H') x = ox + n();
    else if (C === 'V') y = oy + n();
    else if (C === 'M' || C === 'L' || C === 'T') { x = ox + n(); y = oy + n(); if (C === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; } }
    else { i++; continue; }
    out.push([x, y]);
  }
  return out;
}

/** Escala, origen y alturas del SVG de la finca. Sin escala, `metersPerUnit: null` (se pide al subir). */
export function estateMeta(svg: string): EstateMeta {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const box = (attr(root, 'viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const [vy, vh] = box.length === 4 && box[3]! > 0 ? [box[1]!, box[3]!] : [0, num(attr(root, 'height')) ?? 0];
  const [vx, vw] = box.length === 4 && box[2]! > 0 ? [box[0]!, box[2]!] : [0, num(attr(root, 'width')) ?? 0];
  // Curvas de nivel (convención de Core con UI-kit, 27-10): un trazado por altura, con rectas o curvas Bézier.
  const contours: EstateContour[] = [];
  if (vh > 0 && vw > 0) {
    for (const m of svg.matchAll(/<path\b[^>]*\sdata-contour\s*=\s*(["'])([^"']+)\1[^>]*>/gi)) {
      const points = pathPoints(attr(m[0], 'd') ?? '').map(([x, y]): [number, number] => [round4((x - vx) / vw), round4((y - vy) / vh)]);
      if (points.length < 2) continue;
      // El ancla, en el punto medio de la curva: el del medio o, con un número par de puntos, entre los dos del medio.
      const n = points.length; const h = Math.floor(n / 2);
      const anchor: [number, number] = n % 2 ? points[h]! : [round4((points[h - 1]![0] + points[h]![0]) / 2), round4((points[h - 1]![1] + points[h]![1]) / 2)];
      contours.push({ name: m[2]!.trim(), points: points.slice(0, 200), anchor });
    }
  }
  const mpu = num(attr(root, 'data-meters-per-unit'));
  const bands: EstateBand[] = [];
  if (vh > 0) {
    // Una banda por altura: `data-band="…"` o `data-name="Altura N…"` (el SVG de Core), en un rectángulo o un trazado
    // con coordenadas absolutas. Su alto es el de la forma.
    for (const m of svg.matchAll(/<(rect|path|polygon)\b[^>]*>/gi)) {
      const tag = m[0];
      const name = (attr(tag, 'data-band') ?? (/^altura\b/i.test(attr(tag, 'data-name') ?? '') ? attr(tag, 'data-name') : null))?.trim();
      if (!name) continue;
      let top: number | null = null; let bottom: number | null = null;
      if (m[1]!.toLowerCase() === 'rect') {
        const y = num(attr(tag, 'y')) ?? 0; const h = num(attr(tag, 'height'));
        if (h !== null && h > 0) { top = y; bottom = y + h; }
      } else {
        const coords = ((attr(tag, 'd') ?? attr(tag, 'points') ?? '').match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
        const ys = coords.filter((_, i) => i % 2 === 1);
        if (ys.length >= 2) { top = Math.min(...ys); bottom = Math.max(...ys); }
      }
      if (top === null || bottom === null || bottom <= top) continue;
      bands.push({ name, y0: round4((top - vy) / vh), y1: round4((bottom - vy) / vh) });
    }
  }
  return {
    metersPerUnit: mpu !== null && mpu > 0 ? mpu : null,
    originX: num(attr(root, 'data-origin-x')) ?? 0,
    originY: num(attr(root, 'data-origin-y')) ?? 0,
    bands: bands.sort((p, q) => p.y0 - q.y0).slice(0, 10),
    contours,
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

/**
 * Dónde va la etiqueta de la curva de nivel de cada altura en el dibujo de la finca (`floor_plans.contours`, Recursos 0814):
 * en la línea de arriba de su banda, a la izquierda. La altura se reconoce por su nombre al principio de la banda. Las
 * bandas en sí no se guardan: el SVG de la finca ya las dibuja (aviso de Guests).
 */
/** Igual con las curvas de nivel del SVG: la etiqueta, en el punto medio de la curva de cada altura. */
export function contoursFromCurves(curves: readonly EstateContour[], alturas: ReadonlyArray<{ id: string; name: string }>): Array<{ spaceId: string; x: number; y: number }> {
  const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const out: Array<{ spaceId: string; x: number; y: number }> = [];
  for (const c of curves) {
    const a = [...alturas].sort((p, q) => q.name.length - p.name.length).find((x) => fold(c.name) === fold(x.name) || fold(c.name).startsWith(`${fold(x.name)} `));
    if (a && !out.some((o) => o.spaceId === a.id)) out.push({ spaceId: a.id, x: c.anchor[0], y: c.anchor[1] });
  }
  return out;
}

export function contoursFromBands(bands: readonly EstateBand[], alturas: ReadonlyArray<{ id: string; name: string }>): Array<{ spaceId: string; x: number; y: number }> {
  const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const out: Array<{ spaceId: string; x: number; y: number }> = [];
  for (const b of bands) {
    const a = [...alturas].sort((p, q) => q.name.length - p.name.length).find((x) => fold(b.name) === fold(x.name) || fold(b.name).startsWith(`${fold(x.name)} `));
    if (a && !out.some((o) => o.spaceId === a.id)) out.push({ spaceId: a.id, x: 0.02, y: b.y0 });
  }
  return out;
}

/** Imágenes de los edificios (`resources.space_images`, 0814): siluetas, secciones y fotos. */
export const IMAGE_KINDS = ['silueta', 'seccion', 'foto'] as const;
export type ImageKind = typeof IMAGE_KINDS[number];
export const IMAGE_KIND_LABELS: Record<ImageKind, string> = { silueta: 'Silueta', seccion: 'Sección', foto: 'Foto' };
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export function imageProblem(file: { type: string; size: number }, title: string): string | null {
  if (!title.trim()) return 'Ponle un título a la imagen.';
  if (title.trim().length > 120) return 'El título, como mucho 120 letras.';
  if (!(IMAGE_MIME as readonly string[]).includes(file.type)) return 'La imagen tiene que ser PNG, JPG o SVG.';
  if (file.size > IMAGE_MAX_BYTES) return 'La imagen no puede pasar de 5 MB.';
  return null;
}

/** Una entrada de `floor_plans.contours` (0814 y 0815): altura, ancla de la etiqueta y, si se ajustó, sus puntos. */
export interface ContourEntry { spaceId: string; x: number; y: number; points?: Array<[number, number]> }

/** Las curvas con la de `spaceId` ajustada (`points`, de 2 a 200, en 0..1). Si no tenía entrada, se añade con su ancla. */
export function withContourPoints(raw: unknown, spaceId: string, points: ReadonlyArray<readonly [number, number]>, anchor: readonly [number, number]): ContourEntry[] {
  const list: ContourEntry[] = Array.isArray(raw) ? (raw as ContourEntry[]).map((c) => ({ ...c })) : [];
  const pts = points.slice(0, 200).map(([x, y]) => [round4(x), round4(y)] as [number, number]);
  const at = list.findIndex((c) => c.spaceId === spaceId);
  if (at >= 0) list[at] = { ...list[at]!, points: pts };
  else list.push({ spaceId, x: round4(anchor[0]), y: round4(anchor[1]), points: pts });
  return list;
}

/** Mueve el punto `i` de una curva sin salirse del dibujo (0..1). */
export function movePoint(points: ReadonlyArray<readonly [number, number]>, i: number, dx: number, dy: number): Array<[number, number]> {
  return points.map(([x, y], n) => (n === i ? [round4(x + dx), round4(y + dy)] : [x, y]) as [number, number]);
}
