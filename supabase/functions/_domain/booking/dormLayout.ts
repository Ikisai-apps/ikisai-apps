/**
 * «Monta el dormitorio» (tanda 36, MUELA-049): la estancia en cuadrantes y sus camas. Sin DOM ni red.
 * - `spaces.layout` = {cols, rows}; `beds.cell` = {x, y, rot}. Cada cama ocupa dos cuadrantes: a lo ancho (rot 0, 2×1)
 *   o a lo largo (rot 90, 1×2). Una litera o una doble también: son una sola cama de 2 plazas.
 * - Ninguna cama se sale ni se monta sobre otra. Las que no tienen sitio guardado (o chocan) se colocan solas en el
 *   primer hueco, y la estancia crece de fondo si hace falta.
 */

export interface Grid { cols: number; rows: number }
export interface Cell { x: number; y: number; rot: 0 | 90 }
export interface Rect { x: number; y: number; w: number; h: number }

export const GRID_LIMITS = { minCols: 2, maxCols: 16, minRows: 2, maxRows: 40 } as const;
export const DEFAULT_COLS = 4;

/** Lo que ocupa una cama en su celda. */
export const footprint = (cell: Cell): Rect => (cell.rot === 90 ? { x: cell.x, y: cell.y, w: 1, h: 2 } : { x: cell.x, y: cell.y, w: 2, h: 1 });

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (grid: Grid, r: Rect): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= grid.cols && r.y + r.h <= grid.rows;

export function validGrid(value: unknown): value is Grid {
  const g = value as Grid | null;
  return !!g && Number.isInteger(g.cols) && Number.isInteger(g.rows)
    && g.cols >= GRID_LIMITS.minCols && g.cols <= GRID_LIMITS.maxCols && g.rows >= GRID_LIMITS.minRows && g.rows <= GRID_LIMITS.maxRows;
}

export function validCell(value: unknown): value is Cell {
  const c = value as Cell | null;
  return !!c && Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0 && (c.rot === 0 || c.rot === 90);
}

/** Por qué no cabe una cama ahí: `fuera`, `encima` (con la otra cama) o `null` si cabe. */
export function placeProblem(grid: Grid, cells: ReadonlyMap<string, Cell>, id: string, cell: Cell): { reason: 'fuera' } | { reason: 'encima'; other: string } | null {
  const r = footprint(cell);
  if (!inside(grid, r)) return { reason: 'fuera' };
  for (const [other, c] of cells) if (other !== id && overlaps(r, footprint(c))) return { reason: 'encima', other };
  return null;
}

/** Primer hueco libre (de arriba abajo y de izquierda a derecha), a lo ancho y si no, a lo largo. */
export function firstFree(grid: Grid, cells: ReadonlyMap<string, Cell>, id = '\0'): Cell | null {
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      for (const rot of [0, 90] as const) {
        const cell: Cell = { x, y, rot };
        if (!placeProblem(grid, cells, id, cell)) return cell;
      }
    }
  }
  return null;
}

/**
 * La distribución que se pinta: la guardada si vale, y las camas sin sitio colocadas en el primer hueco. Sin
 * distribución guardada, 4 cuadrantes de ancho y el fondo justo. Devuelve también qué camas se han recolocado.
 */
export function arrange(layout: unknown, beds: ReadonlyArray<{ id: string; cell?: unknown }>): { grid: Grid; cells: Map<string, Cell>; moved: string[] } {
  const grid: Grid = validGrid(layout) ? { cols: layout.cols, rows: layout.rows }
    : { cols: DEFAULT_COLS, rows: Math.min(GRID_LIMITS.maxRows, Math.max(GRID_LIMITS.minRows, Math.ceil(beds.length / Math.floor(DEFAULT_COLS / 2)))) };
  const cells = new Map<string, Cell>();
  const moved: string[] = [];
  const pending: string[] = [];
  for (const bed of beds) {
    if (validCell(bed.cell) && !placeProblem(grid, cells, bed.id, bed.cell)) cells.set(bed.id, { x: bed.cell.x, y: bed.cell.y, rot: bed.cell.rot });
    else pending.push(bed.id);
  }
  for (const id of pending) {
    let cell = firstFree(grid, cells, id);
    while (!cell && grid.rows < GRID_LIMITS.maxRows) { grid.rows += 1; cell = firstFree(grid, cells, id); }
    if (!cell) continue; // no cabe ni con el fondo máximo: se queda fuera del dibujo (la lista la sigue nombrando)
    cells.set(id, cell);
    moved.push(id);
  }
  return { grid, cells, moved };
}

