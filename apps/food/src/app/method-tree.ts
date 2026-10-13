/**
 * Elaboración como lista plana con profundidad (FB_2026_028, decisión del usuario del 13-10-2026: «subpasos sin
 * restricción, como las tareas de Tasks»). Lógica pura, sin DOM: el editor (`ui/method-steps.ts`) y las pruebas
 * (`tests/food/method-tree.test.ts`) la comparten.
 *
 * Cada fila es `{id, depth}` con profundidad 1 (paso) o 2 (subpaso). Un subpaso cuelga del último paso que tiene encima,
 * así que mover un subpaso a otro paso es solo cambiarlo de sitio, y meter o sacar de nivel es cambiar su profundidad.
 * Reglas: dos niveles como máximo, la primera fila siempre es un paso, un paso con subpasos no se mete de nivel y un paso
 * se mueve siempre con sus subpasos (su «bloque»).
 */
// Misma forma que `MethodStep` de `@ikisai/domain-food` (steps.ts). Se declara aquí para que las pruebas de la raíz, que
// no resuelven los alias de la app, puedan importar este módulo.
export interface MethodStep { id: string; text: string; steps?: MethodStep[] }

export type Depth = 1 | 2;
export interface FlatRow { id: string; depth: Depth }
export interface FlatStep extends FlatRow { text: string }

/** Árbol → filas planas, en orden de lectura. */
export function flatten(steps: MethodStep[]): FlatStep[] {
  return steps.flatMap((step) => [
    { id: step.id, text: step.text, depth: 1 as Depth },
    ...(step.steps ?? []).map((sub) => ({ id: sub.id, text: sub.text, depth: 2 as Depth })),
  ]);
}

/**
 * Filas planas → árbol que se guarda. Los textos se recortan y las filas vacías se quitan; si un paso queda vacío, sus
 * subpasos con texto suben a pasos (no se pierden). Un subpaso sin paso encima (no debería pasar) también queda como paso.
 */
export function toTree(rows: FlatStep[]): MethodStep[] {
  const out: MethodStep[] = [];
  let parent: MethodStep | null = null;
  for (const row of rows) {
    const text = row.text.trim();
    if (row.depth === 1) {
      parent = text ? { id: row.id, text } : null;
      if (parent) out.push(parent);
      continue;
    }
    if (!text) continue;
    if (parent) (parent.steps ??= []).push({ id: row.id, text });
    else out.push({ id: row.id, text });
  }
  return out;
}

/** Número de cada fila: `1`, `1.1`, `1.2`, `2`… */
export function numbering(rows: readonly FlatRow[]): string[] {
  let step = 0, sub = 0;
  return rows.map((row) => {
    if (row.depth === 1 || step === 0) { step += 1; sub = 0; return `${step}`; }
    sub += 1;
    return `${step}.${sub}`;
  });
}

/** Fin (exclusivo) del bloque de la fila `i`: un paso arrastra sus subpasos; un subpaso va solo. */
export function blockEnd(rows: readonly FlatRow[], i: number): number {
  if (rows[i]?.depth !== 1) return i + 1;
  let end = i + 1;
  while (end < rows.length && rows[end]!.depth === 2) end += 1;
  return end;
}

/** Si el paso `i` tiene subpasos. */
export const hasSubsteps = (rows: readonly FlatRow[], i: number): boolean => rows[i]?.depth === 1 && rows[i + 1]?.depth === 2;

/**
 * Profundidades posibles para soltar un bloque en el hueco `gap` de la lista sin ese bloque (`rest`): 0 es antes de la
 * primera fila y `rest.length`, al final. Un subpaso necesita un paso encima y el bloque debe ser una sola fila (dos
 * niveles como máximo); un paso no puede caer entre subpasos (partiría el paso de otro).
 */
export function dropDepths(rest: readonly FlatRow[], gap: number, single: boolean): Depth[] {
  const out: Depth[] = [];
  if (rest[gap]?.depth !== 2) out.push(1);
  if (single && gap > 0) out.push(2);
  return out;
}

