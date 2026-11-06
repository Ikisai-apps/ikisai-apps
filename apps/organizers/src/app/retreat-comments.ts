/**
 * Comentarios del retiro (API.md §15, bandeja de quien organiza): lo que sus asistentes cuentan en Guests sobre el retiro
 * («Cuéntanos qué tal», tema y mensaje). El núcleo los guarda con destino `organizer` y deja verlos a quien tiene ese
 * retiro en su ámbito (`core.feedback_can_see`); `GET feedback?app=guests` los devuelve junto con lo demás que la persona
 * puede ver. Aquí se quedan solo los de huéspedes, sobre el evento y de este retiro. Quien organiza puede contestar
 * (X6, núcleo 0121): el asistente ve la respuesta en Guests, en «Lo que me has enviado», firmada con su nombre.
 */
import type { SyncClient } from '@ikisai/sync-client';

export interface FeedbackItem {
  id: string; code: string; reporterKind: string; subject: string; intent: string; category: string | null; message: string;
  scope: { reservation_id?: string; guest_id?: string } | null; createdAt: string;
  /** La última respuesta (núcleo 0121): de quien organiza (`kind: organizer`, con su nombre) o de la casa («Ikisai»). */
  reply?: { text: string; from: string | null; at: string; kind?: 'house' | 'organizer' } | null;
  /** Si quien lo pide puede contestar (quien organiza ese retiro, a un comentario de un asistente). */
  canReply?: boolean;
}

/** Contesta a un comentario (`POST feedback/:id/replies`, 0121): de 1 a 2000 caracteres, lo comprueba también el núcleo. */
export async function replyTo(client: Pick<SyncClient, 'api'>, reportId: string, message: string): Promise<{ id: string; created_at: string }> {
  return client.api(`/feedback/${encodeURIComponent(reportId)}/replies`, { method: 'POST', json: { message: message.trim() } });
}

export const REPLY_MAX = 2000;

/** Los de huéspedes sobre el evento de este retiro, del más reciente al más antiguo. */
export function retreatComments(items: readonly FeedbackItem[], reservationId: string): FeedbackItem[] {
  const id = reservationId.toLowerCase();
  return items.filter((r) => r.reporterKind === 'guest' && r.subject === 'event' && r.scope?.reservation_id?.toLowerCase() === id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Todos los comentarios de Guests que la persona puede ver, abiertos o no (necesita red). */
export async function loadGuestFeedback(client: Pick<SyncClient, 'api'>): Promise<FeedbackItem[]> {
  const out = await client.api<{ items?: FeedbackItem[] }>('/feedback?app=guests&status=all&limit=500');
  return out.items ?? [];
}
