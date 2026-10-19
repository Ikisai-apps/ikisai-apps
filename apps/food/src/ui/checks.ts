/**
 * Veredicto y comprobaciones ✓ / ! de Food (tanda 27; 068 §5 y el Cierre): la pieza del kit `renderChecks`, con el tono
 * de cada comprobación que falta (`alert`, en rojo, lo que impide; `warn`, en ámbar, lo que conviene o va en curso).
 * El tono va además en el texto, nunca solo en el color.
 */
import { renderChecks, type CheckItem } from '@ikisai/ui-kit';

export interface ToneCheck extends CheckItem {
  tone: 'alert' | 'warn';
}

export function tonedChecks(items: ToneCheck[], options: { verdict: string; label: string; feedbackId: string; feedbackLabel: string }): HTMLElement {
  const box = renderChecks({ items, verdict: options.verdict, label: options.label });
  box.setAttribute('data-feedback-id', options.feedbackId);
  box.setAttribute('data-feedback-label', options.feedbackLabel);
  box.classList.add('fd-checks');
  const verdict = box.querySelector<HTMLElement>('.check-verdict');
  if (verdict && items.some((i) => !i.ok && i.tone === 'alert')) verdict.dataset.tone = 'alert';
  box.querySelectorAll<HTMLElement>('.check-item').forEach((li, index) => { li.dataset.tone = items[index]?.tone ?? 'warn'; });
  return box;
}

/** «1 cosa por resolver · La primera: …» o «Lista para enviar · 2 cosas por mejorar, opcionales». */
export function verdictText(items: ToneCheck[], ready: string): string {
  const blocking = items.filter((i) => !i.ok && i.tone === 'alert');
  const optional = items.filter((i) => !i.ok && i.tone === 'warn').length;
  if (blocking.length) return `${blocking.length === 1 ? '1 cosa por resolver' : `${blocking.length} cosas por resolver`} · La primera: ${blocking[0]!.detail ?? blocking[0]!.text}`;
  return optional ? `${ready} · ${optional === 1 ? '1 cosa por mejorar, opcional' : `${optional} cosas por mejorar, opcionales`}` : ready;
}
