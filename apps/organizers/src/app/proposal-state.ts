/**
 * Versiones de la propuesta (pasada única, zona 2; Booking #610, `include_history`). Puro, con prueba de Node.
 * - `proposalVersions`: la vigente (la aceptada; si no, la enviada de versión más alta) y las demás, de la más alta a la
 *   más baja (sustituidas, caducadas y, si las hubiera, enviadas antiguas).
 * - `compareVersions`: línea a línea y al pie (total, señal, personas, fechas y precio medio por persona).
 */
import type { PortalProposal } from './api.ts';
import { averagePrice } from './quote.ts';

export interface ProposalVersions { current: PortalProposal | null; previous: PortalProposal[] }

export function proposalVersions(items: PortalProposal[]): ProposalVersions {
  const sorted = [...items].sort((a, b) => b.version - a.version);
  const current = sorted.find((p) => p.status === 'aceptada') ?? sorted.find((p) => p.status === 'enviada') ?? null;
  return { current, previous: sorted.filter((p) => p !== current) };
}

export type LineChange = 'nueva' | 'quitada' | number | null;
export interface CompareLine { label: string; a: number | null; b: number | null; change: LineChange }
export interface CompareFoot<T> { a: T; b: T }
export interface Comparison {
  lines: CompareLine[];
  total: CompareFoot<number>;
  deposit: CompareFoot<number>;
  persons: CompareFoot<number | null>;
  dates: CompareFoot<{ start: string | null; end: string | null }>;
  average: CompareFoot<number | null>;
}

const amountOf = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const keyOf = (l: { description: string; unit: string }) => `${l.description.trim().toLowerCase()}|${l.unit}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Compara la versión `a` (la de ahora) con `b` (la anterior): «nueva», «quitada» o la diferencia de `a` sobre `b`. */
export function compareVersions(a: PortalProposal, b: PortalProposal): Comparison {
  const older = new Map(b.lines.map((l) => [keyOf(l), l]));
  const seen = new Set<string>();
  const lines: CompareLine[] = a.lines.map((l) => {
    const key = keyOf(l);
    seen.add(key);
    const before = older.get(key);
    const now = amountOf(l.amount);
    if (!before) return { label: l.description, a: now, b: null, change: 'nueva' as const };
    const then = amountOf(before.amount);
    return { label: l.description, a: now, b: then, change: now === null || then === null ? null : round2(now - then) };
  });
  for (const l of b.lines) {
    if (!seen.has(keyOf(l))) lines.push({ label: l.description, a: null, b: amountOf(l.amount), change: 'quitada' });
  }
  return {
    lines,
    total: { a: Number(a.total) || 0, b: Number(b.total) || 0 },
    deposit: { a: Number(a.deposit_amount) || 0, b: Number(b.deposit_amount) || 0 },
    persons: { a: a.persons ?? null, b: b.persons ?? null },
    dates: { a: { start: a.start_date, end: a.end_date }, b: { start: b.start_date, end: b.end_date } },
    average: { a: averagePrice(a.total, a.persons), b: averagePrice(b.total, b.persons) },
  };
}
