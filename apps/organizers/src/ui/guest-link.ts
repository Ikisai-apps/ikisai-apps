/**
 * Enviar el enlace personal de un asistente (API.md §9.4 y §9.6), igual desde la fila de la lista que desde su ficha:
 * relee los enlaces, confirma si ya tiene uno vivo (el anterior deja de funcionar), guarda lo pendiente, lo emite y abre la
 * hoja de compartir. El enlace se ve una sola vez; en esta sesión, el recordatorio puede llevarlo (`issued`).
 */
import { confirmDialog, toast } from '@ikisai/ui-kit';
import type { GuestMode } from '../../../../supabase/functions/_domain/booking/mod.ts';
import type { PortalGuest, PortalLink, PortalRestriction, ReservationDetail } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError } from '../app/client.ts';
import { linksByGuest } from '../app/guests-state.ts';
import { t } from '../app/i18n.ts';
import { linkMessage } from '../app/texts.ts';
import { openShareSheet } from './share.ts';
import type { ViewContext } from './shell.ts';

/** Enlaces emitidos en esta sesión: el recordatorio puede llevarlo mientras siga abierta la app. */
export const issued = new Map<string, string>();

/** Borrador de la ficha del asistente (`guest:{id}`), el mismo que guarda `guest.ts`. */
export interface GuestDraft { guestId?: string; fields: Record<string, string>; restrictions?: PortalRestriction[] }

export interface SendLinkOptions {
  reservationId: string;
  guest: PortalGuest;
  detail: ReservationDetail;
  mode: GuestMode;
  link: PortalLink | undefined;
  /** Guarda lo pendiente; con `false` no se emite el enlace. */
  flushPending: () => Promise<boolean>;
  feedback: 'fila' | 'ficha';
}

export async function sendGuestLink(ctx: ViewContext, o: SendLinkOptions): Promise<boolean> {
  const { guest } = o;
  // 1 · Releer: la lista pudo quedarse atrás (otra persona o pestaña le envió uno).
  let link = o.link;
  try { link = linksByGuest((await ctx.api.links(o.reservationId)).value.items).get(guest.id); } catch { /* sin lectura: lo que ya se sabía */ }
  // 2 · Con un enlace vivo, se confirma: el anterior deja de funcionar.
  if (link && !(await confirmDialog({ title: t('Reenviar enlace'), text: t('Se creará un enlace nuevo para {nombre} y el anterior dejará de funcionar.', { nombre: guest.display_name }), confirmLabel: t('Crear enlace nuevo') }))) return false;
  try {
    // 3 · Lo pendiente primero: nunca se emite con cambios sin guardar.
    if (!(await o.flushPending())) return false;
    // 4 · Emitir.
    const email = typeof guest.fields.email === 'string' ? guest.fields.email : null;
    const issue = () => ctx.api.issueGuestLink({ reservationId: o.reservationId, guestId: guest.id, name: guest.display_name, email, replace: true });
    const out = o.feedback === 'fila'
      ? await ctx.usage.run('organizers.asistentes.lista.enviar_enlace', issue)
      : link ? await ctx.usage.run('organizers.asistente.ficha.reenviar_enlace', issue) : await ctx.usage.run('organizers.asistente.ficha.enviar_enlace', issue);
    // 5 · Compartir: el enlace se ve una vez y WhatsApp va al número escrito.
    issued.set(guest.id, out.url);
    openShareSheet({ name: guest.display_name, text: linkMessage(guest.display_name, o.detail, out.url, o.mode), phone: typeof guest.fields.phone === 'string' ? guest.fields.phone : null });
    return true;
  } catch (e) {
    toast(describeError(e, guest.display_name));
    return false;
  }
}

/**
 * Desde la fila: si la ficha tiene cambios sin guardar en este dispositivo (borrador distinto de lo guardado), se abre
 * la ficha para revisarlos y no se emite nada (puede faltar la declaración o haber un conflicto que resolver).
 */
export async function rowFlushPending(ctx: ViewContext, reservationId: string, guest: PortalGuest): Promise<boolean> {
  const draft = await cache.draft<GuestDraft>(ctx.userId, `guest:${guest.id}`).catch(() => null);
  const changed = !!draft && (draft.restrictions !== undefined || Object.entries(draft.fields ?? {}).some(([key, value]) =>
    guest.fields[key] !== true && String(value ?? '').trim() !== (typeof guest.fields[key] === 'string' ? (guest.fields[key] as string) : '').trim()));
  if (!changed) return true;
  toast(t('{nombre} tiene cambios sin guardar: revísalos en su ficha antes de enviar el enlace.', { nombre: guest.display_name }));
  ctx.navigate(`#/retiro/${reservationId}/asistentes/${guest.id}`);
  return false;
}
