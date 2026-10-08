/**
 * Lo facturado y cobrado de una reserva, que registra Finance (`invoices.reservation_collected`, #324). Lo usa el aviso del
 * plazo máximo interno del saldo en la ficha. Se guarda en memoria unos minutos para no pedirlo en cada repintado.
 */
import type { SyncClient } from '@ikisai/sync-client';

export interface Collected { reservation_id: string; invoiced: number; collected: number; last_collected_at: string | null }

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Collected }>();

export function cachedCollected(reservationId: string): Collected | null {
  const hit = cache.get(reservationId);
  return hit && Date.now() - hit.at < TTL_MS ? hit.value : null;
}

/** Sin red o si Finance no responde, null: el aviso remite entonces a Finance sin afirmar nada. */
export async function fetchCollected(client: SyncClient, reservationId: string): Promise<Collected | null> {
  const hit = cachedCollected(reservationId);
  if (hit) return hit;
  if (!navigator.onLine) return null;
  try {
    const rows = await client.api<Array<Record<string, unknown>>>('/read/invoices.reservation_collected', { method: 'POST', json: { reservation_ids: [reservationId] } });
    const row = (Array.isArray(rows) ? rows : []).find((r) => r.reservation_id === reservationId);
    if (!row) return null;
    const value: Collected = { reservation_id: reservationId, invoiced: Number(row.invoiced ?? 0), collected: Number(row.collected ?? 0), last_collected_at: (row.last_collected_at as string | null) ?? null };
    cache.set(reservationId, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

/** Estado del saldo pasado el plazo: cobrado del todo, pendiente (con lo que falta) o desconocido. */
export function balanceState(contracted: number, collected: Collected | null): { kind: 'paid' } | { kind: 'pending'; missing: number } | { kind: 'unknown' } {
  if (!collected || !Number.isFinite(contracted) || contracted <= 0) return { kind: 'unknown' };
  const missing = Math.round((contracted - collected.collected) * 100) / 100;
  return missing > 0.005 ? { kind: 'pending', missing } : { kind: 'paid' };
}
