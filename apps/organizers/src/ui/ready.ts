/**
 * Veredicto de Diseño y Fechas (MUELA-072:47, que VG mantiene en la MUELA-084): arriba el veredicto ✓ / !, debajo
 * «Siguiente» en grande con la acción que toca y, al final, lo que falta con «Ir a…». La regla es pura y común
 * (`app/design-checks.ts`, `readyVerdict`); aquí solo se pinta. Los ids de feedback los pone quien llama, literales (`mark`, con
 * `fbMark`), para que entren en el catálogo.
 */
import { el, renderChecks, type CheckItem } from '@ikisai/ui-kit';
import type { ReadyVerdict, VerdictNext } from '../app/design-checks.ts';
import { t } from '../app/i18n.ts';

export function renderReady(verdict: ReadyVerdict, items: CheckItem[], options: { label: string; go: (next: VerdictNext) => void; mark: (next: HTMLElement) => HTMLElement }): HTMLElement {
  const n = verdict.next;
  // Lo que va en «Siguiente» no se repite en la lista (como el paso a paso del Resumen); el veredicto sí lo cuenta.
  const rest = n?.kind === 'check' ? items.filter((i) => i.ok || i.text !== n.check.text) : items;
  const box = renderChecks({ items: rest, onlyPending: true, label: options.label, verdict: verdict.text });
  // El kit saca ✓ / ! de la lista que se le pasa; aquí manda el veredicto (la lista puede quedarse sin pendientes).
  const head = box.querySelector<HTMLElement>('.check-verdict');
  if (head) {
    head.classList.toggle('ok', verdict.ok);
    head.classList.toggle('bad', !verdict.ok);
    head.dataset.verdict = verdict.ok ? 'ok' : 'bad';
    const mark = head.querySelector('.check-mark');
    if (mark) mark.textContent = verdict.ok ? '✓' : '!';
  }
  box.classList.add('orgready');
  if (!n) return box;
  const next = el('button', { type: 'button', class: 'step-next orgready-next', id: 'readyNext', 'aria-label': `${t('Siguiente')}: ${n.title}. ${n.action}`, onclick: () => options.go(n) },
    el('span', { class: 'step-icon', 'aria-hidden': 'true' }, '→'),
    el('span', { class: 'step-nexttext' },
      el('span', { class: 'step-label' }, t('Siguiente')),
      el('strong', null, n.title),
      n.detail ? el('small', null, n.detail) : null),
    el('span', { class: 'step-go', 'aria-hidden': 'true' }, n.action, ' ›'));
  options.mark(next);
  // El veredicto va arriba y la lista de lo que falta debajo: «Siguiente» se pone entre los dos.
  if (head) head.after(next);
  else box.prepend(next);
  return box;
}
