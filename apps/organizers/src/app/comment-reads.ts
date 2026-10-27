/**
 * «Comentarios de tus asistentes»: leídos y sin leer (0706; diseño en MUELA/equipo/feedback/organizers/COMENTARIOS_LEIDOS.md).
 * Lo que ha visto cada persona se apunta en `organizers.comment_reads`, en el espejo local: sin red se encola y la marca
 * «Nuevo» se quita al momento. Cada uno ve solo lo suyo. Sin i18n ni DOM, para las pruebas en node.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { SyncApiError } from '@ikisai/sync-client';
import { TABLES, validateOperations } from '../../../../supabase/functions/_domain/organizers/mod.ts';

/** Ids de los comentarios que esta persona ya ha visto en este retiro. */
export async function readIds(client: Pick<SyncClient, 'list'>, reservationId: string, userId: string): Promise<Set<string>> {
  const rows = await client.list(TABLES.commentReads);
  return new Set(rows.filter((r) => r.reservation_id === reservationId && r.user_id === userId && !r.deleted_at).map((r) => String(r.report_id).toLowerCase()));
}

/** Los comentarios (por id) que aún no ha visto. */
export function unreadOf(reportIds: readonly string[], read: ReadonlySet<string>): string[] {
  return reportIds.filter((id) => !read.has(id.toLowerCase()));
}

/** Las filas que apuntan como vistos los que faltan (ninguna si ya estaban). */
export function readOperations(reportIds: readonly string[], read: ReadonlySet<string>, reservationId: string, userId: string): RowOperation[] {
  return unreadOf([...new Set(reportIds.map((id) => id.toLowerCase()))], read).map((reportId) => ({
    op: 'insert', table: TABLES.commentReads, id: crypto.randomUUID(), fields: { reservation_id: reservationId, report_id: reportId, user_id: userId },
  }));
}

/**
 * Apunta como vistos los comentarios. Con «todos» (dirección) también se escribe: leer no es cambiar el retiro, así que no
 * pasa por la propuesta del equipo (`own.ts`, `save`). Devuelve los que se han apuntado.
 */
export async function markRead(client: Pick<SyncClient, 'list' | 'commit' | 'bootstrap'>, reservationId: string, userId: string, reportIds: readonly string[]): Promise<string[]> {
  const read = await readIds(client, reservationId, userId);
  const operations = readOperations(reportIds, read, reservationId, userId);
  if (!operations.length) return [];
  const issue = validateOperations(operations as never, client.bootstrap()?.membership, undefined, userId);
  if (issue) throw new SyncApiError(issue.code === 'OUT_OF_SCOPE' ? 403 : 422, issue.code, issue.message, issue.details);
  await client.commit(operations);
  return operations.map((o) => String((o.fields as { report_id: string }).report_id));
}
