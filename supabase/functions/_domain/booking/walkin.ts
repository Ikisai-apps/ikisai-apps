/**
 * Alojamiento a la carta (0487, VG 27-10-2026): el precio por noche que sale de las tarifas y el apunte de ingresos que
 * Booking manda a Finance (`invoices.record_app_entry`) al cobrar. Sin DOM ni red.
 */

export const WALKIN_METHODS = ['cash', 'bizum', 'bitcoin', 'card'] as const;
export type WalkinMethod = (typeof WALKIN_METHODS)[number];
export const WALKIN_METHOD_LABELS: Record<WalkinMethod | 'online', string> = { cash: 'Efectivo', bizum: 'Bizum', bitcoin: 'Bitcoin', card: 'Tarjeta (datáfono)', online: 'En línea' };
/** El cobro que llega pagado por la pasarela (1413): no se elige a mano en recepción. */
export type ChargeMethod = WalkinMethod | 'online';

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
  id: string; event_id: string; nights: number; price_cents: number; amount_cents: number; method: ChargeMethod | null;
  paid_day: string | null; title: string; guest: string | null; space: string | null; bed: string | null;
  /** 1403: lo devuelto (céntimos) y con qué método; el apunte va por lo cobrado menos lo devuelto. */
  refund_cents?: number | null; refund_method?: ChargeMethod | null;
}

/**
 * El apunte para Finance (§17.2 de invoices). Idempotente por `source_ref`: reenviar sustituye o no cambia nada.
 * Con devolución (1403), un solo apunte por lo cobrado menos lo devuelto: el método de la devolución en negativo y una línea
 * de detalle negativa, para que métodos y desglose sumen el importe (lo exige Finance).
 */
export function walkinFinanceEntry(c: WalkinForSend) {
  if (!c.method || !c.paid_day) throw new Error('walkin not paid');
  const where = [c.space, c.bed].filter(Boolean).join(' · ') || 'Sin cama';
  const refund = Math.max(0, Math.min(Number(c.refund_cents) || 0, c.amount_cents));
  const methods: Record<string, number> = { [c.method]: c.amount_cents };
  if (refund > 0) {
    const back = c.refund_method ?? c.method;
    methods[back] = (methods[back] ?? 0) - refund;
  }
  const detail = [{ code: 'noche', name: `Noche en ${where}`, quantity: c.nights, amount_cents: c.amount_cents }];
  if (refund > 0) detail.push({ code: 'devolucion', name: 'Devolución', quantity: 1, amount_cents: -refund });
  return {
    source_app: 'booking', source_ref: `booking:stay:${c.id}`, kind: 'income', entry_date: c.paid_day,
    description: `Alojamiento · ${c.title}${c.guest ? ` · ${c.guest}` : ''} · ${c.nights} ${c.nights === 1 ? 'noche' : 'noches'}${refund > 0 ? ' · con devolución' : ''}`.slice(0, 200),
    amount_cents: c.amount_cents - refund, tax_rate: 10,
    methods,
    detail,
    event_id: c.event_id,
  };
}

/** Código público del evento (0488): 10 caracteres sin ambigüedades (sin 0/O ni 1/I/L). */
export const PUBLIC_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PUBLIC_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;
/** Un código nuevo con aleatorio fuerte («Regenerar»). */
export function newPublicCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return Array.from(random(10), (b) => PUBLIC_CODE_ALPHABET[b % PUBLIC_CODE_ALPHABET.length]).join('');
}
/** La URL del QR de entrada de visitantes (acordada con Guests). */
export const visitorUrl = (code: string): string => `https://ven.ikisai.com/e/${code}`;

