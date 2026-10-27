/**
 * Venta de noches en línea (booking-22; 1413): la pasarela de pago detrás de una interfaz, para que la elección de la
 * pasarela (vg-38) solo cambie el adaptador.
 * - La tarjeta la pone el visitante en la página de la pasarela (alojada por ella): Ikisai nunca ve datos de tarjeta.
 * - La pasarela avisa por webhook firmado. El adaptador comprueba la firma y lo traduce a un evento neutro.
 * - Sin pasarela configurada (lo de hoy), el pago en línea responde 503 `PAYMENTS_OFF`.
 */

import { normalizeStripeEvent, PaymentGatewayError, verifyStripeSignature, type PaymentGateway } from '../_domain/payments/stripe.ts';

export interface PaymentIntentInput {
  /** Importe que calcula el servidor (céntimos, EUR). */
  amountCents: number;
  /** Referencia propia, estable por solicitud (`booking-stay-<id>`). */
  reference: string;
  description: string;
  /** Adónde vuelve el visitante al terminar (ven.ikisai.com). */
  returnUrl: string;
  /** Hasta cuándo vale el intento (el fin de la retención). */
  expiresAt: string;
}

export interface PaymentIntent { providerRef: string; redirectUrl: string }

/** Un aviso de la pasarela ya verificado. */
export interface PaymentEvent {
  eventId: string;
  providerRef: string;
  /** `ignored`: un aviso válido que no es de Booking (otra app de la misma cuenta) o que no interesa: se acusa con 200. */
  status: 'paid' | 'failed' | 'expired' | 'refunded' | 'ignored';
  /** El pago de la pasarela (`pi_…`), con `paid`: con él se casan después las devoluciones (1420). */
  paymentRef?: string;
  refundedCents?: number;
  feeCents?: number;
}

export interface PaymentProvider {
  /** Nombre corto (`redsys`, `stripe`…): va en `stay_payments.provider` y en la ruta del webhook. */
  name: string;
  createIntent(input: PaymentIntentInput): Promise<PaymentIntent>;
  /** Comprueba la firma y traduce el aviso; `null` si no es válido o no interesa. */
  parseWebhook(request: Request): Promise<PaymentEvent | null>;
  /** Devuelve parte o todo de un pago (1414). Con la misma clave, la pasarela devuelve una sola vez (1419). */
  refund?(providerRef: string, cents: number, idempotencyKey?: string): Promise<{ refundRef: string }>;
  /** Estado de un intento, para conciliar avisos perdidos (1414). */
  fetchStatus?(providerRef: string): Promise<{ status: 'pending' | 'paid' | 'failed' | 'expired'; feeCents?: number; paymentRef?: string }>;
  /** Caduca a mano un intento abierto (la cama ya no está guardada; 1420). */
  expireIntent?(providerRef: string): Promise<void>;
}

/**
 * Stripe (1420): envuelve la pasarela compartida de Finance (`_domain/payments/stripe.ts`) con el contrato de Booking.
 * - La sesión caduca como pronto a los 31 minutos (Stripe no deja menos); la cama se guarda 20 (VG). El worker de
 *   conciliación caduca a mano las sesiones de lo que ya venció (`expireIntent`).
 * - `metadata.app = 'booking'`: la cuenta de Stripe es compartida y cada app atiende solo sus avisos. Los de otra app son
 *   `ignored`. Una devolución sin metadatos se intenta casar por el pago y, si no es nuestra, también se acusa.
 */
