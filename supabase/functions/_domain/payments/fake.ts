/**
 * Stripe falso (finance-18): el mismo contrato que `createStripeGateway`, sin red, para las pruebas de Finance y de
 * Booking. Guarda las sesiones en memoria, respeta la idempotencia, deja «pagar» o caducar una sesión y construye el
 * webhook firmado que mandaría Stripe. Datos sintéticos: ninguna tarjeta.
 */
import { checkCheckoutRequest, signStripePayload, type CheckoutRequest, type CheckoutSession, type PaymentGateway, PaymentGatewayError } from './stripe.ts';

export interface FakeStripe extends PaymentGateway {
  sessions: Map<string, CheckoutSession>;
  /** Peticiones recibidas (para comprobar importe, caducidad y metadatos). */
  requests: CheckoutRequest[];
  /** Marca la sesión como pagada (como si quien paga terminara en la página de Stripe). */
  pay(id: string, amountCents?: number): CheckoutSession;
  /** La próxima llamada falla como si la pasarela no respondiera. */
  failNext(): void;
  /** El cuerpo y la cabecera `Stripe-Signature` del webhook de una sesión. */
  webhook(id: string, type: 'checkout.session.completed' | 'checkout.session.expired' | 'charge.refunded', secret: string, options?: { eventId?: string; at?: number }): Promise<{ body: string; signature: string }>;
}

export function createFakeStripe(options: { now?: () => number } = {}): FakeStripe {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, CheckoutSession>();
  const byKey = new Map<string, string>();
  const requests: CheckoutRequest[] = [];
  const refunds = new Map<string, { refundId: string; status: string }>();
  const refunded = new Map<string, number>();
  let seq = 0;
  let fail = false;
  const guard = () => { if (fail) { fail = false; throw new PaymentGatewayError('La pasarela no responde.', 'GATEWAY_UNAVAILABLE'); } };
  const get = (id: string) => { const s = sessions.get(id); if (!s) throw new PaymentGatewayError('No existe.', 'resource_missing', 404); return s; };
  return {
    provider: 'stripe', sessions, requests,
    async createCheckout(r) {
      guard();
      checkCheckoutRequest(r, now());
      const existing = byKey.get(r.idempotencyKey);
      if (existing) return { ...sessions.get(existing)! };
      requests.push(r);
      const id = `cs_test_${String(++seq).padStart(6, '0')}`;
      const s: CheckoutSession = { provider: 'stripe', id, url: `https://checkout.stripe.com/c/pay/${id}`, expiresAt: r.expiresAt.toISOString(), status: 'open', paymentStatus: 'unpaid',
        amountCents: r.amountCents, currency: r.currency, metadata: { ...r.metadata }, paymentIntent: null };
      sessions.set(id, s); byKey.set(r.idempotencyKey, id);
      return { ...s };
    },
    async getCheckout(id) { guard(); const s = get(id); if (s.status === 'open' && Date.parse(s.expiresAt) <= now()) s.status = 'expired'; return { ...s }; },
    async expireCheckout(id) { guard(); const s = get(id); if (s.status === 'open') s.status = 'expired'; return { ...s }; },
    pay(id, amountCents) { const s = get(id); s.status = 'complete'; s.paymentStatus = 'paid'; s.paymentIntent = `pi_test_${id.slice(8)}`; if (amountCents !== undefined) s.amountCents = amountCents; return { ...s }; },
    async refund(paymentIntent, amountCents, idempotencyKey) {
      guard();
      const done = refunds.get(idempotencyKey);
      if (done) return done;
      const s = [...sessions.values()].find((x) => x.paymentIntent === paymentIntent);
      if (!s) throw new PaymentGatewayError('No existe.', 'resource_missing', 404);
      const already = refunded.get(paymentIntent) ?? 0;
      if (!Number.isInteger(amountCents) || amountCents <= 0 || already + amountCents > s.amountCents) throw new PaymentGatewayError('Importe inválido.', 'INVALID_AMOUNT', 400);
      refunded.set(paymentIntent, already + amountCents);
      const out = { refundId: `re_test_${String(++seq).padStart(6, '0')}`, status: 'succeeded' };
      refunds.set(idempotencyKey, out);
      return out;
    },
    failNext() { fail = true; },
    async webhook(id, type, secret, o = {}) {
      const s = get(id);
      const object = type === 'charge.refunded'
        ? { id: `ch_test_${id.slice(8)}`, object: 'charge', payment_intent: s.paymentIntent, amount: s.amountCents, amount_refunded: refunded.get(s.paymentIntent ?? '') ?? 0, currency: s.currency, metadata: s.metadata }
        : { id: s.id, object: 'checkout.session', status: s.status, payment_status: s.paymentStatus, amount_total: s.amountCents, currency: s.currency,
            metadata: s.metadata, expires_at: Math.floor(Date.parse(s.expiresAt) / 1000), url: s.url, payment_intent: s.paymentIntent };
      const body = JSON.stringify({ id: o.eventId ?? `evt_test_${id}_${type}`, type, data: { object } });
      return { body, signature: await signStripePayload(body, secret, o.at ?? now()) };
    },
  };
}
