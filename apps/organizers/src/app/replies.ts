/**
 * Respuestas de la casa a lo que quien organiza escribe a Ikisai (núcleo 0117; diseño en
 * MUELA/equipo/feedback/organizers/RESPUESTAS_CASA.md). `GET feedback/replies` trae las respuestas a sus propios informes,
 * firmadas «Ikisai», con su retiro. Sin i18n ni DOM, para las pruebas en node.
 */
import type { SyncClient } from '@ikisai/sync-client';

export interface Reply { id: string; report_id: string; report_code?: string; reservation_id: string | null; message: string; created_at: string; read: boolean }

/** Las respuestas a mis informes (necesita red; sin ella, ninguna). */
export async function loadReplies(client: Pick<SyncClient, 'api'>): Promise<Reply[]> {
  const out = await client.api<{ items?: Reply[] }>('/feedback/replies');
  return out.items ?? [];
}

/** «Mis retiros»: cuántas respuestas sin ver tiene cada retiro (por id de reserva, en minúsculas). */
export function unreadRepliesByReservation(replies: readonly Reply[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of replies) {
    const id = r.reservation_id?.toLowerCase();
    if (!id || r.read) continue;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** Las de un informe, de la más antigua a la más nueva. */
export function repliesOf(replies: readonly Reply[], reportId: string): Reply[] {
  return replies.filter((r) => r.report_id === reportId).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Marca como vistas las que se acaban de enseñar (solo las que aún no lo estaban). */
export async function markRepliesRead(client: Pick<SyncClient, 'api'>, replies: readonly Reply[]): Promise<number> {
  const ids = replies.filter((r) => !r.read).map((r) => r.id);
  if (!ids.length) return 0;
  const out = await client.api<{ read?: number }>('/feedback/replies/read', { method: 'POST', json: { ids } });
  return out.read ?? 0;
}
