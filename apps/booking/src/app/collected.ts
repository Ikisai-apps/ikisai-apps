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

/**
 * «Movimientos» del extracto (MUELA-067; Finance #643, `invoices.reservation_movements`): las emitidas de la reserva una a
 * una, con sus rectificativas en negativo. En memoria unos minutos y la última copia en el dispositivo, para verla sin red;
 * se borra al cerrar sesión (`forgetMovements`).
 */
export interface Movement {
  id: string;
  number: string | null;
  issueDate: string | null;
  concept: string | null;
  purpose: string | null;
  kind: 'factura' | 'rectificativa';
  total: number;
  collected: boolean;
  paidAt: string | null;
}
export interface Movements { at: string; items: Movement[] }

const MOVES_KEY = 'booking:movimientos:';
const movesCache = new Map<string, { at: number; value: Movements }>();

function storedMovements(reservationId: string): Movements | null {
  try {
    const raw = localStorage.getItem(MOVES_KEY + reservationId);
    const value = raw ? JSON.parse(raw) as Movements : null;
    return value && Array.isArray(value.items) ? value : null;
  } catch {
    return null;
  }
}

/** Lo que hay sin pedir nada: la copia en memoria o, si no, la del dispositivo. */
export function cachedMovements(reservationId: string): { value: Movements; fresh: boolean } | null {
  const hit = movesCache.get(reservationId);
  if (hit) return { value: hit.value, fresh: Date.now() - hit.at < TTL_MS };
  const stored = storedMovements(reservationId);
  return stored ? { value: stored, fresh: false } : null;
}

/** Pide las facturas a Finance. Sin red o si falla, null (y se sigue con la copia que haya). */
export async function fetchMovements(client: SyncClient, reservationId: string): Promise<Movements | null> {
  const hit = movesCache.get(reservationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (!navigator.onLine) return null;
  try {
    const rows = await client.api<Array<Record<string, unknown>>>('/read/invoices.reservation_movements', { method: 'POST', json: { reservation_ids: [reservationId] } });
    const items: Movement[] = (Array.isArray(rows) ? rows : []).filter((r) => r.reservation_id === reservationId).map((r) => ({
      id: String(r.issued_invoice_id ?? r.full_number ?? crypto.randomUUID()),
      number: (r.full_number as string | null) ?? null,
      issueDate: (r.issue_date as string | null) ?? null,
      concept: (r.concept as string | null) ?? null,
      purpose: (r.purpose as string | null) ?? null,
      kind: r.kind === 'rectificativa' ? 'rectificativa' : 'factura',
      total: Number(r.total ?? 0),
      collected: r.collected === true,
      paidAt: (r.paid_at as string | null) ?? null,
    }));
    const value: Movements = { at: new Date().toISOString(), items };
    movesCache.set(reservationId, { at: Date.now(), value });
    try { localStorage.setItem(MOVES_KEY + reservationId, JSON.stringify(value)); } catch { /* sin almacenamiento: solo en memoria */ }
    return value;
  } catch {
    return null;
  }
}

/** Al cerrar sesión: fuera las copias de las facturas. */
export function forgetMovements(): void {
  movesCache.clear();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(MOVES_KEY)) localStorage.removeItem(key);
    }
  } catch { /* nada que borrar */ }
}

/** Lo cobrado según las facturas (las rectificativas restan): sirve sin red, con la última copia. */
export const collectedFromMovements = (m: Movements): number => Math.round(m.items.filter((x) => x.collected).reduce((s, x) => s + x.total, 0) * 100) / 100;
