/**
 * Enlaces de pago de las emitidas (finance-18, PR 2; API.md §19.2). Se cobra cada factura emitida con una sesión de
 * Stripe Checkout de 24 h; se reutiliza la abierta si queda tiempo. El importe sale de la factura (servidor), nunca de
 * quien pide. Sin pasarela configurada (sin `STRIPE_SECRET_KEY`): 503 PAYMENTS_OFF.
 *
 * La tabla y las reglas están en SQL (0255: acciones de sistema `payment_link_prepare` y `payment_link_save`); aquí solo
 * se habla con la pasarela (`_domain/payments`).
 */
import { fail, type Supabase } from '../_kit/mod.ts';
import { defaultExpiry, PaymentGatewayError, type PaymentGateway } from '../_domain/payments/stripe.ts';

export interface PaymentLink { id: string; url: string; provider: string; provider_ref: string; amount: number; expires_at: string }

export interface PaymentLinksOptions {
  /** A dónde vuelve quien paga. Por defecto, la ficha de las emitidas en Finance. */
  successUrl?: (issuedInvoiceId: string) => string;
  cancelUrl?: (issuedInvoiceId: string) => string;
  now?: () => number;
}

const FINANCE = 'https://finance.ikisai.com';

export function createPaymentLinks(supabase: Supabase, gateway: PaymentGateway | null, options: PaymentLinksOptions = {}) {
  const now = options.now ?? Date.now;
  const invoke = <T>(name: string, args: Record<string, unknown>) => supabase.rpc<T>('core_invoke', { p_app: 'invoices', p_actor: null, p_name: name, p_args: args });

  /** El enlace abierto de la factura o uno nuevo. `requestedBy`: quien lo pide (persona de Finance o del portal). */
  async function ensure(issuedInvoiceId: string, requestedBy: string | null, from: 'finance' | 'portal', urls?: { success: string; cancel: string }): Promise<PaymentLink & { reused: boolean }> {
    const prep = await invoke<{ attempt: number; invoice: { id: string; number: string | null; description: string | null; total: number; currency: string }; open: PaymentLink | null }>(
      'invoices.payment_link_prepare', { issued_invoice_id: issuedInvoiceId });
    if (prep.open) return { ...prep.open, reused: true };
    if (!gateway) fail(503, 'PAYMENTS_OFF', 'El pago en línea aún no está activado.');
    const amountCents = Math.round(Number(prep.invoice.total) * 100);
    const at = now();
    let session;
    try {
      session = await gateway!.createCheckout({
        amountCents, currency: String(prep.invoice.currency ?? 'EUR').toLowerCase(),
        description: [prep.invoice.number ? `Factura ${prep.invoice.number}` : 'Factura', prep.invoice.description].filter(Boolean).join(' · ').slice(0, 250),
        metadata: { app: 'invoices', issued_invoice_id: issuedInvoiceId },
        expiresAt: defaultExpiry(at),
        successUrl: urls?.success ?? options.successUrl?.(issuedInvoiceId) ?? `${FINANCE}/#/facturas?vista=emitidas&pagada=${issuedInvoiceId}`,
        cancelUrl: urls?.cancel ?? options.cancelUrl?.(issuedInvoiceId) ?? `${FINANCE}/#/facturas?vista=emitidas`,
        // Por factura, importe e intento: reintentar el mismo intento da la misma sesión; tras caducar, otra.
        idempotencyKey: `invoices:pl:${issuedInvoiceId}:${amountCents}:${prep.attempt}`,
      });
    } catch (error) {
      if (error instanceof PaymentGatewayError) fail(error.code === 'GATEWAY_UNAVAILABLE' ? 503 : 502, 'PAYMENT_GATEWAY', 'La pasarela de pago no ha podido crear el enlace. Inténtalo más tarde.', { code: error.code });
      throw error;
    }
    const saved = await invoke<PaymentLink>('invoices.payment_link_save', {
      issued_invoice_id: issuedInvoiceId, provider: session.provider, provider_ref: session.id, url: session.url, amount: amountCents / 100,
      currency: session.currency.toUpperCase(), expires_at: session.expiresAt, requested_by: requestedBy, requested_from: from,
    });
    return { ...saved, reused: false };
  }

  return { ensure };
}