export type Direction = 'left' | 'right' | 'up' | 'down';
const STEP: Record<Direction, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** Mover un cuadrante. */
export const moved = (cell: Cell, dir: Direction): Cell => ({ ...cell, x: cell.x + STEP[dir][0], y: cell.y + STEP[dir][1] });

/** Girar 90°. Si girada no cabe donde está, prueba a desplazarla un cuadrante hacia dentro. */
export function rotated(grid: Grid, cells: ReadonlyMap<string, Cell>, id: string, cell: Cell): Cell {
  const turned: Cell = { ...cell, rot: cell.rot === 0 ? 90 : 0 };
  if (!placeProblem(grid, cells, id, turned)) return turned;
  for (const shifted of [{ ...turned, x: turned.x - 1 }, { ...turned, y: turned.y - 1 }]) {
    if (!placeProblem(grid, cells, id, shifted)) return shifted;
  }
  return turned;
}

/** ¿Se puede encoger hasta `next`? Todas las camas tienen que seguir dentro. */
export const fitsIn = (next: Grid, cells: ReadonlyMap<string, Cell>): boolean =>
  validGrid(next) && [...cells.values()].every((c) => inside(next, footprint(c)));

/** Una cama tal como la guarda Booking (lo que hace falta para dibujarla). */
export interface BedPart { id: string; kind?: string; capacity?: number; active?: boolean; cell?: unknown; resource_id?: string | null; resource_part?: string | null }
/** Lo que se dibuja: una cama con sus partes. `id` y `cell` son los de la parte principal (la fija, si la hay). */
export interface Piece<B extends BedPart> { id: string; main: B; parts: B[]; seats: number; extras: number }

const isExtraPart = (b: BedPart): boolean => b.kind === 'supletoria';

/**
 * Las piezas del dormitorio (FB_2026_047, 050 y 051):
 * - El espejo de Recursos (migración 0465) guarda una cama de Recursos en dos filas, la parte fija y la supletoria, con el
 *   mismo `resource_id`. Son la misma cama física (p. ej. una litera de abajo fija y arriba supletoria): una sola pieza.
 * - Las inactivas (archivadas) no se dibujan: van aparte, para nombrarlas.
 * El orden es el de la primera parte de cada pieza.
 */
export function pieces<B extends BedPart>(beds: readonly B[]): { pieces: Piece<B>[]; inactive: B[] } {
  const out: Piece<B>[] = [];
  const byResource = new Map<string, Piece<B>>();
  const inactive: B[] = [];
  for (const bed of beds) {
    if (bed.active === false) { inactive.push(bed); continue; }
    const key = bed.resource_id && bed.resource_part ? bed.resource_id : null;
    const found = key ? byResource.get(key) : undefined;
    const piece = found ?? { id: bed.id, main: bed, parts: [], seats: 0, extras: 0 };
    piece.parts.push(bed);
    const n = Number(bed.capacity) || 0;
    if (isExtraPart(bed)) piece.extras += n; else piece.seats += n;
    // La parte principal es la fija; la supletoria solo si no hay otra.
    if (found && isExtraPart(piece.main) && !isExtraPart(bed)) { piece.main = bed; piece.id = bed.id; }
    if (!found) { out.push(piece); if (key) byResource.set(key, piece); }
  }
  return { pieces: out, inactive };
}

/** Nombre corto para la pieza del dibujo (el completo va en la barra y en la etiqueta accesible): «Hab 4 · Litera 1» → «Litera 1». */
export function shortName(label: string, max = 14): string {
  const text = label.replace(/\s*\(supletoria\)\s*$/i, '').trim();
  const tail = text.includes(' · ') ? text.slice(text.lastIndexOf(' · ') + 3) : text;
  return tail.length <= max ? tail : `${tail.slice(0, max - 1).trimEnd()}…`;
}
