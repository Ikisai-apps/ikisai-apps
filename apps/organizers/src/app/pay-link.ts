/**
 * Pagos en línea (fase 6, decisión de VG del 27-10-2026: después del sábado). Finance crea un enlace de pago por factura o
 * vencimiento (Stripe Payment Links o Redsys del banco) y lo da en `portal_reservation_money` (petición F5). Organizers solo
 * enseña «Pagar ahora»: ningún dato de tarjeta pasa por Ikisai, y lo cobrado lo sigue registrando Finance.
 * Puro (sin i18n ni DOM): qué enlaces se pueden enseñar.
 */
import type { PortalInvoice } from './api.ts';

/** Pasarelas con las que trabaja Finance. Un enlace a otro sitio no se enseña nunca. */
export const PAY_HOSTS = ['buy.stripe.com', 'checkout.stripe.com', 'sis.redsys.es', 'sis-t.redsys.es'] as const;

/** La URL que se puede abrir, o `null`: factura sin cobrar, `https`, pasarela conocida y sin caducar. */
export function payLinkOf(invoice: PortalInvoice, now: number = Date.now()): string | null {
  const link = invoice.payment_link;
  if (!link || invoice.collected || invoice.status === 'rectificada') return null;
  let url: URL;
  try { url = new URL(link.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !(PAY_HOSTS as readonly string[]).includes(url.hostname)) return null;
  if (link.expires_at && Date.parse(link.expires_at) <= now) return null;
  return url.toString();
}

/** Las facturas con enlace de pago vigente, en el orden de Finance. */
export function payableInvoices(invoices: PortalInvoice[], now: number = Date.now()): Array<{ invoice: PortalInvoice; url: string }> {
  return invoices.flatMap((invoice) => { const url = payLinkOf(invoice, now); return url ? [{ invoice, url }] : []; });
}
