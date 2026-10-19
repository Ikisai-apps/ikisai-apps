/**
 * Recorrido de la entrega a la gestoría (tanda 27, MUELA-042 y 070): Validar · Preparar · Enviar · Entregada · Archivada.
 * Proyección pura de las facturas por resolver del periodo y de sus entregas (la más nueva manda); sin estado nuevo.
 * El sello de antes (Lista · Casi lista · Preparada · Entregada · Desfasada) queda como la frase bajo el recorrido, que
 * sigue diciendo lo que se queda fuera. Sin dependencias (se prueba con node).
 */
export const DELIVERY_STAGES = [
  { key: 'validar', label: 'Validar' },
  { key: 'preparar', label: 'Preparar' },
  { key: 'enviar', label: 'Enviar' },
  { key: 'entregada', label: 'Entregada' },
  { key: 'archivada', label: 'Archivada' },
] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number]['key'];

export interface DeliveryInput {
  /** Facturas del periodo por resolver (no entran en la entrega). */
  pending: number;
  /** Validadas o archivadas del periodo (lo que entraría). */
  ready: number;
  /** La entrega más nueva del periodo, si la hay. */
  latest: { status: 'generada' | 'entregada'; stale: boolean; archived: boolean; delivered_to: string | null } | null;
}

export interface DeliveryState { stage: DeliveryStage; bad: DeliveryStage[]; seal: string; caption: string }

const facturas = (n: number) => (n === 1 ? '1 factura' : `${n} facturas`);

export function deliveryState(input: DeliveryInput): DeliveryState {
  const out = input.pending ? ` · ${facturas(input.pending)} por resolver ${input.pending === 1 ? 'se queda' : 'se quedan'} fuera` : '';
  const { latest } = input;
  if (!latest) {
    if (!input.ready) return { stage: 'validar', bad: input.pending ? ['validar'] : [], seal: 'Vacía', caption: input.pending ? `Vacía: ${facturas(input.pending)} por resolver` : 'Vacía: no hay facturas validadas en el periodo' };
    return input.pending
      ? { stage: 'validar', bad: ['validar'], seal: 'Casi lista', caption: `Casi lista: ${facturas(input.ready)} para la gestoría${out}` }
      : { stage: 'preparar', bad: [], seal: 'Lista', caption: `Lista: ${facturas(input.ready)} para la gestoría. Prepara la entrega.` };
  }
  if (latest.stale) return { stage: 'preparar', bad: ['preparar'], seal: 'Desfasada', caption: `Desfasada: algo cambió desde la entrega; prepara otra${out}` };
  if (latest.archived) return { stage: 'archivada', bad: [], seal: 'Archivada', caption: 'Archivada: de sus facturas solo se tocan el pago y las notas' };
  if (latest.status === 'entregada') return { stage: 'entregada', bad: [], seal: 'Entregada', caption: `Entregada${latest.delivered_to ? `: ${latest.delivered_to}` : ''}${out}` };
  return { stage: 'enviar', bad: [], seal: 'Preparada', caption: `Preparada: descárgala y envíala a la gestoría${out}` };
}