export function stripeBookingProvider(options: {
  gateway: PaymentGateway;
  webhookSecret: string;
  verify?: typeof verifyStripeSignature;
  now?: () => number;
}): PaymentProvider {
  const { gateway, webhookSecret } = options;
  const verify = options.verify ?? verifyStripeSignature;
  const now = options.now ?? Date.now;
  return {
    name: 'stripe',
    async createIntent(input) {
      const expiresAt = new Date(Math.max(Date.parse(input.expiresAt), now() + 31 * 60_000 + 30_000));
      const session = await gateway.createCheckout({
        amountCents: input.amountCents, currency: 'eur', description: input.description, metadata: { app: 'booking', reference: input.reference },
        expiresAt, successUrl: input.returnUrl, cancelUrl: `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}cancelado=1`,
        idempotencyKey: `${input.reference}-${input.expiresAt}`,
      });
      return { providerRef: session.id, redirectUrl: session.url };
    },
    async parseWebhook(request) {
      let raw: Awaited<ReturnType<typeof verifyStripeSignature>>;
      try {
        raw = await verify(await request.text(), request.headers.get('stripe-signature'), webhookSecret);
      } catch {
        return null;
      }
      const e = normalizeStripeEvent(raw);
      const foreign = e.metadata.app !== undefined && e.metadata.app !== 'booking';
      const ref = e.sessionId ?? e.paymentIntent;
      if (foreign || e.kind === 'ignored' || !ref) return { eventId: e.eventId, providerRef: ref ?? '', status: 'ignored' };
      return {
        eventId: e.eventId, providerRef: ref, status: e.kind,
        ...(e.kind === 'refunded' && e.refundedCents !== null ? { refundedCents: e.refundedCents } : {}),
        ...(e.kind === 'paid' && e.paymentIntent ? { paymentRef: e.paymentIntent } : {}),
      };
    },
    async refund(providerRef, cents, idempotencyKey) {
      const session = await gateway.getCheckout(providerRef);
      if (!session.paymentIntent) throw new PaymentGatewayError('La sesión no tiene pago.', 'NOT_PAID');
      const out = await gateway.refund(session.paymentIntent, cents, idempotencyKey ?? `booking-refund-${providerRef}-${crypto.randomUUID()}`);
      return { refundRef: out.refundId };
    },
    async fetchStatus(providerRef) {
      const s = await gateway.getCheckout(providerRef);
      if (s.status === 'complete' && s.paymentStatus === 'paid') return { status: 'paid', ...(s.paymentIntent ? { paymentRef: s.paymentIntent } : {}) };
      if (s.status === 'expired') return { status: 'expired' };
      return { status: 'pending' };
    },
    async expireIntent(providerRef) {
      await gateway.expireCheckout(providerRef);
    },
  };
}

/**
 * Pasarela falsa para las pruebas: crea intentos con una URL de mentira y acepta avisos firmados con un secreto
 * compartido (`X-Fake-Signature`).
 */
export function fakePaymentProvider(secret = 'secreto-de-pruebas'): PaymentProvider & { intents: PaymentIntentInput[]; refunds: Array<{ providerRef: string; cents: number }>; states: Map<string, 'pending' | 'paid' | 'failed' | 'expired'> } {
  const intents: PaymentIntentInput[] = [];
  const refunds: Array<{ providerRef: string; cents: number }> = [];
  const states = new Map<string, 'pending' | 'paid' | 'failed' | 'expired'>();
  const keys = new Map<string, string>();
  return {
    name: 'fake',
    intents, refunds, states,
    async refund(providerRef, cents, idempotencyKey) {
      // como la pasarela de verdad: con la misma clave, la misma devolución
      const seen = idempotencyKey ? keys.get(idempotencyKey) : undefined;
      if (seen) return { refundRef: seen };
      refunds.push({ providerRef, cents });
      const refundRef = `re_${refunds.length}`;
      if (idempotencyKey) keys.set(idempotencyKey, refundRef);
      return { refundRef };
    },
    async fetchStatus(providerRef) { return { status: states.get(providerRef) ?? 'pending' }; },
    async createIntent(input) {
      intents.push(input);
      const ref = `pi_${intents.length}_${input.reference}`;
      return { providerRef: ref, redirectUrl: `https://pago.example.invalid/${ref}` };
    },
    async parseWebhook(request) {
      if (request.headers.get('X-Fake-Signature') !== secret) return null;
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body.eventId !== 'string' || typeof body.providerRef !== 'string') return null;
      if (!['paid', 'failed', 'expired', 'refunded'].includes(String(body.status))) return null;
      return {
        eventId: body.eventId, providerRef: body.providerRef, status: body.status as PaymentEvent['status'],
        ...(typeof body.refundedCents === 'number' ? { refundedCents: body.refundedCents } : {}),
        ...(typeof body.feeCents === 'number' ? { feeCents: body.feeCents } : {}),
      };
    },
  };
}
