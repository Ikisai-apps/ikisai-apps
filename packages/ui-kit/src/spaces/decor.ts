/**
 * Retícula y decoración de los planos (encargo de VG del 27-10; diseño en MUELA/equipo/feedback/recursos/DECORACION_Y_FINCA.md).
 * - **Retícula**: cada dibujo trae `grid = { metersPerUnit, originX, originY }`. Las celdas son de 5 m, 1 m o 0,5 m.
 * - **Decoración**: iconos subidos (SVG, PNG o GIF) vistos desde arriba, cada uno en una celda de su escala. Un objeto ocupa
 *   1 celda (`size: 1`) o 2×2 (`size: 4`). Se pintan como `<image>`, así que nunca se ejecutan.
 * - **Camas con icono**: símbolos propios del kit para cada `bed_kind` (individual, doble, litera y sofá cama), dibujados
 *   encima del color y del estado de siempre.
 * Las funciones de este archivo son puras salvo `bedSymbols`; las usa `createSpaceMap`.
 */
import type { FloorPlan } from './map.ts';

/** Escala de la retícula: lado de la celda en metros. */
export type GridScale = 5 | 1 | 0.5;
export const GRID_SCALES: readonly GridScale[] = [5, 1, 0.5];

/** Escala del dibujo (`resources.floor_plans`): metros por unidad de la imagen y origen de la retícula, en unidades. */
export interface PlanGrid {
  metersPerUnit: number;
  originX?: number;
  originY?: number;
}

/** Un objeto de decoración sobre un dibujo. */
export interface DecorItem {
  id: string;
  planId: string;
  /** Icono del catálogo (para la app); el kit pinta `iconUrl`. Sin él, es una baliza: imagen propia o solo texto. */
  iconId?: string | null;
  /** URL del icono o de la imagen subida (SVG, PNG, GIF, JPG o WebP), ya resuelta por la app. Sin ella, baliza de texto (`label`). */
  iconUrl?: string | null;
  /** Imagen propia subida por la app (`decor_items.file_id`, Recursos 0821); el kit pinta su `iconUrl`. */
  fileId?: string | null;
  cellX: number;
  cellY: number;
  /** Escala de las celdas en las que está. */
  scale: GridScale;
  /** 1 celda o 4 (2×2). */
  size: 1 | 4;
  rotation: 0 | 90 | 180 | 270;
  /** Nombre del objeto («Planta grande»): en el modo colocar y para el lector de pantalla. En una baliza, su texto. */
  label?: string | null;
}

