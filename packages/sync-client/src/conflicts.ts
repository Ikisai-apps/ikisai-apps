import type { RowOperation, SyncedRow, TableName } from './types.ts';

/** Columnas que gestiona el servidor y no cuentan como «cambio de contenido» al comparar versiones. */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(['id', 'revision', 'created_at', 'updated_at', 'updated_by', '_pending']);

export type RowKey = `${TableName}|${string}`;

export function rowKey(table: TableName, id: string): RowKey {
  return `${table}|${id}`;
}

export function operationKey(op: RowOperation): RowKey | null {
  return op.op === 'call' ? null : rowKey(op.table, op.id);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Campos de `fields` cuyo valor difiere de la base (si no hay base, todos). */
export function changedByMe(fields: Record<string, unknown>, base: SyncedRow | null): string[] {
  return Object.keys(fields).filter((k) => base === null || !deepEqual(fields[k], base[k]));
}

/** Columnas en las que `current` difiere de la base, ignorando las de sistema (si no hay base, todas las de current). */
export function changedByThem(current: SyncedRow, base: SyncedRow | null): string[] {
  const columns = new Set<string>([...Object.keys(current), ...(base ? Object.keys(base) : [])]);
  return Array.from(columns).filter((k) => !SYSTEM_COLUMNS.has(k) && (base === null || !deepEqual(current[k], base[k])));
}

export interface ConflictAnalysis {
  mine: string[];
  theirs: string[];
  overlapping: string[];
  /** Verdadero si el servidor borró o restauró la fila desde la base: nunca se rebasa solo. */
  deletionChanged: boolean;
}

export function analyseConflict(operation: RowOperation, base: SyncedRow | null, current: SyncedRow): ConflictAnalysis {
  const mine = operation.op === 'update' || operation.op === 'insert' ? changedByMe(operation.fields, base) : [];
  const theirs = changedByThem(current, base);
  const overlapping = mine.filter((k) => theirs.includes(k));
  const deletionChanged = base !== null && (base.deleted_at ?? null) !== (current.deleted_at ?? null);
  return { mine, theirs, overlapping, deletionChanged };
}

/** Quita las marcas locales antes de comparar o enviar. */
export function stripLocal(row: SyncedRow): SyncedRow {
  const { _pending: _omit, ...rest } = row as SyncedRow & { _pending?: boolean };
  return rest as SyncedRow;
}
