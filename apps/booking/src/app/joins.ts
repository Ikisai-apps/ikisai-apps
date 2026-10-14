/**
 * Booking · «Apuntarme» (O2, API.md §26.3): las sugerencias del núcleo de tipo `apuntarme` que esperan al personal.
 * Necesitan red (la cola vive en el núcleo, no en el espejo); sin ella, la ficha lo dice y no inventa nada.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { JOIN_PROCEDURE, JOIN_SUGGESTION_KIND } from '@ikisai/domain-booking';

export interface JoinPerson { person_key?: string; name: string }
export interface PendingJoin {
  id: string;
  reservationId: string;
  persons: JoinPerson[];
  message: string | null;
  author: string;
  createdAt: string;
  args: Record<string, unknown>;
}

type SuggestionLike = { id: string; kind: string; status: string; operations: Array<{ op: string; procedure?: string; args?: Record<string, unknown> }>; author?: { name?: string }; createdAt: string };

/** Pendientes de «Apuntarme», de todas las reservas o de una. `null` si no se pudo preguntar (sin red o sin permiso). */
export async function pendingJoins(client: SyncClient, reservationId?: string): Promise<PendingJoin[] | null> {
  if (!navigator.onLine) return null;
  try {
    const out = await client.suggestions({ scope: 'pending', app: 'booking', limit: 200 });
    return (out.items as unknown as SuggestionLike[]).flatMap((s) => {
      const call = s.kind === JOIN_SUGGESTION_KIND ? s.operations.find((o) => o.op === 'call' && o.procedure === JOIN_PROCEDURE) : undefined;
      const args = call?.args ?? null;
      if (!args || typeof args.reservation_id !== 'string' || (reservationId && args.reservation_id !== reservationId)) return [];
      return [{ id: s.id, reservationId: args.reservation_id, persons: Array.isArray(args.persons) ? (args.persons as JoinPerson[]) : [],
        message: typeof args.message === 'string' ? args.message : null, author: s.author?.name || 'Huésped', createdAt: s.createdAt, args }];
    });
  } catch {
    return null;
  }
}

/** Aceptar (el lote tal cual), pasar al organizador (lote corregido con `mode: 'organizer'`) o descartar. */
export async function decideJoin(client: SyncClient, join: PendingJoin, decision: 'accept' | 'organizer' | 'discard', comment?: string): Promise<void> {
  const extra = comment?.trim() ? { comment: comment.trim() } : {};
  if (decision === 'discard') { await client.decideSuggestion(join.id, 'reject', extra); return; }
  const operations = decision === 'organizer' ? [{ op: 'call', procedure: JOIN_PROCEDURE, args: { ...join.args, mode: 'organizer' } }] : undefined;
  await client.decideSuggestion(join.id, 'approve', { ...extra, ...(operations ? { operations: operations as never } : {}) });
}
