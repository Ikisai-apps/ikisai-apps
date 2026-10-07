/**
 * Ikisai Booking · avisos del portal al comercial (fase 2 de los portales): fechas posibles marcadas por un organizador,
 * «Quiero confirmar» y comentarios sobre la propuesta. La acción del portal los deja en `booking.portal_notices` y este tick
 * los convierte en peticiones a Tasks (T3) con la cuenta de servicio de Booking. Idempotente por aviso.
 */
export type PortalNoticeKind = 'fechas' | 'quiere_confirmar' | 'comentario';

export interface PortalTasksRequest {
  source: 'booking';
  kind: 'booking.organizer_dates' | 'booking.organizer_confirm' | 'booking.proposal_comment';
  kind_label: string;
  external_ref: string;
  title: string;
  note?: string;
  priority: 'high' | 'normal';
  external_url: string;
}

/** Formato de Tasks (docs/tasks/API.md §22, #301): tipo, etiqueta y referencia idempotente por aviso. Sin datos de contacto. */
const KINDS: Record<PortalNoticeKind, { kind: PortalTasksRequest['kind']; label: string; title: (r: string) => string; priority: PortalTasksRequest['priority']; ref: (code: string, n: string) => string }> = {
  fechas: { kind: 'booking.organizer_dates', label: 'Organizador · Fechas posibles', title: (r) => `El organizador marcó fechas posibles · ${r}`, priority: 'normal', ref: (c, n) => `RES${c}-FECHAS-${n}` },
  quiere_confirmar: { kind: 'booking.organizer_confirm', label: 'Organizador · Quiere confirmar', title: (r) => `Quiere confirmar la propuesta · ${r}`, priority: 'high', ref: (c) => `RES${c}-CONFIRMAR` },
  comentario: { kind: 'booking.proposal_comment', label: 'Organizador · Comentario a la propuesta', title: (r) => `Comentario del organizador sobre la propuesta · ${r}`, priority: 'normal', ref: (c, n) => `PROP${c}-COMENTARIO-${n}` },
};

export function portalTasksRequest(n: { id: string; kind: PortalNoticeKind; reservation_id: string; code: string | null; title: string }): PortalTasksRequest {
  const k = KINDS[n.kind];
  const code = (n.code ?? n.reservation_id).replace(/[^A-Za-z0-9_.:-]/g, '');
  return {
    source: 'booking', kind: k.kind, kind_label: k.label, external_ref: k.ref(code, n.id.slice(0, 8)).slice(0, 150),
    title: k.title(`${n.code ?? ''} ${n.title}`.trim()).slice(0, 120), priority: k.priority,
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
