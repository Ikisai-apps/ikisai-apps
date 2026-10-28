/**
 * Redsys falso: el adaptador de verdad (`createRedsysGateway`) con una clave sintética y el REST de devoluciones en
 * memoria, sin red. Para las pruebas de Finance y de Booking: crea el formulario firmado como Redsys, deja «pagar»
 * (aviso firmado de autorizado o denegado, con o sin Bizum) y devolver. Ningún dato de tarjeta.
 */
import { createRedsysGateway, decodeRedsysParameters, redsysSignature, signRedsysNotification } from './redsys.ts';
import type { CheckoutRequest, CheckoutSession, PaymentGateway } from './stripe.ts';

/** Clave sintética de 24 bytes en base64 (no es de ningún comercio). */
export const FAKE_REDSYS_KEY = btoa(String.fromCharCode(...Array.from({ length: 24 }, (_, i) => (i * 37 + 11) % 256)));

export interface FakeRedsys extends PaymentGateway {
  secretKey: string;
  sessions: Map<string, CheckoutSession>;
  requests: CheckoutRequest[];
  /** Devoluciones hechas por pedido (céntimos). */
  refunded: Map<string, number>;
  /** El aviso firmado que mandaría Redsys al terminar quien paga: autorizado (`ok`) o denegado. */
  notification(order: string, outcome: 'ok' | 'denied', options?: { amountCents?: number; bizum?: boolean }): Promise<Record<string, string>>;
}

export function createFakeRedsys(options: { now?: () => number; goUrl?: string; notifyUrl?: string; methods?: 'card' | 'bizum' | 'both' } = {}): FakeRedsys {
  const secretKey = FAKE_REDSYS_KEY;
  const sessions = new Map<string, CheckoutSession>();
  const requests: CheckoutRequest[] = [];
  const refunded = new Map<string, number>();
  let auth = 0;
  // El REST de Redsys en memoria: comprueba la firma de la petición y contesta firmado (0900 = devolución aceptada)
  const rest: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    const p = decodeRedsysParameters(body.Ds_MerchantParameters!);
    const order = p.DS_MERCHANT_ORDER!; const amount = Number(p.DS_MERCHANT_AMOUNT);
    const signedOk = body.Ds_Signature === await redsysSignature(secretKey, order, body.Ds_MerchantParameters!);
    const s = sessions.get(order);
    const already = refunded.get(order) ?? 0;
    const ok = signedOk && !!s && s.paymentStatus === 'paid' && already + amount <= s.amountCents;
    if (ok) refunded.set(order, already + amount);
    const signed = await signRedsysNotification(secretKey, { Ds_Order: order, Ds_Amount: String(amount), Ds_Currency: '978', Ds_TransactionType: '3',
      Ds_Response: ok ? '0900' : '0950', Ds_AuthorisationCode: ok ? String(++auth).padStart(6, '0') : '' });
    return Response.json(signed);
  };
  const real = createRedsysGateway({ secretKey, merchantCode: '999008881', terminal: '1', environment: 'pruebas',
    goUrl: options.goUrl ?? 'https://finance.ikisai.com/api/v1/public/payments/redsys/go', notifyUrl: options.notifyUrl ?? 'https://finance.ikisai.com/api/v1/public/payments/redsys',
    methods: options.methods, fetch: rest, now: options.now });
  return {
    ...real, secretKey, sessions, requests, refunded,
    async createCheckout(r) {
      const s = await real.createCheckout(r);
      if (!sessions.has(s.id)) { requests.push(r); sessions.set(s.id, s); }
      return { ...sessions.get(s.id)! };
    },
    async notification(order, outcome, o = {}) {
      const s = sessions.get(order);
      if (!s) throw new Error(`Pedido desconocido: ${order}`);
      if (outcome === 'ok') { s.status = 'complete'; s.paymentStatus = 'paid'; s.paymentIntent = order; }
      const fields = decodeRedsysParameters(s.form!.fields.Ds_MerchantParameters!);
      return signRedsysNotification(secretKey, {
        Ds_Order: order, Ds_Amount: String(o.amountCents ?? s.amountCents), Ds_Currency: '978', Ds_TransactionType: '0',
        Ds_Response: outcome === 'ok' ? '0000' : '0190', Ds_AuthorisationCode: outcome === 'ok' ? String(++auth).padStart(6, '0') : '',
        Ds_MerchantData: encodeURIComponent(fields.DS_MERCHANT_MERCHANTDATA ?? '{}'), Ds_ProcessedPayMethod: o.bizum ? '68' : '1',
      });
    },
  };
}
