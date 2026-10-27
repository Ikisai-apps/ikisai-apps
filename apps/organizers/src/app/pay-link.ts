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

/**
 * «Pagar ahora» sin enlace (F5, Finance §19.3): una emitida sin cobrar, con importe y sin enlace vigente, cuyo enlace se pide
 * al pulsar (`POST payments/link`). Finance vuelve a comprobar si se puede cobrar (`409 PAYMENT_NOT_ALLOWED`).
 */
export function payOnDemand(invoice: PortalInvoice, now: number = Date.now()): boolean {
  return invoice.status === 'emitida' && !invoice.collected && Number(invoice.total) > 0 && payLinkOf(invoice, now) === null;
}

/** Las facturas con enlace de pago vigente, en el orden de Finance. */
export function payableInvoices(invoices: PortalInvoice[], now: number = Date.now()): Array<{ invoice: PortalInvoice; url: string }> {
  return invoices.flatMap((invoice) => { const url = payLinkOf(invoice, now); return url ? [{ invoice, url }] : []; });
}

/**
 * «Pago en curso» (diseño en MUELA/equipo/feedback/organizers/PAGO_EN_CURSO.md): al pulsar «Pagar ahora» se apunta en el
 * dispositivo, para no pagar dos veces mientras Finance no registra el cobro. Solo es un aviso: lo cobrado lo dice Finance.
 */
export type PayState = 'pagar' | 'en_curso' | 'caducado' | 'cobrada';
export const PENDING_MS = 72 * 3600_000;
const KEY = (invoiceId: string) => `organizers.pay.pending.${invoiceId}`;

/** El estado de una factura para «Pagar en línea», según lo cobrado y la marca del dispositivo (`pendingAt`, en ms). */
export function payState(invoice: Pick<PortalInvoice, 'collected'>, pendingAt: number | null, now: number = Date.now()): PayState {
  if (invoice.collected) return 'cobrada';
  if (pendingAt === null) return 'pagar';
  return now - pendingAt < PENDING_MS ? 'en_curso' : 'caducado';
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** La marca de «Pago en curso» de una factura, o `null` (también sin almacenamiento disponible). */
export function pendingOf(invoiceId: string, s: Store | null = store()): number | null {
  try { const v = Number(s?.getItem(KEY(invoiceId))); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}
export function markPending(invoiceId: string, now: number = Date.now(), s: Store | null = store()): void {
  try { s?.setItem(KEY(invoiceId), String(now)); } catch { /* sin almacenamiento: no se recuerda */ }
}
export function clearPending(invoiceId: string, s: Store | null = store()): void {
  try { s?.removeItem(KEY(invoiceId)); } catch { /* nada */ }
}

/** Vuelta de la pasarela: `?pago=ok|cancelado&factura=<id>` al final de la ruta (`#/retiro/<id>/pagos?…`). */
export function returnOf(hash: string): { outcome: 'ok' | 'cancelado'; invoiceId: string | null } | null {
  const q = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)) : null;
  const outcome = q?.get('pago');
  if (outcome !== 'ok' && outcome !== 'cancelado') return null;
  const invoiceId = q?.get('factura') ?? null;
  return { outcome, invoiceId: invoiceId && /^[0-9a-f-]{36}$/i.test(invoiceId) ? invoiceId.toLowerCase() : null };
}
