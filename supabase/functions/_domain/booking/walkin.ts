/**
 * Alojamiento a la carta (0487, VG 27-10-2026): el precio por noche que sale de las tarifas y el apunte de ingresos que
 * Booking manda a Finance (`invoices.record_app_entry`) al cobrar. Sin DOM ni red.
 */

export const WALKIN_METHODS = ['cash', 'bizum', 'card'] as const;
export type WalkinMethod = (typeof WALKIN_METHODS)[number];
export const WALKIN_METHOD_LABELS: Record<WalkinMethod, string> = { cash: 'Efectivo', bizum: 'Bizum', card: 'Tarjeta (datáfono)' };

interface RateLike {
  id: string; service?: string | null; unit?: string | null; amount?: number | string | null; active?: boolean | null;
  event_types?: string[] | null; valid_from?: string | null; valid_to?: string | null; position?: number | null; deleted_at?: string | null;
}

/**
 * Precio por noche (céntimos) de la tarifa de alojamiento por persona y noche que vale para ese tipo de reserva y ese día:
 * activa, de servicio «alojamiento», por persona y noche, sin tipos (todos) o con el tipo, y dentro de sus fechas. La
 * primera por posición; `null` si no hay ninguna.
 */
export function walkinNightPrice(rates: readonly RateLike[], eventType: string, day: string): { rateId: string; cents: number } | null {
  const fits = rates.filter((r) => !r.deleted_at && r.active !== false && r.service === 'alojamiento' && r.unit === 'persona_noche'
    && (!r.event_types || r.event_types.length === 0 || r.event_types.includes(eventType))
    && (!r.valid_from || r.valid_from <= day) && (!r.valid_to || day <= r.valid_to)
    && Number.isFinite(Number(r.amount)));
  fits.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  const r = fits[0];
  return r ? { rateId: r.id, cents: Math.round(Number(r.amount) * 100) } : null;
}

export interface WalkinForSend {
  id: string; event_id: string; nights: number; price_cents: number; amount_cents: number; method: WalkinMethod | null;
  paid_day: string | null; title: string; guest: string | null; space: string | null; bed: string | null;
}

/** El apunte para Finance (§17.2 de invoices). Idempotente por `source_ref`: reenviar sustituye o no cambia nada. */
export function walkinFinanceEntry(c: WalkinForSend) {
  if (!c.method || !c.paid_day) throw new Error('walkin not paid');
  const where = [c.space, c.bed].filter(Boolean).join(' · ') || 'Sin cama';
  return {
    source_app: 'booking', source_ref: `booking:stay:${c.id}`, kind: 'income', entry_date: c.paid_day,
    description: `Alojamiento · ${c.title}${c.guest ? ` · ${c.guest}` : ''} · ${c.nights} ${c.nights === 1 ? 'noche' : 'noches'}`.slice(0, 200),
    amount_cents: c.amount_cents, tax_rate: 10,
    methods: { [c.method]: c.amount_cents },
    detail: [{ code: 'noche', name: `Noche en ${where}`, quantity: c.nights, amount_cents: c.amount_cents }],
    event_id: c.event_id,
  };
}
