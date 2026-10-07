/** Coste real de una reserva: compras de Invoices asignadas a la reserva y a su evento (`invoices.booking_cost_projection`), con caché local por reserva. */
import type { SyncClient } from '@ikisai/sync-client';

export interface CostRow {
  allocation_id: string;
  target_kind: string;
  target_id: string;
  invoice_code: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
  expense_category: string | null;
  is_investment: boolean;
  /** Puede llegar como número o como texto. */
  allocated_amount: number | string;
  allocation_revision?: number;
}

export interface CostSummary {
  total: number;
  /** Suma por categoría, de mayor a menor; la inversión va aparte. */
  categories: Array<{ category: string; amount: number; investment: boolean; invoices: number }>;
  rows: Array<{ id: string; date: string | null; supplier: string; amount: number; code: string | null }>;
}

export interface CostResult {
  summary: CostSummary;
  fetchedAt: string;
}

const CACHE_PREFIX = 'booking.costs.';

export function readCostCache(reservationId: string): CostResult | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + reservationId);
    return raw ? (JSON.parse(raw) as CostResult) : null;
  } catch {
    return null;
  }
}

function writeCostCache(reservationId: string, result: CostResult): void {
  try {
    localStorage.setItem(CACHE_PREFIX + reservationId, JSON.stringify(result));
  } catch {
    /* sin almacenamiento: la app funciona igual */
  }
}

/** Borra todas las cachés de costes (son importes): se llama al cerrar sesión. */
export function clearCostCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* nada que borrar */
  }
}

/** Enlaces a Invoices (`docs/invoices/API.md` §9.6). */
export const INVOICES_URL = 'https://invoices.ikisai.com';
export const invoiceUrl = (code: string): string => `${INVOICES_URL}/#/facturas/${encodeURIComponent(code)}`;
/** Emitir la factura de una reserva en Finance (docs/invoices/API.md §14.8): Finance lee la reserva y abre su borrador. */
export const issueInvoiceUrl = (reservationId: string): string => `https://finance.ikisai.com/#/facturas?vista=emitidas&desde=booking:reservation:${encodeURIComponent(reservationId)}`;
export const purchasesUrl = (kind: 'reservation' | 'event', id: string): string => `${INVOICES_URL}/#/compras?destino=booking:${kind}:${id}`;

/** Agrega las filas de la proyección: total, suma por categoría y lista por fecha (más reciente primero). */
export function summarizeCosts(rows: CostRow[]): CostSummary {
  const seen = new Set<string>();
  const unique = rows.filter((row) => (seen.has(row.allocation_id) ? false : (seen.add(row.allocation_id), true)));
  const amount = (row: CostRow): number => { const n = Number(row.allocated_amount); return Number.isFinite(n) ? n : 0; };
  const byCategory = new Map<string, { amount: number; investment: boolean; codes: Set<string> }>();
  for (const row of unique) {
    const category = row.expense_category || 'Sin categoría';
    const key = `${row.is_investment ? 'i' : 'g'}|${category}`;
    const entry = byCategory.get(key) ?? { amount: 0, investment: row.is_investment === true, codes: new Set<string>() };
    entry.amount += amount(row);
    entry.codes.add(row.invoice_code ?? row.allocation_id);
    byCategory.set(key, entry);
  }
  return {
    total: Math.round(unique.reduce((sum, row) => sum + amount(row), 0) * 100) / 100,
    categories: [...byCategory.entries()].map(([key, v]) => ({ category: key.slice(2), amount: Math.round(v.amount * 100) / 100, investment: v.investment, invoices: v.codes.size })).sort((a, b) => b.amount - a.amount),
    rows: unique.map((row) => ({ id: row.allocation_id, date: row.invoice_date, supplier: row.supplier_name ?? '—', amount: amount(row), code: row.invoice_code }))
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || a.id.localeCompare(b.id)),
  };
}

async function readTarget(client: SyncClient, targetId: string): Promise<CostRow[]> {
  const response = await client.api<{ rows: CostRow[] }>(`/read/invoices.booking_cost_projection?where[target_id]=${encodeURIComponent(targetId)}`);
  return response.rows ?? [];
}

/**
 * Pide los costes de la reserva (y de su evento, si existe), guarda la caché y devuelve el resumen.
 * Devuelve `null` sin red; lanza si la API responde con error.
 */
export async function fetchCosts(client: SyncClient, reservationId: string, eventId: string | null): Promise<CostResult | null> {
  if (!navigator.onLine) return null;
  const [forReservation, forEvent] = await Promise.all([readTarget(client, reservationId), eventId ? readTarget(client, eventId) : Promise.resolve([] as CostRow[])]);
  const result: CostResult = { summary: summarizeCosts([...forReservation, ...forEvent]), fetchedAt: new Date().toISOString() };
  writeCostCache(reservationId, result);
  return result;
}
