/**
 * Venta de noches en línea (booking-22; 1413): la pasarela de pago detrás de una interfaz, para que la elección de la
 * pasarela (vg-38) solo cambie el adaptador.
 * - La tarjeta la pone el visitante en la página de la pasarela (alojada por ella): Ikisai nunca ve datos de tarjeta.
 * - La pasarela avisa por webhook firmado. El adaptador comprueba la firma y lo traduce a un evento neutro.
 * - Sin pasarela configurada (lo de hoy), el pago en línea responde 503 `PAYMENTS_OFF`.
 */

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
  status: 'paid' | 'failed' | 'expired' | 'refunded';
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
  fetchStatus?(providerRef: string): Promise<{ status: 'pending' | 'paid' | 'failed' | 'expired'; feeCents?: number }>;
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
