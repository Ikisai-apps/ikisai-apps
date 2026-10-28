/**
 * Enlaces de pago de las emitidas (finance-18, PR 2; API.md §19.2). Se cobra cada factura emitida con una sesión de
 * Stripe Checkout de 24 h; se reutiliza la abierta si queda tiempo. El importe sale de la factura (servidor), nunca de
 * quien pide. Sin pasarela configurada (sin `STRIPE_SECRET_KEY`): 503 PAYMENTS_OFF.
 *
 * La tabla y las reglas están en SQL (0255: acciones de sistema `payment_link_prepare` y `payment_link_save`); aquí solo
 * se habla con la pasarela (`_domain/payments`).
 */
import { ensureServiceActor, fail, type Supabase } from '../_kit/mod.ts';
import { defaultExpiry, normalizeStripeEvent, PaymentGatewayError, verifyStripeSignature, type PaymentGateway } from '../_domain/payments/stripe.ts';
import { normalizeRedsysNotification, redsysGoPage, verifyRedsysNotification } from '../_domain/payments/redsys.ts';

export interface PaymentLink { id: string; url: string; provider: string; provider_ref: string; amount: number; expires_at: string }

export interface PaymentLinksOptions {
  /** A dónde vuelve quien paga. Por defecto, la ficha de las emitidas en Finance. */
  successUrl?: (issuedInvoiceId: string) => string;
  cancelUrl?: (issuedInvoiceId: string) => string;
  /**
   * Las otras pasarelas configuradas (no la activa): sus enlaces ya creados se siguen conciliando aunque el interruptor
   * `PAYMENTS_PROVIDER` haya cambiado (API.md §19.6).
   */
  others?: PaymentGateway[];
  now?: () => number;
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const notice = (title: string, text: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
  + `<body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;

const FINANCE = 'https://finance.ikisai.com';

export function createPaymentLinks(supabase: Supabase, gateway: PaymentGateway | null, options: PaymentLinksOptions = {}) {
  const now = options.now ?? Date.now;
  const invoke = <T>(name: string, args: Record<string, unknown>) => supabase.rpc<T>('core_invoke', { p_app: 'invoices', p_actor: null, p_name: name, p_args: args });
  // «Finance (sistema)» (núcleo 0112): la cuenta con la que `payment_event_apply` marca la factura cobrada. Se registra la
  // primera vez (core.apply_system_operations la necesita) y se recuerda.
  let serviceReady: Promise<string> | null = null;
  const ensureService = () => (serviceReady ??= ensureServiceActor(supabase, 'invoices').catch((error) => { serviceReady = null; throw error; }));

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
      currency: session.currency.toUpperCase(), expires_at: session.expiresAt, requested_by: requestedBy, requested_from: from, form: session.form ?? null,
    });
    return { ...saved, reused: false };
  }

  /**
   * Aviso de Stripe (`POST public/payments/stripe`, PR 4): firma comprobada con `STRIPE_WEBHOOK_SECRET`, normalizado y
   * aplicado en SQL (`payment_event_apply`, idempotente). Sin firma válida, 400 y nada cambia. Responde 200 a lo que no
   * interesa para que Stripe no lo reintente.
   */
  async function webhook(request: Request, secret: string | null): Promise<Response> {
    if (!secret) return Response.json({ error: { code: 'PAYMENTS_OFF' } }, { status: 503 });
    const body = await request.text();
    let event;
    try {
      event = await verifyStripeSignature(body, request.headers.get('stripe-signature'), secret, { now: now() });
    } catch (error) {
      return Response.json({ error: { code: error instanceof PaymentGatewayError ? error.code : 'SIGNATURE_INVALID' } }, { status: 400 });
    }
    const e = normalizeStripeEvent(event);
    await ensureService();
    // Solo lo que es de Finance (los cobros de Booking llevan su propia `app` en metadatos y van a su webhook)
    if (e.metadata.app && e.metadata.app !== 'invoices') return Response.json({ received: true, outcome: 'ignored' });
    const out = await invoke<{ outcome: string }>('invoices.payment_event_apply', {
      provider: 'stripe', event_id: e.eventId, kind: e.kind, provider_ref: e.sessionId, amount_cents: e.amountCents, refunded_cents: e.refundedCents,
      payment_ref: e.paymentIntent, paid_at: new Date(now()).toISOString(),
    });
    return Response.json({ received: true, outcome: out.outcome });
  }

  /**
   * Conciliación (`worker/payments/reconcile`, cada hora si hay algo abierto): pregunta a la pasarela por cada enlace
   * abierto (por si se perdió un aviso) y cierra en la pasarela los cancelados, para que nadie pague uno cancelado.
   */
  async function reconcile(): Promise<{ checked: number; paid: number; closed: number; errors: number }> {
    const gateways = [gateway, ...(options.others ?? [])].filter((g): g is PaymentGateway => !!g);
    if (!gateways.length) return { checked: 0, paid: 0, closed: 0, errors: 0 };
    await ensureService();
    const { items } = await invoke<{ items: Array<{ provider: string; provider_ref: string; status: string; expires_at: string }> }>('invoices.payment_links_to_check', { limit: 50 });
    let paid = 0; let closed = 0; let errors = 0;
    for (const l of items) {
      try {
        const gw = gateways.find((g) => g.provider === l.provider);
        if (!gw) continue;
        // Redsys no se pregunta ni se caduca en la pasarela: el pago llega por su aviso y la caducidad la lleva Finance (la
        // página de paso ya no sirve el formulario de un enlace caducado o cancelado).
        if (gw.queryable === false) {
          if (l.status !== 'abierto' || Date.parse(l.expires_at) <= now()) {
            await invoke('invoices.payment_link_gateway_closed', { provider: l.provider, provider_ref: l.provider_ref });
            closed += 1;
          }
          continue;
        }
        let s = await gw.getCheckout(l.provider_ref);
        if (l.status !== 'abierto' && s.status === 'open') s = await gw.expireCheckout(l.provider_ref);
        if (s.status === 'complete' && s.paymentStatus === 'paid') {
          const out = await invoke<{ outcome: string }>('invoices.payment_event_apply', { provider: l.provider, event_id: `reconcile:${s.id}`, kind: 'paid', provider_ref: s.id,
            amount_cents: s.amountCents, payment_ref: s.paymentIntent, paid_at: new Date(now()).toISOString() });
          if (out.outcome === 'applied') paid += 1;
        } else if (s.status === 'expired') {
          await invoke('invoices.payment_link_gateway_closed', { provider: l.provider, provider_ref: s.id });
          closed += 1;
        }
      } catch { errors += 1; }
    }
    return { checked: items.length, paid, closed, errors };
  }

  /**
   * Aviso de Redsys (`POST public/payments/redsys`, API.md §19.6): llega como formulario (`Ds_SignatureVersion`,
   * `Ds_MerchantParameters`, `Ds_Signature`) y vale solo con la firma de `REDSYS_SECRET_KEY`. Bizum cuenta como «bizum».
   */
  async function redsysWebhook(request: Request, secretKey: string | null): Promise<Response> {
    if (!secretKey) return Response.json({ error: { code: 'PAYMENTS_OFF' } }, { status: 503 });
    const fields = Object.fromEntries(new URLSearchParams(await request.text()));
    let n;
    try {
      n = await verifyRedsysNotification(fields, secretKey);
    } catch (error) {
      return Response.json({ error: { code: error instanceof PaymentGatewayError ? error.code : 'SIGNATURE_INVALID' } }, { status: 400 });
    }
    const e = normalizeRedsysNotification(n);
    if (e.metadata.app && e.metadata.app !== 'invoices') return Response.json({ received: true, outcome: 'ignored' });
    await ensureService();
    const out = await invoke<{ outcome: string }>('invoices.payment_event_apply', {
      provider: 'redsys', event_id: e.eventId, kind: e.kind, provider_ref: e.sessionId, amount_cents: e.amountCents, refunded_cents: e.refundedCents,
      payment_ref: e.paymentIntent, paid_at: new Date(now()).toISOString(), method: n.Ds_ProcessedPayMethod === '68' ? 'bizum' : 'tarjeta',
    });
    return Response.json({ received: true, outcome: out.outcome });
  }

  /** Página de paso de Redsys (`GET public/payments/redsys/go/<pedido>`): manda el formulario si el enlace sigue valiendo. */
  async function redsysGo(order: string): Promise<Response> {
    if (!/^\d{4}[0-9a-z]{8}$/.test(order)) return html(notice('Enlace no válido', 'Pide un enlace de pago nuevo.'), 404);
    const out = await invoke<{ status: string; form: { action: string; fields: Record<string, string> } | null }>('invoices.payment_link_form', { provider_ref: order });
    if (out.form) return html(redsysGoPage(out.form));
    if (out.status === 'pagado') return html(notice('Ya está pagado', 'Este pago ya se hizo. Gracias.'), 410);
    if (out.status === 'desconocido') return html(notice('Enlace no válido', 'Pide un enlace de pago nuevo.'), 404);
    return html(notice('Este enlace ya no vale', 'Ha caducado o se ha cancelado. Pide un enlace de pago nuevo.'), 410);
  }

  return { ensure, webhook, reconcile, redsysWebhook, redsysGo };
}
