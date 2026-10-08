/**
 * Datos propios de Organizers (fase 4, API.md §15.1): las tablas `organizers.*` viven en el espejo local de `sync-client`,
 * así que se editan sin red y la cola las envía al volver. Aquí, lectura por retiro, orden y guardado con la misma
 * validación que la Edge (`_domain/organizers`).
 */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { SyncApiError } from '@ikisai/sync-client';
import { TABLES, validateOperations } from '../../../../supabase/functions/_domain/organizers/mod.ts';

export { TABLES };
export type Row = SyncedRow;

export const byPosition = (a: Row, b: Row): number =>
  Number(a.position ?? 0) - Number(b.position ?? 0) || String(a.created_at).localeCompare(String(b.created_at));

/** Filas vivas de un retiro, en su orden. */
export async function rowsOf(client: SyncClient, table: TableName, reservationId: string): Promise<Row[]> {
  return (await client.list(table)).filter((r) => r.reservation_id === reservationId && !r.deleted_at).sort(byPosition);
}

/** Avisa cuando cambian las tablas indicadas (pull o edición); devuelve la baja. */
export function watch(client: SyncClient, tables: TableName[], listener: () => void): () => void {
  const offs = tables.map((table) => client.onTable(table, () => listener()));
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
  const issue = validateOperations(operations as never, client.bootstrap()?.membership, (_t, id) => byId.get(id));
  if (issue) throw new SyncApiError(issue.code === 'OUT_OF_SCOPE' ? 403 : 422, issue.code, issue.message, issue.details);
  await client.commit(operations);
}

/** Id de un archivo ya subido; con el marcador `{$blob}` aún está en la cola de este dispositivo. */
export const fileIdOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);
