/**
 * Ikisai Tasks · «Quién sabe hacerlo» (P2, PR 4; docs/tasks/API.md §34). Funciones puras: qué personas saben hacer los oficios
 * de una ficha, a partir de `central.capability_options` (el grado efectivo, con la herencia de padre a hijos ya resuelta por
 * Central: aquí no se calcula nada de herencia) y, si se puede leer, `central.availability_options`.
 */

/** Fila de `central.capability_options`: `level` 0 Aprende, 1 Sabe, 2 Experto. */
export interface CapabilityOption {
  person_id: string;
  trade_id: string;
  level: 0 | 1 | 2;
  inherited: boolean;
}

/** Fila de `central.availability_options`: `availability_rank` 1 (alta) a 5 (no disponible). */
export interface AvailabilityOption {
  person_id: string;
  availability: string;
  availability_rank: number;
}

/** Una persona sugerida: su mejor grado entre los oficios pedidos y su disponibilidad, si se conoce. */
export interface WhoKnows {
  person_id: string;
  level: 0 | 1 | 2;
  availability: string | null;
  availability_rank: number | null;
}

export interface WhoKnowsOptions {
  /** Incluir también a quien aprende (grado 0). Por defecto, solo «Sabe» y «Experto». */
  apprentices?: boolean;
  /** Para desempatar por nombre (después de grado y disponibilidad). */
  nameOf?: (personId: string) => string;
  /** Solo estas personas (las del catálogo de personas que conoce la interfaz). */
  known?: (personId: string) => boolean;
}

const rowsOf = (value: unknown): unknown[] => {
  const list = Array.isArray(value) ? value : (value as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(list) ? list : [];
};
const isRecord = (r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object';

/** Solo lo que la interfaz necesita de cada fila (descarta lo que no sea una capacidad con persona, oficio y grado 0..2). */
export function capabilityOptionsFrom(value: unknown): CapabilityOption[] {
  return rowsOf(value).filter(isRecord)
    .filter((r) => typeof r.person_id === 'string' && typeof r.trade_id === 'string' && [0, 1, 2].includes(Number(r.level)) && r.level !== null && r.level !== '')
    .map((r) => ({ person_id: r.person_id as string, trade_id: r.trade_id as string, level: Number(r.level) as 0 | 1 | 2, inherited: r.inherited === true }));
}

/** Solo lo que la interfaz necesita de cada fila (persona, valor y orden 1..5). */
export function availabilityOptionsFrom(value: unknown): AvailabilityOption[] {
  return rowsOf(value).filter(isRecord)
    .filter((r) => typeof r.person_id === 'string' && Number.isFinite(Number(r.availability_rank)) && r.availability_rank !== null)
    .map((r) => ({ person_id: r.person_id as string, availability: typeof r.availability === 'string' ? r.availability : '', availability_rank: Number(r.availability_rank) }));
}

/**
 * Las personas capaces de alguno de los oficios, sin repetir y con su mejor grado. Por defecto sin aprendices.
 * Orden: grado de mayor a menor; después disponibilidad (1 primero; sin dato, al final); después nombre e id.
 */
export function whoKnows(tradeIds: readonly string[], capabilities: readonly CapabilityOption[], availability: readonly AvailabilityOption[] = [], options: WhoKnowsOptions = {}): WhoKnows[] {
  const trades = new Set(tradeIds);
  if (!trades.size) return [];
  const best = new Map<string, 0 | 1 | 2>();
  for (const c of capabilities) {
    if (!trades.has(c.trade_id)) continue;
    if (options.known && !options.known(c.person_id)) continue;
    const prev = best.get(c.person_id);
    if (prev === undefined || c.level > prev) best.set(c.person_id, c.level);
  }
  const avail = new Map(availability.map((a) => [a.person_id, a]));
  const nameOf = options.nameOf ?? (() => '');
  const out: WhoKnows[] = [];
  for (const [person_id, level] of best) {
    if (level === 0 && !options.apprentices) continue;
    const a = avail.get(person_id);
    out.push({ person_id, level, availability: a?.availability ?? null, availability_rank: a ? a.availability_rank : null });
  }
  const rank = (w: WhoKnows) => w.availability_rank ?? Number.POSITIVE_INFINITY;
  return out.sort((a, b) => b.level - a.level || rank(a) - rank(b) || nameOf(a.person_id).localeCompare(nameOf(b.person_id), 'es') || a.person_id.localeCompare(b.person_id));
}

/** ¿Hay aprendices (grado 0 como mejor grado) que el enlace «Ver también aprendices» añadiría? */
export function hasApprentices(tradeIds: readonly string[], capabilities: readonly CapabilityOption[], options: Pick<WhoKnowsOptions, 'known'> = {}): boolean {
  return whoKnows(tradeIds, capabilities, [], { ...options, apprentices: true }).some((w) => w.level === 0);
}