/** Hueco válido más cercano para un paso con subpasos: el principio o el final del paso en el que ha caído. */
export function snapGap(rest: readonly FlatRow[], gap: number): number {
  if (rest[gap]?.depth !== 2) return gap;
  let before = gap;
  while (before > 0 && rest[before]?.depth === 2) before -= 1; // índice del paso de esos subpasos
  let after = gap;
  while (after < rest.length && rest[after]!.depth === 2) after += 1;
  return gap - before <= after - gap ? before : after;
}

/**
 * Mueve el bloque de la fila `i` al hueco `gap` (contado en la lista sin el bloque) con la profundidad `depth` para su
 * primera fila (los subpasos de un paso se quedan en 2). Devuelve la lista nueva, o null si no cumple las reglas.
 */
export function moveBlock<T extends FlatRow>(rows: readonly T[], i: number, gap: number, depth: Depth): T[] | null {
  if (i < 0 || i >= rows.length) return null;
  const end = blockEnd(rows, i);
  const block = rows.slice(i, end);
  const rest = [...rows.slice(0, i), ...rows.slice(end)];
  if (gap < 0 || gap > rest.length) return null;
  if (!dropDepths(rest, gap, block.length === 1).includes(depth)) return null;
  const moved = [{ ...block[0]!, depth }, ...block.slice(1)] as T[];
  return [...rest.slice(0, gap), ...moved, ...rest.slice(gap)];
}

/**
 * Sube una posición. Un paso salta por encima del paso anterior (con todos sus subpasos); un subpaso sube una fila y, si
 * tenía su paso encima, pasa a ser el último subpaso del paso anterior.
 */
export function moveUp<T extends FlatRow>(rows: readonly T[], i: number): T[] | null {
  const row = rows[i];
  if (!row) return null;
  if (row.depth === 2) return moveBlock(rows, i, i - 1, 2);
  let prev = i - 1;
  while (prev >= 0 && rows[prev]!.depth === 2) prev -= 1;
  return prev < 0 ? null : moveBlock(rows, i, prev, 1);
}

/** Baja una posición: un paso salta por debajo del paso siguiente; un subpaso baja una fila (y, tras el último, pasa a ser el primer subpaso del paso siguiente). */
export function moveDown<T extends FlatRow>(rows: readonly T[], i: number): T[] | null {
  const row = rows[i];
  if (!row) return null;
  if (row.depth === 2) return i + 1 < rows.length ? moveBlock(rows, i, i + 1, 2) : null;
  const end = blockEnd(rows, i);
  if (end >= rows.length) return null;
  const rest = [...rows.slice(0, i), ...rows.slice(end)];
  return moveBlock(rows, i, blockEnd(rest, i), 1);
}

/** Si el paso `i` puede pasar a subpaso del paso anterior: hay un paso encima y no tiene subpasos propios. */
export const canIndent = (rows: readonly FlatRow[], i: number): boolean => rows[i]?.depth === 1 && i > 0 && !hasSubsteps(rows, i);

/** Mete de nivel: el paso `i` (sin subpasos) pasa a ser el último subpaso del paso anterior. */
export function indent<T extends FlatRow>(rows: readonly T[], i: number): T[] | null {
  return canIndent(rows, i) ? moveBlock(rows, i, i, 2) : null;
}

/**
 * Saca de nivel: el subpaso `i` pasa a ser un paso justo detrás del paso en el que estaba. Sus hermanos de debajo se
 * quedan en su paso (no se los lleva): en una receta los subpasos describen su paso, no al que se ha sacado.
 */
export function outdent<T extends FlatRow>(rows: readonly T[], i: number): T[] | null {
  if (rows[i]?.depth !== 2) return null;
  const rest = [...rows.slice(0, i), ...rows.slice(i + 1)];
  let gap = i;
  while (gap < rest.length && rest[gap]!.depth === 2) gap += 1;
  return moveBlock(rows, i, gap, 1);
}

/** La primera fila nunca es un subpaso (por ejemplo, tras quitar el primer paso). */
export function normalize<T extends FlatRow>(rows: readonly T[]): T[] {
  if (!rows.length || rows[0]!.depth === 1) return rows.slice();
  return [{ ...rows[0]!, depth: 1 as Depth }, ...rows.slice(1)];
}