/** Texto de una baliza, tal como se pinta (una línea corta; el entero va en `aria-label`). */
export const beaconText = (label: string | null | undefined): string => {
  const t = (label ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 24 ? `${t.slice(0, 23)}…` : t;
};

/** Icono que se puede poner (catálogo de Central). */
export interface DecorIcon {
  id: string;
  url: string;
  label: string;
  /** Tamaño por defecto al ponerlo. */
  size?: 1 | 4;
}

export type DecorChange =
  | { type: 'add'; item: DecorItem }
  | { type: 'move'; item: DecorItem }
  | { type: 'rotate'; item: DecorItem }
  | { type: 'remove'; item: DecorItem };

/** Retícula válida: metros por unidad positivos y finitos. */
export function validGrid(grid: unknown): grid is PlanGrid {
  const g = grid as PlanGrid | null | undefined;
  return !!g && typeof g.metersPerUnit === 'number' && Number.isFinite(g.metersPerUnit) && g.metersPerUnit > 0
    && (g.originX === undefined || Number.isFinite(g.originX)) && (g.originY === undefined || Number.isFinite(g.originY));
}

const sizeOf = (plan: Pick<FloorPlan, 'width' | 'height'>) => ({ w: plan.width > 0 ? plan.width : 1000, h: plan.height > 0 ? plan.height : 700 });

/** Lado de una celda de `scale` metros, en unidades del dibujo; `null` si el dibujo no tiene retícula. */
export function cellSize(plan: Pick<FloorPlan, 'grid'>, scale: GridScale): number | null {
  return validGrid(plan.grid) ? scale / plan.grid.metersPerUnit : null;
}

/** Esquina superior izquierda de la celda, en coordenadas relativas (0..1) del dibujo; `null` sin retícula. */
export function cellToRel(plan: Pick<FloorPlan, 'grid' | 'width' | 'height'>, scale: GridScale, cellX: number, cellY: number): { x: number; y: number } | null {
  const cs = cellSize(plan, scale);
  if (cs === null || !validGrid(plan.grid)) return null;
  const { w, h } = sizeOf(plan);
  return { x: ((plan.grid.originX ?? 0) + cellX * cs) / w, y: ((plan.grid.originY ?? 0) + cellY * cs) / h };
}

/** Celda que contiene el punto relativo (0..1) del dibujo; `null` sin retícula. */
export function relToCell(plan: Pick<FloorPlan, 'grid' | 'width' | 'height'>, scale: GridScale, x: number, y: number): { cellX: number; cellY: number } | null {
  const cs = cellSize(plan, scale);
  if (cs === null || !validGrid(plan.grid)) return null;
  const { w, h } = sizeOf(plan);
  return { cellX: Math.floor((x * w - (plan.grid.originX ?? 0)) / cs + 1e-9), cellY: Math.floor((y * h - (plan.grid.originY ?? 0)) / cs + 1e-9) };
}

/** Caja del objeto en unidades del dibujo (antes de girar); `null` sin retícula. */
export function decorBox(plan: Pick<FloorPlan, 'grid' | 'width' | 'height'>, item: Pick<DecorItem, 'cellX' | 'cellY' | 'scale' | 'size'>): { x: number; y: number; side: number } | null {
  const cs = cellSize(plan, item.scale);
  const at = cellToRel(plan, item.scale, item.cellX, item.cellY);
  if (cs === null || !at) return null;
  const { w, h } = sizeOf(plan);
  return { x: at.x * w, y: at.y * h, side: cs * (item.size === 4 ? 2 : 1) };
}

/** Solo URLs que no ejecutan nada: http(s), rutas propias, `blob:` y `data:` de imagen. */
export function safeIconUrl(url: string): boolean {
  return /^(https?:\/\/|\/|\.\/|blob:)/i.test(url) || /^data:image\/(png|gif|jpeg|webp|svg\+xml)[;,]/i.test(url);
}

/** Tipos de cama con icono (`attributes.bed_kind`). */
export const BED_KINDS = ['individual', 'doble', 'litera', 'sofa_cama'] as const;
export type BedKind = typeof BED_KINDS[number];

const NS = 'http://www.w3.org/2000/svg';

/**
 * Símbolos de las camas, vistos desde arriba, con el cabecero arriba (`viewBox` vertical). Solo trazo (`currentColor`),
 * para no tapar el color del estado ni el número.
 */
export function bedSymbols(prefix: string): SVGDefsElement {
  const defs = document.createElementNS(NS, 'defs');
  const add = (kind: BedKind, viewBox: string, paths: string[]) => {
    const symbol = document.createElementNS(NS, 'symbol');
    symbol.setAttribute('id', `${prefix}-${kind}`);
    symbol.setAttribute('viewBox', viewBox);
    symbol.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      symbol.append(p);
    }
    defs.append(symbol);
  };
  // Marco, almohada y embozo.
  add('individual', '0 0 20 40', ['M2 2h16v36H2z', 'M5 5h10v6H5z', 'M2 15h16']);
  add('doble', '0 0 32 40', ['M2 2h28v36H2z', 'M5 5h10v6H5z', 'M17 5h10v6H17z', 'M2 15h28']);
  // Litera: dos marcos desplazados (la de arriba y la de abajo).
  add('litera', '0 0 22 40', ['M2 2h16v34H2z', 'M4 4h16v34H4z', 'M6 7h8v5H6z']);
  // Sofá cama: respaldo y brazos.
  add('sofa_cama', '0 0 20 40', ['M2 2h16v36H2z', 'M2 2h4v36H2z', 'M6 2h12v4H6z', 'M6 34h12v4H6z']);
  return defs;
}

export const bedKindOf = (attributes: Record<string, unknown>): BedKind | null => {
  const k = attributes.bed_kind;
  return typeof k === 'string' && (BED_KINDS as readonly string[]).includes(k) ? (k as BedKind) : null;
};
