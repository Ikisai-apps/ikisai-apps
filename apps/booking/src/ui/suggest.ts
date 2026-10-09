/**
 * FB_2026_014 · nombres que ya existen (zonas, espacios, lugares): el campo de texto ofrece los valores existentes en una
 * lista con búsqueda (`<datalist>` nativo: filtra al escribir y deja escribir uno nuevo) y avisa si el valor es nuevo o
 * se parece a uno que ya hay salvo mayúsculas, tildes o espacios («Sala Roble» frente a «sala  roble»).
 * Versión local pensada para pasar al kit (petición a UI en SALIDA).
 */

/** Forma comparable: minúsculas, sin tildes, espacios simples y sin espacios en los extremos. */
export function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Valores únicos y no vacíos, en orden alfabético (`es`); entre parecidos se queda el primero que aparece. */
export function uniqueNames(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const value = (raw ?? '').trim();
    if (value && !seen.has(normalizeName(value))) seen.set(normalizeName(value), value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'es'));
}

export type NameMatch =
  | { kind: 'empty' }
  | { kind: 'exact'; match: string }
  | { kind: 'similar'; match: string }
  | { kind: 'new' };

/** ¿Existe ya? Exacto, parecido (mismo nombre salvo mayúsculas, tildes o espacios) o nuevo. */
export function matchName(value: string, existing: readonly string[]): NameMatch {
  const text = value.trim();
  if (!text) return { kind: 'empty' };
  const exact = existing.find((e) => e.trim() === text);
  if (exact) return { kind: 'exact', match: exact };
  const similar = existing.find((e) => normalizeName(e) === normalizeName(text));
  return similar ? { kind: 'similar', match: similar } : { kind: 'new' };
}

/**
 * Texto del aviso bajo el campo. `pick`: se elige entre lo que hay (zona, lugar); `unique`: el nombre no debería repetirse
 * (un espacio). Devuelve null si no hay nada que decir.
 */
export function suggestMessage(found: NameMatch, mode: 'pick' | 'unique'): { text: string; use?: string; warn: boolean } | null {
  if (found.kind === 'empty') return null;
  if (mode === 'pick') {
    if (found.kind === 'exact') return null;
    if (found.kind === 'similar') return { text: `Ya existe «${found.match}».`, use: found.match, warn: true };
    return { text: 'Nuevo: no existe todavía.', warn: false };
  }
  if (found.kind === 'new') return null;
  return { text: `Ya hay uno que se llama «${found.match}».`, warn: true };
}
