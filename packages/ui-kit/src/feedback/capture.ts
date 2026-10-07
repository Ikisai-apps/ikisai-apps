/**
 * Señalar un elemento **una sola vez**, sin el interruptor «Señalar para comentar» (portales, petición C4 de
 * Organizers): arma el gesto (pulsación mantenida o Mayúsculas+F10), aparta las hojas abiertas para que se vea la
 * pantalla, muestra una barra «Mantén pulsado sobre el lugar… · Cancelar» y resuelve con el nodo señalado (o `null` si
 * se cancela con el botón o Escape). Después lo deja todo como estaba.
 */
import { el } from '../dom.ts';
import { ensureFeedbackGlobalStyles } from './global-style.ts';
import { installFeedbackGesture } from './gesture.ts';
import { resolveFeedbackNode, type FeedbackNode } from './node.ts';
import { kt } from '../i18n/i18n.ts';

export interface CaptureOptions {
  /** Texto de la barra; por defecto «Mantén pulsado sobre el lugar al que te refieres». */
  text?: string;
  /** Nodo de reserva (página o sección) si lo señalado no tiene `data-feedback-id`. */
  fallbackNode?: () => { id: string; path: string[] };
  /** Dónde montar la barra; por defecto `document.body`. */
  container?: () => HTMLElement;
}

export function captureFeedbackTarget(options: CaptureOptions = {}): Promise<FeedbackNode | null> {
  ensureFeedbackGlobalStyles();
  return new Promise((resolve) => {
    const html = document.documentElement;
    let done = false;
    const cancel = el('button', { type: 'button', class: 'ghost small fb-capture-cancel' }, kt('Cancelar'));
    const bar = el('div', { class: 'ikisai-fb-layer fb-capture-bar', role: 'status', 'aria-live': 'polite', 'data-feedback-ignore': '' },
      el('span', null, options.text ?? kt('Mantén pulsado sobre el lugar al que te refieres')), cancel);
    const finish = (node: FeedbackNode | null) => {
      if (done) return;
      done = true;
      gesture.destroy();
      bar.remove();
      html.classList.remove('fb-capturing');
      document.removeEventListener('keydown', onKey, true);
      resolve(node);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(null); } };
    const gesture = installFeedbackGesture({
      onSignal: (target) => finish(resolveFeedbackNode(target, options.fallbackNode)),
      enabled: () => !done,
    });
    cancel.addEventListener('click', () => finish(null));
    document.addEventListener('keydown', onKey, true);
    html.classList.add('fb-capturing');
    (options.container?.() ?? document.body).appendChild(bar);
    cancel.focus({ preventScroll: true });
  });
}
