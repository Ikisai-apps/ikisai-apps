/**
 * Guiado, nivel mínimo: al llegar con `?campo=…&paso=…` (de `withGuideLink`), una línea arriba explica el paso y el campo
 * se señala (a la vista, con el foco y resaltado). «Ver el campo» lo vuelve a señalar; «‹ Volver a…» lleva de vuelta a
 * quien guía, que reconsulta lo pendiente (nada se da por hecho por haber vuelto). La monta `createAppShell({ guide })`.
 * - Si el campo está escondido, se pide a la app con `registerReveal`. Si no aparece, lo dice («No encuentro…»).
 * - El texto del paso viene de la URL: se pinta como texto, nunca como HTML.
 * Prefijo de clases: `guia-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { icon } from '../icons.ts';
import { pointAt, revealAnchor } from './anchors.ts';
import { clearGuideLink, type GuideLink } from './link.ts';

export interface FieldPointer {
  element: HTMLElement;
  /** Busca y señala el campo; `false` si no aparece. */
  point(): Promise<boolean>;
  close(): void;
}

export function createFieldPointer(link: GuideLink, options: { feedbackId?: string; timeoutMs?: number } = {}): FieldPointer {
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const message = el('span', { class: 'guia-text' });
  const status = el('span', { class: 'guia-status', role: 'status', 'aria-live': 'polite' });
  const again = el('button', { type: 'button', class: 'ghost small guia-again', ...mark('ver', 'Ver el campo'), onclick: () => void api.point() }, kt('Ver el campo'));
  const element = el('div', { class: 'guia-callout', role: 'region', 'aria-label': kt('Paso del recorrido'), ...(base ? { 'data-feedback-id': base, 'data-feedback-label': 'Paso del recorrido' } : {}) },
    el('span', { class: 'guia-icon', 'aria-hidden': 'true' }, icon('pin', 16)),
    el('span', { class: 'guia-body' }, message, status),
    again,
    el('button', { type: 'button', class: 'iconbtn guia-close', 'aria-label': kt('Cerrar el aviso del paso'), ...mark('cerrar', 'Cerrar el aviso'), onclick: () => api.close() }, icon('close', 16)));
  replace(message, link.step ?? kt('Este es el campo del paso.'));

  const api: FieldPointer = {
    element,
    async point() {
      if (!link.field) return false;
      status.textContent = '';
      const node = await revealAnchor(link.field, { timeoutMs: options.timeoutMs });
      if (!node) { status.textContent = kt('No encuentro el campo de este paso en esta pantalla.'); element.dataset.found = 'false'; return false; }
      element.dataset.found = 'true';
      pointAt(node);
      return true;
    },
    close() { clearGuideLink(); element.remove(); },
  };
  return api;
}
