/**
 * Propuesta del equipo de Ikisai en preparación (decisión de VG del 26-10-2026, migración 0703). Dirección, con «todos» y
 * sin permiso propio sobre el retiro, edita la experiencia y las ofertas como cualquier coorganizadora, pero nada se escribe:
 * cada cambio se junta en un borrador por retiro que las pantallas ven encima del espejo local (`overlay`) y que se envía de
 * una vez como una sola sugerencia del núcleo. Así no sale una propuesta por campo (Experiencia guarda sola) ni se llega al
 * límite de 30 pendientes por persona.
 *
 * El borrador vive en la pestaña (`sessionStorage`, si se puede): sobrevive a una recarga, no a cerrar la pestaña.
 * Lo que se juntó y no se envió se dice siempre en la barra de la ficha.
 */
import type { RowOperation, SyncedRow } from '@ikisai/sync-client';

type RowOp = Exclude<RowOperation, { op: 'call' }>;

export interface Draft {
  /** Estable mientras dura el borrador: si el envío se repite (sin respuesta, sin red), el núcleo devuelve la misma. */
  requestId: string;
  operations: RowOp[];
}

/**
 * Junta `next` en el lote: varias ediciones de la misma fila quedan en una sola operación (un alta que luego se edita sigue
 * siendo un alta con los campos al día; un alta que se borra desaparece). Puro.
 */
export function mergeOperations(list: readonly RowOp[], next: readonly RowOp[]): RowOp[] {
  const out: RowOp[] = list.map((op) => ('fields' in op && op.fields ? { ...op, fields: { ...op.fields } } : { ...op }) as RowOp);
  for (const op of next) {
    const i = out.findIndex((o) => o.table === op.table && o.id === op.id);
    const prev = i >= 0 ? out[i]! : null;
    if (!prev) { out.push(op); continue; }
    if (op.op === 'delete') {
      if (prev.op === 'insert') out.splice(i, 1);
      else out[i] = { op: 'delete', table: op.table, id: op.id, expectedRevision: 'expectedRevision' in prev ? prev.expectedRevision : op.expectedRevision };
    } else if (op.op === 'update' && (prev.op === 'insert' || prev.op === 'update' || prev.op === 'restore')) {
      out[i] = { ...prev, fields: { ...(prev.fields ?? {}), ...op.fields } } as RowOp;
    } else {
      out[i] = op;
    }
  }
  return out;
}

/** Las filas de un retiro como quedarían con el borrador: altas añadidas, cambios encima y bajas fuera. Puro. */
export function overlay(rows: readonly SyncedRow[], operations: readonly RowOp[], table: string): SyncedRow[] {
  const ops = operations.filter((op) => op.table === table);
  if (!ops.length) return [...rows];
  const now = new Date().toISOString();
  const out: SyncedRow[] = [];
  for (const row of rows) {
    const op = ops.find((o) => o.id === row.id);
    if (!op) out.push(row);
    else if (op.op === 'update' || op.op === 'restore') out.push({ ...row, ...(op.fields ?? {}), deleted_at: null });
    // `delete`: fuera de la lista.
  }
  for (const op of ops) {
    if (op.op === 'insert' && !rows.some((r) => r.id === op.id)) {
      out.push({ id: op.id, revision: 0, created_at: now, updated_at: now, updated_by: null, deleted_at: null, ...op.fields });
    }
  }
  return out;
}

/** Al aceptarla, lo nuevo en materiales y preguntas pasa a ser de quien organiza (su biblioteca, 0700). Puro. */
export function ownedBy(operations: readonly RowOperation[], userId: string, ownedTables: readonly string[]): RowOperation[] {
  return operations.map((op) => op.op === 'insert' && ownedTables.includes(op.table) ? { ...op, fields: { ...op.fields, owner_id: userId } } : op);
}

/** ¿Lleva un archivo aún sin subir (`{$blob}`)? Una sugerencia no viaja con la cola de subidas. Puro. */
export function hasPendingFile(operations: readonly RowOperation[]): boolean {
  return operations.some((op) => 'fields' in op && !!op.fields && Object.values(op.fields).some((v) => !!v && typeof v === 'object' && '$blob' in (v as object)));
}

const KEY = (reservationId: string) => `organizers.propuesta.${reservationId}`;
const drafts = new Map<string, Draft>();
const listeners = new Set<(reservationId: string) => void>();

function stored(reservationId: string): Draft | null {
  try {
    const raw = sessionStorage.getItem(KEY(reservationId));
    const value = raw ? JSON.parse(raw) as Draft : null;
    return value && typeof value.requestId === 'string' && Array.isArray(value.operations) ? value : null;
  } catch {
    return null;
  }
}

function persist(reservationId: string, draft: Draft | null): void {
  try {
    if (draft) sessionStorage.setItem(KEY(reservationId), JSON.stringify(draft));
    else sessionStorage.removeItem(KEY(reservationId));
  } catch { /* sin almacenamiento: se queda en memoria */ }
}

export function draftOf(reservationId: string): Draft | null {
  if (!drafts.has(reservationId)) { const s = stored(reservationId); if (s) drafts.set(reservationId, s); }
  return drafts.get(reservationId) ?? null;
}

export function addToDraft(reservationId: string, operations: readonly RowOp[]): void {
  const current = draftOf(reservationId);
  const draft: Draft = { requestId: current?.requestId ?? `propuesta-${crypto.randomUUID()}`, operations: mergeOperations(current?.operations ?? [], operations) };
  if (draft.operations.length) { drafts.set(reservationId, draft); persist(reservationId, draft); }
  else { drafts.delete(reservationId); persist(reservationId, null); }
  listeners.forEach((fn) => fn(reservationId));
}

export function clearDraft(reservationId: string): void {
  drafts.delete(reservationId);
  persist(reservationId, null);
  listeners.forEach((fn) => fn(reservationId));
}

/** Avisa cuando cambia el borrador de un retiro; devuelve la baja. */
export function onDraft(listener: (reservationId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type ChangeWhat = 'experience' | 'material' | 'question' | 'offer' | 'other';

/** Qué hace cada operación de una propuesta, para pintarla sin jerga: alta, cambio o baja, de qué y con qué nombre. Puro. */
export function describeChange(op: RowOperation, rows: ReadonlyMap<string, Record<string, unknown>> = new Map()): { action: 'add' | 'change' | 'remove'; what: ChangeWhat; name: string | null } {
  if (op.op === 'call') return { action: 'change', what: 'other', name: null };
  const what: ChangeWhat = op.table === 'organizers.experiences' ? 'experience' : op.table === 'organizers.materials' ? 'material'
    : op.table === 'organizers.questions' ? 'question' : op.table === 'organizers.offers' ? 'offer' : 'other';
  const fields = ('fields' in op && op.fields) || {};
  const row = rows.get(op.id) ?? {};
  const nameOf = (x: Record<string, unknown>) => [x.title, x.label, x.name].find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? null;
  return { action: op.op === 'insert' ? 'add' : op.op === 'delete' ? 'remove' : 'change', what, name: nameOf(fields) ?? nameOf(row) };
}
