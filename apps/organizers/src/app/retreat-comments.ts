/**
 * Comentarios del retiro (API.md §15, bandeja de quien organiza): lo que sus asistentes cuentan en Guests sobre el retiro
 * («Cuéntanos qué tal», tema y mensaje). El núcleo los guarda con destino `organizer` y deja verlos a quien tiene ese
 * retiro en su ámbito (`core.feedback_can_see`); `GET feedback?app=guests` los devuelve junto con lo demás que la persona
 * puede ver. Aquí se quedan solo los de huéspedes, sobre el evento y de este retiro. Solo lectura: los gestiona Ikisai.
 */
import type { SyncClient } from '@ikisai/sync-client';

export interface FeedbackItem {
  id: string; code: string; reporterKind: string; subject: string; intent: string; category: string | null; message: string;
  scope: { reservation_id?: string; guest_id?: string } | null; createdAt: string;
}

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
