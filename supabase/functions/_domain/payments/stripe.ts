/**
 * Pasarela de pago compartida (finance-18; dueña: Finance, la consume también Booking). Decisión de VG del 27-10: Stripe
 * ahora, Redsys/Bizum después; ningún dato de tarjeta pasa por Ikisai (el pago ocurre en la página de Stripe).
 *
 * - `PaymentGateway`: lo que necesita una app para cobrar un importe con un enlace que caduca y saber si se pagó.
 * - `createStripeGateway({ secretKey })`: Stripe Checkout por su API REST (sin SDK). La sesión cobra un importe exacto
 *   (lo pone el servidor, nunca el cliente), caduca (máximo 24 h) y lleva `metadata` para casar el pago.
 * - `verifyStripeSignature`: la firma del webhook (`Stripe-Signature: t=…,v1=…`, HMAC-SHA256 de `t.cuerpo`) con
 *   tolerancia de tiempo. Sin firma válida, el aviso no vale.
 * - El Stripe falso para pruebas está en `./fake.ts` (mismo contrato, sin red).
 * Los secretos (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) solo viven en la Edge; aquí llegan como parámetro.
 */

export interface CheckoutRequest {
  /** Céntimos, entero > 0. */
  amountCents: number;
  /** ISO 4217 en minúsculas (`eur`). */
  currency: string;
  /** Lo que ve quien paga («Factura PA-2026-0101 · Retiro de octubre»). Sin datos personales. */
  description: string;
  /** Para casar el pago (`issued_invoice_id`, `reservation_id`…). Solo ids, nunca datos personales. */
  metadata: Record<string, string>;
  /** Cuándo caduca (Stripe: entre 30 min y 24 h desde ahora). */
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  /** Misma clave = misma sesión (reintentos). */
  idempotencyKey: string;
}

export interface CheckoutSession {
  provider: 'stripe';
  id: string;
  url: string;
  expiresAt: string;
  /** `open`, `complete` o `expired` (Stripe). */
  status: 'open' | 'complete' | 'expired';
  /** `paid` cuando el cobro está hecho. */
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
  /** El pago de Stripe (`pi_…`) cuando lo hay: hace falta para devolver. */
  paymentIntent: string | null;
}

/** Aviso de la pasarela ya normalizado (lo que necesitan Finance y Booking, sin nada de la tarjeta). */
export interface PaymentEvent {
  eventId: string;
  kind: 'paid' | 'expired' | 'refunded' | 'failed' | 'ignored';
  /** La sesión de Checkout (`cs_…`), si el aviso es de una sesión. */
  sessionId: string | null;
  paymentIntent: string | null;
  amountCents: number | null;
  /** En una devolución, lo devuelto en total hasta ahora. */
  refundedCents: number | null;
  currency: string | null;
  metadata: Record<string, string>;
}

export interface PaymentGateway {
  provider: 'stripe';
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  getCheckout(id: string): Promise<CheckoutSession>;
  /** Caduca a mano una sesión abierta (al anular o cobrar a mano la factura). */
  expireCheckout(id: string): Promise<CheckoutSession>;
  /** Devuelve parte o todo de un pago (`pi_…`). Idempotente por clave. */
  refund(paymentIntent: string, amountCents: number, idempotencyKey: string): Promise<{ refundId: string; status: string }>;
}

export class PaymentGatewayError extends Error {
  constructor(message: string, readonly code: string, readonly status: number | null = null) { super(message); }
}

const API = 'https://api.stripe.com/v1';
/** Stripe admite caducidad entre 30 min y 24 h; se recorta un poco para no rozar el límite. */
const MIN_MS = 31 * 60_000;
const MAX_MS = 23 * 3600_000 + 55 * 60_000;

