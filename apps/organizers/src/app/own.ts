/**
 * Datos propios de Organizers (fase 4, API.md §15.1): las tablas `organizers.*` viven en el espejo local de `sync-client`,
 * así que se editan sin red y la cola las envía al volver. Aquí, lectura por retiro, orden y guardado con la misma
 * validación que la Edge (`_domain/organizers`).
 *
 * Dirección sin permiso propio sobre el retiro (solo «todos», 0703) no escribe: `save` junta el cambio en la propuesta
 * del equipo de Ikisai (`proposal-draft.ts`) y `rowsOf` y `watch` la ven encima del espejo, así que las pantallas no cambian.
 */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { SyncApiError } from '@ikisai/sync-client';
import { TABLES, validateOperations, writeMode } from '../../../../supabase/functions/_domain/organizers/mod.ts';
import { addToDraft, draftOf, hasPendingFile, onDraft, overlay } from './proposal-draft.ts';

export { TABLES };
export type Row = SyncedRow;

export const byPosition = (a: Row, b: Row): number =>
  Number(a.position ?? 0) - Number(b.position ?? 0) || String(a.created_at).localeCompare(String(b.created_at));

/** Filas vivas de un retiro, en su orden. */
export async function rowsOf(client: SyncClient, table: TableName, reservationId: string): Promise<Row[]> {
  const rows = (await client.list(table)).filter((r) => r.reservation_id === reservationId && !r.deleted_at);
  const draft = draftOf(reservationId);
  return (draft ? overlay(rows, draft.operations, table) : rows).sort(byPosition);
}

/** Avisa cuando cambian las tablas indicadas (pull o edición); devuelve la baja. */
export function watch(client: SyncClient, tables: TableName[], listener: () => void): () => void {
  const offs = [...tables.map((table) => client.onTable(table, () => listener())), onDraft(() => listener())];
  return () => offs.forEach((off) => off());
}

/** Biblioteca: lo que creó esta persona en otros retiros (materiales y preguntas), lo más reciente primero. */
export async function libraryOf(client: SyncClient, table: TableName, userId: string, reservationId: string): Promise<Row[]> {
  return (await client.list(table)).filter((r) => r.owner_id === userId && r.reservation_id !== reservationId && !r.deleted_at)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export const nextPosition = (rows: Row[]): number => rows.reduce((max, r) => Math.max(max, Number(r.position) || 0), 0) + 1;

/** Valida como la Edge y encola. Un problema de forma sale como error de la API (código y detalle). */
export async function save(client: SyncClient, operations: RowOperation[], current: Row[] = []): Promise<void> {
  const byId = new Map(current.map((r) => [r.id, r]));
  const membership = client.bootstrap()?.membership;
  const reservation = reservationOf(operations, byId);
  if (reservation && writeMode(membership, reservation) === 'propose') {
    const issue = validateOperations(operations as never, membership, (_t, id) => byId.get(id), null, 'proposal');
    if (issue) throw new SyncApiError(issue.code === 'OUT_OF_SCOPE' ? 403 : 422, issue.code, issue.message, issue.details);
    if (hasPendingFile(operations)) throw new SyncApiError(422, 'PROPOSAL_NO_FILES', 'Una propuesta no lleva archivos.', {});
    addToDraft(reservation, operations as never);
    return;
  }
  const issue = validateOperations(operations as never, membership, (_t, id) => byId.get(id));
  if (issue) throw new SyncApiError(issue.code === 'OUT_OF_SCOPE' ? 403 : 422, issue.code, issue.message, issue.details);
  await client.commit(operations);
}

/** Retiro de un lote: el del alta o el de la fila que se cambia (todas las de un lote son del mismo). */
function reservationOf(operations: RowOperation[], byId: Map<string, Row>): string | null {
  for (const op of operations) {
    if (op.op === 'call') continue;
    const fromFields = 'fields' in op && op.fields && typeof op.fields.reservation_id === 'string' ? op.fields.reservation_id : null;
    const fromRow = byId.get(op.id)?.reservation_id;
    const id = fromFields ?? (typeof fromRow === 'string' ? fromRow : null);
    if (id) return id;
  }
  return null;
}

/** Id de un archivo ya subido; con el marcador `{$blob}` aún está en la cola de este dispositivo. */
export const fileIdOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);
