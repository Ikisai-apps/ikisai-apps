/**
 * Ikisai Booking · avisos del portal al comercial (fase 2 de los portales): fechas posibles marcadas por un organizador,
 * «Quiero confirmar» y comentarios sobre la propuesta. La acción del portal los deja en `booking.portal_notices` y este tick
 * los convierte en peticiones a Tasks (T3) con la cuenta de servicio de Booking. Idempotente por aviso.
 */
export type PortalNoticeKind = 'fechas' | 'quiere_confirmar' | 'comentario';

export interface PortalTasksRequest {
  source: 'booking';
  kind: 'booking.portal_dates' | 'booking.portal_wants_confirm' | 'booking.portal_comment';
  kind_label: string;
  external_ref: string;
  title: string;
  note?: string;
  priority: 'high' | 'normal';
  external_url: string;
}

const KINDS: Record<PortalNoticeKind, { kind: PortalTasksRequest['kind']; label: string; title: (r: string) => string; priority: PortalTasksRequest['priority'] }> = {
  fechas: { kind: 'booking.portal_dates', label: 'Fechas posibles del organizador', title: (r) => `El organizador marcó fechas posibles · ${r}`, priority: 'normal' },
  quiere_confirmar: { kind: 'booking.portal_wants_confirm', label: 'El organizador quiere confirmar', title: (r) => `Quiere confirmar la propuesta · ${r}`, priority: 'high' },
  comentario: { kind: 'booking.portal_comment', label: 'Comentario sobre la propuesta', title: (r) => `Comentario del organizador sobre la propuesta · ${r}`, priority: 'normal' },
};

export function portalTasksRequest(n: { id: string; kind: PortalNoticeKind; reservation_id: string; code: string | null; title: string }): PortalTasksRequest {
  const k = KINDS[n.kind];
  const ref = n.code ?? n.reservation_id;
  return {
    source: 'booking', kind: k.kind, kind_label: k.label, external_ref: `${ref}:${n.kind}:${n.id}`,
    title: k.title(`${ref} ${n.title}`).slice(0, 120), priority: k.priority,
    external_url: `https://booking.ikisai.com/#/reservas/${n.reservation_id}`,
  };
}

export async function portalTick(deps: {
  invoke: (name: string, args: Record<string, unknown>) => Promise<any>;
  notifyTasks?: (request: PortalTasksRequest) => Promise<boolean>;
}): Promise<{ notified: number; pending: number }> {
  const due = (await deps.invoke('booking.portal_notices_due', {})) as { items: Array<{ id: string; kind: PortalNoticeKind; reservation_id: string; code: string | null; title: string }> };
  if (!deps.notifyTasks) return { notified: 0, pending: due.items.length };
  let notified = 0;
  for (const n of due.items) {
    const ok = await deps.notifyTasks(portalTasksRequest(n));
    await deps.invoke('booking.portal_notice_mark', { id: n.id, ok });
    if (ok) notified++;
  }
  return { notified, pending: due.items.length - notified };
}