/** Comprueba la petición antes de mandarla: importe entero positivo, moneda, caducidad dentro del margen y metadatos cortos. */
export function checkCheckoutRequest(r: CheckoutRequest, now = Date.now()): void {
  if (!Number.isInteger(r.amountCents) || r.amountCents <= 0) throw new PaymentGatewayError('Importe inválido.', 'INVALID_AMOUNT');
  if (!/^[a-z]{3}$/.test(r.currency)) throw new PaymentGatewayError('Moneda inválida.', 'INVALID_CURRENCY');
  const ms = r.expiresAt.getTime() - now;
  if (!(ms >= MIN_MS && ms <= MAX_MS + 5 * 60_000)) throw new PaymentGatewayError('Caducidad fuera de margen (30 min – 24 h).', 'INVALID_EXPIRY');
  if (Object.keys(r.metadata).length > 20 || Object.entries(r.metadata).some(([k, v]) => k.length > 40 || v.length > 500)) throw new PaymentGatewayError('Metadatos demasiado largos.', 'INVALID_METADATA');
  if (!/^https:\/\//.test(r.successUrl) || !/^https:\/\//.test(r.cancelUrl)) throw new PaymentGatewayError('URL de vuelta inválida.', 'INVALID_URL');
}

/** Caducidad estándar: 24 h (recortada al margen de Stripe). */
export function defaultExpiry(now = Date.now()): Date {
  return new Date(now + MAX_MS);
}

function form(r: CheckoutRequest): URLSearchParams {
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('line_items[0][quantity]', '1');
  f.set('line_items[0][price_data][currency]', r.currency);
  f.set('line_items[0][price_data][unit_amount]', String(r.amountCents));
  f.set('line_items[0][price_data][product_data][name]', r.description.slice(0, 250));
  f.set('expires_at', String(Math.floor(r.expiresAt.getTime() / 1000)));
  f.set('success_url', r.successUrl);
  f.set('cancel_url', r.cancelUrl);
  for (const [k, v] of Object.entries(r.metadata)) {
    f.set(`metadata[${k}]`, v);
    f.set(`payment_intent_data[metadata][${k}]`, v);
  }
  return f;
}

/** De la respuesta de Stripe a nuestro contrato (solo lo que hace falta; nada de la tarjeta). */
export function sessionFrom(raw: any): CheckoutSession {
  return {
    provider: 'stripe', id: String(raw.id), url: String(raw.url ?? ''),
    expiresAt: new Date(Number(raw.expires_at) * 1000).toISOString(),
    status: raw.status === 'complete' || raw.status === 'expired' ? raw.status : 'open',
    paymentStatus: raw.payment_status === 'paid' || raw.payment_status === 'no_payment_required' ? raw.payment_status : 'unpaid',
    amountCents: Number(raw.amount_total ?? 0), currency: String(raw.currency ?? ''),
    metadata: Object.fromEntries(Object.entries(raw.metadata ?? {}).map(([k, v]) => [k, String(v)])),
    paymentIntent: typeof raw.payment_intent === 'string' ? raw.payment_intent : (raw.payment_intent?.id ?? null),
  };
}

/**
 * Un evento de Stripe (ya verificado con `verifyStripeSignature`) en el formato común:
 * - `checkout.session.completed` con `payment_status = paid` (o `checkout.session.async_payment_succeeded`) → `paid`;
 * - `checkout.session.expired` → `expired`; `checkout.session.async_payment_failed` → `failed`;
 * - `charge.refunded` → `refunded`, con `amount_refunded` y el `payment_intent` (la app lo casa con su sesión guardada);
 * - lo demás → `ignored`.
 */
export function normalizeStripeEvent(event: { id: string; type: string; data: { object: any } }): PaymentEvent {
  const o = event.data?.object ?? {};
  const meta = Object.fromEntries(Object.entries(o.metadata ?? {}).map(([k, v]) => [k, String(v)]));
  const pi = typeof o.payment_intent === 'string' ? o.payment_intent : (o.payment_intent?.id ?? null);
  const base = { eventId: String(event.id), sessionId: o.object === 'checkout.session' ? String(o.id) : null, paymentIntent: pi, currency: o.currency ?? null, metadata: meta };
  switch (event.type) {
    case 'checkout.session.completed':
      return { ...base, kind: o.payment_status === 'paid' ? 'paid' : 'ignored', amountCents: Number(o.amount_total ?? 0), refundedCents: null };
    case 'checkout.session.async_payment_succeeded':
      return { ...base, kind: 'paid', amountCents: Number(o.amount_total ?? 0), refundedCents: null };
    case 'checkout.session.async_payment_failed':
      return { ...base, kind: 'failed', amountCents: Number(o.amount_total ?? 0), refundedCents: null };
    case 'checkout.session.expired':
      return { ...base, kind: 'expired', amountCents: Number(o.amount_total ?? 0), refundedCents: null };
    case 'charge.refunded':
      return { ...base, kind: 'refunded', amountCents: Number(o.amount ?? 0), refundedCents: Number(o.amount_refunded ?? 0) };
    default:
      return { ...base, kind: 'ignored', amountCents: null, refundedCents: null };
  }
}

export function createStripeGateway(options: { secretKey: string; fetch?: typeof fetch; now?: () => number }): PaymentGateway {
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  async function call(method: 'GET' | 'POST', path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<any> {
    let res: Response;
    try {
      res = await transport(`${API}${path}`, {
        method, headers: { Authorization: `Bearer ${options.secretKey}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(body ? { body: body.toString() } : {}), signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaymentGatewayError('La pasarela no responde.', 'GATEWAY_UNAVAILABLE');
    }
    const out = await res.json().catch(() => ({})) as any;
    if (!res.ok) throw new PaymentGatewayError(String(out?.error?.message ?? 'La pasarela ha rechazado la operación.').slice(0, 300), String(out?.error?.code ?? 'GATEWAY_REJECTED'), res.status);
    return out;
  }
  return {
    provider: 'stripe',
    async createCheckout(r) { checkCheckoutRequest(r, now()); return sessionFrom(await call('POST', '/checkout/sessions', form(r), r.idempotencyKey)); },
    async getCheckout(id) { return sessionFrom(await call('GET', `/checkout/sessions/${encodeURIComponent(id)}`)); },
    async expireCheckout(id) { return sessionFrom(await call('POST', `/checkout/sessions/${encodeURIComponent(id)}/expire`, new URLSearchParams())); },
    async refund(paymentIntent, amountCents, idempotencyKey) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new PaymentGatewayError('Importe inválido.', 'INVALID_AMOUNT');
      const out = await call('POST', '/refunds', new URLSearchParams({ payment_intent: paymentIntent, amount: String(amountCents) }), idempotencyKey);
      return { refundId: String(out.id), status: String(out.status ?? '') };
    },
  };
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Firma del webhook de Stripe. `payload` es el cuerpo tal cual llegó (texto, sin reparsear). Devuelve el evento ya
 * parseado si la firma es buena y está dentro de la tolerancia (300 s); si no, lanza `PaymentGatewayError`.
 */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, options: { toleranceSec?: number; now?: number } = {}): Promise<{ id: string; type: string; data: { object: any } }> {
  if (!header || !secret) throw new PaymentGatewayError('Sin firma.', 'SIGNATURE_MISSING');
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const v1 = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !v1.length) throw new PaymentGatewayError('Firma mal formada.', 'SIGNATURE_INVALID');
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - t) > (options.toleranceSec ?? 300)) throw new PaymentGatewayError('Firma fuera de tiempo.', 'SIGNATURE_EXPIRED');
  const expected = await hmacHex(secret, `${t}.${payload}`);
  if (!v1.some((v) => sameHex(v, expected))) throw new PaymentGatewayError('Firma incorrecta.', 'SIGNATURE_INVALID');
  try { return JSON.parse(payload); } catch { throw new PaymentGatewayError('Cuerpo inválido.', 'PAYLOAD_INVALID'); }
}

/** Para pruebas y para el Stripe falso: la cabecera `Stripe-Signature` de un cuerpo. */
export async function signStripePayload(payload: string, secret: string, at = Date.now()): Promise<string> {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${payload}`)}`;
}
